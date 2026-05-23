import {
  InvoiceGatewayFeePolicy,
  InvoicePaymentAttemptStatus,
  InvoiceStatus,
  Role,
  SubscriptionStatus,
  WalletLedgerDirection,
  WalletLedgerType,
  WalletTopupStatus,
  type Prisma
} from "@prisma/client";

import { getLouvinConfig } from "@/lib/env";
import { prisma } from "@/lib/db/prisma";
import { isLikelyQrisPayload } from "@/lib/payment/checkoutFallback";
import { acquireIdempotencyLock } from "@/lib/redis/idempotency";
import { publishInvoicePaidEvent, publishInvoiceUpdatedEvent } from "@/lib/ably/publisher";
import { syncConversationCrmStageFromInvoice } from "@/server/services/crmPipelineService";
import { processAiAutomationTrigger } from "@/server/services/aiAutomationService";
import { writeAuditLogSafe } from "@/server/services/auditLogService";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { ServiceError } from "@/server/services/serviceError";

const DEFAULT_VA_FEE_CENTS = 6_500;
const SPECIAL_VA_FEE_CENTS = 6_500;
const DEFAULT_QRIS_FEE_BPS = 200;

const SPECIAL_VA_METHODS = new Set<string>([]);

export const INVOICE_VA_METHODS = [
  "cimb_niaga_va",
  "bni_va",
  "permata_va",
  "bri_va"
] as const;

export type InvoiceVaMethod = (typeof INVOICE_VA_METHODS)[number];
export type InvoiceGatewayMethod = "bank_transfer" | "qris" | InvoiceVaMethod;

export type OrgInvoicePaymentSettings = {
  enableBankTransfer: boolean;
  enableQris: boolean;
  enabledVaMethods: InvoiceVaMethod[];
  feePolicy: InvoiceGatewayFeePolicy;
  autoConfirmLabelEnabled: boolean;
  paymentMethodsOrder: string[];
};

type LouvinCreateResponse = {
  success?: boolean;
  transaction?: {
    id?: string;
    amount?: number;
    fee?: number;
    net_amount?: number;
    status?: string;
    reference?: string;
  };
  payment?: {
    order_id?: string;
    payment_method?: string;
    amount?: number;
    fee?: number;
    payment_number?: string;
    expired_at?: string;
    va_number?: string;
    qr_string?: string;
  };
};

type LouvinDetailResponse = {
  success?: boolean;
  transaction?: {
    id?: string;
    amount?: number;
    net_amount?: number;
    reference?: string;
    status?: string;
    updated_at?: string;
  };
};

type BankAccountSnapshot = {
  bankName: string;
  accountNumber: string;
  accountHolder: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function toWholeNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.round(numeric));
}

function calculateGatewayFeeCents(baseAmountCents: number, feeBps: number): number {
  return Math.ceil((Math.max(0, baseAmountCents) * Math.max(0, feeBps)) / 10_000);
}

function resolveVaFeeCents(method: InvoiceVaMethod): number {
  if (SPECIAL_VA_METHODS.has(method)) {
    return SPECIAL_VA_FEE_CENTS;
  }
  return DEFAULT_VA_FEE_CENTS;
}

function isInvoiceVaMethod(value: string): value is InvoiceVaMethod {
  return (INVOICE_VA_METHODS as readonly string[]).includes(value);
}

function parseVaMethodsJson(raw: string | null | undefined): InvoiceVaMethod[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item): item is InvoiceVaMethod => isInvoiceVaMethod(item));
  } catch {
    return [];
  }
}

function serializeVaMethodsJson(methods: InvoiceVaMethod[]): string {
  const unique = [...new Set(methods)].filter((method) => isInvoiceVaMethod(method));
  return JSON.stringify(unique);
}

function parseStringArrayJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseBankAccountsJson(raw: string | null | undefined): BankAccountSnapshot[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const results: BankAccountSnapshot[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const bankName = normalize((item as { bankName?: unknown }).bankName as string | undefined);
      const accountNumber = normalize((item as { accountNumber?: unknown }).accountNumber as string | undefined);
      const accountHolder = normalize((item as { accountHolder?: unknown }).accountHolder as string | undefined);
      if (!bankName || !accountNumber || !accountHolder) {
        continue;
      }
      results.push({ bankName, accountNumber, accountHolder });
    }
    return results;
  } catch {
    return [];
  }
}

type NormalizedGatewayPayment = {
  paymentNumber: string | null;
  paymentMethod: string;
  expiredAt: Date | null;
  rawExpiredAt: string | null;
};

function normalizeGatewayPayment(input: {
  payment: LouvinCreateResponse["payment"] | null | undefined;
  fallbackMethod: string;
  trace: string;
}): NormalizedGatewayPayment {
  const payment = input.payment ?? {};
  const paymentNumber = ((payment.payment_number ?? "").trim() || (payment.qr_string ?? "").trim() || (payment.va_number ?? "").trim()) || null;
  const paymentMethod = (payment.payment_method ?? "").trim().toLowerCase() || input.fallbackMethod;
  const rawExpiredAt = payment.expired_at?.trim() || null;
  const date = rawExpiredAt ? new Date(rawExpiredAt) : null;
  const expiredAt = date && !Number.isNaN(date.getTime()) ? date : null;

  if (!payment.payment_method || (!payment.payment_number && (payment.qr_string || payment.va_number))) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "louvin.payment_payload_fallback",
        trace: input.trace,
        usedFallbackMethod: !payment.payment_method,
        usedFallbackPaymentNumber: !payment.payment_number && Boolean(payment.qr_string || payment.va_number),
        inferredQrisPayload: isLikelyQrisPayload(paymentNumber)
      })
    );
  }

  return { paymentNumber, paymentMethod, expiredAt, rawExpiredAt };
}

export async function getOrgInvoicePaymentSettings(orgId: string): Promise<OrgInvoicePaymentSettings> {
  const normalizedOrgId = normalize(orgId);
  if (!normalizedOrgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const existing = await prisma.orgInvoicePaymentSetting.findUnique({
    where: { orgId: normalizedOrgId },
    select: {
      enableBankTransfer: true,
      enableQris: true,
      enabledVaMethodsJson: true,
      feePolicy: true,
      autoConfirmLabelEnabled: true,
      paymentMethodsOrderJson: true
    }
  });

  if (!existing) {
    return {
      enableBankTransfer: true,
      enableQris: false,
      enabledVaMethods: [],
      feePolicy: InvoiceGatewayFeePolicy.CUSTOMER,
      autoConfirmLabelEnabled: true,
      paymentMethodsOrder: []
    };
  }

  return {
    enableBankTransfer: existing.enableBankTransfer,
    enableQris: existing.enableQris,
    enabledVaMethods: parseVaMethodsJson(existing.enabledVaMethodsJson),
    feePolicy: existing.feePolicy,
    autoConfirmLabelEnabled: existing.autoConfirmLabelEnabled,
    paymentMethodsOrder: parseStringArrayJson(existing.paymentMethodsOrderJson)
  };
}

export async function updateOrgInvoicePaymentSettings(input: {
  actorUserId: string;
  orgId?: string;
  enableBankTransfer?: boolean;
  enableQris?: boolean;
  enabledVaMethods?: string[];
  feePolicy?: string;
  autoConfirmLabelEnabled?: boolean;
  paymentMethodsOrder?: string[];
}) {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, normalize(input.orgId));
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: input.actorUserId
      }
    },
    select: {
      role: true
    }
  });

  if (!membership || membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can update payment settings.");
  }

  const current = await getOrgInvoicePaymentSettings(orgId);
  const nextFeePolicy =
    input.feePolicy === InvoiceGatewayFeePolicy.MERCHANT || input.feePolicy === InvoiceGatewayFeePolicy.CUSTOMER
      ? input.feePolicy
      : current.feePolicy;
  const nextVaMethods = Array.isArray(input.enabledVaMethods)
    ? input.enabledVaMethods
        .map((item) => normalize(item))
        .filter((item): item is InvoiceVaMethod => isInvoiceVaMethod(item))
    : current.enabledVaMethods;
  const nextPaymentMethodsOrder = Array.isArray(input.paymentMethodsOrder)
    ? input.paymentMethodsOrder.filter((item): item is string => typeof item === "string")
    : current.paymentMethodsOrder;

  const updated = await prisma.orgInvoicePaymentSetting.upsert({
    where: { orgId },
    create: {
      orgId,
      enableBankTransfer: input.enableBankTransfer ?? current.enableBankTransfer,
      enableQris: input.enableQris ?? current.enableQris,
      enabledVaMethodsJson: serializeVaMethodsJson(nextVaMethods),
      feePolicy: nextFeePolicy,
      autoConfirmLabelEnabled: input.autoConfirmLabelEnabled ?? current.autoConfirmLabelEnabled,
      paymentMethodsOrderJson: JSON.stringify(nextPaymentMethodsOrder)
    },
    update: {
      enableBankTransfer: input.enableBankTransfer ?? current.enableBankTransfer,
      enableQris: input.enableQris ?? current.enableQris,
      enabledVaMethodsJson: serializeVaMethodsJson(nextVaMethods),
      feePolicy: nextFeePolicy,
      autoConfirmLabelEnabled: input.autoConfirmLabelEnabled ?? current.autoConfirmLabelEnabled,
      paymentMethodsOrderJson: JSON.stringify(nextPaymentMethodsOrder)
    },
    select: {
      enableBankTransfer: true,
      enableQris: true,
      enabledVaMethodsJson: true,
      feePolicy: true,
      autoConfirmLabelEnabled: true,
      paymentMethodsOrderJson: true
    }
  });

  return {
    enableBankTransfer: updated.enableBankTransfer,
    enableQris: updated.enableQris,
    enabledVaMethods: parseVaMethodsJson(updated.enabledVaMethodsJson),
    feePolicy: updated.feePolicy,
    autoConfirmLabelEnabled: updated.autoConfirmLabelEnabled,
    paymentMethodsOrder: parseStringArrayJson(updated.paymentMethodsOrderJson)
  };
}

async function createPakasirTransaction(input: {
  orderId: string;
  amount: number;
  method: string;
}) {
  const config = getLouvinConfig();
  const response = await fetch(`${config.baseUrl}/create-transaction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey
    },
    body: JSON.stringify({
      amount: input.amount,
      payment_type: input.method,
      reference: input.orderId
    })
  });

  const payload = (await response.json().catch(() => null)) as LouvinCreateResponse | null;
  if (!response.ok || !payload?.payment?.order_id) {
    throw new ServiceError(502, "LOUVIN_CREATE_FAILED", "Failed to create payment transaction.");
  }

  return payload;
}

async function fetchPakasirTransactionDetail(input: { orderId: string; amount: number }) {
  const config = getLouvinConfig();
  const params = new URLSearchParams({ id: input.orderId });
  const response = await fetch(`${config.baseUrl}/check-status?${params.toString()}`, {
    method: "GET"
  });
  const payload = (await response.json().catch(() => null)) as LouvinDetailResponse | null;
  if (!response.ok || !payload?.transaction) {
    throw new ServiceError(502, "LOUVIN_DETAIL_FAILED", "Failed to verify payment transaction.");
  }

  return payload;
}

export async function getPublicInvoicePaymentOptions(publicToken: string) {
  const token = normalize(publicToken);
  if (!token) {
    throw new ServiceError(400, "INVALID_TOKEN", "token is required.");
  }

  const invoice = await prisma.invoice.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      orgId: true,
      invoiceNo: true,
      status: true,
      totalCents: true,
      currency: true,
      bankAccountsJson: true,
      org: {
        select: {
          walletBalanceCents: true,
          subscription: {
            select: {
              gatewayFeeBps: true,
              status: true
            }
          }
        }
      }
    }
  });

  if (!invoice) {
    throw new ServiceError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
  }

  const settings = await getOrgInvoicePaymentSettings(invoice.orgId);
  const qrisFeeBps = invoice.org.subscription?.gatewayFeeBps ?? DEFAULT_QRIS_FEE_BPS;
  const qrisFeeCents = calculateGatewayFeeCents(invoice.totalCents, qrisFeeBps);
  const bankAccounts = parseBankAccountsJson(invoice.bankAccountsJson);
  const primaryBankAccount = bankAccounts[0] ?? null;

  const vaOptions = settings.enabledVaMethods.map((method) => ({
    method,
    feeCents: resolveVaFeeCents(method),
    autoConfirm: true,
    disabled: settings.feePolicy === InvoiceGatewayFeePolicy.MERCHANT && invoice.org.walletBalanceCents < resolveVaFeeCents(method)
  }));

  const qrisOption = settings.enableQris
    ? {
        method: "qris" as const,
        feeCents: qrisFeeCents,
        autoConfirm: true,
        disabled: settings.feePolicy === InvoiceGatewayFeePolicy.MERCHANT && invoice.org.walletBalanceCents < qrisFeeCents
      }
    : null;

  return {
    invoice: {
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      status: invoice.status,
      totalCents: invoice.totalCents,
      currency: invoice.currency
    },
    settings,
    bankTransfer: {
      enabled: settings.enableBankTransfer && Boolean(primaryBankAccount),
      autoConfirm: false,
      bankName: primaryBankAccount?.bankName ?? null,
      accountNumber: primaryBankAccount?.accountNumber ?? null,
      accountHolder: primaryBankAccount?.accountHolder ?? null
    },
    qris: qrisOption,
    va: vaOptions,
    autoConfirmLabel: settings.autoConfirmLabelEnabled
      ? "VA dan QRIS terkonfirmasi otomatis tanpa konfirmasi manual."
      : null
  };
}

export async function createPublicInvoicePaymentAttempt(input: {
  publicToken: string;
  method: string;
}) {
  const token = normalize(input.publicToken);
  const method = normalize(input.method).toLowerCase();
  if (!token || !method) {
    throw new ServiceError(400, "INVALID_INPUT", "token and method are required.");
  }

  const invoice = await prisma.invoice.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      orgId: true,
      invoiceNo: true,
      status: true,
      totalCents: true,
      bankAccountsJson: true,
      customerId: true,
      conversationId: true,
      org: {
        select: {
          walletBalanceCents: true,
          subscription: {
            select: {
              gatewayFeeBps: true,
              status: true
            }
          }
        }
      }
    }
  });

  if (!invoice) {
    throw new ServiceError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
  }
  if (invoice.status === InvoiceStatus.VOID || invoice.status === InvoiceStatus.PAID) {
    throw new ServiceError(400, "INVOICE_NOT_PAYABLE", "Invoice cannot be paid.");
  }

  const settings = await getOrgInvoicePaymentSettings(invoice.orgId);
  if (method === "bank_transfer") {
    if (!settings.enableBankTransfer) {
      throw new ServiceError(400, "PAYMENT_METHOD_DISABLED", "Bank transfer is disabled.");
    }
    const primaryBankAccount = parseBankAccountsJson(invoice.bankAccountsJson)[0] ?? null;
    if (!primaryBankAccount) {
      throw new ServiceError(
        400,
        "BANK_ACCOUNT_NOT_CONFIGURED",
        "Metode bank transfer belum bisa digunakan karena rekening tujuan belum dikonfigurasi."
      );
    }
    return {
      mode: "manual_bank_transfer" as const,
      invoiceId: invoice.id,
      paymentMethod: "bank_transfer",
      amountCents: invoice.totalCents,
      feeCents: 0,
      customerPayableCents: invoice.totalCents,
      expiresAt: null,
      paymentNumber: primaryBankAccount.accountNumber,
      paymentBankName: primaryBankAccount.bankName,
      paymentAccountHolder: primaryBankAccount.accountHolder,
      attemptId: null,
      orderId: null,
      autoConfirm: false
    };
  }

  const qrisFeeBps = invoice.org.subscription?.gatewayFeeBps ?? DEFAULT_QRIS_FEE_BPS;
  let feeCents = 0;
  if (method === "qris") {
    if (!settings.enableQris) {
      throw new ServiceError(400, "PAYMENT_METHOD_DISABLED", "QRIS is disabled.");
    }
    feeCents = calculateGatewayFeeCents(invoice.totalCents, qrisFeeBps);
  } else if (isInvoiceVaMethod(method)) {
    if (!settings.enabledVaMethods.includes(method)) {
      throw new ServiceError(400, "PAYMENT_METHOD_DISABLED", "Selected virtual account is disabled.");
    }
    feeCents = resolveVaFeeCents(method);
  } else {
    throw new ServiceError(400, "INVALID_PAYMENT_METHOD", "Unsupported payment method.");
  }

  if (settings.feePolicy === InvoiceGatewayFeePolicy.MERCHANT && invoice.org.walletBalanceCents < feeCents) {
    throw new ServiceError(400, "WALLET_BALANCE_INSUFFICIENT", "Saldo wallet tidak cukup untuk menanggung biaya metode ini.");
  }

  const customerPayableCents =
    settings.feePolicy === InvoiceGatewayFeePolicy.CUSTOMER ? invoice.totalCents + feeCents : invoice.totalCents;

  const orderId = `INVPAY-${invoice.id}-${Date.now()}`;
  const gatewayPayload = await createPakasirTransaction({
    orderId,
    amount: customerPayableCents,
    method
  });
  const normalizedPayment = normalizeGatewayPayment({
    payment: gatewayPayload.payment,
    fallbackMethod: method,
    trace: "public_invoice_payment_attempt"
  });

  const paymentNumber = normalizedPayment.paymentNumber ?? "";
  const expiredAt = normalizedPayment.expiredAt;

  const attempt = await prisma.$transaction(async (tx) => {
    await tx.invoicePaymentAttempt.updateMany({
      where: {
        orgId: invoice.orgId,
        invoiceId: invoice.id,
        status: InvoicePaymentAttemptStatus.PENDING
      },
      data: {
        status: InvoicePaymentAttemptStatus.SUPERSEDED
      }
    });

    return tx.invoicePaymentAttempt.create({
      data: {
        orgId: invoice.orgId,
        invoiceId: invoice.id,
        orderId,
        provider: "louvin",
        paymentMethod: normalizedPayment.paymentMethod,
        feePolicy: settings.feePolicy,
        invoiceAmountCents: invoice.totalCents,
        feeCents,
        customerPayableCents,
        paymentNumber,
        expiresAt: expiredAt,
        status: InvoicePaymentAttemptStatus.PENDING,
        gatewayRawJson: JSON.stringify({ create: gatewayPayload })
      },
      select: {
        id: true,
        orderId: true,
        paymentMethod: true,
        invoiceAmountCents: true,
        feeCents: true,
        customerPayableCents: true,
        paymentNumber: true,
        expiresAt: true,
        status: true,
        createdAt: true
      }
    });
  });

  return {
    mode: "gateway" as const,
    attemptId: attempt.id,
    invoiceId: invoice.id,
    orderId: attempt.orderId,
    paymentMethod: attempt.paymentMethod,
    amountCents: attempt.invoiceAmountCents,
    feeCents: attempt.feeCents,
    customerPayableCents: attempt.customerPayableCents,
    paymentNumber: attempt.paymentNumber,
    paymentBankName: null,
    paymentAccountHolder: null,
    expiresAt: attempt.expiresAt,
    status: attempt.status,
    autoConfirm: true,
    feePolicy: settings.feePolicy
  };
}

function isCompletedStatus(status: string | undefined): boolean {
  return normalize(status).toLowerCase() === "settled";
}

export async function processInvoicePakasirWebhook(payload: {
  order_id?: unknown;
  amount?: unknown;
  status?: unknown;
}) {
  const orderId = typeof payload.order_id === "string" ? payload.order_id.trim() : "";
  const incomingAmount = toWholeNumber(payload.amount);
  const incomingStatus = typeof payload.status === "string" ? payload.status : "";

  if (!orderId || !incomingAmount || !incomingStatus) {
    throw new ServiceError(400, "INVALID_WEBHOOK_PAYLOAD", "Invalid Louvin webhook payload for invoice.");
  }

  const replayLockKey = `idmp:louvin:webhook:invoice:${orderId}:${incomingStatus}:${incomingAmount}`;
  const lockAcquired = await acquireIdempotencyLock(replayLockKey, 60 * 60 * 24);
  if (!lockAcquired) {
    return { skipped: true, reason: "replay" as const };
  }

  const attempt = await prisma.invoicePaymentAttempt.findUnique({
    where: { orderId },
    select: {
      id: true,
      orgId: true,
      invoiceId: true,
      orderId: true,
      paymentMethod: true,
      feePolicy: true,
      feeCents: true,
      customerPayableCents: true,
      status: true,
      invoice: {
        select: {
          id: true,
          status: true,
          conversationId: true,
          milestones: {
            select: {
              id: true,
              status: true
            }
          }
        }
      }
    }
  });

  if (!attempt) {
    throw new ServiceError(404, "INVOICE_ATTEMPT_NOT_FOUND", "Invoice payment attempt not found.");
  }

  if (!isCompletedStatus(incomingStatus)) {
    void processAiAutomationTrigger({
      trigger: "INVOICE_UNPAID",
      orgId: attempt.orgId,
      invoiceId: attempt.invoiceId,
      conversationId: attempt.invoice.conversationId ?? undefined,
      invoiceStatus: attempt.invoice.status
    }).catch(() => undefined);

    return {
      skipped: true,
      reason: "unpaid_status" as const
    };
  }

  if (attempt.status === InvoicePaymentAttemptStatus.PAID) {
    return { skipped: true, reason: "already_paid" as const };
  }

  const detail = await fetchPakasirTransactionDetail({
    orderId,
    amount: incomingAmount
  });
  const transaction = detail.transaction;
  const verifiedPaid = isCompletedStatus(transaction?.status);
  const verifiedAmount = toWholeNumber(transaction?.amount);

  if (!verifiedPaid || verifiedAmount !== attempt.customerPayableCents) {
    throw new ServiceError(400, "INVOICE_WEBHOOK_VERIFY_FAILED", "Webhook verification failed for invoice payment.");
  }

  const paidAt = transaction?.updated_at ? new Date(transaction.updated_at) : new Date();

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const latestAttempt = await tx.invoicePaymentAttempt.findUnique({
      where: { orderId: attempt.orderId },
      select: {
        id: true,
        status: true,
        orgId: true,
        invoiceId: true,
        feePolicy: true,
        feeCents: true,
        paymentMethod: true,
        customerPayableCents: true,
        invoice: {
          select: {
            id: true,
            status: true,
            conversationId: true,
            milestones: {
              select: {
                id: true,
                status: true
              }
            }
          }
        }
      }
    });

    if (!latestAttempt) {
      throw new ServiceError(404, "INVOICE_ATTEMPT_NOT_FOUND", "Invoice payment attempt not found.");
    }
    if (latestAttempt.status === InvoicePaymentAttemptStatus.PAID) {
      return {
        invoiceId: latestAttempt.invoiceId,
        orgId: latestAttempt.orgId,
        invoiceStatus: latestAttempt.invoice.status,
        conversationId: latestAttempt.invoice.conversationId,
        alreadyPaid: true
      };
    }

    await tx.invoicePaymentAttempt.update({
      where: { orderId: attempt.orderId },
      data: {
        status: InvoicePaymentAttemptStatus.PAID,
        paidAt,
        gatewayRawJson: JSON.stringify({ detail })
      }
    });

    await tx.paymentMilestone.updateMany({
      where: {
        orgId: latestAttempt.orgId,
        invoiceId: latestAttempt.invoiceId,
        status: "PENDING"
      },
      data: {
        status: "PAID",
        paidAt
      }
    });

    const invoiceStatus = InvoiceStatus.PAID;
    await tx.invoice.update({
      where: { id: latestAttempt.invoiceId },
      data: {
        status: invoiceStatus
      }
    });

    if (latestAttempt.feePolicy === InvoiceGatewayFeePolicy.MERCHANT && latestAttempt.feeCents > 0) {
      const org = await tx.org.findUnique({
        where: { id: latestAttempt.orgId },
        select: { walletBalanceCents: true }
      });
      if (!org) {
        throw new ServiceError(404, "ORG_NOT_FOUND", "Organization not found.");
      }

      const nextBalance = Math.max(0, org.walletBalanceCents - latestAttempt.feeCents);
      await tx.org.update({
        where: { id: latestAttempt.orgId },
        data: { walletBalanceCents: nextBalance }
      });
      await tx.orgWalletLedger.create({
        data: {
          orgId: latestAttempt.orgId,
          type: WalletLedgerType.INVOICE_FEE_DEBIT,
          direction: WalletLedgerDirection.DEBIT,
          amountCents: latestAttempt.feeCents,
          balanceAfterCents: nextBalance,
          referenceType: "invoice_payment_attempt",
          referenceId: latestAttempt.id,
          note: `Potongan fee ${latestAttempt.paymentMethod} untuk invoice`
        }
      });
    }

    return {
      invoiceId: latestAttempt.invoiceId,
      orgId: latestAttempt.orgId,
      invoiceStatus,
      conversationId: latestAttempt.invoice.conversationId,
      alreadyPaid: false
    };
  });

  if (!updated.alreadyPaid) {
    void publishInvoicePaidEvent({
      orgId: updated.orgId,
      invoiceId: updated.invoiceId,
      status: "PAID"
    });
    void publishInvoiceUpdatedEvent({
      orgId: updated.orgId,
      invoiceId: updated.invoiceId,
      status: updated.invoiceStatus
    });

    if (updated.conversationId) {
      void syncConversationCrmStageFromInvoice({
        orgId: updated.orgId,
        conversationId: updated.conversationId,
        target: "INVOICE_PAID"
      }).catch(() => undefined);
    }
  }

  await writeAuditLogSafe({
    orgId: updated.orgId,
    actorUserId: "system:louvin-webhook",
    action: "invoice.gateway_paid",
    entityType: "invoice",
    entityId: updated.invoiceId,
    meta: {
      orderId,
      amount: incomingAmount,
      paymentStatus: incomingStatus
    }
  });

  return {
    processed: true,
    invoiceId: updated.invoiceId,
    orgId: updated.orgId,
    status: updated.invoiceStatus
  };
}

export async function createWalletTopup(input: {
  actorUserId: string;
  orgId?: string;
  amountCents: number;
  paymentMethod?: string;
}) {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, normalize(input.orgId));
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: input.actorUserId
      }
    },
    select: { role: true }
  });
  if (!membership || membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can top up wallet.");
  }

  const amountCents = Math.max(0, Math.round(input.amountCents));
  if (amountCents < 10_000) {
    throw new ServiceError(400, "INVALID_TOPUP_AMOUNT", "Minimal topup adalah Rp10.000.");
  }

  const paymentMethod = normalize(input.paymentMethod) || "qris";
  const orderId = `TOPUP-${orgId}-${Date.now()}`;
  const gatewayPayload = await createPakasirTransaction({
    orderId,
    amount: amountCents,
    method: paymentMethod
  });
  const normalizedPayment = normalizeGatewayPayment({
    payment: gatewayPayload.payment,
    fallbackMethod: paymentMethod,
    trace: "wallet_topup_checkout"
  });

  const created = await prisma.orgWalletTopup.create({
    data: {
      orgId,
      orderId,
      amountCents,
      feeCents: 0,
      customerPayableCents: amountCents,
      paymentMethod: normalizedPayment.paymentMethod,
      paymentNumber: normalizedPayment.paymentNumber,
      status: WalletTopupStatus.PENDING,
      expiresAt: normalizedPayment.expiredAt,
      gatewayRawJson: JSON.stringify({ create: gatewayPayload }),
      createdByUserId: input.actorUserId
    },
    select: {
      id: true,
      orderId: true,
      amountCents: true,
      customerPayableCents: true,
      paymentMethod: true,
      paymentNumber: true,
      status: true,
      expiresAt: true,
      createdAt: true
    }
  });

  return created;
}

export async function listWalletTopups(input: {
  actorUserId: string;
  orgId?: string;
}) {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, normalize(input.orgId));
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: input.actorUserId
      }
    },
    select: { role: true }
  });
  if (!membership || membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can view wallet topups.");
  }

  return prisma.orgWalletTopup.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
}

export async function createWithdrawRequest(input: {
  actorUserId: string;
  orgId?: string;
  amountCents: number;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  note?: string;
}) {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, normalize(input.orgId));
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: input.actorUserId
      }
    },
    select: { role: true }
  });
  if (!membership || membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can request withdraw.");
  }

  const amountCents = Math.max(0, Math.round(input.amountCents));
  if (amountCents < 10_000) {
    throw new ServiceError(400, "INVALID_WITHDRAW_AMOUNT", "Minimal withdraw adalah Rp10.000.");
  }

  return prisma.$transaction(async (tx) => {
    const org = await tx.org.findUnique({
      where: { id: orgId },
      select: { walletBalanceCents: true }
    });
    if (!org) {
      throw new ServiceError(404, "ORG_NOT_FOUND", "Organization not found.");
    }
    if (org.walletBalanceCents < amountCents) {
      throw new ServiceError(400, "WALLET_BALANCE_INSUFFICIENT", "Saldo wallet tidak cukup.");
    }

    const nextBalance = org.walletBalanceCents - amountCents;
    await tx.org.update({
      where: { id: orgId },
      data: { walletBalanceCents: nextBalance }
    });

    const request = await tx.orgWalletWithdrawRequest.create({
      data: {
        orgId,
        amountCents,
        bankName: normalize(input.bankName),
        accountNumber: normalize(input.accountNumber),
        accountHolder: normalize(input.accountHolder),
        note: normalize(input.note) || null,
        requestedByUserId: input.actorUserId
      }
    });

    await tx.orgWalletLedger.create({
      data: {
        orgId,
        type: WalletLedgerType.WITHDRAW_DEBIT,
        direction: WalletLedgerDirection.DEBIT,
        amountCents,
        balanceAfterCents: nextBalance,
        referenceType: "withdraw_request",
        referenceId: request.id,
        createdByUserId: input.actorUserId,
        note: "Potong saldo saat request withdraw"
      }
    });

    return request;
  });
}

export async function listWithdrawRequests(input: {
  actorUserId: string;
  orgId?: string;
}) {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, normalize(input.orgId));
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: input.actorUserId
      }
    },
    select: { role: true }
  });
  if (!membership || membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can view withdraw requests.");
  }

  return prisma.orgWalletWithdrawRequest.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
}

export async function processTopupPakasirWebhook(payload: {
  order_id?: unknown;
  amount?: unknown;
  status?: unknown;
}) {
  const orderId = typeof payload.order_id === "string" ? payload.order_id.trim() : "";
  const incomingAmount = toWholeNumber(payload.amount);
  const incomingStatus = typeof payload.status === "string" ? payload.status : "";

  if (!orderId || !incomingAmount || !incomingStatus) {
    throw new ServiceError(400, "INVALID_WEBHOOK_PAYLOAD", "Invalid Louvin webhook payload for topup.");
  }

  const replayLockKey = `idmp:louvin:webhook:topup:${orderId}:${incomingStatus}:${incomingAmount}`;
  const lockAcquired = await acquireIdempotencyLock(replayLockKey, 60 * 60 * 24);
  if (!lockAcquired) {
    return { skipped: true, reason: "replay" as const };
  }

  const topup = await prisma.orgWalletTopup.findUnique({
    where: { orderId },
    select: {
      id: true,
      orgId: true,
      orderId: true,
      amountCents: true,
      customerPayableCents: true,
      status: true
    }
  });

  if (!topup) {
    throw new ServiceError(404, "TOPUP_NOT_FOUND", "Wallet topup not found.");
  }

  if (topup.status === WalletTopupStatus.PAID) {
    return { skipped: true, reason: "already_paid" as const };
  }

  const detail = await fetchPakasirTransactionDetail({
    orderId,
    amount: incomingAmount
  });
  const transaction = detail.transaction;
  const verifiedPaid = isCompletedStatus(transaction?.status);
  const verifiedAmount = toWholeNumber(transaction?.amount);

  if (!verifiedPaid || verifiedAmount !== topup.customerPayableCents) {
    throw new ServiceError(400, "TOPUP_WEBHOOK_VERIFY_FAILED", "Webhook verification failed for topup.");
  }

  const paidAt = transaction?.updated_at ? new Date(transaction.updated_at) : new Date();
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.orgWalletTopup.findUnique({
      where: { orderId },
      select: {
        id: true,
        orgId: true,
        amountCents: true,
        status: true
      }
    });
    if (!current) {
      throw new ServiceError(404, "TOPUP_NOT_FOUND", "Wallet topup not found.");
    }
    if (current.status === WalletTopupStatus.PAID) {
      return {
        orgId: current.orgId,
        topupId: current.id,
        alreadyPaid: true
      };
    }

    await tx.orgWalletTopup.update({
      where: { orderId },
      data: {
        status: WalletTopupStatus.PAID,
        paidAt,
        gatewayRawJson: JSON.stringify({ detail })
      }
    });

    const org = await tx.org.findUnique({
      where: { id: current.orgId },
      select: { walletBalanceCents: true }
    });
    if (!org) {
      throw new ServiceError(404, "ORG_NOT_FOUND", "Organization not found.");
    }

    const nextBalance = org.walletBalanceCents + current.amountCents;
    await tx.org.update({
      where: { id: current.orgId },
      data: { walletBalanceCents: nextBalance }
    });

    await tx.orgWalletLedger.create({
      data: {
        orgId: current.orgId,
        type: WalletLedgerType.TOPUP_CREDIT,
        direction: WalletLedgerDirection.CREDIT,
        amountCents: current.amountCents,
        balanceAfterCents: nextBalance,
        referenceType: "wallet_topup",
        referenceId: current.id,
        note: "Topup wallet via Louvin"
      }
    });

    return {
      orgId: current.orgId,
      topupId: current.id,
      alreadyPaid: false
    };
  });

  return {
    processed: true,
    orgId: result.orgId,
    topupId: result.topupId,
    alreadyPaid: result.alreadyPaid
  };
}

export async function getOrgWalletSummary(input: {
  actorUserId: string;
  orgId?: string;
}) {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, normalize(input.orgId));
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: input.actorUserId
      }
    },
    select: { role: true }
  });
  if (!membership || membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can access wallet summary.");
  }

  const [org, recentLedger] = await Promise.all([
    prisma.org.findUnique({
      where: { id: orgId },
      select: { id: true, walletBalanceCents: true, name: true }
    }),
    prisma.orgWalletLedger.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 30
    })
  ]);

  if (!org) {
    throw new ServiceError(404, "ORG_NOT_FOUND", "Organization not found.");
  }

  return {
    orgId: org.id,
    orgName: org.name,
    walletBalanceCents: org.walletBalanceCents,
    ledgers: recentLedger
  };
}

export async function processWithdrawRequestAction(input: {
  actorUserId: string;
  requestId: string;
  action: "APPROVE" | "PAID" | "REJECT";
  note?: string;
}) {
  const membership = await prisma.platformMember.findUnique({
    where: { userId: input.actorUserId },
    select: { id: true }
  });
  if (!membership) {
    throw new ServiceError(403, "FORBIDDEN_SUPERADMIN_ONLY", "Only superadmin can process withdraw request.");
  }

  const requestId = normalize(input.requestId);
  if (!requestId) {
    throw new ServiceError(400, "INVALID_REQUEST_ID", "requestId is required.");
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.orgWalletWithdrawRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        orgId: true,
        amountCents: true,
        status: true
      }
    });
    if (!request) {
      throw new ServiceError(404, "WITHDRAW_REQUEST_NOT_FOUND", "Withdraw request not found.");
    }

    if (input.action === "APPROVE") {
      if (request.status !== "PENDING") {
        throw new ServiceError(400, "INVALID_WITHDRAW_STATUS", "Only pending request can be approved.");
      }
      return tx.orgWalletWithdrawRequest.update({
        where: { id: request.id },
        data: {
          status: "APPROVED",
          processedByUserId: input.actorUserId,
          processedAt: new Date(),
          processedNote: normalize(input.note) || null
        }
      });
    }

    if (input.action === "PAID") {
      if (request.status !== "APPROVED") {
        throw new ServiceError(400, "INVALID_WITHDRAW_STATUS", "Only approved request can be marked paid.");
      }
      return tx.orgWalletWithdrawRequest.update({
        where: { id: request.id },
        data: {
          status: "PAID",
          processedByUserId: input.actorUserId,
          processedAt: new Date(),
          processedNote: normalize(input.note) || null
        }
      });
    }

    if (request.status !== "PENDING" && request.status !== "APPROVED") {
      throw new ServiceError(400, "INVALID_WITHDRAW_STATUS", "Withdraw request cannot be rejected.");
    }

    const org = await tx.org.findUnique({
      where: { id: request.orgId },
      select: { walletBalanceCents: true }
    });
    if (!org) {
      throw new ServiceError(404, "ORG_NOT_FOUND", "Organization not found.");
    }

    const nextBalance = org.walletBalanceCents + request.amountCents;
    await tx.org.update({
      where: { id: request.orgId },
      data: { walletBalanceCents: nextBalance }
    });

    await tx.orgWalletLedger.create({
      data: {
        orgId: request.orgId,
        type: WalletLedgerType.WITHDRAW_REFUND,
        direction: WalletLedgerDirection.CREDIT,
        amountCents: request.amountCents,
        balanceAfterCents: nextBalance,
        referenceType: "withdraw_request",
        referenceId: request.id,
        createdByUserId: input.actorUserId,
        note: "Refund saldo karena withdraw ditolak"
      }
    });

    return tx.orgWalletWithdrawRequest.update({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        processedByUserId: input.actorUserId,
        processedAt: new Date(),
        processedNote: normalize(input.note) || null
      }
    });
  });
}

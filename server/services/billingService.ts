import { randomUUID } from "node:crypto";

import { BillingChargeStatus, Prisma, Role, SubscriptionStatus } from "@prisma/client";

import { getLouvinConfig } from "@/lib/env";
import { prisma } from "@/lib/db/prisma";
import { acquireIdempotencyLock } from "@/lib/redis/idempotency";
import { isLikelyQrisPayload } from "@/lib/payment/checkoutFallback";
import { normalizeCheckoutCouponCode, resolveCouponForCheckout, type ResolvedCheckoutCoupon } from "@/server/services/platformCouponService";
import { ServiceError } from "@/server/services/serviceError";

const TRIAL_DAYS = 14;
const DEFAULT_GRACE_DAYS = 3;
const RENEWAL_DAYS = 28;
const DEFAULT_BASE_AMOUNT_CENTS = 99_000;
const DEFAULT_GATEWAY_FEE_BPS = 200;
const DEFAULT_CURRENCY = "IDR";
const WEBHOOK_ACTOR_USER_ID = "system:louvin-webhook";
const BUSINESS_PROVISIONING_ORDER_PREFIX = "BIZ";
let lastProvisioningOrderTs = 0;
let lastProvisioningOrderSeq = 0;
const BILLING_PLAN_SCHEMES = [
  { months: 1, label: "Bulanan", discountBps: 0 },
  { months: 3, label: "3 Bulan", discountBps: 1_000 },
  { months: 12, label: "1 Tahun", discountBps: 2_000 }
] as const;
const DEFAULT_BILLING_PLAN_MONTHS = 1 as const;

type BillingPlanMonths = (typeof BILLING_PLAN_SCHEMES)[number]["months"];

type OwnerBusinessProvisioningOrderView = {
  id: string;
  orderId: string;
  businessName: string;
  status: BillingChargeStatus;
  requestedAmountCents: number;
  providerFeeCents: number | null;
  payableAmountCents: number;
  paymentMethod: string;
  paymentNumber: string | null;
  expiredAt: Date | null;
  paidAt: Date | null;
  createdOrg: {
    id: string;
    name: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BillingPlanPricing = {
  months: BillingPlanMonths;
  label: string;
  discountBps: number;
  rawBaseAmountCents: number;
  discountCents: number;
  netBaseAmountCents: number;
  gatewayFeeCents: number;
  totalAmountCents: number;
  renewalDays: number;
};

async function writeWebhookAuditLog(input: {
  action:
    | "louvin.webhook.received"
    | "louvin.webhook.replay_skipped"
    | "louvin.webhook.charge_not_found"
    | "louvin.webhook.already_paid"
    | "louvin.webhook.verification_failed"
    | "louvin.webhook.completed";
  orderId: string;
  meta: Record<string, unknown>;
}) {
  try {
    await prisma.platformAuditLog.create({
      data: {
        actorUserId: WEBHOOK_ACTOR_USER_ID,
        action: input.action,
        targetType: "billing_webhook",
        targetId: input.orderId,
        metaJson: JSON.stringify(input.meta)
      }
    });
  } catch {
    // best-effort observability, never block billing flow
  }
}

type PakasirCreateResponse = {
  message?: string;
  status?: string | boolean;
  error?: string;
  success?: boolean;
  transaction?: {
    id?: string;
    amount?: number;
    fee?: number;
    net_amount?: number;
    reference?: string;
    status?: string;
    updated_at?: string;
  };
  payment?: {
    order_id?: string;
    amount?: number;
    fee?: number;
    total_payment?: number;
    payment_number?: string;
    payment_method?: string;
    expired_at?: string;
    qr_string?: string;
  };
};

type PakasirPaymentPayload = {
  amount?: unknown;
  fee?: unknown;
  total_payment?: unknown;
};

type PakasirDetailResponse = {
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

function normalize(value: string): string {
  return value.trim();
}

function normalizePaymentMethod(value: string | undefined, fallback: string): string {
  const normalized = normalize(value ?? "").toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (!/^[a-z0-9_]{2,32}$/.test(normalized)) {
    return fallback;
  }

  return normalized;
}

function toSafeAuditMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 240) : null;
}

function parseJsonSafely(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export type NormalizedGatewayPayment = {
  paymentNumber: string | null;
  paymentMethod: string;
  expiredAt: Date | null;
  rawExpiredAt: string | null;
};

export function normalizeLouvinCreatePayment(input: {
  payment: PakasirCreateResponse["payment"] | null | undefined;
  fallbackMethod: string;
  trace: string;
}): NormalizedGatewayPayment {
  const payment = input.payment ?? {};
  const paymentNumber = ((payment.payment_number ?? "").trim() || (payment.qr_string ?? "").trim()) || null;
  const paymentMethod = (payment.payment_method ?? "").trim().toLowerCase() || input.fallbackMethod;
  const rawExpiredAt = payment.expired_at?.trim() || null;
  const expiredAt = rawExpiredAt ? new Date(rawExpiredAt) : null;
  const validExpiredAt = expiredAt && !Number.isNaN(expiredAt.getTime()) ? expiredAt : null;

  if (!payment.payment_method || (!payment.payment_number && payment.qr_string)) {
    // observability non-fatal for gateway payload inconsistencies
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "louvin.checkout_payload_fallback",
        trace: input.trace,
        usedFallbackMethod: !payment.payment_method,
        usedFallbackPaymentNumber: !payment.payment_number && Boolean(payment.qr_string),
        inferredQrisPayload: isLikelyQrisPayload(paymentNumber)
      })
    );
  }

  return {
    paymentNumber,
    paymentMethod,
    expiredAt: validExpiredAt,
    rawExpiredAt
  };
}

export function resolvePakasirCreateFailureMessage(input: {
  status: number;
  payload: Record<string, unknown> | null;
  rawBody: string;
}): string {
  const payload = input.payload;
  const candidates = [
    toSafeAuditMessage(payload?.message),
    toSafeAuditMessage(payload?.error),
    toSafeAuditMessage(payload?.status),
    toSafeAuditMessage(input.rawBody)
  ].filter(Boolean) as string[];

  const gatewayReason = candidates[0] ?? null;
  if (!gatewayReason) {
    return "Failed to create payment transaction.";
  }

  return `Failed to create payment transaction: ${gatewayReason}`;
}

function toPositiveWholeNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return Math.round(numeric);
}

function resolveBillingPlanMonths(value: unknown): BillingPlanMonths {
  const parsed = toPositiveWholeNumber(value);
  const matched = BILLING_PLAN_SCHEMES.find((plan) => plan.months === parsed);
  return matched?.months ?? DEFAULT_BILLING_PLAN_MONTHS;
}

function getBillingPlanScheme(planMonths: BillingPlanMonths) {
  return BILLING_PLAN_SCHEMES.find((plan) => plan.months === planMonths) ?? BILLING_PLAN_SCHEMES[0];
}

export function calculateBillingPlanPricing(input: {
  baseAmountCents: number;
  gatewayFeeBps: number;
  planMonths: BillingPlanMonths;
}): BillingPlanPricing {
  const plan = getBillingPlanScheme(input.planMonths);
  const normalizedBaseAmountCents = Math.max(0, Math.round(input.baseAmountCents));
  const rawBaseAmountCents = normalizedBaseAmountCents * plan.months;
  const discountCents = Math.floor((rawBaseAmountCents * plan.discountBps) / 10_000);
  const netBaseAmountCents = Math.max(0, rawBaseAmountCents - discountCents);
  const gatewayFeeCents = calculateGatewayFeeCents(netBaseAmountCents, input.gatewayFeeBps);
  const totalAmountCents = netBaseAmountCents + gatewayFeeCents;

  return {
    months: plan.months,
    label: plan.label,
    discountBps: plan.discountBps,
    rawBaseAmountCents,
    discountCents,
    netBaseAmountCents,
    gatewayFeeCents,
    totalAmountCents,
    renewalDays: RENEWAL_DAYS * plan.months
  };
}

function parseGatewayRawAsRecord(gatewayRawJson: string | null): Record<string, unknown> | null {
  if (!gatewayRawJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(gatewayRawJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractNestedObjectField(
  node: unknown,
  field: "payment" | "checkoutMeta",
  depth = 0
): Record<string, unknown> | null {
  if (!node || typeof node !== "object" || depth > 5) {
    return null;
  }

  const record = node as Record<string, unknown>;
  const directField = record[field];
  if (directField && typeof directField === "object") {
    return directField as Record<string, unknown>;
  }

  return extractNestedObjectField(record.create, field, depth + 1);
}

export function resolvePakasirPaymentSummary(input: {
  payment: PakasirPaymentPayload | null | undefined;
  fallbackRequestedAmountCents: number;
}): {
  requestedAmountCents: number;
  providerFeeCents: number | null;
  payableAmountCents: number;
} {
  const requestedAmountCents = toPositiveWholeNumber(input.payment?.amount) ?? Math.max(0, Math.round(input.fallbackRequestedAmountCents));
  const directProviderFeeCents = toPositiveWholeNumber(input.payment?.fee);
  const gatewayTotalPaymentCents = toPositiveWholeNumber(input.payment?.total_payment);
  const inferredProviderFeeCents =
    gatewayTotalPaymentCents !== null && gatewayTotalPaymentCents > requestedAmountCents
      ? gatewayTotalPaymentCents - requestedAmountCents
      : null;
  const providerFeeCents = directProviderFeeCents ?? inferredProviderFeeCents;
  const payableAmountCents = requestedAmountCents;

  return {
    requestedAmountCents,
    providerFeeCents,
    payableAmountCents
  };
}

function parsePakasirPaymentFromGatewayRaw(gatewayRawJson: string | null): PakasirPaymentPayload | null {
  const parsed = parseGatewayRawAsRecord(gatewayRawJson);
  if (!parsed) {
    return null;
  }

  const payment = extractNestedObjectField(parsed, "payment");
  if (!payment) {
    return null;
  }

  return payment as PakasirPaymentPayload;
}

function resolveRenewalDaysFromCharge(gatewayRawJson: string | null): number {
  const parsed = parseGatewayRawAsRecord(gatewayRawJson);
  if (!parsed) {
    return RENEWAL_DAYS;
  }

  const checkoutMeta = extractNestedObjectField(parsed, "checkoutMeta");
  if (!checkoutMeta) {
    return RENEWAL_DAYS;
  }

  const planMonths = resolveBillingPlanMonths(checkoutMeta.planMonths);
  const explicitRenewalDays = toPositiveWholeNumber(checkoutMeta.renewalDays);
  if (explicitRenewalDays !== null && explicitRenewalDays > 0) {
    return explicitRenewalDays;
  }

  return RENEWAL_DAYS * planMonths;
}

export function calculateGatewayFeeCents(baseAmountCents: number, feeBps = DEFAULT_GATEWAY_FEE_BPS): number {
  return Math.ceil((baseAmountCents * feeBps) / 10_000);
}

export function calculateTotalChargeCents(baseAmountCents: number, feeBps = DEFAULT_GATEWAY_FEE_BPS): number {
  return baseAmountCents + calculateGatewayFeeCents(baseAmountCents, feeBps);
}

async function reserveCouponRedemption(input: {
  tx: Prisma.TransactionClient;
  coupon: ResolvedCheckoutCoupon;
  target: "BILLING" | "BUSINESS_PROVISIONING";
  orgId?: string;
  userId?: string;
  billingChargeId?: string;
  provisioningOrderId?: string;
}) {
  if (input.coupon.maxRedemptions !== null) {
    const updateCount = await input.tx.platformCoupon.updateMany({
      where: {
        id: input.coupon.couponId,
        redeemedCount: {
          lt: input.coupon.maxRedemptions
        }
      },
      data: {
        redeemedCount: {
          increment: 1
        }
      }
    });

    if (updateCount.count === 0) {
      throw new ServiceError(400, "COUPON_USAGE_LIMIT_REACHED", "Kupon sudah mencapai batas penggunaan.");
    }
  } else {
    await input.tx.platformCoupon.update({
      where: { id: input.coupon.couponId },
      data: {
        redeemedCount: {
          increment: 1
        }
      }
    });
  }

  await input.tx.platformCouponRedemption.create({
    data: {
      couponId: input.coupon.couponId,
      couponCode: input.coupon.code,
      targetType: input.target,
      orgId: input.orgId,
      userId: input.userId,
      billingChargeId: input.billingChargeId,
      provisioningOrderId: input.provisioningOrderId,
      subtotalCents: input.coupon.subtotalCents,
      discountCents: input.coupon.discountCents,
      finalAmountCents: input.coupon.finalAmountCents
    }
  });
}

function addDays(source: Date, days: number): Date {
  return new Date(source.getTime() + days * 24 * 60 * 60 * 1000);
}

export type SubscriptionAccessState = {
  status: SubscriptionStatus;
  trialEndAt: Date;
  graceEndAt: Date;
  currentPeriodEndAt: Date | null;
  isLocked: boolean;
};

export type SubscriptionReminderState = {
  shouldShowBanner: boolean;
  shouldBroadcastWhatsapp: boolean;
  dueAt: Date | null;
  daysRemaining: number | null;
  message: string;
};

export function computeSubscriptionAccessState(input: {
  status: SubscriptionStatus;
  trialEndAt: Date;
  graceDays: number;
  currentPeriodEndAt: Date | null;
  now?: Date;
}): SubscriptionAccessState {
  const now = input.now ?? new Date();
  const graceEndAt = addDays(input.trialEndAt, input.graceDays);
  const activePeriod = input.currentPeriodEndAt ? input.currentPeriodEndAt.getTime() > now.getTime() : false;

  let isLocked = false;
  if (input.status === SubscriptionStatus.CANCELED) {
    isLocked = true;
  } else if (input.status === SubscriptionStatus.ACTIVE) {
    isLocked = !activePeriod;
  } else if (input.status === SubscriptionStatus.TRIALING) {
    isLocked = now.getTime() > graceEndAt.getTime();
  } else if (input.status === SubscriptionStatus.PAST_DUE) {
    isLocked = true;
  }

  return {
    status: input.status,
    trialEndAt: input.trialEndAt,
    graceEndAt,
    currentPeriodEndAt: input.currentPeriodEndAt,
    isLocked
  };
}

async function getOrgSubscriptionOrThrow(orgId: string) {
  const subscription = await prisma.orgSubscription.findUnique({
    where: { orgId }
  });

  if (!subscription) {
    throw new ServiceError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription is not configured for this organization.");
  }

  return subscription;
}

async function requireOrgMembership(userId: string, orgId: string) {
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId
      }
    },
    select: {
      role: true
    }
  });

  if (!membership) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }

  return membership;
}

async function requireOrgOwner(userId: string, orgId: string) {
  const membership = await requireOrgMembership(userId, orgId);
  if (membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can access billing management.");
  }
}

async function requireAnyOwnedOrganization(userId: string): Promise<{ orgId: string }> {
  const membership = await prisma.orgMember.findFirst({
    where: {
      userId,
      role: Role.OWNER
    },
    select: {
      orgId: true
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  if (!membership) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can create new business.");
  }

  return membership;
}

function resolveSubscriptionDueAt(input: {
  status: SubscriptionStatus;
  trialEndAt: Date;
  currentPeriodEndAt: Date | null;
}): Date | null {
  if (input.status === SubscriptionStatus.ACTIVE) {
    return input.currentPeriodEndAt;
  }

  if (input.status === SubscriptionStatus.TRIALING) {
    return input.trialEndAt;
  }

  return input.currentPeriodEndAt ?? input.trialEndAt;
}

export function computeSubscriptionReminderState(input: {
  membershipRole: Role;
  status: SubscriptionStatus;
  trialEndAt: Date;
  currentPeriodEndAt: Date | null;
  now?: Date;
}): SubscriptionReminderState {
  const now = input.now ?? new Date();
  const isOwner = input.membershipRole === Role.OWNER;

  if (input.status !== SubscriptionStatus.TRIALING) {
    return {
      shouldShowBanner: false,
      shouldBroadcastWhatsapp: false,
      dueAt: null,
      daysRemaining: null,
      message: ""
    };
  }

  const dueAt = resolveSubscriptionDueAt({
    status: input.status,
    trialEndAt: input.trialEndAt,
    currentPeriodEndAt: input.currentPeriodEndAt
  });

  if (!dueAt) {
    return {
      shouldShowBanner: false,
      shouldBroadcastWhatsapp: false,
      dueAt: null,
      daysRemaining: null,
      message: ""
    };
  }

  const remainingMs = dueAt.getTime() - now.getTime();
  const remainingDaysFloat = remainingMs / (24 * 60 * 60 * 1000);
  const daysRemaining = remainingDaysFloat >= 0 ? Math.ceil(remainingDaysFloat) : null;
  const isWithinTrialReminderWindow = daysRemaining !== null && daysRemaining <= 3;

  if (!isWithinTrialReminderWindow) {
    return {
      shouldShowBanner: false,
      shouldBroadcastWhatsapp: false,
      dueAt,
      daysRemaining,
      message: ""
    };
  }

  const dueDateLabel = dueAt.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const urgencyLabel = daysRemaining === 0 ? "hari ini" : `${daysRemaining} hari lagi`;
  const message = isOwner
    ? `Suka platform kami? Trial berakhir ${dueDateLabel} (${urgencyLabel}). Berlangganan sekarang agar operasional tim tetap lancar tanpa jeda.`
    : `Trial bisnis berakhir ${dueDateLabel} (${urgencyLabel}). Mohon hubungi owner untuk melanjutkan langganan.`;

  return {
    shouldShowBanner: true,
    shouldBroadcastWhatsapp: isOwner,
    dueAt,
    daysRemaining,
    message
  };
}

export async function ensureBillingRecordForOrg(orgId: string, startsAt = new Date()) {
  const normalizedOrgId = normalize(orgId);
  if (!normalizedOrgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const trialStartAt = startsAt;
  const trialEndAt = addDays(startsAt, TRIAL_DAYS);

  return prisma.orgSubscription.upsert({
    where: { orgId: normalizedOrgId },
    create: {
      orgId: normalizedOrgId,
      status: SubscriptionStatus.TRIALING,
      trialStartAt,
      trialEndAt,
      graceDays: DEFAULT_GRACE_DAYS,
      baseAmountCents: DEFAULT_BASE_AMOUNT_CENTS,
      gatewayFeeBps: DEFAULT_GATEWAY_FEE_BPS,
      currency: DEFAULT_CURRENCY
    },
    update: {}
  });
}

export async function getOrgSubscriptionView(actorUserId: string, orgIdInput: string) {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const membership = await requireOrgMembership(actorUserId, orgId);
  const subscription = await getOrgSubscriptionOrThrow(orgId);
  const state = computeSubscriptionAccessState({
    status: subscription.status,
    trialEndAt: subscription.trialEndAt,
    graceDays: subscription.graceDays,
    currentPeriodEndAt: subscription.currentPeriodEndAt
  });
  const reminder = computeSubscriptionReminderState({
    membershipRole: membership.role,
    status: subscription.status,
    trialEndAt: subscription.trialEndAt,
    currentPeriodEndAt: subscription.currentPeriodEndAt
  });
  const plans = BILLING_PLAN_SCHEMES.map((plan) =>
    calculateBillingPlanPricing({
      baseAmountCents: subscription.baseAmountCents,
      gatewayFeeBps: subscription.gatewayFeeBps,
      planMonths: plan.months
    })
  );
  const defaultPlan = plans.find((plan) => plan.months === DEFAULT_BILLING_PLAN_MONTHS) ?? plans[0];

  return {
    subscription,
    state,
    reminder,
    pricing: {
      baseAmountCents: defaultPlan.netBaseAmountCents,
      gatewayFeeCents: defaultPlan.gatewayFeeCents,
      totalAmountCents: defaultPlan.totalAmountCents,
      renewalDays: defaultPlan.renewalDays,
      currency: subscription.currency,
      defaultPlanMonths: DEFAULT_BILLING_PLAN_MONTHS,
      plans
    }
  };
}

export async function assertOrgBillingAccess(orgIdInput: string, mode: "read" | "write" = "write"): Promise<void> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const subscription = await getOrgSubscriptionOrThrow(orgId);
  const state = computeSubscriptionAccessState({
    status: subscription.status,
    trialEndAt: subscription.trialEndAt,
    graceDays: subscription.graceDays,
    currentPeriodEndAt: subscription.currentPeriodEndAt
  });

  if (!state.isLocked) {
    return;
  }

  if (mode === "read") {
    return;
  }

  throw new ServiceError(402, "BILLING_LOCKED", "Organization access is locked due to subscription status.");
}

export async function listOrgBillingCharges(actorUserId: string, orgIdInput: string) {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  await requireOrgOwner(actorUserId, orgId);
  const charges = await prisma.billingCharge.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  return charges.map((charge) => {
    const summary = resolvePakasirPaymentSummary({
      payment: parsePakasirPaymentFromGatewayRaw(charge.gatewayRawJson),
      fallbackRequestedAmountCents: charge.totalAmountCents
    });

    return {
      ...charge,
      requestedAmountCents: summary.requestedAmountCents,
      providerFeeCents: summary.providerFeeCents,
      payableAmountCents: summary.payableAmountCents
    };
  });
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
      reference: input.orderId,
      amount: input.amount,
      payment_type: input.method
    })
  });

  const rawBody = await response.text();
  const parsedPayload = parseJsonSafely(rawBody);
  const payload = (parsedPayload as PakasirCreateResponse | null) ?? null;
  if (!response.ok || !payload?.payment?.order_id) {
    const message = resolvePakasirCreateFailureMessage({
      status: response.status,
      payload: parsedPayload,
      rawBody
    });
    const error = new ServiceError(502, "LOUVIN_CREATE_FAILED", message) as ServiceError & {
      metaJson?: Record<string, unknown>;
    };
    error.metaJson = {
      status: response.status,
      method: input.method,
      orderId: input.orderId,
      amount: input.amount,
      gatewayMessage: toSafeAuditMessage(parsedPayload?.message) ?? toSafeAuditMessage(parsedPayload?.error),
      gatewayStatus: toSafeAuditMessage(parsedPayload?.status),
      rawBody: toSafeAuditMessage(rawBody)
    };
    throw error;
  }

  return payload;
}

export async function createBillingCheckout(input: {
  actorUserId: string;
  orgId: string;
  paymentMethod?: string;
  planMonths?: unknown;
  couponCode?: string | null;
}) {
  const orgId = normalize(input.orgId);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  await requireOrgOwner(input.actorUserId, orgId);
  const subscription = await getOrgSubscriptionOrThrow(orgId);
  const config = getLouvinConfig();
  const paymentMethod = normalizePaymentMethod(input.paymentMethod, config.defaultMethod);
  const planMonths = resolveBillingPlanMonths(input.planMonths);
  const selectedPlan = calculateBillingPlanPricing({
    baseAmountCents: subscription.baseAmountCents,
    gatewayFeeBps: subscription.gatewayFeeBps,
    planMonths
  });
  const couponCode = normalizeCheckoutCouponCode(input.couponCode);
  const appliedCoupon = couponCode
    ? await resolveCouponForCheckout({
        couponCode,
        target: "BILLING",
        subtotalCents: selectedPlan.totalAmountCents
      })
    : null;
  const baseAmountCents = selectedPlan.netBaseAmountCents;
  const gatewayFeeCents = selectedPlan.gatewayFeeCents;
  const totalAmountCents = appliedCoupon?.finalAmountCents ?? selectedPlan.totalAmountCents;
  const orderId = `SUB-${orgId}-${Date.now()}`;

  const gatewayPayload = await createPakasirTransaction({
    orderId,
    amount: totalAmountCents,
    method: paymentMethod
  });
  const normalizedPayment = normalizeLouvinCreatePayment({
    payment: gatewayPayload.payment,
    fallbackMethod: paymentMethod,
    trace: "billing_checkout"
  });
  const paymentSummary = resolvePakasirPaymentSummary({
    payment: gatewayPayload.payment ?? null,
    fallbackRequestedAmountCents: totalAmountCents
  });

  const charge = await prisma.$transaction(async (tx) => {
    const createdCharge = await tx.billingCharge.create({
      data: {
        orgId,
        orderId,
        status: BillingChargeStatus.PENDING,
        baseAmountCents,
        gatewayFeeCents,
        totalAmountCents,
        paymentMethod: normalizedPayment.paymentMethod,
        gatewayProvider: "louvin",
        gatewayProjectSlug: "louvin",
        gatewayRawJson: JSON.stringify({
          create: gatewayPayload,
          checkoutMeta: {
            planMonths: selectedPlan.months,
            renewalDays: selectedPlan.renewalDays,
            discountBps: selectedPlan.discountBps,
            rawBaseAmountCents: selectedPlan.rawBaseAmountCents,
            discountCents: selectedPlan.discountCents,
            netBaseAmountCents: selectedPlan.netBaseAmountCents,
            gatewayFeeCents: selectedPlan.gatewayFeeCents,
            totalAmountCents: selectedPlan.totalAmountCents,
            couponCode: appliedCoupon?.code ?? null,
            couponDiscountCents: appliedCoupon?.discountCents ?? 0,
            finalAmountCents: totalAmountCents
          }
        }),
        paymentNumber: normalizedPayment.paymentNumber,
        expiredAt: normalizedPayment.expiredAt,
        createdByUserId: input.actorUserId,
        appliedCouponCode: appliedCoupon?.code ?? null,
        couponDiscountCents: appliedCoupon?.discountCents ?? 0,
        couponSnapshotJson: appliedCoupon
          ? JSON.stringify({
              code: appliedCoupon.code,
              name: appliedCoupon.name,
              target: appliedCoupon.target,
              discountType: appliedCoupon.discountType,
              discountValue: appliedCoupon.discountValue,
              maxDiscountCents: appliedCoupon.maxDiscountCents,
              subtotalCents: appliedCoupon.subtotalCents,
              discountCents: appliedCoupon.discountCents,
              finalAmountCents: appliedCoupon.finalAmountCents
            })
          : null
      }
    });

    if (appliedCoupon) {
      await reserveCouponRedemption({
        tx,
        coupon: appliedCoupon,
        target: "BILLING",
        orgId,
        userId: input.actorUserId,
        billingChargeId: createdCharge.id
      });
    }

    return createdCharge;
  });

  return {
    charge,
    payment: {
      ...(gatewayPayload.payment ?? {}),
      payment_number: normalizedPayment.paymentNumber ?? undefined,
      payment_method: normalizedPayment.paymentMethod,
      expired_at: normalizedPayment.rawExpiredAt ?? undefined
    },
    paymentSummary,
    selectedPlan,
    appliedCoupon
  };
}

function parseProvisioningBusinessName(value: unknown): string {
  const businessName = typeof value === "string" ? value.trim() : "";
  if (businessName.length < 2 || businessName.length > 80) {
    throw new ServiceError(400, "INVALID_BUSINESS_NAME", "Business name must be between 2 and 80 characters.");
  }
  return businessName;
}

export function createBusinessProvisioningOrderId(
  userId: string,
  nowMs = Date.now(),
  forceDeterministic = false
): string {
  const suffix = userId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8) || "owner";
  const ts = Math.max(0, Math.floor(nowMs));
  if (ts === lastProvisioningOrderTs) {
    lastProvisioningOrderSeq = (lastProvisioningOrderSeq + 1) % (36 * 36);
  } else {
    lastProvisioningOrderTs = ts;
    lastProvisioningOrderSeq = 0;
  }

  const encodedTs = ts.toString(36).toUpperCase();
  const encodedSeq = lastProvisioningOrderSeq.toString(36).toUpperCase().padStart(2, "0");
  const shouldAppendEntropy = !forceDeterministic && arguments.length < 2;
  const entropy = shouldAppendEntropy ? randomUUID().replace(/-/g, "").slice(0, 2).toUpperCase() : "";
  return `${BUSINESS_PROVISIONING_ORDER_PREFIX}-${suffix}-${encodedTs}${encodedSeq}${entropy}`;
}

function mapProvisioningOrderView(order: {
  id: string;
  orderId: string;
  businessName: string;
  status: BillingChargeStatus;
  paymentMethod: string;
  paymentNumber: string | null;
  expiredAt: Date | null;
  paidAt: Date | null;
  gatewayRawJson: string | null;
  totalAmountCents: number;
  createdAt: Date;
  updatedAt: Date;
  createdOrg: { id: string; name: string } | null;
}): OwnerBusinessProvisioningOrderView {
  const paymentSummary = resolvePakasirPaymentSummary({
    payment: parsePakasirPaymentFromGatewayRaw(order.gatewayRawJson),
    fallbackRequestedAmountCents: order.totalAmountCents
  });

  return {
    id: order.id,
    orderId: order.orderId,
    businessName: order.businessName,
    status: order.status,
    requestedAmountCents: paymentSummary.requestedAmountCents,
    providerFeeCents: paymentSummary.providerFeeCents,
    payableAmountCents: paymentSummary.payableAmountCents,
    paymentMethod: order.paymentMethod,
    paymentNumber: order.paymentNumber,
    expiredAt: order.expiredAt,
    paidAt: order.paidAt,
    createdOrg: order.createdOrg,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

export async function createBusinessProvisioningCheckout(input: {
  actorUserId: string;
  businessName: unknown;
  paymentMethod?: string;
  planMonths?: unknown;
  couponCode?: string | null;
}) {
  await requireAnyOwnedOrganization(input.actorUserId);
  const businessName = parseProvisioningBusinessName(input.businessName);
  const config = getLouvinConfig();
  const paymentMethod = normalizePaymentMethod(input.paymentMethod, config.defaultMethod);
  const planMonths = resolveBillingPlanMonths(input.planMonths);
  const selectedPlan = calculateBillingPlanPricing({
    baseAmountCents: DEFAULT_BASE_AMOUNT_CENTS,
    gatewayFeeBps: DEFAULT_GATEWAY_FEE_BPS,
    planMonths
  });
  const couponCode = normalizeCheckoutCouponCode(input.couponCode);
  const appliedCoupon = couponCode
    ? await resolveCouponForCheckout({
        couponCode,
        target: "BUSINESS_PROVISIONING",
        subtotalCents: selectedPlan.totalAmountCents
      })
    : null;
  const finalTotalAmountCents = appliedCoupon?.finalAmountCents ?? selectedPlan.totalAmountCents;
  const orderId = createBusinessProvisioningOrderId(input.actorUserId);
  let gatewayPayload: PakasirCreateResponse;
  try {
    gatewayPayload = await createPakasirTransaction({
      orderId,
      amount: finalTotalAmountCents,
      method: paymentMethod
    });
  } catch (error) {
    try {
      await prisma.platformAuditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "louvin.provisioning.checkout_failed",
          targetType: "business_provisioning",
          targetId: orderId,
          metaJson: JSON.stringify({
            businessName,
            planMonths,
            paymentMethod,
            amount: finalTotalAmountCents,
            ...(error instanceof ServiceError && (error as ServiceError & { metaJson?: Record<string, unknown> }).metaJson
              ? (error as ServiceError & { metaJson?: Record<string, unknown> }).metaJson
              : {})
          })
        }
      });
    } catch {
      // best effort audit logging
    }
    throw error;
  }
  const normalizedPayment = normalizeLouvinCreatePayment({
    payment: gatewayPayload.payment,
    fallbackMethod: paymentMethod,
    trace: "business_provisioning_checkout"
  });
  const paymentSummary = resolvePakasirPaymentSummary({
    payment: gatewayPayload.payment ?? null,
    fallbackRequestedAmountCents: finalTotalAmountCents
  });

  const provisioningOrder = await prisma.$transaction(async (tx) => {
    const createdOrder = await tx.ownerBusinessProvisioningOrder.create({
      data: {
        userId: input.actorUserId,
        orderId,
        businessName,
        status: BillingChargeStatus.PENDING,
        baseAmountCents: selectedPlan.netBaseAmountCents,
        gatewayFeeCents: selectedPlan.gatewayFeeCents,
        totalAmountCents: finalTotalAmountCents,
        paymentMethod: normalizedPayment.paymentMethod,
        gatewayProvider: "louvin",
        gatewayProjectSlug: "louvin",
        gatewayRawJson: JSON.stringify({
          create: gatewayPayload,
          checkoutMeta: {
            planMonths: selectedPlan.months,
            renewalDays: selectedPlan.renewalDays,
            discountBps: selectedPlan.discountBps,
            rawBaseAmountCents: selectedPlan.rawBaseAmountCents,
            discountCents: selectedPlan.discountCents,
            netBaseAmountCents: selectedPlan.netBaseAmountCents,
            gatewayFeeCents: selectedPlan.gatewayFeeCents,
            totalAmountCents: selectedPlan.totalAmountCents,
            couponCode: appliedCoupon?.code ?? null,
            couponDiscountCents: appliedCoupon?.discountCents ?? 0,
            finalAmountCents: finalTotalAmountCents
          }
        }),
        paymentNumber: normalizedPayment.paymentNumber,
        expiredAt: normalizedPayment.expiredAt,
        appliedCouponCode: appliedCoupon?.code ?? null,
        couponDiscountCents: appliedCoupon?.discountCents ?? 0,
        couponSnapshotJson: appliedCoupon
          ? JSON.stringify({
              code: appliedCoupon.code,
              name: appliedCoupon.name,
              target: appliedCoupon.target,
              discountType: appliedCoupon.discountType,
              discountValue: appliedCoupon.discountValue,
              maxDiscountCents: appliedCoupon.maxDiscountCents,
              subtotalCents: appliedCoupon.subtotalCents,
              discountCents: appliedCoupon.discountCents,
              finalAmountCents: appliedCoupon.finalAmountCents
            })
          : null
      },
      include: {
        createdOrg: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (appliedCoupon) {
      await reserveCouponRedemption({
        tx,
        coupon: appliedCoupon,
        target: "BUSINESS_PROVISIONING",
        userId: input.actorUserId,
        provisioningOrderId: createdOrder.id
      });
    }

    return createdOrder;
  });

  return {
    order: mapProvisioningOrderView(provisioningOrder),
    payment: {
      ...(gatewayPayload.payment ?? {}),
      payment_number: normalizedPayment.paymentNumber ?? undefined,
      payment_method: normalizedPayment.paymentMethod,
      expired_at: normalizedPayment.rawExpiredAt ?? undefined
    },
    paymentSummary,
    selectedPlan,
    appliedCoupon
  };
}

export async function getBusinessProvisioningOrderView(input: {
  actorUserId: string;
  provisioningOrderId: string;
}): Promise<OwnerBusinessProvisioningOrderView> {
  const provisioningOrderId = normalize(input.provisioningOrderId);
  if (!provisioningOrderId) {
    throw new ServiceError(400, "INVALID_PROVISIONING_ORDER_ID", "Provisioning order id is required.");
  }

  const order = await prisma.ownerBusinessProvisioningOrder.findFirst({
    where: {
      id: provisioningOrderId,
      userId: input.actorUserId
    },
    include: {
      createdOrg: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  if (!order) {
    throw new ServiceError(404, "PROVISIONING_ORDER_NOT_FOUND", "Business provisioning order not found.");
  }

  return mapProvisioningOrderView(order);
}

async function fetchPakasirTransactionDetail(input: {
  orderId: string;
  amount: number;
}): Promise<PakasirDetailResponse> {
  const config = getLouvinConfig();
  const params = new URLSearchParams({ id: input.orderId });
  const response = await fetch(`${config.baseUrl}/check-status?${params.toString()}`, {
    method: "GET"
  });
  const payload = (await response.json().catch(() => null)) as PakasirDetailResponse | null;
  if (!response.ok || !payload?.transaction) {
    throw new ServiceError(502, "LOUVIN_DETAIL_FAILED", "Failed to verify payment transaction.");
  }

  return payload;
}

async function activateSubscriptionFromPaidCharge(orgId: string, paidAt: Date, renewalDays = RENEWAL_DAYS) {
  const periodStart = paidAt;
  const normalizedRenewalDays = Math.max(1, Math.floor(renewalDays));
  const periodEnd = addDays(periodStart, normalizedRenewalDays);

  await prisma.orgSubscription.update({
    where: { orgId },
    data: {
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStartAt: periodStart,
      currentPeriodEndAt: periodEnd,
      nextDueAt: periodEnd,
      lastPaidAt: paidAt
    }
  });
}

async function activateSubscriptionForProvisionedBusiness(input: {
  orgId: string;
  paidAt: Date;
  renewalDays: number;
}) {
  const periodStart = input.paidAt;
  const normalizedRenewalDays = Math.max(1, Math.floor(input.renewalDays));
  const periodEnd = addDays(periodStart, normalizedRenewalDays);

  await prisma.orgSubscription.upsert({
    where: {
      orgId: input.orgId
    },
    create: {
      orgId: input.orgId,
      status: SubscriptionStatus.ACTIVE,
      trialStartAt: periodStart,
      trialEndAt: periodStart,
      graceDays: DEFAULT_GRACE_DAYS,
      currentPeriodStartAt: periodStart,
      currentPeriodEndAt: periodEnd,
      nextDueAt: periodEnd,
      baseAmountCents: DEFAULT_BASE_AMOUNT_CENTS,
      gatewayFeeBps: DEFAULT_GATEWAY_FEE_BPS,
      currency: DEFAULT_CURRENCY,
      lastPaidAt: periodStart
    },
    update: {
      status: SubscriptionStatus.ACTIVE,
      trialStartAt: periodStart,
      trialEndAt: periodStart,
      graceDays: DEFAULT_GRACE_DAYS,
      currentPeriodStartAt: periodStart,
      currentPeriodEndAt: periodEnd,
      nextDueAt: periodEnd,
      baseAmountCents: DEFAULT_BASE_AMOUNT_CENTS,
      gatewayFeeBps: DEFAULT_GATEWAY_FEE_BPS,
      currency: DEFAULT_CURRENCY,
      lastPaidAt: periodStart
    }
  });
}

async function completeBusinessProvisioningOrder(input: {
  orderId: string;
  amount: number;
  status: string;
}) {
  const order = await prisma.ownerBusinessProvisioningOrder.findUnique({
    where: {
      orderId: input.orderId
    }
  });
  if (!order) {
    return null;
  }

  if (order.status === BillingChargeStatus.PAID && order.createdOrgId) {
    return { order, skipped: true as const };
  }

  const detail = await fetchPakasirTransactionDetail({
    orderId: input.orderId,
    amount: input.amount
  });
  const transaction = detail.transaction;
  const isCompleted = transaction?.status?.toLowerCase() === "settled";
  const isAmountMatch = Number(transaction?.amount) === order.totalAmountCents;

  if (!isCompleted || !isAmountMatch) {
    await writeWebhookAuditLog({
      action: "louvin.webhook.verification_failed",
      orderId: input.orderId,
      meta: {
        amount: input.amount,
        status: input.status,
        detailStatus: transaction?.status ?? null,
        detailAmount: transaction?.amount ?? null,
        expectedAmount: order.totalAmountCents,
        provisioningOrderId: order.id
      }
    });
    throw new ServiceError(400, "PAYMENT_VERIFICATION_FAILED", "Payment verification failed.");
  }

  const paidAt = transaction?.updated_at ? new Date(transaction.updated_at) : new Date();
  const existingGatewayRaw = parseGatewayRawAsRecord(order.gatewayRawJson);
  const createPayload = existingGatewayRaw?.create ?? existingGatewayRaw ?? null;
  const checkoutMeta = extractNestedObjectField(existingGatewayRaw, "checkoutMeta");
  const renewalDays = resolveRenewalDaysFromCharge(order.gatewayRawJson);

  const updated = await prisma.$transaction(async (tx) => {
    const latest = await tx.ownerBusinessProvisioningOrder.findUnique({
      where: {
        id: order.id
      }
    });
    if (!latest) {
      throw new ServiceError(404, "PROVISIONING_ORDER_NOT_FOUND", "Business provisioning order not found.");
    }

    let createdOrgId = latest.createdOrgId;
    if (!createdOrgId) {
      const createdOrg = await tx.org.create({
        data: {
          name: latest.businessName
        },
        select: {
          id: true
        }
      });
      createdOrgId = createdOrg.id;
      await tx.orgMember.create({
        data: {
          orgId: createdOrgId,
          userId: latest.userId,
          role: Role.OWNER
        }
      });
      await tx.aiAgentConfig.create({
        data: {
          orgId: createdOrgId,
          enabled: false,
          role: "SALES_ASSISTANT",
          goal: "ANSWER_QUESTION",
          tone: "FRIENDLY",
          salesMode: "SOFT_SELLING",
          stopIfHumanReply: true,
          typingDelayMs: 1200,
          multiBubbleReply: false,
          confidenceThreshold: 70,
          activeModelTier: "FREE"
        }
      });
      await tx.aiTokenBalance.create({
        data: {
          orgId: createdOrgId,
          totalTokens: 0,
          usedTokens: 0,
          remainingTokens: 0
        }
      });
    }

    const updatedOrder = await tx.ownerBusinessProvisioningOrder.update({
      where: {
        id: latest.id
      },
      data: {
        status: BillingChargeStatus.PAID,
        paidAt,
        createdOrgId,
        gatewayRawJson: JSON.stringify({
          create: createPayload,
          checkoutMeta,
          detail
        })
      }
    });

    return updatedOrder;
  });

  if (updated.createdOrgId) {
    await activateSubscriptionForProvisionedBusiness({
      orgId: updated.createdOrgId,
      paidAt,
      renewalDays
    });
  }

  await writeWebhookAuditLog({
    action: "louvin.webhook.completed",
    orderId: input.orderId,
    meta: {
      amount: input.amount,
      status: input.status,
      provisioningOrderId: updated.id,
      orgId: updated.createdOrgId,
      paidAt: paidAt.toISOString()
    }
  });

  return { order: updated, skipped: false as const };
}

export async function processPakasirWebhook(input: {
  order_id?: unknown;
  amount?: unknown;
  status?: unknown;
}) {
  const orderId = typeof input.order_id === "string" ? input.order_id.trim() : "";
  const amount = typeof input.amount === "number" ? input.amount : Number(input.amount ?? 0);
  const status = typeof input.status === "string" ? input.status.toLowerCase() : "";

  if (!orderId || !Number.isFinite(amount) || amount <= 0 || !status) {
    throw new ServiceError(400, "INVALID_WEBHOOK_PAYLOAD", "Invalid Louvin webhook payload.");
  }

  await writeWebhookAuditLog({
    action: "louvin.webhook.received",
    orderId,
    meta: {
      amount,
      status
    }
  });

  const replayLockKey = `idmp:louvin:webhook:${orderId}:${status}:${amount}`;
  const lockAcquired = await acquireIdempotencyLock(replayLockKey, 60 * 60 * 24);
  if (!lockAcquired) {
    await writeWebhookAuditLog({
      action: "louvin.webhook.replay_skipped",
      orderId,
      meta: {
        amount,
        status
      }
    });
    return { charge: null, skipped: true, reason: "replay" };
  }

  const charge = await prisma.billingCharge.findUnique({ where: { orderId } });
  if (!charge) {
    const provisioningResult = await completeBusinessProvisioningOrder({
      orderId,
      amount,
      status
    });
    if (provisioningResult) {
      return {
        charge: null,
        provisioningOrder: provisioningResult.order,
        skipped: provisioningResult.skipped
      };
    }

    await writeWebhookAuditLog({
      action: "louvin.webhook.charge_not_found",
      orderId,
      meta: {
        amount,
        status
      }
    });
    throw new ServiceError(404, "BILLING_CHARGE_NOT_FOUND", "Billing charge not found.");
  }

  if (charge.status === BillingChargeStatus.PAID) {
    await writeWebhookAuditLog({
      action: "louvin.webhook.already_paid",
      orderId,
      meta: {
        amount,
        status,
        chargeId: charge.id
      }
    });
    return { charge, skipped: true };
  }

  const detail = await fetchPakasirTransactionDetail({ orderId, amount });
  const transaction = detail.transaction;
  const isCompleted = transaction?.status?.toLowerCase() === "settled";
  const isAmountMatch = Number(transaction?.amount) === charge.totalAmountCents;

  if (!isCompleted || !isAmountMatch) {
    await writeWebhookAuditLog({
      action: "louvin.webhook.verification_failed",
      orderId,
      meta: {
        amount,
        status,
        detailStatus: transaction?.status ?? null,
        detailAmount: transaction?.amount ?? null,
        expectedAmount: charge.totalAmountCents,
        chargeId: charge.id
      }
    });
    throw new ServiceError(400, "PAYMENT_VERIFICATION_FAILED", "Payment verification failed.");
  }

  const paidAt = transaction?.updated_at ? new Date(transaction.updated_at) : new Date();
  const existingGatewayRaw = parseGatewayRawAsRecord(charge.gatewayRawJson);
  const createPayload = existingGatewayRaw?.create ?? existingGatewayRaw ?? null;
  const checkoutMeta = extractNestedObjectField(existingGatewayRaw, "checkoutMeta");

  const updatedCharge = await prisma.billingCharge.update({
    where: { id: charge.id },
    data: {
      status: BillingChargeStatus.PAID,
      paidAt,
      gatewayRawJson: JSON.stringify({
        create: createPayload,
        checkoutMeta,
        detail
      })
    }
  });

  const renewalDays = resolveRenewalDaysFromCharge(charge.gatewayRawJson);
  await activateSubscriptionFromPaidCharge(charge.orgId, paidAt, renewalDays);

  await writeWebhookAuditLog({
    action: "louvin.webhook.completed",
    orderId,
    meta: {
      amount,
      status,
      chargeId: updatedCharge.id,
      orgId: updatedCharge.orgId,
      paidAt: paidAt.toISOString()
    }
  });

  return {
    charge: updatedCharge,
    skipped: false
  };
}

export async function runSubscriptionTransitionSweep(now = new Date()) {
  const subscriptions = await prisma.orgSubscription.findMany({
    where: {
      status: {
        in: [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE]
      }
    }
  });

  for (const subscription of subscriptions) {
    if (subscription.status === SubscriptionStatus.TRIALING) {
      const graceEndAt = addDays(subscription.trialEndAt, subscription.graceDays);
      if (now.getTime() > graceEndAt.getTime()) {
        await prisma.orgSubscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.PAST_DUE
          }
        });
      }
      continue;
    }

    if (subscription.status === SubscriptionStatus.ACTIVE && subscription.currentPeriodEndAt && now.getTime() > subscription.currentPeriodEndAt.getTime()) {
      await prisma.orgSubscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.PAST_DUE
        }
      });
    }
  }
}

export async function setSubscriptionActionBySuperadmin(input: {
  orgId: string;
  action: "MARK_ACTIVE" | "MARK_PAST_DUE" | "CANCEL" | "EXTEND_TRIAL";
  extendDays?: number;
}) {
  const orgId = normalize(input.orgId);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const subscription = await getOrgSubscriptionOrThrow(orgId);

  if (input.action === "MARK_ACTIVE") {
    const start = new Date();
    const end = addDays(start, RENEWAL_DAYS);
    return prisma.orgSubscription.update({
      where: { orgId },
      data: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStartAt: start,
        currentPeriodEndAt: end,
        nextDueAt: end
      }
    });
  }

  if (input.action === "MARK_PAST_DUE") {
    return prisma.orgSubscription.update({
      where: { orgId },
      data: {
        status: SubscriptionStatus.PAST_DUE
      }
    });
  }

  if (input.action === "CANCEL") {
    return prisma.orgSubscription.update({
      where: { orgId },
      data: {
        status: SubscriptionStatus.CANCELED
      }
    });
  }

  const extendDays = Number.isFinite(input.extendDays) ? Math.max(1, Math.floor(input.extendDays ?? 0)) : 1;
  return prisma.orgSubscription.update({
    where: { orgId },
    data: {
      status: SubscriptionStatus.TRIALING,
      trialEndAt: addDays(subscription.trialEndAt, extendDays)
    }
  });
}

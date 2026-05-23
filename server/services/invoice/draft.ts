import { InvoiceStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { publishInvoiceCreatedEvent, publishInvoiceUpdatedEvent } from "@/lib/ably/publisher";
import { processAiAutomationTrigger } from "@/server/services/aiAutomationService";
import { writeAuditLogSafe } from "@/server/services/auditLogService";
import { requireInvoiceAccess } from "@/server/services/invoice/access";
import {
  computeDraftInputDerived,
  createDraftInvoiceWithRetry,
  generateDraftPdfAndPersist,
  listOrgBankAccounts,
  loadDraftCustomerContext,
  normalizeConversationId
} from "@/server/services/invoice/draftInternals";
import type {
  CreateDraftInvoiceInput,
  EditInvoiceItemsInput,
  InvoiceDraftResult,
  InvoiceItemsEditResult
} from "@/server/services/invoice/invoiceTypes";
import {
  computeInvoiceTotals,
  normalize,
  normalizeCurrency,
  normalizeInvoiceDiscount,
  normalizeItems,
  normalizeMilestones,
  normalizeOptional
} from "@/server/services/invoice/invoiceUtils";
import { ServiceError } from "@/server/services/serviceError";

function isCustomerNameSnapshotUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("Unknown argument `customerDisplayNameSnapshot`") ||
    message.includes("Unknown field `customerDisplayNameSnapshot`") ||
    message.includes("Unknown column 'customerDisplayNameSnapshot'")
  );
}

export async function createDraftInvoice(
  input: CreateDraftInvoiceInput
): Promise<InvoiceDraftResult> {
  const orgId = normalize(input.orgId);
  const customerId = normalize(input.customerId);
  const conversationId = normalizeConversationId(input.conversationId);
  const customerDisplayNameSnapshot = normalizeOptional(input.customerDisplayNameSnapshot);
  const currency = normalizeCurrency(input.currency);
  const notes = normalizeOptional(input.notes);
  const terms = normalizeOptional(input.terms);

  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!customerId) {
    throw new ServiceError(400, "MISSING_CUSTOMER_ID", "customerId is required.");
  }

  await requireInvoiceAccess(input.actorUserId, orgId);

  const customer = await loadDraftCustomerContext({
    orgId,
    customerId,
    conversationId: conversationId ?? undefined
  });
  const {
    normalizedItems,
    subtotalCents,
    totalCents,
    grossSubtotalCents,
    lineDiscountCents,
    invoiceDiscountType,
    invoiceDiscountValue,
    invoiceDiscountCents,
    taxCents,
    normalizedMilestones
  } = computeDraftInputDerived(input);
  const bankAccounts = await listOrgBankAccounts(orgId);

  const created = await createDraftInvoiceWithRetry({
    orgId,
    customerId,
    conversationId: conversationId ?? undefined,
    customerDisplayNameSnapshot,
    actorUserId: input.actorUserId,
    kind: input.kind,
    currency,
    notes,
    terms,
    dueDate: input.dueDate ?? undefined,
    bankAccounts,
    normalizedItems,
    normalizedMilestones,
    grossSubtotalCents,
    lineDiscountCents,
    invoiceDiscountType,
    invoiceDiscountValue,
    invoiceDiscountCents,
    taxCents,
    subtotalCents,
    totalCents
  });

  await generateDraftPdfAndPersist({
    orgId,
    created,
    customer,
    currency,
    grossSubtotalCents,
    lineDiscountCents,
    invoiceDiscountType,
    invoiceDiscountValue,
    invoiceDiscountCents,
    taxCents,
    customerDisplayNameSnapshot,
    notes,
    terms,
    dueDate: input.dueDate ?? undefined,
    normalizedItems,
    bankAccounts
  });

  await writeAuditLogSafe({
    orgId,
    actorUserId: input.actorUserId,
    action: "invoice.created",
    entityType: "invoice",
    entityId: created.id,
    meta: {
      invoiceNo: created.invoiceNo,
      customerId,
      conversationId: conversationId ?? null,
      totalCents: created.totalCents
    }
  });

  void publishInvoiceCreatedEvent({
    orgId,
    invoiceId: created.id,
    status: created.status
  });
  void processAiAutomationTrigger({
    trigger: "INVOICE_CREATED",
    orgId,
    invoiceId: created.id,
    conversationId: conversationId ?? undefined,
    customerId,
    invoiceStatus: created.status
  }).catch(() => undefined);
  return created;
}

export async function editInvoiceItems(
  input: EditInvoiceItemsInput
): Promise<InvoiceItemsEditResult> {
  const orgId = normalize(input.orgId);
  const invoiceId = normalize(input.invoiceId);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!invoiceId) {
    throw new ServiceError(400, "MISSING_INVOICE_ID", "invoiceId is required.");
  }

  await requireInvoiceAccess(input.actorUserId, orgId);

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      orgId
    },
    select: {
      id: true,
      kind: true,
      status: true,
      invoiceNo: true
    }
  });

  if (!invoice) {
    throw new ServiceError(404, "INVOICE_NOT_FOUND", "Invoice does not exist.");
  }

  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new ServiceError(400, "INVOICE_NOT_EDITABLE", "Only draft invoices can be edited.");
  }

  const normalizedItems = normalizeItems(input.items);
  const normalizedInvoiceDiscount = normalizeInvoiceDiscount(input.invoiceDiscount);
  const customerDisplayNameSnapshot = normalizeOptional(input.customerDisplayNameSnapshot);
  const notes = normalizeOptional(input.notes);
  const terms = normalizeOptional(input.terms);
  const totals = computeInvoiceTotals(normalizedItems, normalizedInvoiceDiscount);
  const subtotalCents = totals.subtotalCents;
  const totalCents = totals.totalCents;
  const normalizedMilestones = normalizeMilestones(invoice.kind, totalCents, input.milestones);

  const runDraftUpdate = async (includeSnapshot: boolean) =>
    prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({
        where: {
          orgId,
          invoiceId: invoice.id
        }
      });

      await tx.paymentMilestone.deleteMany({
        where: {
          orgId,
          invoiceId: invoice.id
        }
      });

      const invoiceInTx = await tx.invoice.findFirst({
        where: {
          id: invoice.id,
          orgId
        },
        select: {
          id: true
        }
      });

      if (!invoiceInTx) {
        throw new ServiceError(404, "INVOICE_NOT_FOUND", "Invoice does not exist.");
      }

      await tx.invoice.update({
        where: {
          id: invoiceInTx.id
        },
        data: {
          subtotalCents,
          totalCents,
          grossSubtotalCents: totals.grossSubtotalCents,
          lineDiscountCents: totals.lineDiscountCents,
          invoiceDiscountType: normalizedInvoiceDiscount.type,
          invoiceDiscountValue: normalizedInvoiceDiscount.value,
          invoiceDiscountCents: totals.invoiceDiscountCents,
          taxCents: totals.taxCents,
          ...(includeSnapshot
            ? {
                customerDisplayNameSnapshot: customerDisplayNameSnapshot ?? null
              }
            : {}),
          notes: notes ?? null,
          terms: terms ?? null,
          items: {
            create: normalizedItems.map((item) => ({
              ...item,
              orgId
            }))
          },
          milestones: {
            create: normalizedMilestones.map((milestone) => ({
              ...milestone,
              orgId
            }))
          }
        }
      });

      const refreshed = await tx.invoice.findFirst({
        where: {
          id: invoice.id,
          orgId
        },
        select: {
          id: true,
          invoiceNo: true,
          subtotalCents: true,
          totalCents: true,
          milestones: {
            select: {
              id: true,
              type: true,
              amountCents: true,
              dueDate: true,
              status: true
            },
            orderBy: {
              type: "asc"
            }
          },
          updatedAt: true
        }
      });

      if (!refreshed) {
        throw new ServiceError(404, "INVOICE_NOT_FOUND", "Invoice does not exist.");
      }

      return refreshed;
    });

  let updated: InvoiceItemsEditResult;
  try {
    updated = await runDraftUpdate(Boolean(customerDisplayNameSnapshot));
  } catch (error) {
    if (!customerDisplayNameSnapshot || !isCustomerNameSnapshotUnsupported(error)) {
      throw error;
    }
    updated = await runDraftUpdate(false);
  }

  await writeAuditLogSafe({
    orgId,
    actorUserId: input.actorUserId,
    action: "invoice.items_updated",
    entityType: "invoice",
    entityId: updated.id,
    meta: {
      invoiceNo: updated.invoiceNo,
      totalCents: updated.totalCents
    }
  });

  void publishInvoiceUpdatedEvent({
    orgId,
    invoiceId: updated.id,
    status: InvoiceStatus.DRAFT
  });

  return updated;
}

export async function deleteDraftInvoice(input: {
  actorUserId: string;
  orgId: string;
  invoiceId: string;
}): Promise<{ id: string }> {
  const orgId = normalize(input.orgId);
  const invoiceId = normalize(input.invoiceId);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!invoiceId) {
    throw new ServiceError(400, "MISSING_INVOICE_ID", "invoiceId is required.");
  }

  await requireInvoiceAccess(input.actorUserId, orgId);

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      orgId
    },
    select: {
      id: true,
      status: true,
      invoiceNo: true
    }
  });

  if (!invoice) {
    throw new ServiceError(404, "INVOICE_NOT_FOUND", "Invoice does not exist.");
  }

  if (invoice.status !== InvoiceStatus.DRAFT && invoice.status !== InvoiceStatus.VOID) {
    throw new ServiceError(
      400,
      "INVOICE_NOT_DELETABLE",
      "Only draft or void invoices can be deleted."
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentProof.deleteMany({
      where: {
        orgId,
        invoiceId: invoice.id
      }
    });

    await tx.paymentMilestone.deleteMany({
      where: {
        orgId,
        invoiceId: invoice.id
      }
    });

    await tx.invoiceItem.deleteMany({
      where: {
        orgId,
        invoiceId: invoice.id
      }
    });

    await tx.invoice.delete({
      where: {
        id: invoice.id
      }
    });
  });

  await writeAuditLogSafe({
    orgId,
    actorUserId: input.actorUserId,
    action: "invoice.deleted",
    entityType: "invoice",
    entityId: invoice.id,
    meta: {
      invoiceNo: invoice.invoiceNo
    }
  });

  void publishInvoiceUpdatedEvent({
    orgId,
    invoiceId: invoice.id,
    status: InvoiceStatus.VOID
  });

  return {
    id: invoice.id
  };
}

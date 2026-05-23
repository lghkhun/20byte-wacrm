import { extractInvisibleAttributionMarker } from "@/lib/attribution/invisibleMarker";
import { extractTrackingRef } from "@/lib/attribution/trackingRef";
import { prisma } from "@/lib/db/prisma";
import { enqueueMetaEventJob } from "@/server/queues/metaEventQueue";
import type { Prisma } from "@prisma/client";
import { processAiAutomationTrigger } from "@/server/services/aiAutomationService";
import { autoEnrollWhatsAppFlowOnChatIncoming } from "@/server/services/whatsappCampaignService";

import type { InboundStoreResult, ResolvedAttribution, StoreInboundMessageInput } from "@/server/services/message/messageTypes";
import { normalize, normalizeFileSize, normalizeMessageText, normalizeOptional } from "@/server/services/message/messageUtils";
import { getOrCreateCustomer, getOrCreateOpenConversation } from "@/server/services/message/inboundInfra/customerConversation";
import { publishInboundConversationUpdatedNonBlocking, publishMessageNewEventNonBlocking } from "@/server/services/message/inboundInfra/events";
import { resolveInboundAttribution } from "@/server/services/message/inboundInfra/attribution";
import { findExistingInboundByWaMessageId, storeInboundMessageInTransaction } from "@/server/services/message/inboundInfra/persistence";

function emptyInboundResult(duplicate = false, messageId: string | null = null): InboundStoreResult {
  return {
    stored: false,
    duplicate,
    messageId,
    conversationId: null,
    conversationStatus: null,
    assignedToMemberId: null
  };
}

function buildInboundContext(input: StoreInboundMessageInput) {
  const orgId = normalize(input.orgId);
  const customerPhoneE164 = normalize(input.customerPhoneE164);
  const waMessageId = normalize(input.waMessageId);

  const rawText = normalizeOptional(input.text);
  const trackingExtract = extractTrackingRef(rawText);
  const invisibleExtract = extractInvisibleAttributionMarker(trackingExtract.cleanText);
  const resolvedShortlinkCode =
    normalizeOptional(input.shortlinkCode) ?? trackingExtract.shortlinkCodeFromRef ?? invisibleExtract.shortlinkCode;

  return {
    orgId,
    customerPhoneE164,
    waChatJid: normalizeOptional(input.waChatJid),
    waMessageId,
    customerDisplayName: normalizeOptional(input.customerDisplayName),
    customerAvatarUrl: normalizeOptional(input.customerAvatarUrl),
    senderWaJid: normalizeOptional(input.senderWaJid),
    senderPhoneE164: normalizeOptional(input.senderPhoneE164),
    senderDisplayName: normalizeOptional(input.senderDisplayName),
    shortlinkCode: resolvedShortlinkCode,
    trackingId: normalizeOptional(input.trackingId) ?? trackingExtract.trackingId,
    fbclid: normalizeOptional(input.fbclid),
    fbc: normalizeOptional(input.fbc),
    fbp: normalizeOptional(input.fbp),
    ctwaClid: normalizeOptional(input.ctwaClid),
    wabaId: normalizeOptional(input.wabaId),
    replyToWaMessageId: normalizeOptional(input.replyToWaMessageId),
    replyPreviewText: normalizeMessageText(input.replyPreviewText),
    text: normalizeMessageText(invisibleExtract.cleanText),
    mediaId: normalizeOptional(input.mediaId),
    mediaUrl: normalizeOptional(input.mediaUrl),
    mimeType: normalizeOptional(input.mimeType),
    fileName: normalizeOptional(input.fileName),
    fileSize: normalizeFileSize(input.fileSize),
    durationSec: typeof input.durationSec === "number" && Number.isFinite(input.durationSec) ? Math.max(0, Math.floor(input.durationSec)) : undefined,
    type: input.type
  };
}

function resolveConversationAttribution(
  customer: {
    source: string | null;
    campaign: string | null;
    adset: string | null;
    ad: string | null;
    platform: string | null;
    medium: string | null;
  },
  attribution?: ResolvedAttribution
): ResolvedAttribution {
  return {
    source: customer.source ?? attribution?.source ?? "organic",
    campaign: customer.campaign ?? attribution?.campaign ?? undefined,
    adset: customer.adset ?? customer.platform ?? attribution?.adset ?? attribution?.platform ?? undefined,
    ad: customer.ad ?? customer.medium ?? attribution?.ad ?? attribution?.medium ?? undefined,
    platform: customer.platform ?? customer.adset ?? attribution?.adset ?? attribution?.platform ?? undefined,
    medium: customer.medium ?? customer.ad ?? attribution?.ad ?? attribution?.medium ?? undefined,
    shortlinkId: attribution?.shortlinkId,
    trackingId: attribution?.trackingId,
    fbclid: attribution?.fbclid,
    fbc: attribution?.fbc,
    fbp: attribution?.fbp,
    ctwaClid: attribution?.ctwaClid,
    wabaId: attribution?.wabaId
  };
}

export async function storeInboundMessage(input: StoreInboundMessageInput): Promise<InboundStoreResult> {
  const context = buildInboundContext(input);

  if (!context.orgId || !context.customerPhoneE164 || !context.waMessageId) {
    return emptyInboundResult();
  }

  const existing = await findExistingInboundByWaMessageId(context.waMessageId);
  if (existing) {
    return emptyInboundResult(true, existing.id);
  }

  const createdMessage = await storeInboundMessageInTransaction({
    context,
    resolveAttribution: async (tx: Prisma.TransactionClient) => {
      const resolved = await resolveInboundAttribution(tx, context.orgId, context.shortlinkCode, context.trackingId);
      return {
        source: resolved?.source ?? "organic",
        campaign: resolved?.campaign,
        adset: resolved?.adset,
        ad: resolved?.ad,
        platform: resolved?.platform,
        medium: resolved?.medium,
        shortlinkId: resolved?.shortlinkId,
        trackingId: context.trackingId,
        fbclid: resolved?.fbclid ?? context.fbclid,
        fbc: resolved?.fbc ?? context.fbc,
        fbp: resolved?.fbp ?? context.fbp,
        ctwaClid: context.ctwaClid,
        wabaId: context.wabaId
      };
    },
    getOrCreateCustomer: async (tx: Prisma.TransactionClient, attribution) =>
      getOrCreateCustomer(
        tx,
        context.orgId,
        context.customerPhoneE164,
        context.customerDisplayName,
        context.customerAvatarUrl,
        attribution
      ),
    getOrCreateConversation: async (tx: Prisma.TransactionClient, customerId, attribution, customer) =>
      getOrCreateOpenConversation(tx, context.orgId, customerId, resolveConversationAttribution(customer, attribution), context.waChatJid)
  });

  publishMessageNewEventNonBlocking({
    orgId: context.orgId,
    conversationId: createdMessage.conversationId,
    messageId: createdMessage.id,
    direction: "INBOUND"
  });
  publishInboundConversationUpdatedNonBlocking({
    orgId: context.orgId,
    conversationId: createdMessage.conversationId,
    assignedToMemberId: createdMessage.assignedToMemberId,
    status: createdMessage.conversationStatus
  });
  void processAiAutomationTrigger({
    trigger: "CHAT_INCOMING",
    orgId: context.orgId,
    conversationId: createdMessage.conversationId,
    customerId: createdMessage.customerId,
    conversationStatus: createdMessage.conversationStatus,
    noHumanReply: Boolean(createdMessage.assignedToMemberId)
  }).catch(() => undefined);
  void autoEnrollWhatsAppFlowOnChatIncoming({
    orgId: context.orgId,
    conversationId: createdMessage.conversationId,
    customerId: createdMessage.customerId
  }).catch(() => undefined);

  if (createdMessage.customerCreated) {
    const conversationAttribution = await prisma.conversation.findFirst({
      where: {
        id: createdMessage.conversationId,
        orgId: context.orgId
      },
      select: {
        trackingId: true,
        fbclid: true,
        fbc: true,
        fbp: true,
        ctwaClid: true,
        wabaId: true
      }
    });
    void enqueueMetaEventJob({
      orgId: context.orgId,
      kind: "LEAD",
      customerId: createdMessage.customerId,
      dedupeKey: `lead:${createdMessage.customerId}`,
      trackingId: conversationAttribution?.trackingId ?? context.trackingId,
      customerPhoneE164: context.customerPhoneE164,
      fbclid: conversationAttribution?.fbclid ?? context.fbclid,
      fbc: conversationAttribution?.fbc ?? context.fbc,
      fbp: conversationAttribution?.fbp ?? context.fbp,
      ctwaClid: conversationAttribution?.ctwaClid ?? context.ctwaClid,
      wabaId: conversationAttribution?.wabaId ?? context.wabaId
    }).catch(() => undefined);
  }

  return {
    stored: true,
    duplicate: false,
    messageId: createdMessage.id,
    conversationId: createdMessage.conversationId,
    conversationStatus: createdMessage.conversationStatus,
    assignedToMemberId: createdMessage.assignedToMemberId
  };
}

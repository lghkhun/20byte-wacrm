import { WAMessageStatus } from "baileys";

import { publishConversationUpdatedEvent } from "@/lib/ably/publisher";
import { updateOutboundDeliveryStatusByWaMessageId } from "@/server/services/message/outboundInfra/persistence";
import { processCampaignReadEvent } from "@/server/services/whatsappCampaignService";

export type BaileysOutboundStatusUpdate = {
  key?: {
    id?: string | null;
    fromMe?: boolean | null;
  } | null;
  update?: {
    status?: number | null;
  } | null;
};

type DeliveryStatus = "SENT" | "DELIVERED" | "READ";

type StatusProcessingDeps = {
  updateDeliveryStatusByWaMessageId?: typeof updateOutboundDeliveryStatusByWaMessageId;
  publishConversationUpdated?: typeof publishConversationUpdatedEvent;
};

function normalize(value: string | undefined): string {
  return (value ?? "").trim();
}

export function mapBaileysStatusToDeliveryStatus(status: number | null | undefined): DeliveryStatus | null {
  if (typeof status !== "number") {
    return null;
  }

  if (status >= WAMessageStatus.READ) {
    return "READ";
  }
  if (status >= WAMessageStatus.DELIVERY_ACK) {
    return "DELIVERED";
  }
  if (status >= WAMessageStatus.SERVER_ACK) {
    return "SENT";
  }

  return null;
}

export async function processBaileysOutboundStatusUpdate(
  orgId: string,
  update: BaileysOutboundStatusUpdate,
  deps?: StatusProcessingDeps
): Promise<Awaited<ReturnType<typeof updateOutboundDeliveryStatusByWaMessageId>>> {
  if (!update?.key?.fromMe) {
    return null;
  }

  const waMessageId = normalize(update.key?.id ?? undefined);
  if (!waMessageId) {
    return null;
  }

  const deliveryStatus = mapBaileysStatusToDeliveryStatus(update.update?.status ?? null);
  if (!deliveryStatus) {
    return null;
  }

  const updateDeliveryStatusByWaMessageId = deps?.updateDeliveryStatusByWaMessageId ?? updateOutboundDeliveryStatusByWaMessageId;
  const publishConversationUpdated = deps?.publishConversationUpdated ?? publishConversationUpdatedEvent;

  const updated = await updateDeliveryStatusByWaMessageId({
    orgId,
    waMessageId,
    deliveryStatus
  });

  if (!updated) {
    return null;
  }

  if (deliveryStatus === "READ") {
    await processCampaignReadEvent({
      orgId,
      conversationId: updated.conversationId,
      messageId: updated.messageId,
      waMessageId
    });
  }

  void publishConversationUpdated({
    orgId,
    conversationId: updated.conversationId,
    assignedToMemberId: updated.assignedToMemberId,
    status: updated.conversationStatus,
    crmPipelineId: updated.crmPipelineId,
    crmStageId: updated.crmStageId,
    crmStageName: updated.crmStageName
  });

  return updated;
}

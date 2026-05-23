import { startMetaEventProcessor, stopMetaEventProcessor } from "@/worker/processors/metaEventProcessor";
import { startStorageCleanupProcessor, stopStorageCleanupProcessor } from "@/worker/processors/storageCleanupProcessor";
import { startStorageCleanupScheduler, stopStorageCleanupScheduler } from "@/worker/processors/storageCleanupScheduler";
import {
  startWhatsAppPublicScheduleProcessor,
  stopWhatsAppPublicScheduleProcessor
} from "@/worker/processors/whatsappPublicScheduleProcessor";
import {
  startWhatsAppPublicWebhookProcessor,
  stopWhatsAppPublicWebhookProcessor
} from "@/worker/processors/whatsappPublicWebhookProcessor";
import { startWhatsAppCampaignProcessor, stopWhatsAppCampaignProcessor } from "@/worker/processors/whatsappCampaignProcessor";

export async function startWorker(): Promise<void> {
  const redisEnabled = Boolean(process.env.REDIS_URL?.trim());

  if (!redisEnabled) {
    console.warn("[worker] REDIS_URL is missing. Redis-based processors are disabled.");
    return;
  }

  await Promise.all([
    startMetaEventProcessor(),
    startStorageCleanupProcessor(),
    startStorageCleanupScheduler(),
    startWhatsAppPublicScheduleProcessor(),
    startWhatsAppPublicWebhookProcessor(),
    startWhatsAppCampaignProcessor()
  ]);
}

export function stopWorker(): void {
  stopMetaEventProcessor();
  stopStorageCleanupProcessor();
  stopStorageCleanupScheduler();
  stopWhatsAppPublicScheduleProcessor();
  stopWhatsAppPublicWebhookProcessor();
  stopWhatsAppCampaignProcessor();
}

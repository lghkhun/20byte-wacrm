import {
  dequeueWhatsAppCampaignExecutionJob,
  requeueWhatsAppCampaignExecutionJob
} from "@/server/queues/whatsappCampaignQueue";
import { sendRedisCommand } from "@/lib/redis/redisResp";
import {
  processWhatsAppBroadcastRecipientsBatch,
  processWhatsAppCampaignExecutionJob,
  processWhatsAppRulePendingChecksBatch
} from "@/server/services/whatsappCampaignService";

const IDLE_TIMEOUT_SECONDS = 5;
let running = false;
const EXECUTION_LOCK_TTL_SECONDS = 90;
const BROADCAST_BATCH_LOCK_KEY = "20byte:whatsapp:broadcast:batch:lock";
const BROADCAST_BATCH_LOCK_TTL_SECONDS = 10;

function getRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error("Missing required environment variable: REDIS_URL");
  }
  return redisUrl;
}

async function acquireExecutionLock(executionId: string): Promise<boolean> {
  const key = `20byte:whatsapp:campaign:lock:${executionId}`;
  const result = await sendRedisCommand(getRedisUrl(), [
    "SET",
    key,
    "1",
    "NX",
    "EX",
    String(EXECUTION_LOCK_TTL_SECONDS)
  ]);
  return result === "OK";
}

async function releaseExecutionLock(executionId: string): Promise<void> {
  const key = `20byte:whatsapp:campaign:lock:${executionId}`;
  await sendRedisCommand(getRedisUrl(), ["DEL", key]);
}

async function acquireBroadcastBatchLock(): Promise<boolean> {
  const result = await sendRedisCommand(getRedisUrl(), [
    "SET",
    BROADCAST_BATCH_LOCK_KEY,
    "1",
    "NX",
    "EX",
    String(BROADCAST_BATCH_LOCK_TTL_SECONDS)
  ]);
  return result === "OK";
}

async function releaseBroadcastBatchLock(): Promise<void> {
  await sendRedisCommand(getRedisUrl(), ["DEL", BROADCAST_BATCH_LOCK_KEY]);
}

export async function startWhatsAppCampaignProcessor(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  console.log("[worker] whatsapp campaign processor started");

  while (running) {
    try {
      const job = await dequeueWhatsAppCampaignExecutionJob(IDLE_TIMEOUT_SECONDS);
      if (!job) {
        const batchLockAcquired = await acquireBroadcastBatchLock().catch(() => false);
        if (batchLockAcquired) {
          try {
            await processWhatsAppBroadcastRecipientsBatch(25);
            await processWhatsAppRulePendingChecksBatch(25);
          } finally {
            await releaseBroadcastBatchLock().catch(() => {});
          }
        }
        continue;
      }

      const dueAtMs = new Date(job.dueAt).getTime();
      if (Number.isFinite(dueAtMs) && dueAtMs > Date.now()) {
        await requeueWhatsAppCampaignExecutionJob(job);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const lockAcquired = await acquireExecutionLock(job.executionId);
      if (!lockAcquired) {
        continue;
      }

      try {
        await processWhatsAppCampaignExecutionJob(job.executionId);
        const batchLockAcquired = await acquireBroadcastBatchLock().catch(() => false);
        if (batchLockAcquired) {
          try {
            await processWhatsAppBroadcastRecipientsBatch(10);
            await processWhatsAppRulePendingChecksBatch(10);
          } finally {
            await releaseBroadcastBatchLock().catch(() => {});
          }
        }
      } finally {
        await releaseExecutionLock(job.executionId).catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[worker] whatsapp campaign processor error: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function stopWhatsAppCampaignProcessor(): void {
  running = false;
}

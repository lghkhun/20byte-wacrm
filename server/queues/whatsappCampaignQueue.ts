import { randomUUID } from "crypto";

import { sendRedisCommand } from "@/lib/redis/redisResp";

const WHATSAPP_CAMPAIGN_QUEUE_KEY = "20byte:whatsapp:campaign:execution";

export type WhatsAppCampaignExecutionJob = {
  id: string;
  orgId: string;
  executionId: string;
  dueAt: string;
  receivedAt: string;
};

function normalize(value: string | undefined): string {
  return (value ?? "").trim();
}

function getRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("Missing required environment variable: REDIS_URL");
  }
  return redisUrl;
}

function parseJob(raw: string): WhatsAppCampaignExecutionJob {
  const parsed = JSON.parse(raw) as WhatsAppCampaignExecutionJob;
  if (!normalize(parsed.id) || !normalize(parsed.orgId) || !normalize(parsed.executionId) || !normalize(parsed.dueAt)) {
    throw new Error("Invalid WhatsApp campaign queue payload.");
  }
  return parsed;
}

export async function enqueueWhatsAppCampaignExecutionJob(payload: {
  orgId: string;
  executionId: string;
  dueAt: string;
}): Promise<WhatsAppCampaignExecutionJob> {
  const orgId = normalize(payload.orgId);
  const executionId = normalize(payload.executionId);
  const dueAt = normalize(payload.dueAt);
  if (!orgId || !executionId || !dueAt) {
    throw new Error("Invalid WhatsApp campaign queue payload.");
  }

  const job: WhatsAppCampaignExecutionJob = {
    id: randomUUID(),
    orgId,
    executionId,
    dueAt,
    receivedAt: new Date().toISOString()
  };

  await sendRedisCommand(getRedisUrl(), ["RPUSH", WHATSAPP_CAMPAIGN_QUEUE_KEY, JSON.stringify(job)]);
  return job;
}

export async function dequeueWhatsAppCampaignExecutionJob(timeoutSeconds = 5): Promise<WhatsAppCampaignExecutionJob | null> {
  const response = await sendRedisCommand(getRedisUrl(), [
    "BLPOP",
    WHATSAPP_CAMPAIGN_QUEUE_KEY,
    String(Math.max(0, timeoutSeconds))
  ]);

  if (response === null) {
    return null;
  }
  if (!Array.isArray(response) || response.length < 2 || typeof response[1] !== "string") {
    throw new Error("Invalid BLPOP response for WhatsApp campaign queue.");
  }

  return parseJob(response[1]);
}

export async function requeueWhatsAppCampaignExecutionJob(job: WhatsAppCampaignExecutionJob): Promise<void> {
  await sendRedisCommand(getRedisUrl(), ["RPUSH", WHATSAPP_CAMPAIGN_QUEUE_KEY, JSON.stringify(job)]);
}


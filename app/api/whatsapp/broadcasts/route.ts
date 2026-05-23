import type { NextRequest } from "next/server";
import type { WaTemplateCategory } from "@prisma/client";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import {
  createWhatsAppBroadcast,
  deleteWhatsAppBroadcast,
  listWhatsAppBroadcasts,
  updateWhatsAppBroadcast
} from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type BroadcastBody = {
  orgId?: unknown;
  broadcastId?: unknown;
  name?: unknown;
  messageMode?: unknown;
  recipientMode?: unknown;
  segment?: unknown;
  selectedCustomerIds?: unknown;
  filters?: unknown;
  batchSize?: unknown;
  batchIntervalSeconds?: unknown;
  scheduledAt?: unknown;
  text?: unknown;
  templateName?: unknown;
  templateLanguageCode?: unknown;
  templateCategory?: unknown;
  templateComponentsJson?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTemplateCategory(value: unknown): WaTemplateCategory | undefined {
  if (value === "MARKETING" || value === "UTILITY" || value === "AUTHENTICATION" || value === "SERVICE") {
    return value;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asDate(value: unknown): Date | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

export async function GET(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, request.nextUrl.searchParams.get("orgId") ?? "");
    const items = await listWhatsAppBroadcasts({
      actorUserId: auth.session.userId,
      orgId
    });
    return successResponse({ items }, 200);
  } catch (error) {
    if (error instanceof ServiceError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "WHATSAPP_BROADCAST_LIST_FAILED", "Failed to load broadcasts.");
  }
}

export async function POST(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: BroadcastBody;
  try {
    body = (await request.json()) as BroadcastBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, asString(body.orgId));
    const messageModeRaw = asString(body.messageMode).toUpperCase();
    const messageMode = messageModeRaw === "TEXT" ? "TEXT" : "TEMPLATE";
    const selectedCustomerIds = Array.isArray(body.selectedCustomerIds)
      ? body.selectedCustomerIds.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];
    const filters =
      body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
        ? (body.filters as Record<string, unknown>)
        : {};
    const item = await createWhatsAppBroadcast({
      actorUserId: auth.session.userId,
      orgId,
      name: asString(body.name),
      messageMode,
      recipientMode: asString(body.recipientMode),
      segment: asString(body.segment),
      selectedCustomerIdsJson: JSON.stringify(selectedCustomerIds),
      filtersJson: JSON.stringify(filters),
      batchSize: asNumber(body.batchSize),
      batchIntervalSeconds: asNumber(body.batchIntervalSeconds),
      scheduledAt: asDate(body.scheduledAt),
      text: asString(body.text),
      templateName: asString(body.templateName),
      templateLanguageCode: asString(body.templateLanguageCode),
      templateCategory: asTemplateCategory(body.templateCategory),
      templateComponentsJson: asString(body.templateComponentsJson)
    });
    return successResponse({ item }, 201);
  } catch (error) {
    if (error instanceof ServiceError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "WHATSAPP_BROADCAST_CREATE_FAILED", "Failed to create broadcast.");
  }
}

export async function PATCH(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: BroadcastBody;
  try {
    body = (await request.json()) as BroadcastBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, asString(body.orgId));
    const selectedCustomerIds = Array.isArray(body.selectedCustomerIds)
      ? body.selectedCustomerIds.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : undefined;
    const filters =
      body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
        ? (body.filters as Record<string, unknown>)
        : undefined;
    const messageModeRaw = asString(body.messageMode).toUpperCase();
    const messageMode = messageModeRaw === "TEXT" || messageModeRaw === "TEMPLATE" ? messageModeRaw : undefined;
    const item = await updateWhatsAppBroadcast({
      actorUserId: auth.session.userId,
      orgId,
      broadcastId: asString(body.broadcastId),
      name: asString(body.name) || undefined,
      text: asString(body.text) || undefined,
      messageMode: messageMode as "TEXT" | "TEMPLATE" | undefined,
      recipientMode: asString(body.recipientMode) || undefined,
      segment: asString(body.segment) || undefined,
      selectedCustomerIdsJson: selectedCustomerIds ? JSON.stringify(selectedCustomerIds) : undefined,
      filtersJson: filters ? JSON.stringify(filters) : undefined,
      batchSize: asNumber(body.batchSize),
      batchIntervalSeconds: asNumber(body.batchIntervalSeconds),
      scheduledAt: asDate(body.scheduledAt),
      templateName: asString(body.templateName) || undefined,
      templateLanguageCode: asString(body.templateLanguageCode) || undefined,
      templateCategory: asTemplateCategory(body.templateCategory),
      templateComponentsJson: asString(body.templateComponentsJson) || undefined
    });
    return successResponse({ item }, 200);
  } catch (error) {
    if (error instanceof ServiceError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "WHATSAPP_BROADCAST_UPDATE_FAILED", "Failed to update broadcast.");
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: BroadcastBody;
  try {
    body = (await request.json()) as BroadcastBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, asString(body.orgId));
    const result = await deleteWhatsAppBroadcast({
      actorUserId: auth.session.userId,
      orgId,
      broadcastId: asString(body.broadcastId)
    });
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "WHATSAPP_BROADCAST_DELETE_FAILED", "Failed to delete broadcast.");
  }
}

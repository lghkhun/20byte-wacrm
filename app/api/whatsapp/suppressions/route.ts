import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { clearWhatsAppSuppression, upsertWhatsAppSuppression } from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type SuppressionRequest = {
  orgId?: unknown;
  conversationId?: unknown;
  reason?: unknown;
};

export async function POST(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: SuppressionRequest;
  try {
    body = (await request.json()) as SuppressionRequest;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const item = await upsertWhatsAppSuppression({
      actorUserId: auth.session.userId,
      orgId,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
      reason: typeof body.reason === "string" ? body.reason : ""
    });
    return successResponse({ item }, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_SUPPRESSION_UPSERT_FAILED", "Failed to upsert suppression.");
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: SuppressionRequest;
  try {
    body = (await request.json()) as SuppressionRequest;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const result = await clearWhatsAppSuppression({
      actorUserId: auth.session.userId,
      orgId,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : ""
    });
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_SUPPRESSION_CLEAR_FAILED", "Failed to clear suppression.");
  }
}


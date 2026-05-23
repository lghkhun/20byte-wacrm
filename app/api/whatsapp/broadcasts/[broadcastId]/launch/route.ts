import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { launchWhatsAppBroadcast } from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type LaunchBody = {
  orgId?: unknown;
};

export async function POST(request: NextRequest, context: { params: Promise<{ broadcastId: string }> }) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: LaunchBody;
  try {
    body = (await request.json()) as LaunchBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const result = await launchWhatsAppBroadcast({
      actorUserId: auth.session.userId,
      orgId,
      broadcastId: params.broadcastId
    });
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "WHATSAPP_BROADCAST_LAUNCH_FAILED", "Failed to launch broadcast.");
  }
}

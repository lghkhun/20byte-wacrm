import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { enrollConversationToWhatsAppFlow } from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type EnrollRequest = {
  orgId?: unknown;
  conversationId?: unknown;
};

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ flowId: string }>;
  }
) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: EnrollRequest;
  try {
    body = (await request.json()) as EnrollRequest;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const result = await enrollConversationToWhatsAppFlow({
      actorUserId: auth.session.userId,
      orgId,
      flowId: params.flowId,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : ""
    });
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_FLOW_ENROLL_FAILED", "Failed to enroll conversation to flow.");
  }
}


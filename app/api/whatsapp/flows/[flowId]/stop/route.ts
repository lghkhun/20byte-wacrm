import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { stopWhatsAppFlow } from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type FlowActionRequest = {
  orgId?: unknown;
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

  let body: FlowActionRequest = {};
  try {
    body = (await request.json()) as FlowActionRequest;
  } catch {
    body = {};
  }

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const result = await stopWhatsAppFlow(auth.session.userId, orgId, params.flowId);
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_FLOW_STOP_FAILED", "Failed to stop WhatsApp flow.");
  }
}


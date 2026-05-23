import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { getWhatsAppCampaignAnalytics } from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

export async function GET(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, request.nextUrl.searchParams.get("orgId") ?? "");
    const analytics = await getWhatsAppCampaignAnalytics(auth.session.userId, orgId);
    return successResponse({ analytics }, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_CAMPAIGN_ANALYTICS_FAILED", "Failed to load WhatsApp campaign analytics.");
  }
}


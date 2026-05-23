import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import {
  createWhatsAppFlowRule,
  deleteWhatsAppFlowRule,
  listWhatsAppFlowRules,
  updateWhatsAppFlowRule
} from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type RuleRequestBody = {
  orgId?: unknown;
  ruleId?: unknown;
  triggerType?: unknown;
  conditionExpr?: unknown;
  actionType?: unknown;
  isActive?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function GET(request: NextRequest, context: { params: Promise<{ flowId: string }> }) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, request.nextUrl.searchParams.get("orgId") ?? "");
    const items = await listWhatsAppFlowRules({
      actorUserId: auth.session.userId,
      orgId,
      flowId: params.flowId
    });
    return successResponse({ items }, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_RULES_LIST_FAILED", "Failed to load flow rules.");
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ flowId: string }> }) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: RuleRequestBody;
  try {
    body = (await request.json()) as RuleRequestBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, asString(body.orgId) ?? "");
    const item = await createWhatsAppFlowRule({
      actorUserId: auth.session.userId,
      orgId,
      flowId: params.flowId,
      triggerType: asString(body.triggerType) ?? "",
      conditionExpr: asString(body.conditionExpr) ?? "",
      actionType: asString(body.actionType) ?? "",
      isActive: typeof body.isActive === "boolean" ? body.isActive : true
    });
    return successResponse({ item }, 201);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_RULES_CREATE_FAILED", "Failed to create flow rule.");
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ flowId: string }> }) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: RuleRequestBody;
  try {
    body = (await request.json()) as RuleRequestBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, asString(body.orgId) ?? "");
    const item = await updateWhatsAppFlowRule({
      actorUserId: auth.session.userId,
      orgId,
      flowId: params.flowId,
      ruleId: asString(body.ruleId) ?? "",
      triggerType: asString(body.triggerType),
      conditionExpr: asString(body.conditionExpr),
      actionType: asString(body.actionType),
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined
    });
    return successResponse({ item }, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_RULES_UPDATE_FAILED", "Failed to update flow rule.");
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ flowId: string }> }) {
  const auth = requireApiSession(request);
  if (auth.response) return auth.response;

  let body: RuleRequestBody;
  try {
    body = (await request.json()) as RuleRequestBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const params = await context.params;
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, asString(body.orgId) ?? "");
    const result = await deleteWhatsAppFlowRule({
      actorUserId: auth.session.userId,
      orgId,
      flowId: params.flowId,
      ruleId: asString(body.ruleId) ?? ""
    });
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_RULES_DELETE_FAILED", "Failed to delete flow rule.");
  }
}

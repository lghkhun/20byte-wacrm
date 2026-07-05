import { type NextRequest, NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/middleware";
import { getAiAgentConfig, updateAiAgentConfig } from "@/server/services/aiAutomationService";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { ServiceError } from "@/server/services/serviceError";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function withServerTiming<T>(response: T, startedAt: number): T {
  const durationMs = Number((performance.now() - startedAt).toFixed(1));
  if (response instanceof Response) {
    response.headers.set("Server-Timing", `app;dur=${durationMs}`);
  }
  return response;
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const auth = requireApiSession(request);
  if (auth.response) {
    return withServerTiming(auth.response, startedAt);
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, request.nextUrl.searchParams.get("orgId") ?? "");
    const data = await getAiAgentConfig(auth.session.userId, orgId);
    return withServerTiming(NextResponse.json({ data, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_CONFIG_GET_FAILED", "Failed to load AI config."), startedAt);
  }
}

export async function PATCH(request: NextRequest) {
  const startedAt = performance.now();
  const auth = requireApiSession(request);
  if (auth.response) {
    return withServerTiming(auth.response, startedAt);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return withServerTiming(errorResponse(400, "INVALID_JSON", "Request body must be valid JSON."), startedAt);
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const config = await updateAiAgentConfig(auth.session.userId, orgId, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      goal: typeof body.goal === "string" ? body.goal : undefined,
      tone: typeof body.tone === "string" ? body.tone : undefined,
      salesMode: typeof body.salesMode === "string" ? body.salesMode : undefined,
      businessName: typeof body.businessName === "string" || body.businessName === null ? body.businessName : undefined,
      advancedPrompt: typeof body.advancedPrompt === "string" || body.advancedPrompt === null ? body.advancedPrompt : undefined,
      stopIfHumanReply: typeof body.stopIfHumanReply === "boolean" ? body.stopIfHumanReply : undefined,
      typingDelayMs: typeof body.typingDelayMs === "number" ? body.typingDelayMs : undefined,
      multiBubbleReply: typeof body.multiBubbleReply === "boolean" ? body.multiBubbleReply : undefined,
      confidenceThreshold: typeof body.confidenceThreshold === "number" ? body.confidenceThreshold : undefined,
      modelFree: typeof body.modelFree === "string" ? body.modelFree : undefined,
      modelPaid: typeof body.modelPaid === "string" ? body.modelPaid : undefined,
      activeModelTier: typeof body.activeModelTier === "string" ? body.activeModelTier : undefined
    });
    return withServerTiming(NextResponse.json({ data: { config }, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_CONFIG_PATCH_FAILED", "Failed to update AI config."), startedAt);
  }
}

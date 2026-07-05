import { type NextRequest, NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/middleware";
import { createAiAutomation, deleteAiAutomation, listAiAutomations, updateAiAutomation } from "@/server/services/aiAutomationService";
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
    const items = await listAiAutomations(auth.session.userId, orgId);
    return withServerTiming(NextResponse.json({ data: { items }, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_AUTOMATION_LIST_FAILED", "Failed to load AI automation rules."), startedAt);
  }
}

export async function POST(request: NextRequest) {
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
    const item = await createAiAutomation(auth.session.userId, orgId, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" || body.description === null ? body.description : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      trigger: typeof body.trigger === "string" ? body.trigger : "",
      delayMinutes: typeof body.delayMinutes === "number" ? body.delayMinutes : undefined,
      conditions: Array.isArray(body.conditions)
        ? body.conditions
            .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === "object")
            .map((it) => ({
              type: typeof it.type === "string" ? it.type : "",
              operator: typeof it.operator === "string" ? it.operator : undefined,
              value: typeof it.value === "string" ? it.value : ""
            }))
        : undefined,
      actions: Array.isArray(body.actions)
        ? body.actions
            .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === "object")
            .map((it) => ({
              type: typeof it.type === "string" ? it.type : "",
              payloadJson: typeof it.payloadJson === "string" ? it.payloadJson : "{}"
            }))
        : undefined
    });
    return withServerTiming(NextResponse.json({ data: { item }, meta: {} }, { status: 201 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_AUTOMATION_CREATE_FAILED", "Failed to create AI automation rule."), startedAt);
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
    const automationId = typeof body.automationId === "string" ? body.automationId : "";
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const item = await updateAiAutomation(auth.session.userId, orgId, automationId, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" || body.description === null ? body.description : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      trigger: typeof body.trigger === "string" ? body.trigger : undefined,
      delayMinutes: typeof body.delayMinutes === "number" ? body.delayMinutes : undefined,
      conditions: Array.isArray(body.conditions)
        ? body.conditions
            .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === "object")
            .map((it) => ({
              type: typeof it.type === "string" ? it.type : "",
              operator: typeof it.operator === "string" ? it.operator : undefined,
              value: typeof it.value === "string" ? it.value : ""
            }))
        : undefined,
      actions: Array.isArray(body.actions)
        ? body.actions
            .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === "object")
            .map((it) => ({
              type: typeof it.type === "string" ? it.type : "",
              payloadJson: typeof it.payloadJson === "string" ? it.payloadJson : "{}"
            }))
        : undefined
    });
    return withServerTiming(NextResponse.json({ data: { item }, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_AUTOMATION_UPDATE_FAILED", "Failed to update AI automation rule."), startedAt);
  }
}

export async function DELETE(request: NextRequest) {
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
    const automationId = typeof body.automationId === "string" ? body.automationId : "";
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const result = await deleteAiAutomation(auth.session.userId, orgId, automationId);
    return withServerTiming(NextResponse.json({ data: result, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_AUTOMATION_DELETE_FAILED", "Failed to delete AI automation rule."), startedAt);
  }
}

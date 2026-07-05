import { type NextRequest, NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/middleware";
import { createAiKnowledge, deleteAiKnowledge, listAiKnowledge, updateAiKnowledge } from "@/server/services/aiAutomationService";
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
    const type = request.nextUrl.searchParams.get("type") ?? undefined;
    const isActiveRaw = request.nextUrl.searchParams.get("isActive");
    const isActive = isActiveRaw === null ? undefined : isActiveRaw === "true";
    const items = await listAiKnowledge(auth.session.userId, orgId, { type, isActive });
    return withServerTiming(NextResponse.json({ data: { items }, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_KNOWLEDGE_LIST_FAILED", "Failed to load AI knowledge."), startedAt);
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
    const item = await createAiKnowledge(auth.session.userId, orgId, {
      type: typeof body.type === "string" ? body.type : "",
      title: typeof body.title === "string" ? body.title : "",
      content: typeof body.content === "string" ? body.content : "",
      question: typeof body.question === "string" || body.question === null ? body.question : undefined,
      answer: typeof body.answer === "string" || body.answer === null ? body.answer : undefined,
      sourceUrl: typeof body.sourceUrl === "string" || body.sourceUrl === null ? body.sourceUrl : undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined
    });
    return withServerTiming(NextResponse.json({ data: { item }, meta: {} }, { status: 201 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_KNOWLEDGE_CREATE_FAILED", "Failed to create AI knowledge."), startedAt);
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
    const knowledgeId = typeof body.knowledgeId === "string" ? body.knowledgeId : "";
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const item = await updateAiKnowledge(auth.session.userId, orgId, knowledgeId, {
      type: typeof body.type === "string" ? body.type : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      question: typeof body.question === "string" || body.question === null ? body.question : undefined,
      answer: typeof body.answer === "string" || body.answer === null ? body.answer : undefined,
      sourceUrl: typeof body.sourceUrl === "string" || body.sourceUrl === null ? body.sourceUrl : undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined
    });
    return withServerTiming(NextResponse.json({ data: { item }, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_KNOWLEDGE_UPDATE_FAILED", "Failed to update AI knowledge."), startedAt);
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
    const knowledgeId = typeof body.knowledgeId === "string" ? body.knowledgeId : "";
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const result = await deleteAiKnowledge(auth.session.userId, orgId, knowledgeId);
    return withServerTiming(NextResponse.json({ data: result, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_KNOWLEDGE_DELETE_FAILED", "Failed to delete AI knowledge."), startedAt);
  }
}

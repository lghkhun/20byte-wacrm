import { type NextRequest, NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/middleware";
import { previewAiReply } from "@/server/services/aiAutomationService";
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
    const result = await previewAiReply(auth.session.userId, orgId, {
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      type: typeof body.type === "string" ? body.type : undefined,
      conversationId: typeof body.conversationId === "string" || body.conversationId === null ? body.conversationId : undefined,
      customerId: typeof body.customerId === "string" || body.customerId === null ? body.customerId : undefined,
      stopIfHumanReplyTriggered: typeof body.stopIfHumanReplyTriggered === "boolean" ? body.stopIfHumanReplyTriggered : undefined
    });
    return withServerTiming(NextResponse.json({ data: result, meta: {} }, { status: 200 }), startedAt);
  } catch (error) {
    if (error instanceof ServiceError) {
      return withServerTiming(errorResponse(error.status, error.code, error.message), startedAt);
    }
    return withServerTiming(errorResponse(500, "AI_PREVIEW_FAILED", "Failed to preview AI response."), startedAt);
  }
}

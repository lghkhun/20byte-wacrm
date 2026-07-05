import { type NextRequest, NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/middleware";
import { importAiKnowledgeFromUrl } from "@/server/services/aiAutomationService";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { ServiceError } from "@/server/services/serviceError";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const item = await importAiKnowledgeFromUrl(auth.session.userId, orgId, {
      url: typeof body.url === "string" ? body.url : "",
      title: typeof body.title === "string" ? body.title : undefined,
      type: typeof body.type === "string" ? body.type : undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined
    });

    return NextResponse.json({ data: { item }, meta: {} }, { status: 201 });
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "AI_KNOWLEDGE_IMPORT_URL_FAILED", "Failed to import AI knowledge URL.");
  }
}

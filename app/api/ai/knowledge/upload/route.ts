import { type NextRequest, NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/middleware";
import { uploadAiKnowledgeDocument } from "@/server/services/aiAutomationService";
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(400, "INVALID_FORM_DATA", "Request body must be multipart form data.");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errorResponse(400, "MISSING_FILE", "file is required.");
  }

  const fileName = file.name.toLowerCase();
  const mimeType = (file.type || "").toLowerCase();
  const isPdf = mimeType === "application/pdf" || fileName.endsWith(".pdf");
  const isMarkdown = mimeType === "text/markdown" || mimeType === "text/plain" || fileName.endsWith(".md");
  if (!isPdf && !isMarkdown) {
    return errorResponse(400, "INVALID_FILE_TYPE", "Only PDF or Markdown (.md) file is allowed.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, String(formData.get("orgId") ?? ""));
    const item = await uploadAiKnowledgeDocument(auth.session.userId, orgId, {
      fileName: file.name,
      mimeType: file.type || (fileName.endsWith(".md") ? "text/markdown" : "application/pdf"),
      buffer: Buffer.from(await file.arrayBuffer()),
      title: String(formData.get("title") ?? "") || undefined,
      type: String(formData.get("type") ?? "") || undefined,
      priority: Number(formData.get("priority") ?? "0")
    });

    return NextResponse.json({ data: { item }, meta: {} }, { status: 201 });
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "AI_KNOWLEDGE_UPLOAD_FAILED", "Failed to upload AI knowledge document.");
  }
}

import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { requireApiSession } from "@/lib/auth/middleware";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import {
  createWhatsAppFlow,
  deleteWhatsAppFlow,
  listWhatsAppFlows,
  updateWhatsAppFlow
} from "@/server/services/whatsappCampaignService";
import { ServiceError } from "@/server/services/serviceError";

type FlowNodeRequest = {
  key?: unknown;
  type?: unknown;
  configJson?: unknown;
  positionX?: unknown;
  positionY?: unknown;
};

type FlowEdgeRequest = {
  fromNodeKey?: unknown;
  toNodeKey?: unknown;
  conditionKey?: unknown;
};

type CreateOrUpdateFlowRequest = {
  orgId?: unknown;
  flowId?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  triggerType?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

function parseNodes(value: unknown): Array<{
  key: string;
  type: "SEND_TEMPLATE" | "SEND_TEXT" | "DELAY" | "STOP";
  configJson?: string;
  positionX?: number;
  positionY?: number;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is FlowNodeRequest => Boolean(item) && typeof item === "object")
    .map((item) => {
      const typeRaw = typeof item.type === "string" ? item.type.trim().toUpperCase() : "";
      const type = typeRaw === "SEND_TEMPLATE" || typeRaw === "SEND_TEXT" || typeRaw === "DELAY" || typeRaw === "STOP" ? typeRaw : "STOP";
      return {
        key: typeof item.key === "string" ? item.key : "",
        type,
        configJson: typeof item.configJson === "string" ? item.configJson : undefined,
        positionX: typeof item.positionX === "number" ? item.positionX : undefined,
        positionY: typeof item.positionY === "number" ? item.positionY : undefined
      };
    });
}

function parseEdges(value: unknown): Array<{
  fromNodeKey: string;
  toNodeKey: string;
  conditionKey?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is FlowEdgeRequest => Boolean(item) && typeof item === "object")
    .map((item) => ({
      fromNodeKey: typeof item.fromNodeKey === "string" ? item.fromNodeKey : "",
      toNodeKey: typeof item.toNodeKey === "string" ? item.toNodeKey : "",
      conditionKey: typeof item.conditionKey === "string" ? item.conditionKey : undefined
    }));
}

export async function GET(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, request.nextUrl.searchParams.get("orgId") ?? "");
    const items = await listWhatsAppFlows(auth.session.userId, orgId);
    return successResponse({ items }, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_FLOW_LIST_FAILED", "Failed to load WhatsApp flows.");
  }
}

export async function POST(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: CreateOrUpdateFlowRequest;
  try {
    body = (await request.json()) as CreateOrUpdateFlowRequest;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const item = await createWhatsAppFlow(auth.session.userId, orgId, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" || body.description === null ? body.description : undefined,
      status:
        typeof body.status === "string" &&
        (body.status === "DRAFT" || body.status === "ACTIVE" || body.status === "PAUSED" || body.status === "ARCHIVED")
          ? body.status
          : undefined,
      triggerType:
        typeof body.triggerType === "string" && (body.triggerType === "MANUAL" || body.triggerType === "CHAT_INCOMING")
          ? body.triggerType
          : undefined,
      nodes: parseNodes(body.nodes),
      edges: parseEdges(body.edges)
    });

    return successResponse({ item }, 201);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_FLOW_CREATE_FAILED", "Failed to create WhatsApp flow.");
  }
}

export async function PATCH(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: CreateOrUpdateFlowRequest;
  try {
    body = (await request.json()) as CreateOrUpdateFlowRequest;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const flowId = typeof body.flowId === "string" ? body.flowId : "";
    const item = await updateWhatsAppFlow(auth.session.userId, orgId, flowId, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" || body.description === null ? body.description : undefined,
      status:
        typeof body.status === "string" &&
        (body.status === "DRAFT" || body.status === "ACTIVE" || body.status === "PAUSED" || body.status === "ARCHIVED")
          ? body.status
          : undefined,
      triggerType:
        typeof body.triggerType === "string" && (body.triggerType === "MANUAL" || body.triggerType === "CHAT_INCOMING")
          ? body.triggerType
          : undefined,
      nodes: body.nodes !== undefined ? parseNodes(body.nodes) : undefined,
      edges: body.edges !== undefined ? parseEdges(body.edges) : undefined
    });
    return successResponse({ item }, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_FLOW_UPDATE_FAILED", "Failed to update WhatsApp flow.");
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  let body: CreateOrUpdateFlowRequest;
  try {
    body = (await request.json()) as CreateOrUpdateFlowRequest;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  try {
    const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, typeof body.orgId === "string" ? body.orgId : "");
    const flowId = typeof body.flowId === "string" ? body.flowId : "";
    const result = await deleteWhatsAppFlow(auth.session.userId, orgId, flowId);
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, "WHATSAPP_FLOW_DELETE_FAILED", "Failed to delete WhatsApp flow.");
  }
}

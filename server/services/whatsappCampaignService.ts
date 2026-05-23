import {
  Role,
  type WaTemplateCategory,
  type WhatsAppExecutionStopReason,
  type WhatsAppExecutionStatus,
  type WhatsAppFlowNodeType,
  type WhatsAppFlowStatus
} from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { enqueueWhatsAppCampaignExecutionJob } from "@/server/queues/whatsappCampaignQueue";
import {
  parseRuleActions,
  parseRuleConditionExpr,
  shouldRunRule,
  validateRuleActionExpr,
  validateRuleConditionExpr,
  type CampaignRuleAction,
  type CampaignRuleEvent
} from "@/server/services/whatsappCampaignRules";
import { sendInvoiceToCustomer } from "@/server/services/invoiceService";
import { sendOutboundMessage } from "@/server/services/messageService";
import { ServiceError } from "@/server/services/serviceError";

type FlowNodeInput = {
  key: string;
  type: WhatsAppFlowNodeType;
  configJson?: string;
  positionX?: number;
  positionY?: number;
};

type FlowEdgeInput = {
  fromNodeKey: string;
  toNodeKey: string;
  conditionKey?: string;
};

type SendTemplateNodeConfig = {
  templateName: string;
  templateLanguageCode?: string;
  templateCategory?: WaTemplateCategory;
  templateComponents: Array<Record<string, unknown>>;
  text?: string;
};

type DelayNodeConfig = {
  delaySeconds?: number;
};

type SendTextNodeConfig = {
  text: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function ensureValidFlowGraph(
  nodes: Array<{
    key: string;
  }>,
  edges: Array<{
    fromNodeKey: string;
    toNodeKey: string;
  }>
): void {
  const nodeKeys = new Set<string>();
  for (const node of nodes) {
    const key = normalize(node.key);
    if (!key) {
      throw new ServiceError(400, "INVALID_INPUT", "node key is required.");
    }
    if (nodeKeys.has(key)) {
      throw new ServiceError(400, "INVALID_INPUT", `duplicate node key: ${key}`);
    }
    nodeKeys.add(key);
  }

  for (const edge of edges) {
    const fromNodeKey = normalize(edge.fromNodeKey);
    const toNodeKey = normalize(edge.toNodeKey);
    if (!fromNodeKey || !toNodeKey) {
      throw new ServiceError(400, "INVALID_INPUT", "edge fromNodeKey and toNodeKey are required.");
    }
    if (!nodeKeys.has(fromNodeKey) || !nodeKeys.has(toNodeKey)) {
      throw new ServiceError(400, "INVALID_INPUT", "edge contains unknown node key.");
    }
  }
}

async function requireOrgWriteAccess(actorUserId: string, orgIdInput: string): Promise<string> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId: actorUserId } },
    select: { role: true }
  });
  if (!member) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }
  if (member.role !== Role.OWNER && member.role !== Role.ADMIN) {
    throw new ServiceError(403, "FORBIDDEN_FLOW_MANAGE", "Only owner/admin can manage WhatsApp flows.");
  }
  return orgId;
}

async function requireOrgReadAccess(actorUserId: string, orgIdInput: string): Promise<string> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId: actorUserId } },
    select: { id: true }
  });
  if (!member) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }
  return orgId;
}

function parseFlowNodeConfig(type: WhatsAppFlowNodeType, configJson: string): SendTemplateNodeConfig | DelayNodeConfig | SendTextNodeConfig {
  const raw = parseJsonRecord(configJson);
  if (type === "SEND_TEMPLATE") {
    const templateName = normalize(typeof raw.templateName === "string" ? raw.templateName : "");
    const templateLanguageCode = normalize(typeof raw.templateLanguageCode === "string" ? raw.templateLanguageCode : "") || undefined;
    const templateCategoryRaw = normalize(typeof raw.templateCategory === "string" ? raw.templateCategory : "");
    const templateCategory =
      templateCategoryRaw === "MARKETING" ||
      templateCategoryRaw === "UTILITY" ||
      templateCategoryRaw === "AUTHENTICATION" ||
      templateCategoryRaw === "SERVICE"
        ? (templateCategoryRaw as WaTemplateCategory)
        : undefined;
    const templateComponents = Array.isArray(raw.templateComponents)
      ? raw.templateComponents.filter((it) => Boolean(it) && typeof it === "object") as Array<Record<string, unknown>>
      : [];
    const text = normalize(typeof raw.text === "string" ? raw.text : "") || undefined;
    return { templateName, templateLanguageCode, templateCategory, templateComponents, text };
  }
  if (type === "DELAY") {
    const delaySecondsRaw = Number(raw.delaySeconds);
    const delaySeconds =
      Number.isFinite(delaySecondsRaw) && delaySecondsRaw > 0 ? Math.min(7 * 24 * 60 * 60, Math.floor(delaySecondsRaw)) : 0;
    return { delaySeconds };
  }
  if (type === "SEND_TEXT") {
    const text = normalize(typeof raw.text === "string" ? raw.text : "");
    return { text };
  }
  return {};
}

function pickEntryNode(
  nodes: Array<{ key: string; type: WhatsAppFlowNodeType; configJson: string; createdAt: Date }>,
  edges: Array<{ toNodeKey: string }>
): { key: string; type: WhatsAppFlowNodeType; configJson: string } | null {
  if (nodes.length === 0) {
    return null;
  }
  const inboundTargets = new Set(edges.map((edge) => edge.toNodeKey));
  const byCreated = [...nodes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const entry = byCreated.find((node) => !inboundTargets.has(node.key)) ?? byCreated[0];
  return { key: entry.key, type: entry.type, configJson: entry.configJson };
}

function edgeConditionMatched(
  conditionKey: string | null | undefined,
  context: {
    textAllowed?: boolean;
    lastStatus?: "SENT" | "FAILED" | "SKIPPED";
  }
): boolean {
  const key = normalize(conditionKey ?? "").toUpperCase();
  if (!key || key === "ALWAYS" || key === "DEFAULT") {
    return true;
  }
  if (key === "TEXT_ALLOWED") {
    return context.textAllowed === true;
  }
  if (key === "TEXT_BLOCKED") {
    return context.textAllowed === false;
  }
  if (key === "LAST_SENT") {
    return context.lastStatus === "SENT";
  }
  if (key === "LAST_FAILED") {
    return context.lastStatus === "FAILED";
  }
  if (key === "LAST_SKIPPED") {
    return context.lastStatus === "SKIPPED";
  }
  return false;
}

function pickNextNodeKey(
  currentNodeKey: string,
  edges: Array<{ fromNodeKey: string; toNodeKey: string; createdAt: Date; conditionKey?: string | null }>,
  context: {
    textAllowed?: boolean;
    lastStatus?: "SENT" | "FAILED" | "SKIPPED";
  } = {}
): string | null {
  const next = edges
    .filter((edge) => edge.fromNodeKey === currentNodeKey)
    .filter((edge) => edgeConditionMatched(edge.conditionKey, context))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  return next?.toNodeKey ?? null;
}

async function logComplianceEvent(input: {
  orgId: string;
  flowId?: string | null;
  enrollmentId?: string | null;
  executionId?: string | null;
  eventType: string;
  decision: string;
  reasonCode?: string | null;
  reasonDetail?: string | null;
}) {
  await prisma.whatsAppComplianceEvent.create({
    data: {
      orgId: input.orgId,
      flowId: normalize(input.flowId ?? undefined) || null,
      enrollmentId: normalize(input.enrollmentId ?? undefined) || null,
      executionId: normalize(input.executionId ?? undefined) || null,
      eventType: input.eventType,
      decision: input.decision,
      reasonCode: normalize(input.reasonCode ?? undefined) || null,
      reasonDetail: normalize(input.reasonDetail ?? undefined) || null
    }
  });
}

const DIDNT_READ_TIMEOUT_SECONDS = 24 * 60 * 60;
const RULE_SYSTEM_ACTOR = "system:rule-engine";

function isRuleTriggerTypeCompatible(triggerTypeRaw: string, eventType: CampaignRuleEvent["eventType"]): boolean {
  const triggerType = normalize(triggerTypeRaw).toUpperCase();
  if (!triggerType) return true;
  if (
    triggerType === "SUBSCRIBED_SEQUENCE" ||
    triggerType === "UNSUBSCRIBED_SEQUENCE" ||
    triggerType === "COMPLETED_SEQUENCE" ||
    triggerType === "READ_MESSAGE" ||
    triggerType === "DIDNT_READ_MESSAGE"
  ) {
    return triggerType === eventType;
  }
  return true;
}

function buildRuleActionDedupeKey(ruleId: string, actionType: string, event: CampaignRuleEvent): string {
  const eventKey = [
    event.eventType,
    normalize(event.flowId),
    normalize(event.sequenceId),
    normalize(event.broadcastId),
    normalize(event.conversationId),
    normalize(event.customerId),
    normalize(event.messageId),
    normalize(event.waMessageId)
  ].join(":");
  return `${normalize(ruleId)}:${normalize(actionType)}:${eventKey}`;
}

async function alreadyExecutedRuleAction(orgId: string, dedupeKey: string): Promise<boolean> {
  const existing = await prisma.whatsAppComplianceEvent.findFirst({
    where: {
      orgId,
      eventType: "RULE_ACTION_EXECUTED",
      reasonCode: dedupeKey
    },
    select: { id: true }
  });
  return Boolean(existing);
}

async function scheduleDidntReadCheck(input: {
  orgId: string;
  flowId?: string | null;
  ruleId?: string | null;
  messageScope: "SEQUENCE" | "BROADCAST";
  sequenceId?: string | null;
  broadcastId?: string | null;
  conversationId: string;
  customerId: string;
  messageId: string;
  waMessageId?: string | null;
  dueAt?: Date;
}) {
  const dueAt = input.dueAt ?? new Date(Date.now() + DIDNT_READ_TIMEOUT_SECONDS * 1000);
  await prisma.whatsAppRulePendingCheck.upsert({
    where: {
      orgId_messageId_eventType: {
        orgId: input.orgId,
        messageId: input.messageId,
        eventType: "DIDNT_READ_MESSAGE"
      }
    },
    create: {
      orgId: input.orgId,
      flowId: normalize(input.flowId ?? undefined) || null,
      ruleId: normalize(input.ruleId ?? undefined) || null,
      eventType: "DIDNT_READ_MESSAGE",
      messageScope: input.messageScope,
      sequenceId: normalize(input.sequenceId ?? undefined) || null,
      broadcastId: normalize(input.broadcastId ?? undefined) || null,
      conversationId: input.conversationId,
      customerId: input.customerId,
      messageId: input.messageId,
      waMessageId: normalize(input.waMessageId ?? undefined) || null,
      dueAt,
      status: "PENDING"
    },
    update: {
      flowId: normalize(input.flowId ?? undefined) || null,
      ruleId: normalize(input.ruleId ?? undefined) || null,
      messageScope: input.messageScope,
      sequenceId: normalize(input.sequenceId ?? undefined) || null,
      broadcastId: normalize(input.broadcastId ?? undefined) || null,
      conversationId: input.conversationId,
      customerId: input.customerId,
      waMessageId: normalize(input.waMessageId ?? undefined) || null,
      dueAt,
      status: "PENDING",
      processedAt: null
    }
  });
  await logComplianceEvent({
    orgId: input.orgId,
    flowId: input.flowId,
    eventType: "RULE_DIDNT_READ_SCHEDULED",
    decision: "ALLOW",
    reasonCode: input.messageId
  });
}

async function cancelDidntReadCheckForRead(input: {
  orgId: string;
  messageId?: string | null;
  waMessageId?: string | null;
}) {
  const orgId = normalize(input.orgId);
  const messageId = normalize(input.messageId ?? undefined);
  const waMessageId = normalize(input.waMessageId ?? undefined);
  if (!orgId || (!messageId && !waMessageId)) {
    return;
  }

  const where =
    messageId
      ? { orgId, messageId, eventType: "DIDNT_READ_MESSAGE", status: "PENDING" as const }
      : { orgId, waMessageId, eventType: "DIDNT_READ_MESSAGE", status: "PENDING" as const };

  const pendings = await prisma.whatsAppRulePendingCheck.findMany({
    where,
    select: { id: true, flowId: true, messageId: true }
  });
  if (pendings.length === 0) return;

  await prisma.whatsAppRulePendingCheck.updateMany({
    where: { id: { in: pendings.map((item) => item.id) } },
    data: {
      status: "CANCELED",
      processedAt: new Date()
    }
  });
  for (const pending of pendings) {
    await logComplianceEvent({
      orgId,
      flowId: pending.flowId,
      eventType: "RULE_DIDNT_READ_CANCELED",
      decision: "ALLOW",
      reasonCode: pending.messageId
    });
  }
}

async function executeRuleActionForEvent(input: {
  rule: { id: string; createdByUserId?: string | null; flowId: string };
  event: CampaignRuleEvent;
  action: CampaignRuleAction;
}): Promise<void> {
  const { event, action, rule } = input;
  const actionType = normalize(action.actionType).toUpperCase();
  if (!event.orgId || !event.conversationId || !event.customerId) {
    return;
  }
  const dedupeKey = buildRuleActionDedupeKey(rule.id, actionType, event);
  if (await alreadyExecutedRuleAction(event.orgId, dedupeKey)) {
    return;
  }
  const actorUserId = normalize(event.actorUserId ?? rule.createdByUserId ?? "") || RULE_SYSTEM_ACTOR;

  if (actionType === "SUBSCRIBE_SEQUENCE") {
    const targetFlowId = normalize(action.sequenceId);
    if (!targetFlowId) {
      return;
    }
    await autoEnrollOrKeepActive({
      orgId: event.orgId,
      flowId: targetFlowId,
      conversationId: event.conversationId,
      customerId: event.customerId
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "UNSUBSCRIBE_SEQUENCE") {
    const targetFlowId = normalize(action.sequenceId);
    if (!targetFlowId) {
      return;
    }
    await stopEnrollmentByConversation({
      actorUserId,
      orgId: event.orgId,
      flowId: targetFlowId,
      conversationId: event.conversationId,
      emitRuleEvents: false
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "MOVE_SEQUENCE") {
    const fromFlowId = normalize(action.fromSequenceId);
    const toFlowId = normalize(action.toSequenceId);
    if (!fromFlowId || !toFlowId) {
      return;
    }
    if (fromFlowId === toFlowId) {
      return;
    }
    await stopEnrollmentByConversation({
      actorUserId,
      orgId: event.orgId,
      flowId: fromFlowId,
      conversationId: event.conversationId,
      emitRuleEvents: false
    });
    await autoEnrollOrKeepActive({
      orgId: event.orgId,
      flowId: toFlowId,
      conversationId: event.conversationId,
      customerId: event.customerId
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "APPLY_TAG" || actionType === "REMOVE_TAG") {
    const tagId = normalize(action.tagId);
    if (!tagId) return;
    if (actionType === "APPLY_TAG") {
      await prisma.customerTag.upsert({
        where: {
          customerId_tagId: {
            customerId: event.customerId,
            tagId
          }
        },
        update: {},
        create: {
          orgId: event.orgId,
          customerId: event.customerId,
          tagId
        }
      });
    } else {
      await prisma.customerTag.deleteMany({
        where: {
          orgId: event.orgId,
          customerId: event.customerId,
          tagId
        }
      });
    }
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "SEND_INVOICE") {
    const invoiceId = normalize(action.invoiceId);
    if (!invoiceId) return;
    await sendInvoiceToCustomer({
      actorUserId,
      orgId: event.orgId,
      invoiceId
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "UPDATE_STATUS_LEAD" || actionType === "UPDATE_FOLLOWUP" || actionType === "UPDATE_BUSINESS_CATEGORY") {
    await prisma.customer.updateMany({
      where: {
        id: event.customerId,
        orgId: event.orgId
      },
      data: {
        ...(actionType === "UPDATE_STATUS_LEAD" ? { leadStatus: normalize(action.leadStatus) } : {}),
        ...(actionType === "UPDATE_FOLLOWUP" ? { followUpStatus: normalize(action.followUpStatus) || null } : {}),
        ...(actionType === "UPDATE_BUSINESS_CATEGORY" ? { businessCategory: normalize(action.businessCategory) || null } : {})
      }
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "UPDATE_ASSIGN") {
    const assigneeId = normalize(action.assigneeId);
    if (!assigneeId) return;
    const member = await prisma.orgMember.findFirst({
      where: { id: assigneeId, orgId: event.orgId },
      select: { id: true }
    });
    if (!member) return;
    await prisma.conversation.updateMany({
      where: { id: event.conversationId, orgId: event.orgId },
      data: { assignedToMemberId: member.id }
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "UPDATE_PIPELINE_STAGE") {
    const stageName = normalize(action.pipelineStage);
    if (!stageName) return;
    const stage = await prisma.crmPipelineStage.findFirst({
      where: { orgId: event.orgId, name: stageName },
      select: { id: true, pipelineId: true }
    });
    if (!stage) return;
    await prisma.conversation.updateMany({
      where: { id: event.conversationId, orgId: event.orgId },
      data: {
        crmPipelineId: stage.pipelineId,
        crmStageId: stage.id
      }
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }

  if (actionType === "DELETE_CUSTOMER") {
    await prisma.$transaction(async (tx) => {
      await tx.customerTag.deleteMany({
        where: { orgId: event.orgId, customerId: event.customerId }
      });
      await tx.customerNote.deleteMany({
        where: { orgId: event.orgId, customerId: event.customerId }
      });
      await tx.customer.delete({
        where: { id: event.customerId }
      });
    });
    await logComplianceEvent({
      orgId: event.orgId,
      flowId: rule.flowId,
      eventType: "RULE_ACTION_EXECUTED",
      decision: "ALLOW",
      reasonCode: dedupeKey
    });
    return;
  }
}

async function processFlowRulesForEvent(event: CampaignRuleEvent): Promise<void> {
  const orgId = normalize(event.orgId);
  if (!orgId) {
    return;
  }

  const rules = await prisma.whatsAppFlowRule.findMany({
    where: {
      orgId,
      isActive: true
    },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }]
  });
  if (rules.length === 0) {
    return;
  }

  for (const rule of rules) {
    if (!isRuleTriggerTypeCompatible(rule.triggerType, event.eventType)) {
      await logComplianceEvent({
        orgId,
        flowId: rule.flowId,
        eventType: "RULE_SKIPPED",
        decision: "BLOCK",
        reasonCode: "TRIGGER_TYPE_MISMATCH"
      });
      continue;
    }
    if (!shouldRunRule(rule.conditionExpr, event)) {
      await logComplianceEvent({
        orgId,
        flowId: rule.flowId,
        eventType: "RULE_SKIPPED",
        decision: "BLOCK",
        reasonCode: "CONDITION_NOT_MATCHED"
      });
      continue;
    }
    await logComplianceEvent({
      orgId,
      flowId: rule.flowId,
      eventType: "RULE_EVALUATED",
      decision: "ALLOW",
      reasonCode: rule.id
    });
    const actions = parseRuleActions(rule.actionType);
    for (const action of actions) {
      try {
        await executeRuleActionForEvent({
          rule: {
            id: rule.id,
            createdByUserId: rule.createdByUserId,
            flowId: rule.flowId
          },
          event,
          action
        });
      } catch (error) {
        await logComplianceEvent({
          orgId,
          flowId: rule.flowId,
          eventType: "RULE_ACTION_FAILED",
          decision: "BLOCK",
          reasonCode: normalize(action.actionType) || "UNKNOWN_ACTION",
          reasonDetail: error instanceof Error ? error.message : "Rule action failed."
        });
      }
    }
  }
}

async function enqueueExecution(input: {
  orgId: string;
  flowId: string;
  enrollmentId: string;
  nodeKey: string;
  nodeType: WhatsAppFlowNodeType;
  dueAt: Date;
  payloadJson?: string;
}) {
  const execution = await prisma.whatsAppExecution.create({
    data: {
      orgId: input.orgId,
      flowId: input.flowId,
      enrollmentId: input.enrollmentId,
      nodeKey: input.nodeKey,
      nodeType: input.nodeType,
      dueAt: input.dueAt,
      payloadJson: input.payloadJson
    }
  });

  await enqueueWhatsAppCampaignExecutionJob({
    orgId: input.orgId,
    executionId: execution.id,
    dueAt: execution.dueAt.toISOString()
  });

  return execution;
}

export async function listWhatsAppFlows(actorUserId: string, orgIdInput: string) {
  const orgId = await requireOrgReadAccess(actorUserId, orgIdInput);
  return prisma.whatsAppFlow.findMany({
    where: { orgId },
    include: {
      nodes: { orderBy: [{ createdAt: "asc" }] },
      edges: { orderBy: [{ createdAt: "asc" }] }
    },
    orderBy: [{ createdAt: "desc" }]
  });
}

export async function createWhatsAppFlow(
  actorUserId: string,
  orgIdInput: string,
  input: {
    name: string;
    description?: string | null;
    status?: WhatsAppFlowStatus;
    triggerType?: "MANUAL" | "CHAT_INCOMING";
    nodes?: FlowNodeInput[];
    edges?: FlowEdgeInput[];
  }
) {
  const orgId = await requireOrgWriteAccess(actorUserId, orgIdInput);
  const name = normalize(input.name);
  if (!name) {
    throw new ServiceError(400, "INVALID_INPUT", "name is required.");
  }

  const status = input.status ?? "DRAFT";
  const nodes = (input.nodes ?? []).map((node) => ({
    key: normalize(node.key),
    type: node.type,
    configJson: normalize(node.configJson ?? "{}") || "{}",
    positionX: Number.isFinite(node.positionX) ? Math.floor(node.positionX ?? 0) : 0,
    positionY: Number.isFinite(node.positionY) ? Math.floor(node.positionY ?? 0) : 0
  }));
  const edges = (input.edges ?? []).map((edge) => ({
    fromNodeKey: normalize(edge.fromNodeKey),
    toNodeKey: normalize(edge.toNodeKey),
    conditionKey: normalize(edge.conditionKey) || null
  }));

  for (const node of nodes) {
    if (!node.key) {
      throw new ServiceError(400, "INVALID_INPUT", "node key is required.");
    }
  }
  ensureValidFlowGraph(nodes, edges);

  return prisma.$transaction(async (tx) => {
    const flow = await tx.whatsAppFlow.create({
      data: {
        orgId,
        createdByUserId: actorUserId,
        name,
        description: normalize(input.description ?? undefined) || null,
        status,
        triggerType: input.triggerType ?? "MANUAL",
        isTemplateOnly: true
      }
    });

    if (nodes.length > 0) {
      await tx.whatsAppFlowNode.createMany({
        data: nodes.map((node) => ({
          orgId,
          flowId: flow.id,
          key: node.key,
          type: node.type,
          configJson: node.configJson,
          positionX: node.positionX,
          positionY: node.positionY
        }))
      });
    }

    if (edges.length > 0) {
      await tx.whatsAppFlowEdge.createMany({
        data: edges.map((edge) => ({
          orgId,
          flowId: flow.id,
          fromNodeKey: edge.fromNodeKey,
          toNodeKey: edge.toNodeKey,
          conditionKey: edge.conditionKey
        }))
      });
    }

    return tx.whatsAppFlow.findUniqueOrThrow({
      where: { id: flow.id },
      include: {
        nodes: { orderBy: [{ createdAt: "asc" }] },
        edges: { orderBy: [{ createdAt: "asc" }] }
      }
    });
  });
}

export async function updateWhatsAppFlow(
  actorUserId: string,
  orgIdInput: string,
  flowIdInput: string,
  input: {
    name?: string;
    description?: string | null;
    status?: WhatsAppFlowStatus;
    triggerType?: "MANUAL" | "CHAT_INCOMING";
    nodes?: FlowNodeInput[];
    edges?: FlowEdgeInput[];
  }
) {
  const orgId = await requireOrgWriteAccess(actorUserId, orgIdInput);
  const flowId = normalize(flowIdInput);
  if (!flowId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId is required.");
  }

  const existing = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true }
  });
  if (!existing) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "WhatsApp flow not found.");
  }

  const nodes = input.nodes?.map((node) => ({
    key: normalize(node.key),
    type: node.type,
    configJson: normalize(node.configJson ?? "{}") || "{}",
    positionX: Number.isFinite(node.positionX) ? Math.floor(node.positionX ?? 0) : 0,
    positionY: Number.isFinite(node.positionY) ? Math.floor(node.positionY ?? 0) : 0
  }));

  const edges = input.edges?.map((edge) => ({
    fromNodeKey: normalize(edge.fromNodeKey),
    toNodeKey: normalize(edge.toNodeKey),
    conditionKey: normalize(edge.conditionKey) || null
  }));
  if (nodes && edges) {
    ensureValidFlowGraph(nodes, edges);
  }

  return prisma.$transaction(async (tx) => {
    await tx.whatsAppFlow.update({
      where: { id: flowId },
      data: {
        ...(input.name !== undefined ? { name: normalize(input.name) } : {}),
        ...(input.description !== undefined ? { description: normalize(input.description ?? undefined) || null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {})
      }
    });

    if (nodes) {
      await tx.whatsAppFlowNode.deleteMany({ where: { flowId } });
      if (nodes.length > 0) {
        await tx.whatsAppFlowNode.createMany({
          data: nodes.map((node) => ({
            orgId,
            flowId,
            key: node.key,
            type: node.type,
            configJson: node.configJson,
            positionX: node.positionX,
            positionY: node.positionY
          }))
        });
      }
    }

    if (edges) {
      await tx.whatsAppFlowEdge.deleteMany({ where: { flowId } });
      if (edges.length > 0) {
        await tx.whatsAppFlowEdge.createMany({
          data: edges.map((edge) => ({
            orgId,
            flowId,
            fromNodeKey: edge.fromNodeKey,
            toNodeKey: edge.toNodeKey,
            conditionKey: edge.conditionKey
          }))
        });
      }
    }

    return tx.whatsAppFlow.findUniqueOrThrow({
      where: { id: flowId },
      include: {
        nodes: { orderBy: [{ createdAt: "asc" }] },
        edges: { orderBy: [{ createdAt: "asc" }] }
      }
    });
  });
}

export async function deleteWhatsAppFlow(actorUserId: string, orgIdInput: string, flowIdInput: string) {
  const orgId = await requireOrgWriteAccess(actorUserId, orgIdInput);
  const flowId = normalize(flowIdInput);
  if (!flowId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId is required.");
  }

  const existing = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true }
  });
  if (!existing) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "WhatsApp flow not found.");
  }

  await prisma.whatsAppFlow.delete({ where: { id: flowId } });
  return { deleted: true };
}

export async function pauseWhatsAppFlow(actorUserId: string, orgIdInput: string, flowIdInput: string) {
  const orgId = await requireOrgWriteAccess(actorUserId, orgIdInput);
  const flowId = normalize(flowIdInput);
  if (!flowId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId is required.");
  }

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true, status: true }
  });
  if (!flow) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "WhatsApp flow not found.");
  }
  if (flow.status === "ARCHIVED") {
    throw new ServiceError(409, "FLOW_ARCHIVED", "Archived flow cannot be paused.");
  }

  const item = await prisma.whatsAppFlow.update({
    where: { id: flowId },
    data: { status: "PAUSED" }
  });

  await logComplianceEvent({
    orgId,
    flowId,
    eventType: "FLOW_STATUS_CHANGED",
    decision: "ALLOW",
    reasonCode: "PAUSED"
  });

  return item;
}

export async function resumeWhatsAppFlow(actorUserId: string, orgIdInput: string, flowIdInput: string) {
  const orgId = await requireOrgWriteAccess(actorUserId, orgIdInput);
  const flowId = normalize(flowIdInput);
  if (!flowId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId is required.");
  }

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true, status: true }
  });
  if (!flow) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "WhatsApp flow not found.");
  }
  if (flow.status === "ARCHIVED") {
    throw new ServiceError(409, "FLOW_ARCHIVED", "Archived flow cannot be resumed.");
  }

  const item = await prisma.whatsAppFlow.update({
    where: { id: flowId },
    data: { status: "ACTIVE" }
  });

  await logComplianceEvent({
    orgId,
    flowId,
    eventType: "FLOW_STATUS_CHANGED",
    decision: "ALLOW",
    reasonCode: "RESUMED"
  });

  return item;
}

export async function stopWhatsAppFlow(actorUserId: string, orgIdInput: string, flowIdInput: string) {
  const orgId = await requireOrgWriteAccess(actorUserId, orgIdInput);
  const flowId = normalize(flowIdInput);
  if (!flowId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId is required.");
  }

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true }
  });
  if (!flow) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "WhatsApp flow not found.");
  }

  const now = new Date();
  const activeEnrollments = await prisma.whatsAppEnrollment.findMany({
    where: {
      orgId,
      flowId,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  const enrollmentIds = activeEnrollments.map((item) => item.id);

  await prisma.$transaction(async (tx) => {
    await tx.whatsAppFlow.update({
      where: { id: flowId },
      data: { status: "ARCHIVED" }
    });

    if (enrollmentIds.length > 0) {
      await tx.whatsAppEnrollment.updateMany({
        where: { id: { in: enrollmentIds } },
        data: {
          status: "STOPPED",
          finishedAt: now,
          lastError: "Stopped manually by flow action."
        }
      });

      await tx.whatsAppExecution.updateMany({
        where: {
          orgId,
          flowId,
          enrollmentId: { in: enrollmentIds },
          status: "QUEUED"
        },
        data: {
          status: "STOPPED",
          stopReason: "MANUAL_STOP",
          executedAt: now,
          errorCode: "FLOW_STOPPED",
          errorMessage: "Execution stopped because flow was stopped manually."
        }
      });
    }
  });

  await logComplianceEvent({
    orgId,
    flowId,
    eventType: "FLOW_STATUS_CHANGED",
    decision: "ALLOW",
    reasonCode: "STOPPED"
  });

  return {
    stopped: true,
    archived: true,
    stoppedEnrollments: enrollmentIds.length
  };
}

export async function enrollConversationToWhatsAppFlow(input: {
  actorUserId: string;
  orgId: string;
  flowId: string;
  conversationId: string;
}) {
  const orgId = await requireOrgReadAccess(input.actorUserId, input.orgId);
  const flowId = normalize(input.flowId);
  const conversationId = normalize(input.conversationId);
  if (!flowId || !conversationId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId and conversationId are required.");
  }

  const [flow, conversation] = await Promise.all([
    prisma.whatsAppFlow.findFirst({
      where: { id: flowId, orgId },
      include: {
        nodes: { orderBy: [{ createdAt: "asc" }] },
        edges: { orderBy: [{ createdAt: "asc" }] }
      }
    }),
    prisma.conversation.findFirst({
      where: { id: conversationId, orgId },
      select: { id: true, customerId: true }
    })
  ]);

  if (!flow) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "WhatsApp flow not found.");
  }
  if (!conversation) {
    throw new ServiceError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  }
  if (flow.status !== "ACTIVE") {
    throw new ServiceError(409, "FLOW_NOT_ACTIVE", "Flow must be ACTIVE to enroll conversation.");
  }

  const existingActive = await prisma.whatsAppEnrollment.findFirst({
    where: {
      orgId,
      flowId,
      conversationId,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  if (existingActive) {
    return { enrollmentId: existingActive.id, deduped: true };
  }

  const entryNode = pickEntryNode(flow.nodes, flow.edges);
  if (!entryNode) {
    throw new ServiceError(409, "FLOW_NO_NODES", "Flow has no node to execute.");
  }

  const enrollment = await prisma.whatsAppEnrollment.create({
    data: {
      orgId,
      flowId,
      conversationId,
      customerId: conversation.customerId,
      enrolledByUserId: input.actorUserId,
      currentNodeKey: entryNode.key
    }
  });

  await enqueueExecution({
    orgId,
    flowId,
    enrollmentId: enrollment.id,
    nodeKey: entryNode.key,
    nodeType: entryNode.type,
    dueAt: new Date(),
    payloadJson: entryNode.configJson
  });

  await logComplianceEvent({
    orgId,
    flowId,
    enrollmentId: enrollment.id,
    eventType: "ENROLLMENT_CREATED",
    decision: "ALLOW"
  });

  await processFlowRulesForEvent({
    eventType: "SUBSCRIBED_SEQUENCE",
    orgId,
    flowId,
    sequenceId: flowId,
    conversationId,
    customerId: conversation.customerId,
    actorUserId: input.actorUserId
  });

  return { enrollmentId: enrollment.id, deduped: false };
}

async function autoEnrollOrKeepActive(input: {
  orgId: string;
  flowId: string;
  conversationId: string;
  customerId: string;
}): Promise<{ enrollmentId: string; deduped: boolean } | null> {
  const orgId = normalize(input.orgId);
  const flowId = normalize(input.flowId);
  const conversationId = normalize(input.conversationId);
  const customerId = normalize(input.customerId);
  if (!orgId || !flowId || !conversationId || !customerId) {
    return null;
  }

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId, status: "ACTIVE" },
    include: {
      nodes: { orderBy: [{ createdAt: "asc" }] },
      edges: { orderBy: [{ createdAt: "asc" }] }
    }
  });
  if (!flow) {
    return null;
  }

  const existingActive = await prisma.whatsAppEnrollment.findFirst({
    where: {
      orgId,
      flowId,
      conversationId,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  if (existingActive) {
    return { enrollmentId: existingActive.id, deduped: true };
  }

  const entryNode = pickEntryNode(flow.nodes, flow.edges);
  if (!entryNode) {
    return null;
  }

  const enrollment = await prisma.whatsAppEnrollment.create({
    data: {
      orgId,
      flowId,
      conversationId,
      customerId,
      enrolledByUserId: flow.createdByUserId,
      currentNodeKey: entryNode.key
    }
  });

  await enqueueExecution({
    orgId,
    flowId,
    enrollmentId: enrollment.id,
    nodeKey: entryNode.key,
    nodeType: entryNode.type,
    dueAt: new Date(),
    payloadJson: entryNode.configJson
  });

  return { enrollmentId: enrollment.id, deduped: false };
}

export async function autoEnrollWhatsAppFlowOnChatIncoming(input: {
  orgId: string;
  conversationId: string;
  customerId: string;
}): Promise<void> {
  const orgId = normalize(input.orgId);
  const conversationId = normalize(input.conversationId);
  const customerId = normalize(input.customerId);
  if (!orgId || !conversationId || !customerId) {
    return;
  }

  const flows = await prisma.whatsAppFlow.findMany({
    where: {
      orgId,
      status: "ACTIVE",
      triggerType: "CHAT_INCOMING"
    },
    include: {
      nodes: { orderBy: [{ createdAt: "asc" }] },
      edges: { orderBy: [{ createdAt: "asc" }] }
    }
  });

  if (flows.length === 0) {
    return;
  }

  for (const flow of flows) {
    const existingActive = await prisma.whatsAppEnrollment.findFirst({
      where: {
        orgId,
        flowId: flow.id,
        conversationId,
        status: "ACTIVE"
      },
      select: { id: true }
    });
    if (existingActive) {
      continue;
    }

    const entryNode = pickEntryNode(flow.nodes, flow.edges);
    if (!entryNode) {
      continue;
    }

    const enrollment = await prisma.whatsAppEnrollment.create({
      data: {
        orgId,
        flowId: flow.id,
        conversationId,
        customerId,
        enrolledByUserId: flow.createdByUserId,
        currentNodeKey: entryNode.key
      }
    });

    await enqueueExecution({
      orgId,
      flowId: flow.id,
      enrollmentId: enrollment.id,
      nodeKey: entryNode.key,
      nodeType: entryNode.type,
      dueAt: new Date(),
      payloadJson: entryNode.configJson
    });

    await logComplianceEvent({
      orgId,
      flowId: flow.id,
      enrollmentId: enrollment.id,
      eventType: "AUTO_ENROLL_CHAT_INCOMING",
      decision: "ALLOW"
    });

    await processFlowRulesForEvent({
      eventType: "SUBSCRIBED_SEQUENCE",
      orgId,
      flowId: flow.id,
      sequenceId: flow.id,
      conversationId,
      customerId
    });
  }
}

async function markExecutionStatus(input: {
  executionId: string;
  status: WhatsAppExecutionStatus;
  stopReason?: WhatsAppExecutionStopReason;
  errorCode?: string;
  errorMessage?: string;
  messageId?: string | null;
  waMessageId?: string | null;
}) {
  return prisma.whatsAppExecution.update({
    where: { id: input.executionId },
    data: {
      status: input.status,
      stopReason: input.stopReason,
      errorCode: normalize(input.errorCode) || null,
      errorMessage: normalize(input.errorMessage) || null,
      messageId: input.messageId ?? null,
      waMessageId: input.waMessageId ?? null,
      executedAt: new Date()
    }
  });
}

export async function processWhatsAppCampaignExecutionJob(executionIdInput: string): Promise<void> {
  const executionId = normalize(executionIdInput);
  if (!executionId) {
    return;
  }

  const execution = await prisma.whatsAppExecution.findUnique({
    where: { id: executionId },
    include: {
      enrollment: true,
      flow: {
        include: {
          nodes: true,
          edges: true
        }
      }
    }
  });

  if (!execution || execution.status !== "QUEUED") {
    return;
  }

  const orgId = execution.orgId;
  const enrollment = execution.enrollment;
  if (execution.flow.status !== "ACTIVE") {
    await markExecutionStatus({
      executionId,
      status: "STOPPED",
      stopReason: "MANUAL_STOP",
      errorCode: "FLOW_NOT_ACTIVE",
      errorMessage: "Flow is not active."
    });
    return;
  }

  if (enrollment.status !== "ACTIVE") {
    await markExecutionStatus({
      executionId,
      status: "STOPPED",
      stopReason: "ENROLLMENT_NOT_ACTIVE"
    });
    return;
  }

  const node = execution.flow.nodes.find((item) => item.key === execution.nodeKey);
  if (!node) {
    await markExecutionStatus({
      executionId,
      status: "FAILED",
      errorCode: "NODE_NOT_FOUND",
      errorMessage: "Node not found in flow."
    });
    return;
  }

  if (execution.flow.isTemplateOnly && node.type !== "SEND_TEMPLATE" && node.type !== "DELAY" && node.type !== "STOP") {
    await markExecutionStatus({
      executionId,
      status: "SKIPPED",
      stopReason: "TEMPLATE_ONLY_ENFORCED",
      errorCode: "TEMPLATE_ONLY_ENFORCED",
      errorMessage: "Node type is not allowed in template-only mode."
    });
    await logComplianceEvent({
      orgId,
      flowId: execution.flowId,
      enrollmentId: enrollment.id,
      executionId,
      eventType: "EXECUTION_GUARDRAIL",
      decision: "BLOCK",
      reasonCode: "TEMPLATE_ONLY_ENFORCED"
    });
    return;
  }

  if (node.type === "STOP") {
    await markExecutionStatus({
      executionId,
      status: "STOPPED",
      stopReason: "FLOW_COMPLETED"
    });
    await prisma.whatsAppEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: "COMPLETED",
        currentNodeKey: node.key,
        finishedAt: new Date()
      }
    });
    await processFlowRulesForEvent({
      eventType: "COMPLETED_SEQUENCE",
      orgId,
      flowId: execution.flowId,
      sequenceId: execution.flowId,
      conversationId: enrollment.conversationId,
      customerId: enrollment.customerId
    });
    return;
  }

  if (node.type === "DELAY") {
    const delayConfig = parseFlowNodeConfig("DELAY", node.configJson) as DelayNodeConfig;
    await markExecutionStatus({
      executionId,
      status: "SENT"
    });

    const nextNodeKey = pickNextNodeKey(node.key, execution.flow.edges, { lastStatus: "SENT" });
    if (!nextNodeKey) {
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "COMPLETED",
          currentNodeKey: node.key,
          finishedAt: new Date()
        }
      });
      await processFlowRulesForEvent({
        eventType: "COMPLETED_SEQUENCE",
        orgId,
        flowId: execution.flowId,
        sequenceId: execution.flowId,
        conversationId: enrollment.conversationId,
        customerId: enrollment.customerId
      });
      return;
    }

    const nextNode = execution.flow.nodes.find((item) => item.key === nextNodeKey);
    if (!nextNode) {
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "FAILED",
          currentNodeKey: node.key,
          lastError: "Next node not found."
        }
      });
      return;
    }

    const dueAt = new Date(Date.now() + Math.max(0, delayConfig.delaySeconds ?? 0) * 1000);
    await prisma.whatsAppEnrollment.update({
      where: { id: enrollment.id },
      data: { currentNodeKey: nextNode.key }
    });
    await enqueueExecution({
      orgId,
      flowId: execution.flowId,
      enrollmentId: enrollment.id,
      nodeKey: nextNode.key,
      nodeType: nextNode.type,
      dueAt,
      payloadJson: nextNode.configJson
    });
    return;
  }

  if (node.type === "SEND_TEXT") {
    const textConfig = parseFlowNodeConfig("SEND_TEXT", node.configJson) as SendTextNodeConfig;
    const text = normalize(textConfig.text);
    if (!text) {
      await markExecutionStatus({
        executionId,
        status: "FAILED",
        errorCode: "INVALID_TEXT_CONFIG",
        errorMessage: "Text node config is invalid."
      });
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "FAILED",
          currentNodeKey: node.key,
          lastError: "Text node config is invalid."
        }
      });
      return;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: enrollment.conversationId, orgId },
      select: {
        id: true,
        customerId: true,
        customer: {
          select: {
            phoneE164: true
          }
        }
      }
    });
    if (!conversation) {
      await markExecutionStatus({
        executionId,
        status: "FAILED",
        stopReason: "CONVERSATION_NOT_FOUND",
        errorCode: "CONVERSATION_NOT_FOUND",
        errorMessage: "Conversation not found."
      });
      return;
    }

    const [suppression, recentInbound] = await Promise.all([
      prisma.whatsAppSuppression.findFirst({
        where: {
          orgId,
          customerId: conversation.customerId,
          isActive: true
        },
        select: { id: true }
      }),
      prisma.message.findFirst({
        where: {
          orgId,
          conversationId: conversation.id,
          direction: "INBOUND",
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true }
      })
    ]);

    const textAllowed = !suppression && Boolean(recentInbound);
    if (!textAllowed) {
      await markExecutionStatus({
        executionId,
        status: "SKIPPED",
        errorCode: "TEXT_POLICY_BLOCKED",
        errorMessage: suppression ? "Suppression is active." : "No inbound message in last 24h window."
      });
      await logComplianceEvent({
        orgId,
        flowId: execution.flowId,
        enrollmentId: enrollment.id,
        executionId,
        eventType: "TEXT_SEND_GUARDRAIL",
        decision: "BLOCK",
        reasonCode: suppression ? "SUPPRESSION_ACTIVE" : "TEXT_WINDOW_EXPIRED"
      });

      const blockedNextNodeKey = pickNextNodeKey(node.key, execution.flow.edges, { textAllowed: false, lastStatus: "SKIPPED" });
      if (!blockedNextNodeKey) {
        await prisma.whatsAppEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: "STOPPED",
            currentNodeKey: node.key,
            finishedAt: new Date(),
            lastError: "Text send blocked by policy."
          }
        });
        return;
      }
      const blockedNextNode = execution.flow.nodes.find((item) => item.key === blockedNextNodeKey);
      if (!blockedNextNode) {
        await prisma.whatsAppEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: "FAILED",
            currentNodeKey: node.key,
            lastError: "Next node not found."
          }
        });
        return;
      }
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: { currentNodeKey: blockedNextNode.key }
      });
      await enqueueExecution({
        orgId,
        flowId: execution.flowId,
        enrollmentId: enrollment.id,
        nodeKey: blockedNextNode.key,
        nodeType: blockedNextNode.type,
        dueAt: new Date(),
        payloadJson: blockedNextNode.configJson
      });
      return;
    }

    try {
      const actorUserId = normalize(enrollment.enrolledByUserId ?? execution.flow.createdByUserId ?? "");
      if (!actorUserId) {
        await markExecutionStatus({
          executionId,
          status: "FAILED",
          stopReason: "SEND_FAILED",
          errorCode: "MISSING_EXECUTION_ACTOR",
          errorMessage: "Missing execution actor user."
        });
        return;
      }

      const sent = await sendOutboundMessage({
        actorUserId,
        orgId,
        conversationId: enrollment.conversationId,
        type: "TEXT",
        text,
        dispatchMode: "SYNC"
      });

      await markExecutionStatus({
        executionId,
        status: "SENT",
        messageId: sent.messageId,
        waMessageId: sent.waMessageId
      });
      await scheduleDidntReadCheck({
        orgId,
        flowId: execution.flowId,
        messageScope: "SEQUENCE",
        sequenceId: execution.flowId,
        conversationId: enrollment.conversationId,
        customerId: enrollment.customerId,
        messageId: sent.messageId,
        waMessageId: sent.waMessageId
      });
      await logComplianceEvent({
        orgId,
        flowId: execution.flowId,
        enrollmentId: enrollment.id,
        executionId,
        eventType: "TEXT_SEND_GUARDRAIL",
        decision: "ALLOW"
      });

      const nextNodeKey = pickNextNodeKey(node.key, execution.flow.edges, { textAllowed: true, lastStatus: "SENT" });
      if (!nextNodeKey) {
        await prisma.whatsAppEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: "COMPLETED",
            currentNodeKey: node.key,
            finishedAt: new Date()
          }
        });
        await processFlowRulesForEvent({
          eventType: "COMPLETED_SEQUENCE",
          orgId,
          flowId: execution.flowId,
          sequenceId: execution.flowId,
          conversationId: enrollment.conversationId,
          customerId: enrollment.customerId
        });
        return;
      }
      const nextNode = execution.flow.nodes.find((item) => item.key === nextNodeKey);
      if (!nextNode) {
        await prisma.whatsAppEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: "FAILED",
            currentNodeKey: node.key,
            lastError: "Next node not found."
          }
        });
        return;
      }
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: { currentNodeKey: nextNode.key }
      });
      await enqueueExecution({
        orgId,
        flowId: execution.flowId,
        enrollmentId: enrollment.id,
        nodeKey: nextNode.key,
        nodeType: nextNode.type,
        dueAt: new Date(),
        payloadJson: nextNode.configJson
      });
      return;
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : "TEXT_SEND_FAILED";
      const message = error instanceof Error ? error.message : "Text send failed.";
      await markExecutionStatus({
        executionId,
        status: "FAILED",
        stopReason: "SEND_FAILED",
        errorCode: code,
        errorMessage: message
      });
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "FAILED",
          currentNodeKey: node.key,
          lastError: message
        }
      });
      const failedNextNodeKey = pickNextNodeKey(node.key, execution.flow.edges, { textAllowed: true, lastStatus: "FAILED" });
      if (failedNextNodeKey) {
        const failedNextNode = execution.flow.nodes.find((item) => item.key === failedNextNodeKey);
        if (failedNextNode) {
          await prisma.whatsAppEnrollment.update({
            where: { id: enrollment.id },
            data: { status: "ACTIVE", currentNodeKey: failedNextNode.key }
          });
          await enqueueExecution({
            orgId,
            flowId: execution.flowId,
            enrollmentId: enrollment.id,
            nodeKey: failedNextNode.key,
            nodeType: failedNextNode.type,
            dueAt: new Date(),
            payloadJson: failedNextNode.configJson
          });
        }
      }
      return;
    }
  }

  const templateConfig = parseFlowNodeConfig("SEND_TEMPLATE", node.configJson) as SendTemplateNodeConfig;
  if (!templateConfig.templateName || templateConfig.templateComponents.length === 0) {
    await markExecutionStatus({
      executionId,
      status: "FAILED",
      errorCode: "INVALID_TEMPLATE_CONFIG",
      errorMessage: "Template node config is invalid."
    });
    await prisma.whatsAppEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: "FAILED",
        currentNodeKey: node.key,
        lastError: "Template node config is invalid."
      }
    });
    return;
  }

  try {
    const actorUserId = normalize(enrollment.enrolledByUserId ?? execution.flow.createdByUserId ?? "");
    if (!actorUserId) {
      await markExecutionStatus({
        executionId,
        status: "FAILED",
        stopReason: "SEND_FAILED",
        errorCode: "MISSING_EXECUTION_ACTOR",
        errorMessage: "Missing execution actor user."
      });
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "FAILED",
          currentNodeKey: node.key,
          lastError: "Missing execution actor user."
        }
      });
      return;
    }

    const sent = await sendOutboundMessage({
      actorUserId,
      orgId: execution.orgId,
      conversationId: enrollment.conversationId,
      type: "TEMPLATE",
      text: templateConfig.text,
      templateName: templateConfig.templateName,
      templateCategory: templateConfig.templateCategory,
      templateLanguageCode: templateConfig.templateLanguageCode,
      templateComponents: templateConfig.templateComponents,
      dispatchMode: "SYNC"
    });

    await markExecutionStatus({
      executionId,
      status: "SENT",
      messageId: sent.messageId,
      waMessageId: sent.waMessageId
    });
    await scheduleDidntReadCheck({
      orgId,
      flowId: execution.flowId,
      messageScope: "SEQUENCE",
      sequenceId: execution.flowId,
      conversationId: enrollment.conversationId,
      customerId: enrollment.customerId,
      messageId: sent.messageId,
      waMessageId: sent.waMessageId
    });

    await logComplianceEvent({
      orgId,
      flowId: execution.flowId,
      enrollmentId: enrollment.id,
      executionId,
      eventType: "TEMPLATE_SEND",
      decision: "ALLOW"
    });

    const nextNodeKey = pickNextNodeKey(node.key, execution.flow.edges, { lastStatus: "SENT" });
    if (!nextNodeKey) {
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "COMPLETED",
          currentNodeKey: node.key,
          finishedAt: new Date()
        }
      });
      await processFlowRulesForEvent({
        eventType: "COMPLETED_SEQUENCE",
        orgId,
        flowId: execution.flowId,
        sequenceId: execution.flowId,
        conversationId: enrollment.conversationId,
        customerId: enrollment.customerId
      });
      return;
    }

    const nextNode = execution.flow.nodes.find((item) => item.key === nextNodeKey);
    if (!nextNode) {
      await prisma.whatsAppEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: "FAILED",
          currentNodeKey: node.key,
          lastError: "Next node not found."
        }
      });
      return;
    }

    await prisma.whatsAppEnrollment.update({
      where: { id: enrollment.id },
      data: { currentNodeKey: nextNode.key }
    });
    await enqueueExecution({
      orgId,
      flowId: execution.flowId,
      enrollmentId: enrollment.id,
      nodeKey: nextNode.key,
      nodeType: nextNode.type,
      dueAt: new Date(),
      payloadJson: nextNode.configJson
    });
  } catch (error) {
    const code = error instanceof ServiceError ? error.code : "TEMPLATE_SEND_FAILED";
    const message = error instanceof Error ? error.message : "Template send failed.";

    await markExecutionStatus({
      executionId,
      status: "FAILED",
      stopReason: "SEND_FAILED",
      errorCode: code,
      errorMessage: message
    });
    await prisma.whatsAppEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: "FAILED",
        currentNodeKey: node.key,
        lastError: message
      }
    });
    await logComplianceEvent({
      orgId,
      flowId: execution.flowId,
      enrollmentId: enrollment.id,
      executionId,
      eventType: "TEMPLATE_SEND",
      decision: "BLOCK",
      reasonCode: code,
      reasonDetail: message
    });
  }
}

export async function getWhatsAppCampaignAnalytics(actorUserId: string, orgIdInput: string) {
  const orgId = await requireOrgReadAccess(actorUserId, orgIdInput);

  const [enrolled, queued, sent, failed, stopped, skipped, perFlow, bPending, bQueued, bSent, bFailed, bSkipped, bStopped] = await Promise.all([
    prisma.whatsAppEnrollment.count({ where: { orgId } }),
    prisma.whatsAppExecution.count({ where: { orgId, status: "QUEUED" } }),
    prisma.whatsAppExecution.count({ where: { orgId, status: "SENT" } }),
    prisma.whatsAppExecution.count({ where: { orgId, status: "FAILED" } }),
    prisma.whatsAppExecution.count({ where: { orgId, status: "STOPPED" } }),
    prisma.whatsAppExecution.count({ where: { orgId, status: "SKIPPED" } }),
    prisma.whatsAppFlow.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            enrollments: true
          }
        }
      },
      orderBy: [{ createdAt: "desc" }]
    }),
    prisma.whatsAppBroadcastRecipient.count({ where: { orgId, status: "PENDING" } }),
    prisma.whatsAppBroadcastRecipient.count({ where: { orgId, status: "QUEUED" } }),
    prisma.whatsAppBroadcastRecipient.count({ where: { orgId, status: "SENT" } }),
    prisma.whatsAppBroadcastRecipient.count({ where: { orgId, status: "FAILED" } }),
    prisma.whatsAppBroadcastRecipient.count({ where: { orgId, status: "SKIPPED" } }),
    prisma.whatsAppBroadcastRecipient.count({ where: { orgId, status: "STOPPED" } })
  ]);

  return {
    funnel: {
      enrolled,
      queued,
      sent,
      failed,
      stopped,
      skipped
    },
    broadcasts: {
      pending: bPending,
      queued: bQueued,
      sent: bSent,
      failed: bFailed,
      skipped: bSkipped,
      stopped: bStopped
    },
    flows: perFlow.map((flow) => ({
      flowId: flow.id,
      flowName: flow.name,
      enrolled: flow._count.enrollments
    }))
  };
}

export async function upsertWhatsAppSuppression(input: {
  actorUserId: string;
  orgId: string;
  conversationId: string;
  reason?: string;
}) {
  const orgId = await requireOrgReadAccess(input.actorUserId, input.orgId);
  const conversationId = normalize(input.conversationId);
  if (!conversationId) {
    throw new ServiceError(400, "INVALID_INPUT", "conversationId is required.");
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    select: {
      id: true,
      customerId: true,
      customer: {
        select: {
          phoneE164: true
        }
      }
    }
  });
  if (!conversation) {
    throw new ServiceError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  }

  const phoneE164 = normalize(conversation.customer.phoneE164);
  const reason = normalize(input.reason) || null;
  const existing = await prisma.whatsAppSuppression.findFirst({
    where: {
      orgId,
      customerId: conversation.customerId,
      conversationId: conversation.id,
      phoneE164
    },
    select: { id: true }
  });

  const item = existing
    ? await prisma.whatsAppSuppression.update({
        where: { id: existing.id },
        data: { isActive: true, reason }
      })
    : await prisma.whatsAppSuppression.create({
        data: {
          orgId,
          customerId: conversation.customerId,
          conversationId: conversation.id,
          phoneE164,
          reason,
          isActive: true
        }
      });

  await logComplianceEvent({
    orgId,
    flowId: null,
    eventType: "SUPPRESSION_UPDATED",
    decision: "ALLOW",
    reasonCode: "SUPPRESSION_ACTIVE"
  });
  return item;
}

export async function clearWhatsAppSuppression(input: {
  actorUserId: string;
  orgId: string;
  conversationId: string;
}) {
  const orgId = await requireOrgReadAccess(input.actorUserId, input.orgId);
  const conversationId = normalize(input.conversationId);
  if (!conversationId) {
    throw new ServiceError(400, "INVALID_INPUT", "conversationId is required.");
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    select: { id: true, customerId: true }
  });
  if (!conversation) {
    throw new ServiceError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  }

  const result = await prisma.whatsAppSuppression.updateMany({
    where: {
      orgId,
      customerId: conversation.customerId,
      conversationId: conversation.id,
      isActive: true
    },
    data: {
      isActive: false
    }
  });

  await logComplianceEvent({
    orgId,
    flowId: null,
    eventType: "SUPPRESSION_UPDATED",
    decision: "ALLOW",
    reasonCode: "SUPPRESSION_CLEARED"
  });
  return { cleared: result.count };
}

export async function stopEnrollmentByConversation(input: {
  actorUserId: string;
  orgId: string;
  flowId: string;
  conversationId: string;
  emitRuleEvents?: boolean;
}) {
  const orgId = await requireOrgReadAccess(input.actorUserId, input.orgId);
  const flowId = normalize(input.flowId);
  const conversationId = normalize(input.conversationId);
  if (!flowId || !conversationId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId and conversationId are required.");
  }

  const activeEnrollment = await prisma.whatsAppEnrollment.findFirst({
    where: {
      orgId,
      flowId,
      conversationId,
      status: "ACTIVE"
    },
    select: { id: true }
  });
  if (!activeEnrollment) {
    return { stopped: 0 };
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.whatsAppEnrollment.update({
      where: { id: activeEnrollment.id },
      data: {
        status: "STOPPED",
        finishedAt: now,
        lastError: "Stopped manually from quick action."
      }
    });
    await tx.whatsAppExecution.updateMany({
      where: {
        orgId,
        flowId,
        enrollmentId: activeEnrollment.id,
        status: "QUEUED"
      },
      data: {
        status: "STOPPED",
        stopReason: "MANUAL_STOP",
        executedAt: now,
        errorCode: "ENROLLMENT_STOPPED",
        errorMessage: "Execution stopped manually."
      }
    });
  });

  await logComplianceEvent({
    orgId,
    flowId,
    enrollmentId: activeEnrollment.id,
    eventType: "ENROLLMENT_STOPPED",
    decision: "ALLOW",
    reasonCode: "MANUAL_STOP"
  });

  const stoppedEnrollment = await prisma.whatsAppEnrollment.findUnique({
    where: { id: activeEnrollment.id },
    select: { customerId: true }
  });
  if (input.emitRuleEvents !== false) {
    await processFlowRulesForEvent({
      eventType: "UNSUBSCRIBED_SEQUENCE",
      orgId,
      flowId,
      sequenceId: flowId,
      conversationId,
      customerId: stoppedEnrollment?.customerId,
      actorUserId: input.actorUserId
    });
  }
  return { stopped: 1 };
}

export async function listWhatsAppFlowRules(input: {
  actorUserId: string;
  orgId: string;
  flowId: string;
}) {
  const orgId = await requireOrgReadAccess(input.actorUserId, input.orgId);
  const flowId = normalize(input.flowId);
  if (!flowId) {
    throw new ServiceError(400, "INVALID_FLOW_ID", "flowId is required.");
  }

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true }
  });
  if (!flow) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "Flow not found.");
  }

  return prisma.whatsAppFlowRule.findMany({
    where: { orgId, flowId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }]
  });
}

async function assertRuleReferencesValid(input: {
  orgId: string;
  flowId: string;
  conditionExpr: string;
  actionType: string;
}) {
  const condition = parseRuleConditionExpr(input.conditionExpr);
  const actions = parseRuleActions(input.actionType);

  const sequenceIds = new Set<string>();
  const broadcastIds = new Set<string>();
  const tagIds = new Set<string>();
  const invoiceIds = new Set<string>();
  const assigneeIds = new Set<string>();
  const stageNames = new Set<string>();

  for (const trigger of condition.triggers) {
    const sequenceId = normalize(trigger.sequenceId);
    const broadcastId = normalize(trigger.broadcastId);
    if (sequenceId) sequenceIds.add(sequenceId);
    if (broadcastId) broadcastIds.add(broadcastId);
  }
  for (const action of actions) {
    const actionType = normalize(action.actionType).toUpperCase();
    const sequenceId = normalize(action.sequenceId);
    const fromSequenceId = normalize(action.fromSequenceId);
    const toSequenceId = normalize(action.toSequenceId);
    const tagId = normalize(action.tagId);
    const invoiceId = normalize(action.invoiceId);
    const assigneeId = normalize(action.assigneeId);
    const pipelineStage = normalize(action.pipelineStage);
    if (sequenceId) sequenceIds.add(sequenceId);
    if (fromSequenceId) sequenceIds.add(fromSequenceId);
    if (toSequenceId) sequenceIds.add(toSequenceId);
    if (tagId) tagIds.add(tagId);
    if (invoiceId) invoiceIds.add(invoiceId);
    if (assigneeId) assigneeIds.add(assigneeId);
    if (pipelineStage) stageNames.add(pipelineStage);
    if ((actionType === "MOVE_SEQUENCE" || actionType === "SUBSCRIBE_SEQUENCE" || actionType === "UNSUBSCRIBE_SEQUENCE") && sequenceIds.size > 0) {
      sequenceIds.add(input.flowId);
    }
  }

  if (sequenceIds.size > 0) {
    const existing = await prisma.whatsAppFlow.findMany({
      where: {
        id: { in: Array.from(sequenceIds) },
        orgId: input.orgId
      },
      select: { id: true }
    });
    if (existing.length !== sequenceIds.size) {
      throw new ServiceError(400, "RULE_INVALID_SEQUENCE_REFERENCE", "Sequence reference tidak valid untuk organization ini.");
    }
  }
  if (broadcastIds.size > 0) {
    const existing = await prisma.whatsAppBroadcast.findMany({
      where: {
        id: { in: Array.from(broadcastIds) },
        orgId: input.orgId
      },
      select: { id: true }
    });
    if (existing.length !== broadcastIds.size) {
      throw new ServiceError(400, "RULE_INVALID_BROADCAST_REFERENCE", "Broadcast reference tidak valid untuk organization ini.");
    }
  }
  if (tagIds.size > 0) {
    const existing = await prisma.tag.findMany({
      where: {
        id: { in: Array.from(tagIds) },
        orgId: input.orgId
      },
      select: { id: true }
    });
    if (existing.length !== tagIds.size) {
      throw new ServiceError(400, "RULE_INVALID_TAG_REFERENCE", "Tag reference tidak valid untuk organization ini.");
    }
  }
  if (invoiceIds.size > 0) {
    const existing = await prisma.invoice.findMany({
      where: {
        id: { in: Array.from(invoiceIds) },
        orgId: input.orgId
      },
      select: { id: true }
    });
    if (existing.length !== invoiceIds.size) {
      throw new ServiceError(400, "RULE_INVALID_INVOICE_REFERENCE", "Invoice reference tidak valid untuk organization ini.");
    }
  }
  if (assigneeIds.size > 0) {
    const existing = await prisma.orgMember.findMany({
      where: {
        id: { in: Array.from(assigneeIds) },
        orgId: input.orgId
      },
      select: { id: true }
    });
    if (existing.length !== assigneeIds.size) {
      throw new ServiceError(400, "RULE_INVALID_ASSIGNEE_REFERENCE", "Assignee reference tidak valid untuk organization ini.");
    }
  }
  if (stageNames.size > 0) {
    const existing = await prisma.crmPipelineStage.findMany({
      where: {
        orgId: input.orgId,
        name: { in: Array.from(stageNames) }
      },
      select: { name: true }
    });
    if (existing.length !== stageNames.size) {
      throw new ServiceError(400, "RULE_INVALID_PIPELINE_STAGE_REFERENCE", "Pipeline stage reference tidak valid untuk organization ini.");
    }
  }
}

export async function createWhatsAppFlowRule(input: {
  actorUserId: string;
  orgId: string;
  flowId: string;
  triggerType: string;
  conditionExpr: string;
  actionType: string;
  isActive?: boolean;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const flowId = normalize(input.flowId);
  const triggerType = normalize(input.triggerType);
  const conditionExpr = normalize(input.conditionExpr);
  const actionType = normalize(input.actionType);
  if (!flowId || !triggerType || !conditionExpr || !actionType) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId, triggerType, conditionExpr, and actionType are required.");
  }
  const conditionValidation = validateRuleConditionExpr(conditionExpr);
  if (!conditionValidation.valid) {
    throw new ServiceError(400, "INVALID_RULE_CONDITION", conditionValidation.message ?? "conditionExpr tidak valid.");
  }
  const actionValidation = validateRuleActionExpr(actionType);
  if (!actionValidation.valid) {
    throw new ServiceError(400, "INVALID_RULE_ACTION", actionValidation.message ?? "actionType tidak valid.");
  }

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: flowId, orgId },
    select: { id: true }
  });
  if (!flow) {
    throw new ServiceError(404, "FLOW_NOT_FOUND", "Flow not found.");
  }
  await assertRuleReferencesValid({
    orgId,
    flowId,
    conditionExpr: conditionValidation.normalized,
    actionType: actionValidation.normalized
  });

  const maxOrder = await prisma.whatsAppFlowRule.aggregate({
    where: { orgId, flowId },
    _max: { orderIndex: true }
  });

  return prisma.whatsAppFlowRule.create({
    data: {
      orgId,
      flowId,
      createdByUserId: input.actorUserId,
      triggerType,
      conditionExpr: conditionValidation.normalized,
      actionType: actionValidation.normalized,
      isActive: input.isActive ?? true,
      orderIndex: (maxOrder._max.orderIndex ?? -1) + 1
    }
  });
}

export async function updateWhatsAppFlowRule(input: {
  actorUserId: string;
  orgId: string;
  flowId: string;
  ruleId: string;
  triggerType?: string;
  conditionExpr?: string;
  actionType?: string;
  isActive?: boolean;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const flowId = normalize(input.flowId);
  const ruleId = normalize(input.ruleId);
  if (!flowId || !ruleId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId and ruleId are required.");
  }

  const existing = await prisma.whatsAppFlowRule.findFirst({
    where: { id: ruleId, orgId, flowId },
    select: {
      id: true,
      conditionExpr: true,
      actionType: true
    }
  });
  if (!existing) {
    throw new ServiceError(404, "RULE_NOT_FOUND", "Rule not found.");
  }

  const data: Record<string, unknown> = {};
  const nextTriggerType = input.triggerType !== undefined ? normalize(input.triggerType) : undefined;
  const nextConditionExprRaw = input.conditionExpr !== undefined ? normalize(input.conditionExpr) : undefined;
  const nextActionTypeRaw = input.actionType !== undefined ? normalize(input.actionType) : undefined;
  const mergedConditionExpr = nextConditionExprRaw ?? existing.conditionExpr;
  const mergedActionType = nextActionTypeRaw ?? existing.actionType;
  const conditionValidation = validateRuleConditionExpr(mergedConditionExpr);
  if (!conditionValidation.valid) {
    throw new ServiceError(400, "INVALID_RULE_CONDITION", conditionValidation.message ?? "conditionExpr tidak valid.");
  }
  const actionValidation = validateRuleActionExpr(mergedActionType);
  if (!actionValidation.valid) {
    throw new ServiceError(400, "INVALID_RULE_ACTION", actionValidation.message ?? "actionType tidak valid.");
  }
  await assertRuleReferencesValid({
    orgId,
    flowId,
    conditionExpr: conditionValidation.normalized,
    actionType: actionValidation.normalized
  });

  if (nextTriggerType !== undefined) data.triggerType = nextTriggerType;
  if (nextConditionExprRaw !== undefined) data.conditionExpr = conditionValidation.normalized;
  if (nextActionTypeRaw !== undefined) data.actionType = actionValidation.normalized;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  return prisma.whatsAppFlowRule.update({
    where: { id: ruleId },
    data
  });
}

export async function deleteWhatsAppFlowRule(input: {
  actorUserId: string;
  orgId: string;
  flowId: string;
  ruleId: string;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const flowId = normalize(input.flowId);
  const ruleId = normalize(input.ruleId);
  if (!flowId || !ruleId) {
    throw new ServiceError(400, "INVALID_INPUT", "flowId and ruleId are required.");
  }

  const existing = await prisma.whatsAppFlowRule.findFirst({
    where: { id: ruleId, orgId, flowId },
    select: { id: true }
  });
  if (!existing) {
    throw new ServiceError(404, "RULE_NOT_FOUND", "Rule not found.");
  }

  await prisma.whatsAppFlowRule.delete({ where: { id: ruleId } });
  return { deleted: true };
}

type BroadcastRecipientMode = "SEGMENT" | "SELECTED_CUSTOMERS" | "HYBRID";
type BroadcastSegment = "all_leads" | "hot_leads" | "followup_today";

function parseBroadcastRecipientMode(value: string | null | undefined): BroadcastRecipientMode {
  const normalized = normalize(value).toUpperCase();
  if (normalized === "SELECTED_CUSTOMERS" || normalized === "HYBRID") {
    return normalized;
  }
  return "SEGMENT";
}

function parseBroadcastSegment(value: string | null | undefined): BroadcastSegment {
  const normalized = normalize(value);
  if (normalized === "hot_leads" || normalized === "followup_today") {
    return normalized;
  }
  return "all_leads";
}

function computeBroadcastRecipientDueAt(input: {
  baseDueAt: Date;
  recipientIndex: number;
  batchSize: number;
  batchIntervalSeconds: number;
}): Date {
  const safeBatchSize = Math.max(1, Math.floor(input.batchSize || 1));
  const safeBatchIntervalSeconds = Math.max(60, Math.floor(input.batchIntervalSeconds || 60));
  const slotIndex = Math.floor(Math.max(0, input.recipientIndex) / safeBatchSize);
  return new Date(input.baseDueAt.getTime() + slotIndex * safeBatchIntervalSeconds * 1000);
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  const raw = normalize(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalize(typeof item === "string" ? item : "")).filter(Boolean);
  } catch {
    return [];
  }
}

function parseBroadcastFiltersJson(value: string | null | undefined): {
  assignee?: string;
  leadStatus?: string;
  pipelineStage?: string;
  source?: string;
} {
  const parsed = parseJsonRecord(value);
  return {
    assignee: normalize(typeof parsed.assignee === "string" ? parsed.assignee : "") || undefined,
    leadStatus: normalize(typeof parsed.leadStatus === "string" ? parsed.leadStatus : "") || undefined,
    pipelineStage: normalize(typeof parsed.pipelineStage === "string" ? parsed.pipelineStage : "") || undefined,
    source: normalize(typeof parsed.source === "string" ? parsed.source : "") || undefined
  };
}

function assertBroadcastConfigValid(input: {
  messageMode: "TEMPLATE" | "TEXT";
  text?: string;
  templateName?: string;
  templateComponentsJson?: string;
  recipientMode: BroadcastRecipientMode;
  batchSize: number;
  batchIntervalSeconds: number;
  selectedCustomerIdsJson?: string;
}) {
  if (input.messageMode === "TEMPLATE" && !normalize(input.templateName)) {
    throw new ServiceError(400, "INVALID_TEMPLATE", "templateName is required for TEMPLATE mode.");
  }
  if (input.messageMode === "TEMPLATE") {
    const raw = normalize(input.templateComponentsJson);
    if (!raw) {
      throw new ServiceError(400, "INVALID_TEMPLATE_COMPONENTS", "templateComponentsJson is required for TEMPLATE mode.");
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new ServiceError(400, "INVALID_TEMPLATE_COMPONENTS", "templateComponentsJson must be a non-empty array.");
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(400, "INVALID_TEMPLATE_COMPONENTS", "templateComponentsJson must be valid JSON array.");
    }
  }
  if (input.messageMode === "TEXT" && !normalize(input.text)) {
    throw new ServiceError(400, "INVALID_TEXT", "text is required for TEXT mode.");
  }
  if (!Number.isFinite(input.batchSize) || input.batchSize < 1) {
    throw new ServiceError(400, "INVALID_BATCH_SIZE", "batchSize must be at least 1.");
  }
  if (!Number.isFinite(input.batchIntervalSeconds) || input.batchIntervalSeconds < 60) {
    throw new ServiceError(400, "INVALID_BATCH_INTERVAL", "batchIntervalSeconds must be at least 60.");
  }
  if (input.recipientMode === "SELECTED_CUSTOMERS") {
    const selected = parseStringArrayJson(input.selectedCustomerIdsJson);
    if (selected.length === 0) {
      throw new ServiceError(400, "INVALID_RECIPIENTS", "selectedCustomerIds is required for SELECTED_CUSTOMERS mode.");
    }
  }
}

async function resolveBroadcastConversations(input: {
  orgId: string;
  recipientMode: BroadcastRecipientMode;
  segment: BroadcastSegment;
  selectedCustomerIdsJson?: string | null;
  filtersJson?: string | null;
}): Promise<Array<{ id: string; customerId: string; customer: { phoneE164: string } }>> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const filters = parseBroadcastFiltersJson(input.filtersJson);
  const selectedCustomerIds = parseStringArrayJson(input.selectedCustomerIdsJson);
  const customerWhere: Record<string, unknown> = {
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.leadStatus ? { leadStatus: filters.leadStatus } : {})
  };
  if (input.segment === "hot_leads") {
    customerWhere.hotness = "HOT";
  }
  if (input.segment === "followup_today") {
    customerWhere.followUpAt = {
      gte: todayStart,
      lt: tomorrowStart
    };
  }

  const baseWhere: Record<string, unknown> = {
    orgId: input.orgId,
    ...(filters.assignee ? { assignedToMember: { user: { name: filters.assignee } } } : {}),
    ...(filters.pipelineStage ? { crmStage: { name: filters.pipelineStage } } : {})
  };

  if (input.recipientMode === "SELECTED_CUSTOMERS") {
    return prisma.conversation.findMany({
      where: {
        ...baseWhere,
        customerId: { in: selectedCustomerIds }
      },
      select: {
        id: true,
        customerId: true,
        customer: { select: { phoneE164: true } }
      },
      take: 5000
    });
  }

  if (input.recipientMode === "HYBRID" && selectedCustomerIds.length > 0) {
    return prisma.conversation.findMany({
      where: {
        ...baseWhere,
        OR: [
          { customerId: { in: selectedCustomerIds } },
          ...(Object.keys(customerWhere).length > 0 ? [{ customer: customerWhere }] : [{ id: { not: "" } }])
        ]
      },
      select: {
        id: true,
        customerId: true,
        customer: { select: { phoneE164: true } }
      },
      take: 5000
    });
  }

  return prisma.conversation.findMany({
    where: {
      ...baseWhere,
      ...(Object.keys(customerWhere).length > 0 ? { customer: customerWhere } : {})
    },
    select: {
      id: true,
      customerId: true,
      customer: { select: { phoneE164: true } }
    },
    take: 5000
  });
}

export async function listWhatsAppBroadcasts(input: {
  actorUserId: string;
  orgId: string;
}) {
  const orgId = await requireOrgReadAccess(input.actorUserId, input.orgId);
  return prisma.whatsAppBroadcast.findMany({
    where: { orgId },
    include: {
      _count: {
        select: {
          recipients: true
        }
      }
    },
    orderBy: [{ createdAt: "desc" }]
  });
}

export async function createWhatsAppBroadcast(input: {
  actorUserId: string;
  orgId: string;
  name: string;
  messageMode: "TEMPLATE" | "TEXT";
  text?: string;
  templateName?: string;
  templateLanguageCode?: string;
  templateCategory?: WaTemplateCategory;
  templateComponentsJson?: string;
  recipientMode?: string;
  segment?: string;
  selectedCustomerIdsJson?: string;
  filtersJson?: string;
  batchSize?: number;
  batchIntervalSeconds?: number;
  scheduledAt?: Date | null;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const name = normalize(input.name);
  if (!name) {
    throw new ServiceError(400, "INVALID_INPUT", "name is required.");
  }

  const recipientMode = parseBroadcastRecipientMode(input.recipientMode);
  const segment = parseBroadcastSegment(input.segment);
  const batchSize = Math.floor(input.batchSize ?? 5);
  const batchIntervalSeconds = Math.floor(input.batchIntervalSeconds ?? 600);
  const scheduledAt = input.scheduledAt ?? null;
  const selectedCustomerIdsJson = normalize(input.selectedCustomerIdsJson) || null;
  const filtersJson = normalize(input.filtersJson) || null;

  assertBroadcastConfigValid({
    messageMode: input.messageMode,
    text: input.text,
    templateName: input.templateName,
    templateComponentsJson: input.templateComponentsJson,
    recipientMode,
    batchSize,
    batchIntervalSeconds,
    selectedCustomerIdsJson: selectedCustomerIdsJson ?? undefined
  });

  return prisma.whatsAppBroadcast.create({
    data: {
      orgId,
      createdByUserId: input.actorUserId,
      name,
      messageMode: input.messageMode,
      recipientMode,
      segment,
      selectedCustomerIdsJson,
      filtersJson,
      batchSize,
      batchIntervalSeconds,
      scheduledAt,
      text: normalize(input.text) || null,
      templateName: normalize(input.templateName) || null,
      templateLanguageCode: normalize(input.templateLanguageCode) || null,
      templateCategory: input.templateCategory,
      templateComponentsJson: normalize(input.templateComponentsJson) || null
    }
  });
}

export async function updateWhatsAppBroadcast(input: {
  actorUserId: string;
  orgId: string;
  broadcastId: string;
  name?: string;
  text?: string;
  messageMode?: "TEMPLATE" | "TEXT";
  templateName?: string;
  templateLanguageCode?: string;
  templateCategory?: WaTemplateCategory;
  templateComponentsJson?: string;
  recipientMode?: string;
  segment?: string;
  selectedCustomerIdsJson?: string;
  filtersJson?: string;
  batchSize?: number;
  batchIntervalSeconds?: number;
  scheduledAt?: Date | null;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const broadcastId = normalize(input.broadcastId);
  if (!broadcastId) {
    throw new ServiceError(400, "INVALID_BROADCAST_ID", "broadcastId is required.");
  }

  const existing = await prisma.whatsAppBroadcast.findFirst({
    where: { id: broadcastId, orgId }
  });
  if (!existing) {
    throw new ServiceError(404, "BROADCAST_NOT_FOUND", "Broadcast not found.");
  }
  if (existing.status !== "DRAFT") {
    throw new ServiceError(409, "BROADCAST_NOT_DRAFT", "Only draft broadcast can be updated.");
  }

  const messageMode = input.messageMode ?? (existing.messageMode === "TEXT" ? "TEXT" : "TEMPLATE");
  const recipientMode = parseBroadcastRecipientMode(input.recipientMode ?? existing.recipientMode);
  const segment = parseBroadcastSegment(input.segment ?? existing.segment);
  const batchSize = Math.floor(input.batchSize ?? existing.batchSize);
  const batchIntervalSeconds = Math.floor(input.batchIntervalSeconds ?? existing.batchIntervalSeconds);
  const selectedCustomerIdsJson = normalize(input.selectedCustomerIdsJson ?? existing.selectedCustomerIdsJson ?? "") || null;

  assertBroadcastConfigValid({
    messageMode,
    text: input.text ?? existing.text ?? undefined,
    templateName: input.templateName ?? existing.templateName ?? undefined,
    templateComponentsJson: input.templateComponentsJson ?? existing.templateComponentsJson ?? undefined,
    recipientMode,
    batchSize,
    batchIntervalSeconds,
    selectedCustomerIdsJson: selectedCustomerIdsJson ?? undefined
  });

  return prisma.whatsAppBroadcast.update({
    where: { id: broadcastId },
    data: {
      ...(input.name !== undefined ? { name: normalize(input.name) } : {}),
      ...(input.text !== undefined ? { text: normalize(input.text) || null } : {}),
      ...(input.messageMode !== undefined ? { messageMode } : {}),
      ...(input.templateName !== undefined ? { templateName: normalize(input.templateName) || null } : {}),
      ...(input.templateLanguageCode !== undefined ? { templateLanguageCode: normalize(input.templateLanguageCode) || null } : {}),
      ...(input.templateCategory !== undefined ? { templateCategory: input.templateCategory } : {}),
      ...(input.templateComponentsJson !== undefined ? { templateComponentsJson: normalize(input.templateComponentsJson) || null } : {}),
      recipientMode,
      segment,
      selectedCustomerIdsJson,
      filtersJson: normalize(input.filtersJson ?? existing.filtersJson ?? "") || null,
      batchSize,
      batchIntervalSeconds,
      scheduledAt: input.scheduledAt === undefined ? existing.scheduledAt : input.scheduledAt
    }
  });
}

export async function deleteWhatsAppBroadcast(input: {
  actorUserId: string;
  orgId: string;
  broadcastId: string;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const broadcastId = normalize(input.broadcastId);
  if (!broadcastId) {
    throw new ServiceError(400, "INVALID_BROADCAST_ID", "broadcastId is required.");
  }

  const existing = await prisma.whatsAppBroadcast.findFirst({
    where: { id: broadcastId, orgId },
    select: { id: true, status: true }
  });
  if (!existing) {
    throw new ServiceError(404, "BROADCAST_NOT_FOUND", "Broadcast not found.");
  }
  if (existing.status === "RUNNING") {
    throw new ServiceError(409, "BROADCAST_RUNNING", "Running broadcast cannot be deleted.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.whatsAppBroadcastRecipient.deleteMany({
      where: { orgId, broadcastId }
    });
    await tx.whatsAppBroadcast.delete({
      where: { id: broadcastId }
    });
  });
  return { deleted: true };
}

export async function launchWhatsAppBroadcast(input: {
  actorUserId: string;
  orgId: string;
  broadcastId: string;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const broadcastId = normalize(input.broadcastId);
  if (!broadcastId) {
    throw new ServiceError(400, "INVALID_BROADCAST_ID", "broadcastId is required.");
  }

  const broadcast = await prisma.whatsAppBroadcast.findFirst({
    where: { id: broadcastId, orgId }
  });
  if (!broadcast) {
    throw new ServiceError(404, "BROADCAST_NOT_FOUND", "Broadcast not found.");
  }
  if (broadcast.status !== "DRAFT") {
    throw new ServiceError(409, "BROADCAST_NOT_DRAFT", "Only draft broadcast can be launched.");
  }

  const now = new Date();
  const recipientMode = parseBroadcastRecipientMode(broadcast.recipientMode);
  const segment = parseBroadcastSegment(broadcast.segment);
  const conversations = await resolveBroadcastConversations({
    orgId,
    recipientMode,
    segment,
    selectedCustomerIdsJson: broadcast.selectedCustomerIdsJson,
    filtersJson: broadcast.filtersJson
  });
  if (conversations.length === 0) {
    throw new ServiceError(409, "BROADCAST_RECIPIENTS_EMPTY", "No recipients available for this broadcast.");
  }

  const baseDueAt = broadcast.scheduledAt && broadcast.scheduledAt.getTime() > now.getTime() ? broadcast.scheduledAt : now;
  const safeBatchSize = Math.max(1, Math.floor(broadcast.batchSize || 5));
  const safeBatchIntervalSeconds = Math.max(60, Math.floor(broadcast.batchIntervalSeconds || 600));

  await prisma.$transaction(async (tx) => {
    await tx.whatsAppBroadcastRecipient.createMany({
      data: conversations.map((item, index) => {
        const dueAt = computeBroadcastRecipientDueAt({
          baseDueAt,
          recipientIndex: index,
          batchSize: safeBatchSize,
          batchIntervalSeconds: safeBatchIntervalSeconds
        });
        return {
          orgId,
          broadcastId,
          customerId: item.customerId,
          conversationId: item.id,
          phoneE164: normalize(item.customer.phoneE164),
          status: "PENDING" as const,
          dueAt
        };
      }),
      skipDuplicates: true
    });

    await tx.whatsAppBroadcast.update({
      where: { id: broadcastId },
      data: {
        status: "RUNNING",
        launchedAt: now
      }
    });
    await tx.whatsAppComplianceEvent.create({
      data: {
        orgId,
        eventType: "BROADCAST_LAUNCHED",
        decision: "ALLOW",
        reasonCode: `recipients:${conversations.length}`
      }
    });
  });

  return {
    launched: true,
    recipients: conversations.length
  };
}

export async function cancelWhatsAppBroadcast(input: {
  actorUserId: string;
  orgId: string;
  broadcastId: string;
}) {
  const orgId = await requireOrgWriteAccess(input.actorUserId, input.orgId);
  const broadcastId = normalize(input.broadcastId);
  if (!broadcastId) {
    throw new ServiceError(400, "INVALID_BROADCAST_ID", "broadcastId is required.");
  }

  const existing = await prisma.whatsAppBroadcast.findFirst({
    where: { id: broadcastId, orgId },
    select: { id: true, status: true }
  });
  if (!existing) {
    throw new ServiceError(404, "BROADCAST_NOT_FOUND", "Broadcast not found.");
  }
  if (existing.status !== "RUNNING" && existing.status !== "DRAFT") {
    throw new ServiceError(409, "BROADCAST_NOT_CANCELLABLE", "Broadcast cannot be canceled.");
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.whatsAppBroadcast.update({
      where: { id: broadcastId },
      data: {
        status: "CANCELED",
        canceledAt: now
      }
    });
    await tx.whatsAppBroadcastRecipient.updateMany({
      where: {
        orgId,
        broadcastId,
        status: {
          in: ["PENDING", "QUEUED"]
        }
      },
      data: {
        status: "STOPPED",
        errorCode: "BROADCAST_CANCELED",
        errorMessage: "Stopped because broadcast canceled."
      }
    });
    await tx.whatsAppComplianceEvent.create({
      data: {
        orgId,
        eventType: "BROADCAST_CANCELED",
        decision: "ALLOW"
      }
    });
  });

  return { canceled: true };
}

async function maybeFinalizeBroadcast(orgId: string, broadcastId: string): Promise<void> {
  const [pendingOrQueued, running] = await Promise.all([
    prisma.whatsAppBroadcastRecipient.count({
      where: {
        orgId,
        broadcastId,
        status: { in: ["PENDING", "QUEUED"] }
      }
    }),
    prisma.whatsAppBroadcast.findFirst({
      where: { id: broadcastId, orgId },
      select: { id: true, status: true }
    })
  ]);

  if (!running || running.status !== "RUNNING") {
    return;
  }
  if (pendingOrQueued > 0) {
    return;
  }

  await prisma.whatsAppBroadcast.update({
    where: { id: broadcastId },
    data: {
      status: "COMPLETED",
      completedAt: new Date()
    }
  });
  await prisma.whatsAppComplianceEvent.create({
    data: {
      orgId,
      eventType: "BROADCAST_COMPLETED",
      decision: "ALLOW",
      reasonCode: broadcastId
    }
  });
}

export async function processWhatsAppBroadcastRecipientsBatch(limit = 25): Promise<{ processed: number }> {
  const candidates = await prisma.whatsAppBroadcastRecipient.findMany({
    where: {
      status: "PENDING",
      dueAt: { lte: new Date() },
      broadcast: {
        status: "RUNNING"
      }
    },
    include: {
      broadcast: true
    },
    orderBy: [{ createdAt: "asc" }],
    take: Math.max(1, Math.min(100, limit))
  });

  let processed = 0;

  for (const candidate of candidates) {
    const claimed = await prisma.whatsAppBroadcastRecipient.updateMany({
      where: {
        id: candidate.id,
        status: "PENDING"
      },
      data: {
        status: "QUEUED",
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date()
      }
    });
    if (claimed.count !== 1) {
      continue;
    }

    const orgId = candidate.orgId;
    const broadcastId = candidate.broadcastId;

    try {
      if (candidate.broadcast.messageMode === "TEXT") {
        const [suppression, recentInbound] = await Promise.all([
          prisma.whatsAppSuppression.findFirst({
            where: {
              orgId,
              customerId: candidate.customerId,
              isActive: true
            },
            select: { id: true }
          }),
          prisma.message.findFirst({
            where: {
              orgId,
              conversationId: candidate.conversationId,
              direction: "INBOUND",
              createdAt: {
                gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
              }
            },
            orderBy: { createdAt: "desc" },
            select: { id: true }
          })
        ]);

        if (suppression || !recentInbound) {
          await prisma.whatsAppBroadcastRecipient.update({
            where: { id: candidate.id },
            data: {
              status: "SKIPPED",
              errorCode: suppression ? "SUPPRESSION_ACTIVE" : "TEXT_WINDOW_EXPIRED",
              errorMessage: suppression ? "Suppression is active." : "No inbound message in last 24h window."
            }
          });
          await prisma.whatsAppComplianceEvent.create({
            data: {
              orgId,
              eventType: "BROADCAST_POLICY_SKIPPED",
              decision: "BLOCK",
              reasonCode: suppression ? "SUPPRESSION_ACTIVE" : "TEXT_WINDOW_EXPIRED",
              reasonDetail: candidate.broadcastId
            }
          });
          await maybeFinalizeBroadcast(orgId, broadcastId);
          processed += 1;
          continue;
        }
      }

      const actorUserId = normalize(candidate.broadcast.createdByUserId ?? "");
      if (!actorUserId) {
        await prisma.whatsAppBroadcastRecipient.update({
          where: { id: candidate.id },
          data: {
            status: "FAILED",
            errorCode: "MISSING_BROADCAST_ACTOR",
            errorMessage: "Broadcast creator user is missing."
          }
        });
        await maybeFinalizeBroadcast(orgId, broadcastId);
        processed += 1;
        continue;
      }

      if (candidate.broadcast.messageMode === "TEMPLATE") {
        const templateName = normalize(candidate.broadcast.templateName);
        if (!templateName) {
          await prisma.whatsAppBroadcastRecipient.update({
            where: { id: candidate.id },
            data: {
              status: "FAILED",
              errorCode: "INVALID_TEMPLATE_CONFIG",
              errorMessage: "templateName is required."
            }
          });
          await maybeFinalizeBroadcast(orgId, broadcastId);
          processed += 1;
          continue;
        }

        const componentsRaw = normalize(candidate.broadcast.templateComponentsJson);
        let templateComponents: Array<Record<string, unknown>> = [];
        if (componentsRaw) {
          try {
            const parsed = JSON.parse(componentsRaw) as unknown;
            if (Array.isArray(parsed)) {
              templateComponents = parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
            }
          } catch {
            templateComponents = [];
          }
        }
        if (templateComponents.length === 0) {
          await prisma.whatsAppBroadcastRecipient.update({
            where: { id: candidate.id },
            data: {
              status: "FAILED",
              errorCode: "INVALID_TEMPLATE_COMPONENTS",
              errorMessage: "templateComponentsJson must be a non-empty array."
            }
          });
          await maybeFinalizeBroadcast(orgId, broadcastId);
          processed += 1;
          continue;
        }

        const sent = await sendOutboundMessage({
          actorUserId,
          orgId,
          conversationId: candidate.conversationId,
          type: "TEMPLATE",
          templateName,
          templateLanguageCode: normalize(candidate.broadcast.templateLanguageCode) || undefined,
          templateCategory: candidate.broadcast.templateCategory ?? undefined,
          templateComponents,
          dispatchMode: "SYNC"
        });

        await prisma.whatsAppBroadcastRecipient.update({
          where: { id: candidate.id },
          data: {
            status: "SENT",
            executionId: null,
            messageId: sent.messageId,
            waMessageId: sent.waMessageId,
            errorCode: null,
            errorMessage: sent.waMessageId ?? sent.messageId
          }
        });
        await scheduleDidntReadCheck({
          orgId,
          messageScope: "BROADCAST",
          broadcastId: candidate.broadcastId,
          conversationId: candidate.conversationId,
          customerId: candidate.customerId,
          messageId: sent.messageId,
          waMessageId: sent.waMessageId
        });
      } else {
        const text = normalize(candidate.broadcast.text);
        if (!text) {
          await prisma.whatsAppBroadcastRecipient.update({
            where: { id: candidate.id },
            data: {
              status: "FAILED",
              errorCode: "INVALID_TEXT_CONFIG",
              errorMessage: "text is required for TEXT mode."
            }
          });
          await maybeFinalizeBroadcast(orgId, broadcastId);
          processed += 1;
          continue;
        }

        const sent = await sendOutboundMessage({
          actorUserId,
          orgId,
          conversationId: candidate.conversationId,
          type: "TEXT",
          text,
          dispatchMode: "SYNC"
        });

        await prisma.whatsAppBroadcastRecipient.update({
          where: { id: candidate.id },
          data: {
            status: "SENT",
            executionId: null,
            messageId: sent.messageId,
            waMessageId: sent.waMessageId,
            errorCode: null,
            errorMessage: sent.waMessageId ?? sent.messageId
          }
        });
        await scheduleDidntReadCheck({
          orgId,
          messageScope: "BROADCAST",
          broadcastId: candidate.broadcastId,
          conversationId: candidate.conversationId,
          customerId: candidate.customerId,
          messageId: sent.messageId,
          waMessageId: sent.waMessageId
        });
      }

      await maybeFinalizeBroadcast(orgId, broadcastId);
      await prisma.whatsAppComplianceEvent.create({
        data: {
          orgId,
          eventType: "BROADCAST_BATCH_SENT",
          decision: "ALLOW",
          reasonCode: candidate.broadcastId
        }
      });
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown broadcast send error.";
      await prisma.whatsAppBroadcastRecipient.update({
        where: { id: candidate.id },
        data: {
          status: "FAILED",
          errorCode: "BROADCAST_SEND_FAILED",
          errorMessage: message
        }
      });
      await maybeFinalizeBroadcast(orgId, broadcastId);
      processed += 1;
    }
  }

  return { processed };
}

export const __broadcastTestables = {
  parseBroadcastRecipientMode,
  parseBroadcastSegment,
  assertBroadcastConfigValid,
  computeBroadcastRecipientDueAt
};

export async function processWhatsAppRulePendingChecksBatch(limit = 25): Promise<{ processed: number }> {
  const take = Math.max(1, Math.min(200, Math.floor(limit)));
  const now = new Date();
  const candidates = await prisma.whatsAppRulePendingCheck.findMany({
    where: {
      status: "PENDING",
      dueAt: { lte: now }
    },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    take
  });

  let processed = 0;
  for (const candidate of candidates) {
    const claim = await prisma.whatsAppRulePendingCheck.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "PROCESSING" }
    });
    if (claim.count !== 1) continue;

    const message = await prisma.message.findFirst({
      where: {
        id: candidate.messageId,
        orgId: candidate.orgId
      },
      select: {
        id: true,
        deliveryStatus: true
      }
    });

    if (!message || message.deliveryStatus === "READ") {
      await prisma.whatsAppRulePendingCheck.update({
        where: { id: candidate.id },
        data: {
          status: "CANCELED",
          processedAt: new Date()
        }
      });
      await logComplianceEvent({
        orgId: candidate.orgId,
        flowId: candidate.flowId,
        eventType: "RULE_DIDNT_READ_CANCELED",
        decision: "ALLOW",
        reasonCode: candidate.messageId
      });
      processed += 1;
      continue;
    }

    await processFlowRulesForEvent({
      eventType: "DIDNT_READ_MESSAGE",
      orgId: candidate.orgId,
      flowId: candidate.flowId ?? undefined,
      sequenceId: candidate.sequenceId ?? undefined,
      broadcastId: candidate.broadcastId ?? undefined,
      messageScope: candidate.messageScope === "BROADCAST" ? "BROADCAST" : "SEQUENCE",
      conversationId: candidate.conversationId,
      customerId: candidate.customerId,
      messageId: candidate.messageId,
      waMessageId: candidate.waMessageId ?? undefined
    });

    await prisma.whatsAppRulePendingCheck.update({
      where: { id: candidate.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date()
      }
    });
    await logComplianceEvent({
      orgId: candidate.orgId,
      flowId: candidate.flowId,
      eventType: "RULE_DIDNT_READ_TRIGGERED",
      decision: "ALLOW",
      reasonCode: candidate.messageId
    });
    processed += 1;
  }

  return { processed };
}

export async function processCampaignReadEvent(input: {
  orgId: string;
  conversationId: string;
  messageId?: string;
  waMessageId?: string;
}): Promise<void> {
  const orgId = normalize(input.orgId);
  const conversationId = normalize(input.conversationId);
  if (!orgId || !conversationId) {
    return;
  }
  await cancelDidntReadCheckForRead({
    orgId,
    messageId: input.messageId,
    waMessageId: input.waMessageId
  });

  if (normalize(input.messageId ?? "")) {
    const broadcastRecipient = await prisma.whatsAppBroadcastRecipient.findFirst({
      where: {
        orgId,
        messageId: normalize(input.messageId)
      },
      select: {
        broadcastId: true,
        customerId: true
      }
    });
    if (broadcastRecipient) {
      await processFlowRulesForEvent({
        eventType: "READ_MESSAGE",
        orgId,
        broadcastId: broadcastRecipient.broadcastId,
        messageScope: "BROADCAST",
        conversationId,
        customerId: broadcastRecipient.customerId,
        messageId: normalize(input.messageId),
        waMessageId: normalize(input.waMessageId ?? undefined) || undefined
      });
    }
  }

  const activeEnrollments = await prisma.whatsAppEnrollment.findMany({
    where: {
      orgId,
      conversationId,
      status: "ACTIVE"
    },
    select: {
      flowId: true,
      customerId: true
    }
  });

  for (const enrollment of activeEnrollments) {
    await processFlowRulesForEvent({
      eventType: "READ_MESSAGE",
      orgId,
      flowId: enrollment.flowId,
      sequenceId: enrollment.flowId,
      messageScope: "SEQUENCE",
      conversationId,
      customerId: enrollment.customerId,
      messageId: normalize(input.messageId ?? undefined) || undefined,
      waMessageId: normalize(input.waMessageId ?? undefined) || undefined
    });
  }
}

export type CampaignRuleEventType =
  | "SUBSCRIBED_SEQUENCE"
  | "UNSUBSCRIBED_SEQUENCE"
  | "COMPLETED_SEQUENCE"
  | "READ_MESSAGE"
  | "DIDNT_READ_MESSAGE";

export type CampaignRuleEvent = {
  eventType: CampaignRuleEventType;
  orgId: string;
  flowId?: string;
  conversationId?: string;
  customerId?: string;
  actorUserId?: string;
  messageId?: string;
  waMessageId?: string;
  messageScope?: "ANY" | "SEQUENCE" | "BROADCAST";
  sequenceId?: string;
  broadcastId?: string;
};

export type CampaignRuleTrigger = {
  id?: string;
  source?: string;
  eventType?: string;
  messageScope?: "ANY" | "SEQUENCE" | "BROADCAST";
  sequenceId?: string;
  broadcastId?: string;
};

export type CampaignRuleAction = {
  id?: string;
  actionType?: string;
  tagId?: string;
  sequenceId?: string;
  fromSequenceId?: string;
  toSequenceId?: string;
  invoiceId?: string;
  leadStatus?: string;
  followUpStatus?: string;
  businessCategory?: string;
  assigneeId?: string;
  pipelineStage?: string;
};

export type CampaignRuleCondition = {
  name?: string;
  operator?: "OR" | "AND";
  triggers: CampaignRuleTrigger[];
};

export type CampaignRuleActionBundle = {
  operator?: "AND" | "OR";
  actions: CampaignRuleAction[];
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function parseObject(value: string): Record<string, unknown> {
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

export const CAMPAIGN_RULE_EVENT_TYPES: CampaignRuleEventType[] = [
  "SUBSCRIBED_SEQUENCE",
  "UNSUBSCRIBED_SEQUENCE",
  "COMPLETED_SEQUENCE",
  "READ_MESSAGE",
  "DIDNT_READ_MESSAGE"
];

export const CAMPAIGN_RULE_ACTION_TYPES = [
  "APPLY_TAG",
  "REMOVE_TAG",
  "SUBSCRIBE_SEQUENCE",
  "UNSUBSCRIBE_SEQUENCE",
  "MOVE_SEQUENCE",
  "SEND_INVOICE",
  "DELETE_CUSTOMER",
  "UPDATE_STATUS_LEAD",
  "UPDATE_FOLLOWUP",
  "UPDATE_BUSINESS_CATEGORY",
  "UPDATE_ASSIGN",
  "UPDATE_PIPELINE_STAGE"
] as const;

type CampaignRuleActionType = (typeof CAMPAIGN_RULE_ACTION_TYPES)[number];

function normalizeEventType(value: string | undefined): CampaignRuleEventType | undefined {
  const normalized = normalize(value).toUpperCase();
  return CAMPAIGN_RULE_EVENT_TYPES.find((item) => item === normalized as CampaignRuleEventType);
}

function normalizeActionType(value: string | undefined): CampaignRuleActionType | undefined {
  const normalized = normalize(value).toUpperCase();
  return CAMPAIGN_RULE_ACTION_TYPES.find((item) => item === normalized as CampaignRuleActionType);
}

export function parseRuleConditionExpr(raw: string): CampaignRuleCondition {
  const json = parseObject(raw);
  const triggersRaw = Array.isArray(json.triggers) ? json.triggers : [];
  const triggers = triggersRaw
    .filter((it) => Boolean(it) && typeof it === "object")
    .map((it) => {
      const row = it as Record<string, unknown>;
      const messageScopeRaw = normalize(typeof row.messageScope === "string" ? row.messageScope : "ANY").toUpperCase();
      return {
        id: normalize(typeof row.id === "string" ? row.id : "") || undefined,
        source: normalize(typeof row.source === "string" ? row.source : "") || undefined,
        eventType: normalizeEventType(typeof row.eventType === "string" ? row.eventType : ""),
        messageScope:
          messageScopeRaw === "SEQUENCE" || messageScopeRaw === "BROADCAST" || messageScopeRaw === "ANY"
            ? (messageScopeRaw as "ANY" | "SEQUENCE" | "BROADCAST")
            : "ANY",
        sequenceId: normalize(typeof row.sequenceId === "string" ? row.sequenceId : "") || undefined,
        broadcastId: normalize(typeof row.broadcastId === "string" ? row.broadcastId : "") || undefined
      } satisfies CampaignRuleTrigger;
    });

  const operatorRaw = normalize(typeof json.operator === "string" ? json.operator : "OR").toUpperCase();
  return {
    name: normalize(typeof json.name === "string" ? json.name : "") || undefined,
    operator: operatorRaw === "AND" ? "AND" : "OR",
    triggers
  };
}

export function parseRuleActionExpr(raw: string): CampaignRuleActionBundle {
  const json = parseObject(raw);
  const actionsRaw = Array.isArray(json.actions) ? json.actions : [];
  const actions = actionsRaw
    .filter((it) => Boolean(it) && typeof it === "object")
    .map((it) => {
      const row = it as Record<string, unknown>;
      return {
        id: normalize(typeof row.id === "string" ? row.id : "") || undefined,
        actionType: normalizeActionType(typeof row.actionType === "string" ? row.actionType : ""),
        tagId: normalize(typeof row.tagId === "string" ? row.tagId : "") || undefined,
        sequenceId: normalize(typeof row.sequenceId === "string" ? row.sequenceId : "") || undefined,
        fromSequenceId: normalize(typeof row.fromSequenceId === "string" ? row.fromSequenceId : "") || undefined,
        toSequenceId: normalize(typeof row.toSequenceId === "string" ? row.toSequenceId : "") || undefined,
        invoiceId: normalize(typeof row.invoiceId === "string" ? row.invoiceId : "") || undefined,
        leadStatus: normalize(typeof row.leadStatus === "string" ? row.leadStatus : "") || undefined,
        followUpStatus: normalize(typeof row.followUpStatus === "string" ? row.followUpStatus : "") || undefined,
        businessCategory: normalize(typeof row.businessCategory === "string" ? row.businessCategory : "") || undefined,
        assigneeId: normalize(typeof row.assigneeId === "string" ? row.assigneeId : "") || undefined,
        pipelineStage: normalize(typeof row.pipelineStage === "string" ? row.pipelineStage : "") || undefined
      } satisfies CampaignRuleAction;
    });

  const operatorRaw = normalize(typeof json.operator === "string" ? json.operator : "AND").toUpperCase();
  return {
    operator: operatorRaw === "OR" ? "OR" : "AND",
    actions
  };
}

export function validateRuleConditionExpr(raw: string): { valid: boolean; message?: string; normalized: string } {
  const condition = parseRuleConditionExpr(raw);
  if (condition.triggers.length === 0) {
    return { valid: false, message: "Minimal satu trigger wajib diisi.", normalized: raw };
  }

  for (const trigger of condition.triggers) {
    if (!trigger.eventType) {
      return { valid: false, message: "eventType trigger tidak valid.", normalized: raw };
    }
    if ((trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "SEQUENCE" && !trigger.sequenceId) {
      return { valid: false, message: "Trigger read/didnt_read scope sequence wajib sequenceId.", normalized: raw };
    }
    if ((trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "BROADCAST" && !trigger.broadcastId) {
      return { valid: false, message: "Trigger read/didnt_read scope broadcast wajib broadcastId.", normalized: raw };
    }
    if ((trigger.eventType === "SUBSCRIBED_SEQUENCE" || trigger.eventType === "UNSUBSCRIBED_SEQUENCE" || trigger.eventType === "COMPLETED_SEQUENCE") && !trigger.sequenceId) {
      return { valid: false, message: "Trigger sequence wajib sequenceId.", normalized: raw };
    }
  }

  return { valid: true, normalized: JSON.stringify(condition) };
}

export function validateRuleActionExpr(raw: string): { valid: boolean; message?: string; normalized: string } {
  const actions = parseRuleActionExpr(raw);
  if (actions.actions.length === 0) {
    return { valid: false, message: "Minimal satu action wajib diisi.", normalized: raw };
  }

  for (const action of actions.actions) {
    if (!action.actionType) {
      return { valid: false, message: "actionType tidak valid.", normalized: raw };
    }
    if ((action.actionType === "APPLY_TAG" || action.actionType === "REMOVE_TAG") && !action.tagId) {
      return { valid: false, message: "Action tag wajib tagId.", normalized: raw };
    }
    if ((action.actionType === "SUBSCRIBE_SEQUENCE" || action.actionType === "UNSUBSCRIBE_SEQUENCE") && !action.sequenceId) {
      return { valid: false, message: "Action subscribe/unsubscribe wajib sequenceId.", normalized: raw };
    }
    if (action.actionType === "MOVE_SEQUENCE" && (!action.fromSequenceId || !action.toSequenceId)) {
      return { valid: false, message: "Action move sequence wajib fromSequenceId dan toSequenceId.", normalized: raw };
    }
    if (action.actionType === "SEND_INVOICE" && !action.invoiceId) {
      return { valid: false, message: "Action send invoice wajib invoiceId.", normalized: raw };
    }
    if (action.actionType === "UPDATE_STATUS_LEAD" && !action.leadStatus) {
      return { valid: false, message: "Action update status lead wajib leadStatus.", normalized: raw };
    }
    if (action.actionType === "UPDATE_FOLLOWUP" && !action.followUpStatus) {
      return { valid: false, message: "Action update follow up wajib followUpStatus.", normalized: raw };
    }
    if (action.actionType === "UPDATE_BUSINESS_CATEGORY" && !action.businessCategory) {
      return { valid: false, message: "Action update business category wajib businessCategory.", normalized: raw };
    }
    if (action.actionType === "UPDATE_ASSIGN" && !action.assigneeId) {
      return { valid: false, message: "Action update assign wajib assigneeId.", normalized: raw };
    }
    if (action.actionType === "UPDATE_PIPELINE_STAGE" && !action.pipelineStage) {
      return { valid: false, message: "Action update pipeline stage wajib pipelineStage.", normalized: raw };
    }
  }

  return { valid: true, normalized: JSON.stringify(actions) };
}

export function triggerMatchesEvent(trigger: CampaignRuleTrigger, event: CampaignRuleEvent): boolean {
  const eventType = normalize(trigger.eventType).toUpperCase();
  if (!eventType || eventType !== event.eventType) {
    return false;
  }

  if ((event.eventType === "READ_MESSAGE" || event.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope && trigger.messageScope !== "ANY") {
    if (event.messageScope !== trigger.messageScope) {
      return false;
    }
    if (trigger.messageScope === "SEQUENCE") {
      return !trigger.sequenceId || normalize(trigger.sequenceId) === normalize(event.sequenceId);
    }
    if (trigger.messageScope === "BROADCAST") {
      return !trigger.broadcastId || normalize(trigger.broadcastId) === normalize(event.broadcastId);
    }
  }

  if (
    event.eventType === "SUBSCRIBED_SEQUENCE" ||
    event.eventType === "UNSUBSCRIBED_SEQUENCE" ||
    event.eventType === "COMPLETED_SEQUENCE"
  ) {
    if (trigger.sequenceId && normalize(trigger.sequenceId) !== normalize(event.sequenceId ?? event.flowId)) {
      return false;
    }
  }

  return true;
}

export function shouldRunRule(rawConditionExpr: string, event: CampaignRuleEvent): boolean {
  const condition = parseRuleConditionExpr(rawConditionExpr);
  if (condition.triggers.length === 0) {
    return false;
  }

  const flags = condition.triggers.map((trigger) => triggerMatchesEvent(trigger, event));
  if (condition.operator === "AND") {
    return flags.every(Boolean);
  }
  return flags.some(Boolean);
}

export function parseRuleActions(rawActionExpr: string): CampaignRuleAction[] {
  return parseRuleActionExpr(rawActionExpr).actions.filter((action) => normalize(action.actionType));
}

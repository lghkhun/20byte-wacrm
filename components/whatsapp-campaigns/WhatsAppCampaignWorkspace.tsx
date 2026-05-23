"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Check, ListChecks, Paperclip, Pencil, RadioTower, Settings2, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { isAllowedAttachmentType } from "@/components/inbox/input/utils";
import { dismissNotify, notifyError, notifyLoading, notifySuccess } from "@/lib/ui/notify";

type TabId = "sequences" | "broadcast" | "rules";

type FlowNodeType = "SEND_TEMPLATE" | "SEND_TEXT" | "DELAY" | "STOP";
type FlowNode = {
  id: string;
  key: string;
  type: FlowNodeType;
  configJson: string;
};

type FlowEdge = {
  id: string;
  fromNodeKey: string;
  toNodeKey: string;
  conditionKey: string | null;
};

type FlowItem = {
  id: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  triggerType?: "MANUAL" | "CHAT_INCOMING";
  nodes: FlowNode[];
  edges: FlowEdge[];
};

type AnalyticsPayload = {
  analytics?: {
    funnel?: {
      enrolled?: number;
      queued?: number;
      sent?: number;
      failed?: number;
      stopped?: number;
      skipped?: number;
    };
    broadcasts?: {
      pending?: number;
      queued?: number;
      sent?: number;
      failed?: number;
      skipped?: number;
      stopped?: number;
    };
  };
};

type RuleItem = {
  id: string;
  triggerType: string;
  conditionExpr: string;
  actionType: string;
  isActive: boolean;
  updatedAt: string;
};

type TriggerSource = "20BYTE" | "DAEKANAPP" | "META_CAPI";
type TriggerEventType =
  | "TAG_APPLIED"
  | "TAG_REMOVED"
  | "READ_MESSAGE"
  | "DIDNT_READ_MESSAGE"
  | "SUBSCRIBED_SEQUENCE"
  | "UNSUBSCRIBED_SEQUENCE"
  | "COMPLETED_SEQUENCE"
  | "INVOICE_SENDING"
  | "STATUS_LEAD_UPDATE"
  | "FOLLOWUP_UPDATE"
  | "BUSINESS_CATEGORY_UPDATE"
  | "ASSIGN_UPDATE"
  | "PIPELINE_STAGE_UPDATE";
type MessageScopeType = "ANY" | "SEQUENCE" | "BROADCAST";
type RuleActionType =
  | "APPLY_TAG"
  | "REMOVE_TAG"
  | "SUBSCRIBE_SEQUENCE"
  | "UNSUBSCRIBE_SEQUENCE"
  | "MOVE_SEQUENCE"
  | "SEND_INVOICE"
  | "DELETE_CUSTOMER"
  | "UPDATE_STATUS_LEAD"
  | "UPDATE_FOLLOWUP"
  | "UPDATE_BUSINESS_CATEGORY"
  | "UPDATE_ASSIGN"
  | "UPDATE_PIPELINE_STAGE";
type RuleTriggerDraft = {
  id: string;
  source: TriggerSource;
  eventType: TriggerEventType;
  messageScope: MessageScopeType;
  sequenceId: string;
  broadcastId: string;
  tagId: string;
  invoiceId: string;
  leadStatus: string;
  followUpStatus: string;
  businessCategory: string;
  assigneeId: string;
  pipelineStage: string;
};
type RuleActionDraft = {
  id: string;
  actionType: RuleActionType;
  tagId: string;
  sequenceId: string;
  fromSequenceId: string;
  toSequenceId: string;
  invoiceId: string;
  leadStatus: string;
  followUpStatus: string;
  businessCategory: string;
  assigneeId: string;
  pipelineStage: string;
};

type TagOption = {
  id: string;
  name: string;
};

type InvoiceOption = {
  id: string;
  label: string;
};

type BroadcastItem = {
  id: string;
  name: string;
  status: "DRAFT" | "RUNNING" | "COMPLETED" | "CANCELED";
  messageMode: "TEMPLATE" | "TEXT";
  text?: string | null;
  templateName?: string | null;
  recipientMode?: "SEGMENT" | "SELECTED_CUSTOMERS" | "HYBRID";
  segment?: "all_leads" | "hot_leads" | "followup_today";
  selectedCustomerIdsJson?: string | null;
  filtersJson?: string | null;
  batchSize?: number;
  batchIntervalSeconds?: number;
  scheduledAt?: string | null;
  createdAt: string;
  _count?: {
    recipients?: number;
  };
};

type CustomerRow = {
  id: string;
  createdAt?: string | null;
  name?: string | null;
  phoneE164?: string | null;
  businessCategory?: string | null;
  leadStatus?: string | null;
  followUpStatus?: string | null;
  stageName?: string | null;
  assigneeName?: string | null;
  source?: string | null;
};

type BroadcastDraftMap = Record<
  string,
  {
    typeOfMessage: "WINDOW_24H" | "PHONE_NUMBERS";
    selectedCustomerIds: string[];
    scheduleDate: string;
    recipientsCount: string;
    intervalValue: string;
    intervalUnit: "minute" | "hour" | "day";
    text: string;
  }
>;

type BroadcastTypeOfMessage = "WINDOW_24H" | "PHONE_NUMBERS";

const MAIN_TABS: Array<{ id: TabId; label: string; icon: typeof ListChecks }> = [
  { id: "sequences", label: "Sequences", icon: ListChecks },
  { id: "broadcast", label: "Broadcast", icon: RadioTower },
  { id: "rules", label: "Rules", icon: ListChecks }
];

function statusVariant(status: FlowItem["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ACTIVE") return "default";
  if (status === "PAUSED") return "secondary";
  if (status === "ARCHIVED") return "outline";
  return "secondary";
}

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Request failed.");
  }
  return payload;
}

function parseSelectedCustomerIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === "string" ? item : "")).filter(Boolean);
  } catch {
    return [];
  }
}

function parseBroadcastFilters(raw: string | null | undefined): {
  assigneeName: string;
  leadStatus: string;
  pipelineStage: string;
  source: string;
} {
  if (!raw) {
    return {
      assigneeName: "ALL",
      leadStatus: "ALL",
      pipelineStage: "ALL",
      source: "ALL"
    };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      assigneeName: typeof parsed.assigneeName === "string" && parsed.assigneeName ? parsed.assigneeName : "ALL",
      leadStatus: typeof parsed.leadStatus === "string" && parsed.leadStatus ? parsed.leadStatus : "ALL",
      pipelineStage: typeof parsed.pipelineStage === "string" && parsed.pipelineStage ? parsed.pipelineStage : "ALL",
      source: typeof parsed.source === "string" && parsed.source ? parsed.source : "ALL"
    };
  } catch {
    return {
      assigneeName: "ALL",
      leadStatus: "ALL",
      pipelineStage: "ALL",
      source: "ALL"
    };
  }
}

function readableNodeType(type: FlowNodeType): string {
  if (type === "SEND_TEMPLATE") return "Send Template";
  if (type === "SEND_TEXT") return "Send Text";
  if (type === "DELAY") return "Delay";
  return "Stop";
}

const SEQUENCE_DRAFT_STORAGE_KEY = "wa_sequence_builder_drafts_v1";
const BROADCAST_DRAFT_STORAGE_KEY = "wa_broadcast_builder_drafts_v1";

type SequenceDraftMap = Record<
  string,
  {
    name: string;
    status: FlowItem["status"];
    triggerType: "MANUAL" | "CHAT_INCOMING";
    nodes: FlowNode[];
    edges: FlowEdge[];
  }
>;

function readableNodeTiming(node: FlowNode): string {
  if (node.type !== "SEND_TEXT") return "";
  try {
    const parsed = JSON.parse(node.configJson) as {
      timingMode?: "immediately" | "delay";
      delaySeconds?: number;
      delayUnit?: "day" | "hour" | "minute";
    };
    if (parsed.timingMode === "delay") {
      const amount = Math.max(1, Number(parsed.delaySeconds) || 1);
      const unit = parsed.delayUnit ?? "day";
      return `${amount} ${unit}(s) after previous`;
    }
    return "Immediately";
  } catch {
    return "Immediately";
  }
}

function readNodeEnabled(node: FlowNode): boolean {
  try {
    const parsed = JSON.parse(node.configJson) as { enabled?: boolean };
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

function createDefaultRuleTrigger(): RuleTriggerDraft {
  return {
    id: `trigger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: "20BYTE",
    eventType: "TAG_APPLIED",
    messageScope: "ANY",
    sequenceId: "",
    broadcastId: "",
    tagId: "",
    invoiceId: "",
    leadStatus: "",
    followUpStatus: "",
    businessCategory: "",
    assigneeId: "",
    pipelineStage: ""
  };
}

function createDefaultRuleAction(): RuleActionDraft {
  return {
    id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    actionType: "APPLY_TAG",
    tagId: "",
    sequenceId: "",
    fromSequenceId: "",
    toSequenceId: "",
    invoiceId: "",
    leadStatus: "",
    followUpStatus: "",
    businessCategory: "",
    assigneeId: "",
    pipelineStage: ""
  };
}

export function WhatsAppCampaignWorkspace() {
  const [activeTab, setActiveTab] = useState<TabId>("sequences");
  const [isLoading, setIsLoading] = useState(true);
  const [flows, setFlows] = useState<FlowItem[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsPayload["analytics"] | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState("");
  const [selectedNodeKey, setSelectedNodeKey] = useState("");
  const [broadcasts, setBroadcasts] = useState<BroadcastItem[]>([]);
  const [isLoadingFlows, setIsLoadingFlows] = useState(false);
  const [isLoadingRules, setIsLoadingRules] = useState(false);
  const [isLoadingBroadcasts, setIsLoadingBroadcasts] = useState(false);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);

  const [flowForm, setFlowForm] = useState({
    name: "",
    templateName: "",
    templateLanguageCode: "id",
    status: "DRAFT" as "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED",
    triggerType: "MANUAL" as "MANUAL" | "CHAT_INCOMING"
  });
  const [suppressionForm, setSuppressionForm] = useState({
    conversationId: "",
    reason: "Opt-out by request"
  });
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [broadcastForm, setBroadcastForm] = useState({
    name: "",
    segment: "all_leads",
    messageMode: "TEMPLATE" as "TEMPLATE" | "TEXT",
    templateName: "",
    text: ""
  });
  const [stepDraft, setStepDraft] = useState({
    templateName: "",
    text: "",
    delaySeconds: "0",
    timingMode: "immediately" as "immediately" | "delay",
    delayUnit: "day" as "day" | "hour" | "minute"
  });
  const [newStepType, setNewStepType] = useState<FlowNodeType>("SEND_TEXT");
  const [builderMode, setBuilderMode] = useState<"list" | "editor">("list");
  const [newSequenceModalOpen, setNewSequenceModalOpen] = useState(false);
  const [newRuleModalOpen, setNewRuleModalOpen] = useState(false);
  const [newSequenceName, setNewSequenceName] = useState("");
  const [newRuleName, setNewRuleName] = useState("");
  const [draggingNodeKey, setDraggingNodeKey] = useState("");
  const [localDrafts, setLocalDrafts] = useState<SequenceDraftMap>({});
  const [isEditingFlowName, setIsEditingFlowName] = useState(false);
  const [pendingFlowName, setPendingFlowName] = useState("");
  const [attachedFilesByNode, setAttachedFilesByNode] = useState<Record<string, Array<{ fileName: string; mimeType: string; size: number }>>>({});
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [invoiceOptions, setInvoiceOptions] = useState<InvoiceOption[]>([]);
  const [leadStatusOptions, setLeadStatusOptions] = useState<string[]>([]);
  const [followUpOptions, setFollowUpOptions] = useState<string[]>([]);
  const [businessCategoryOptions, setBusinessCategoryOptions] = useState<string[]>([]);
  const [assigneeOptions, setAssigneeOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [pipelineStageOptions, setPipelineStageOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [rulesBuilderMode, setRulesBuilderMode] = useState<"list" | "editor">("list");
  const [broadcastBuilderMode, setBroadcastBuilderMode] = useState<"list" | "editor">("list");
  const [newBroadcastModalOpen, setNewBroadcastModalOpen] = useState(false);
  const [newBroadcastName, setNewBroadcastName] = useState("");
  const [selectedBroadcastId, setSelectedBroadcastId] = useState("");
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [broadcastCustomerSearch, setBroadcastCustomerSearch] = useState("");
  const [broadcastTypeOfMessage, setBroadcastTypeOfMessage] = useState<"WINDOW_24H" | "PHONE_NUMBERS">("WINDOW_24H");
  const [broadcastSelectedCustomerIds, setBroadcastSelectedCustomerIds] = useState<string[]>([]);
  const [broadcastScheduleDate, setBroadcastScheduleDate] = useState("");
  const [broadcastRecipientsCount, setBroadcastRecipientsCount] = useState("5");
  const [broadcastIntervalValue, setBroadcastIntervalValue] = useState("10");
  const [broadcastIntervalUnit, setBroadcastIntervalUnit] = useState<"minute" | "hour" | "day">("minute");
  const [broadcastFilterAssignee, setBroadcastFilterAssignee] = useState("ALL");
  const [broadcastFilterStatus, setBroadcastFilterStatus] = useState("ALL");
  const [broadcastFilterPipeline, setBroadcastFilterPipeline] = useState("ALL");
  const [broadcastFilterSource, setBroadcastFilterSource] = useState("ALL");
  const [broadcastStatusFilter, setBroadcastStatusFilter] = useState<"ALL" | "RUNNING" | "DRAFT" | "COMPLETED" | "CANCELED">("ALL");
  const [broadcastDrafts, setBroadcastDrafts] = useState<BroadcastDraftMap>({});
  const [ruleEditorName, setRuleEditorName] = useState("");
  const [ruleEditorEnabled, setRuleEditorEnabled] = useState(true);
  const [ruleTriggers, setRuleTriggers] = useState<RuleTriggerDraft[]>([]);
  const [ruleActions, setRuleActions] = useState<RuleActionDraft[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  const selectedFlow = useMemo(() => flows.find((flow) => flow.id === selectedFlowId) ?? null, [flows, selectedFlowId]);
  const selectedNode = useMemo(() => selectedFlow?.nodes.find((node) => node.key === selectedNodeKey) ?? null, [selectedFlow, selectedNodeKey]);
  const selectedBroadcast = useMemo(
    () => broadcasts.find((item) => item.id === selectedBroadcastId) ?? null,
    [broadcasts, selectedBroadcastId]
  );
  const filteredBroadcastCustomers = useMemo(() => {
    const keyword = broadcastCustomerSearch.trim().toLowerCase();
    return customers.filter((item) => {
      const assigneeMatch = broadcastFilterAssignee === "ALL" || (item.assigneeName ?? "") === broadcastFilterAssignee;
      const statusMatch = broadcastFilterStatus === "ALL" || (item.leadStatus ?? "") === broadcastFilterStatus;
      const pipelineMatch = broadcastFilterPipeline === "ALL" || (item.stageName ?? "") === broadcastFilterPipeline;
      const sourceMatch = broadcastFilterSource === "ALL" || (item.source ?? "") === broadcastFilterSource;
      if (!assigneeMatch || !statusMatch || !pipelineMatch || !sourceMatch) return false;
      if (!keyword) return true;
      const haystack = `${item.name ?? ""} ${item.phoneE164 ?? ""} ${item.businessCategory ?? ""} ${item.leadStatus ?? ""}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [customers, broadcastCustomerSearch, broadcastFilterAssignee, broadcastFilterStatus, broadcastFilterPipeline, broadcastFilterSource]);
  const broadcastSourceOptions = useMemo(
    () => Array.from(new Set(customers.map((item) => item.source?.trim() ?? "").filter((item) => item.length > 0))).sort((a, b) => a.localeCompare(b)),
    [customers]
  );
  const areAllFilteredCustomersSelected =
    filteredBroadcastCustomers.length > 0 && filteredBroadcastCustomers.every((item) => broadcastSelectedCustomerIds.includes(item.id));
  const visibleBroadcasts = useMemo(() => {
    if (broadcastStatusFilter === "ALL") return broadcasts;
    return broadcasts.filter((item) => item.status === broadcastStatusFilter);
  }, [broadcasts, broadcastStatusFilter]);
  const rulesRuntimeValidation = useMemo(() => {
    if (ruleTriggers.length === 0) return { valid: false, message: "Minimal 1 trigger." };
    if (ruleActions.length === 0) return { valid: false, message: "Minimal 1 action." };
    for (const trigger of ruleTriggers) {
      if (!trigger.eventType) return { valid: false, message: "Event trigger belum lengkap." };
      if ((trigger.eventType === "SUBSCRIBED_SEQUENCE" || trigger.eventType === "UNSUBSCRIBED_SEQUENCE" || trigger.eventType === "COMPLETED_SEQUENCE") && !trigger.sequenceId) {
        return { valid: false, message: "Trigger sequence wajib pilih sequence." };
      }
      if ((trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "SEQUENCE" && !trigger.sequenceId) {
        return { valid: false, message: "Trigger read scope sequence wajib sequence." };
      }
      if ((trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "BROADCAST" && !trigger.broadcastId) {
        return { valid: false, message: "Trigger read scope broadcast wajib broadcast." };
      }
    }
    for (const action of ruleActions) {
      if (!action.actionType) return { valid: false, message: "Action belum lengkap." };
      if ((action.actionType === "APPLY_TAG" || action.actionType === "REMOVE_TAG") && !action.tagId) return { valid: false, message: "Action tag wajib pilih tag." };
      if ((action.actionType === "SUBSCRIBE_SEQUENCE" || action.actionType === "UNSUBSCRIBE_SEQUENCE") && !action.sequenceId) {
        return { valid: false, message: "Action subscribe/unsubscribe wajib sequence." };
      }
      if (action.actionType === "MOVE_SEQUENCE" && (!action.fromSequenceId || !action.toSequenceId)) return { valid: false, message: "Action move wajib from+to." };
      if (action.actionType === "SEND_INVOICE" && !action.invoiceId) return { valid: false, message: "Action send invoice wajib invoice." };
      if (action.actionType === "UPDATE_STATUS_LEAD" && !action.leadStatus) return { valid: false, message: "Action status lead wajib isi." };
      if (action.actionType === "UPDATE_FOLLOWUP" && !action.followUpStatus) return { valid: false, message: "Action followup wajib isi." };
      if (action.actionType === "UPDATE_BUSINESS_CATEGORY" && !action.businessCategory) return { valid: false, message: "Action category wajib isi." };
      if (action.actionType === "UPDATE_ASSIGN" && !action.assigneeId) return { valid: false, message: "Action assign wajib assignee." };
      if (action.actionType === "UPDATE_PIPELINE_STAGE" && !action.pipelineStage) return { valid: false, message: "Action pipeline wajib stage." };
    }
    return { valid: true, message: "Payload runtime valid." };
  }, [ruleActions, ruleTriggers]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(SEQUENCE_DRAFT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SequenceDraftMap;
      setLocalDrafts(parsed);
    } catch {
      setLocalDrafts({});
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SEQUENCE_DRAFT_STORAGE_KEY, JSON.stringify(localDrafts));
  }, [localDrafts]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(BROADCAST_DRAFT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as BroadcastDraftMap;
      setBroadcastDrafts(parsed);
    } catch {
      setBroadcastDrafts({});
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(BROADCAST_DRAFT_STORAGE_KEY, JSON.stringify(broadcastDrafts));
  }, [broadcastDrafts]);

  useEffect(() => {
    if (!Object.keys(localDrafts).length) return;
    setFlows((prev) =>
      prev.map((flow) => {
        const draft = localDrafts[flow.id];
        if (!draft) return flow;
        return {
          ...flow,
          name: draft.name,
          status: draft.status,
          triggerType: draft.triggerType,
          nodes: draft.nodes,
          edges: draft.edges
        };
      })
    );
  }, [localDrafts]);

  useEffect(() => {
    if (!selectedBroadcastId) return;
    const fromApi = broadcasts.find((item) => item.id === selectedBroadcastId) ?? null;
    if (fromApi) {
      const selectedFromApi = parseSelectedCustomerIds(fromApi.selectedCustomerIdsJson);
      const filtersFromApi = parseBroadcastFilters(fromApi.filtersJson);
      const typeFromApi: BroadcastTypeOfMessage = fromApi.messageMode === "TEXT" && fromApi.recipientMode !== "SEGMENT" ? "PHONE_NUMBERS" : "WINDOW_24H";
      setBroadcastForm((prev) => ({
        ...prev,
        name: fromApi.name,
        segment: fromApi.segment ?? "all_leads",
        messageMode: fromApi.messageMode,
        text: fromApi.text ?? prev.text,
        templateName: fromApi.templateName ?? ""
      }));
      setBroadcastTypeOfMessage(typeFromApi);
      setBroadcastSelectedCustomerIds(selectedFromApi);
      setBroadcastFilterAssignee(filtersFromApi.assigneeName || "ALL");
      setBroadcastFilterStatus(filtersFromApi.leadStatus || "ALL");
      setBroadcastFilterPipeline(filtersFromApi.pipelineStage || "ALL");
      setBroadcastFilterSource(filtersFromApi.source || "ALL");
      if (fromApi.scheduledAt) {
        setBroadcastScheduleDate(fromApi.scheduledAt.slice(0, 10));
      } else {
        setBroadcastScheduleDate("");
      }
      if (fromApi.batchSize) {
        setBroadcastRecipientsCount(String(fromApi.batchSize));
      }
      if (fromApi.batchIntervalSeconds) {
        const seconds = fromApi.batchIntervalSeconds;
        if (seconds % 86400 === 0) {
          setBroadcastIntervalValue(String(Math.max(1, Math.floor(seconds / 86400))));
          setBroadcastIntervalUnit("day");
        } else if (seconds % 3600 === 0) {
          setBroadcastIntervalValue(String(Math.max(1, Math.floor(seconds / 3600))));
          setBroadcastIntervalUnit("hour");
        } else {
          setBroadcastIntervalValue(String(Math.max(1, Math.floor(seconds / 60))));
          setBroadcastIntervalUnit("minute");
        }
      }
    }

    const draft = broadcastDrafts[selectedBroadcastId];
    if (!draft) {
      if (!fromApi) {
        setBroadcastTypeOfMessage("WINDOW_24H");
        setBroadcastSelectedCustomerIds([]);
        setBroadcastScheduleDate("");
        setBroadcastRecipientsCount("5");
        setBroadcastIntervalValue("10");
        setBroadcastIntervalUnit("minute");
        setBroadcastFilterAssignee("ALL");
        setBroadcastFilterStatus("ALL");
        setBroadcastFilterPipeline("ALL");
        setBroadcastFilterSource("ALL");
      }
      return;
    }
    setBroadcastTypeOfMessage(draft.typeOfMessage);
    setBroadcastSelectedCustomerIds(draft.selectedCustomerIds);
    setBroadcastScheduleDate(draft.scheduleDate);
    setBroadcastRecipientsCount(draft.recipientsCount);
    setBroadcastIntervalValue(draft.intervalValue || "10");
    setBroadcastIntervalUnit(draft.intervalUnit || "minute");
    setBroadcastForm((prev) => ({ ...prev, text: draft.text }));
  }, [selectedBroadcastId, broadcastDrafts, broadcasts]);

  function getBroadcastConfigPayload() {
    const typeOfMessage: BroadcastTypeOfMessage = broadcastTypeOfMessage;
    const messageMode: "TEXT" | "TEMPLATE" = typeOfMessage === "PHONE_NUMBERS" ? "TEXT" : "TEMPLATE";
    const recipientMode: "SEGMENT" | "SELECTED_CUSTOMERS" = typeOfMessage === "PHONE_NUMBERS" ? "SELECTED_CUSTOMERS" : "SEGMENT";
    const segment = typeOfMessage === "PHONE_NUMBERS" ? "all_leads" : "all_leads";
    const batchSize = Math.max(1, Number(broadcastRecipientsCount) || 1);
    const intervalValue = Math.max(1, Number(broadcastIntervalValue) || 1);
    const batchIntervalSeconds =
      broadcastIntervalUnit === "day" ? intervalValue * 86400 : broadcastIntervalUnit === "hour" ? intervalValue * 3600 : intervalValue * 60;
    const scheduledAt = broadcastScheduleDate ? new Date(`${broadcastScheduleDate}T00:00:00.000Z`).toISOString() : null;
    const filters = {
      assigneeName: broadcastFilterAssignee,
      leadStatus: broadcastFilterStatus,
      pipelineStage: broadcastFilterPipeline,
      source: broadcastFilterSource
    };
    return {
      messageMode,
      recipientMode,
      segment,
      selectedCustomerIds: recipientMode === "SELECTED_CUSTOMERS" ? broadcastSelectedCustomerIds : [],
      filters,
      batchSize,
      batchIntervalSeconds,
      scheduledAt,
      text: broadcastForm.text.trim(),
      templateName: messageMode === "TEMPLATE" ? (broadcastForm.templateName.trim() || "promo_template") : "",
      templateLanguageCode: messageMode === "TEMPLATE" ? "id" : "",
      templateCategory: messageMode === "TEMPLATE" ? "MARKETING" : undefined,
      templateComponentsJson:
        messageMode === "TEMPLATE"
          ? JSON.stringify({
              components: [{ type: "body", parameters: [{ type: "text", text: broadcastForm.text.trim() || "Halo" }] }]
            })
          : ""
    };
  }

  useEffect(() => {
    if (!selectedNode) {
      setStepDraft({ templateName: "", text: "", delaySeconds: "0", timingMode: "immediately", delayUnit: "day" });
      return;
    }
    try {
      const parsed = JSON.parse(selectedNode.configJson) as Record<string, unknown>;
      const delaySeconds = typeof parsed.delaySeconds === "number" ? parsed.delaySeconds : 0;
      const timingMode = typeof parsed.timingMode === "string" && parsed.timingMode === "delay" ? "delay" : "immediately";
      const delayUnit =
        parsed.delayUnit === "minute" || parsed.delayUnit === "hour" || parsed.delayUnit === "day" ? parsed.delayUnit : "day";
      setStepDraft({
        templateName: typeof parsed.templateName === "string" ? parsed.templateName : "",
        text: typeof parsed.text === "string" ? parsed.text : "",
        delaySeconds: String(delaySeconds),
        timingMode,
        delayUnit
      });
      const attachments = Array.isArray(parsed.attachments)
        ? parsed.attachments
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const asRecord = item as Record<string, unknown>;
              if (typeof asRecord.fileName !== "string" || typeof asRecord.mimeType !== "string" || typeof asRecord.size !== "number") return null;
              return {
                fileName: asRecord.fileName,
                mimeType: asRecord.mimeType,
                size: asRecord.size
              };
            })
            .filter((item): item is { fileName: string; mimeType: string; size: number } => item !== null)
        : [];
      setAttachedFilesByNode((prev) => ({
        ...prev,
        [selectedNode.key]: attachments
      }));
    } catch {
      setStepDraft({ templateName: "", text: "", delaySeconds: "0", timingMode: "immediately", delayUnit: "day" });
    }
  }, [selectedNode]);

  useEffect(() => {
    if (!selectedFlow || !selectedNode) return;
    const timer = window.setTimeout(() => {
      void handleSaveStep(true);
    }, 220);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFlow, selectedNode, stepDraft, handleSaveStep]);

  useEffect(() => {
    setPendingFlowName(selectedFlow?.name ?? "");
    setIsEditingFlowName(false);
  }, [selectedFlow?.id, selectedFlow?.name]);

  useEffect(() => {
    const flowId = selectedFlowId.trim();
    if (!flowId) {
      setRules([]);
      return;
    }

    let cancelled = false;
    const loadRules = async () => {
      setIsLoadingRules(true);
      try {
        const response = await fetch(`/api/whatsapp/flows/${flowId}/rules`, { cache: "no-store" });
        const payload = await parseJson<{ data?: { items?: RuleItem[] } }>(response);
        if (!cancelled) {
          setRules(payload.data?.items ?? []);
        }
      } catch (error) {
        if (!cancelled) {
          setRules([]);
          notifyError(error instanceof Error ? error.message : "Gagal memuat rules.");
        }
      } finally {
        if (!cancelled) setIsLoadingRules(false);
      }
    };

    void loadRules();
    return () => {
      cancelled = true;
    };
  }, [selectedFlowId]);

  async function loadFlows() {
    setIsLoadingFlows(true);
    try {
      const response = await fetch("/api/whatsapp/flows", { cache: "no-store" });
      const payload = await parseJson<{ data?: { items?: FlowItem[] } }>(response);
      const nextRaw = payload.data?.items ?? [];
      const next = nextRaw.map((flow) => {
        const draft = localDrafts[flow.id];
        if (!draft) return flow;
        return {
          ...flow,
          name: draft.name,
          status: draft.status,
          triggerType: draft.triggerType,
          nodes: draft.nodes,
          edges: draft.edges
        };
      });
      setFlows(next);
      if (next.length === 0) {
        setSelectedFlowId("");
        setSelectedNodeKey("");
        return;
      }
      const alreadySelected = next.some((flow) => flow.id === selectedFlowId);
      const flowId = alreadySelected ? selectedFlowId : next[0].id;
      setSelectedFlowId(flowId);
      const flow = next.find((item) => item.id === flowId);
      if (!flow) {
        setSelectedNodeKey("");
        return;
      }
      const hasNodeSelected = flow.nodes.some((node) => node.key === selectedNodeKey);
      setSelectedNodeKey(hasNodeSelected ? selectedNodeKey : flow.nodes[0]?.key ?? "");
    } finally {
      setIsLoadingFlows(false);
    }
  }

  async function loadAnalytics() {
    setIsLoadingAnalytics(true);
    const response = await fetch("/api/whatsapp/analytics/campaigns", { cache: "no-store" });
    const payload = await parseJson<{ data?: AnalyticsPayload }>(response);
    setAnalytics(payload.data?.analytics ?? null);
    setIsLoadingAnalytics(false);
  }

  async function loadBroadcasts() {
    setIsLoadingBroadcasts(true);
    const response = await fetch("/api/whatsapp/broadcasts", { cache: "no-store" });
    const payload = await parseJson<{ data?: { items?: BroadcastItem[] } }>(response);
    setBroadcasts(payload.data?.items ?? []);
    setIsLoadingBroadcasts(false);
  }

  async function loadTags() {
    const response = await fetch("/api/tags", { cache: "no-store" });
    const payload = await parseJson<{ data?: { tags?: Array<{ id: string; name: string }> } }>(response);
    setTagOptions((payload.data?.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name })));
  }

  async function loadInvoices() {
    const response = await fetch("/api/invoices?page=1&limit=100", { cache: "no-store" });
    const payload = await parseJson<{ data?: { invoices?: Array<{ id: string; invoiceNo?: string | null; customerDisplayName?: string | null }> } }>(response);
    setInvoiceOptions(
      (payload.data?.invoices ?? []).map((invoice) => ({
        id: invoice.id,
        label: `${invoice.invoiceNo ?? "Invoice"}${invoice.customerDisplayName ? ` - ${invoice.customerDisplayName}` : ""}`
      }))
    );
  }

  async function loadCustomerOptions() {
    const response = await fetch("/api/customers?page=1&limit=200", { cache: "no-store" });
    const payload = await parseJson<{
      data?: {
        customers?: Array<{
          id: string;
          createdAt?: string | null;
          customerName?: string | null;
          phoneE164?: string | null;
          leadStatus?: string | null;
          followUpStatus?: string | null;
          businessCategory?: string | null;
          stageName?: string | null;
          stageId?: string | null;
          assigneeName?: string | null;
          source?: string | null;
        }>;
        assignees?: Array<{ memberId: string; name: string }>;
      };
    }>(response);
    const customers = payload.data?.customers ?? [];
    const leadStatuses = Array.from(new Set(customers.map((item) => item.leadStatus?.trim() ?? "").filter((item) => item.length > 0))).sort((a, b) =>
      a.localeCompare(b)
    );
    const followUps = Array.from(new Set(customers.map((item) => item.followUpStatus?.trim() ?? "").filter((item) => item.length > 0))).sort((a, b) =>
      a.localeCompare(b)
    );
    const categories = Array.from(new Set(customers.map((item) => item.businessCategory?.trim() ?? "").filter((item) => item.length > 0))).sort((a, b) =>
      a.localeCompare(b)
    );
    const stages = Array.from(
      new Map(
        customers
          .filter((item) => (item.stageId?.trim() ?? "").length > 0 && (item.stageName?.trim() ?? "").length > 0)
          .map((item) => [item.stageId!.trim(), { id: item.stageId!.trim(), name: item.stageName!.trim() }])
      ).values()
    ).sort((a, b) => a.name.localeCompare(b.name));

    setLeadStatusOptions(leadStatuses);
    setFollowUpOptions(followUps);
    setBusinessCategoryOptions(categories);
    setPipelineStageOptions(stages);
    setAssigneeOptions((payload.data?.assignees ?? []).map((item) => ({ id: item.memberId, name: item.name })));
    setCustomers(
      customers.map((item) => ({
        id: item.id,
        createdAt: item.createdAt ?? null,
        name: item.customerName ?? null,
        phoneE164: item.phoneE164 ?? null,
        businessCategory: item.businessCategory ?? null,
        leadStatus: item.leadStatus ?? null,
        followUpStatus: item.followUpStatus ?? null,
        stageName: item.stageName ?? null,
        assigneeName: item.assigneeName ?? null,
        source: item.source ?? null
      }))
    );
  }

  async function loadAll() {
    setIsLoading(true);
    try {
      await Promise.all([loadFlows(), loadAnalytics(), loadBroadcasts(), loadTags(), loadInvoices(), loadCustomerOptions()]);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal memuat module WhatsApp campaigns.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persistLocalFlowDraft(flow: FlowItem) {
    setLocalDrafts((prev) => ({
      ...prev,
      [flow.id]: {
        name: flow.name,
        status: flow.status,
        triggerType: flow.triggerType ?? "MANUAL",
        nodes: flow.nodes,
        edges: flow.edges
      }
    }));
  }

  function updateLocalFlow(flowId: string, updater: (flow: FlowItem) => FlowItem): FlowItem | null {
    let updatedFlow: FlowItem | null = null;
    setFlows((prev) =>
      prev.map((flow) => {
        if (flow.id !== flowId) return flow;
        const next = updater(flow);
        updatedFlow = next;
        return next;
      })
    );
    if (updatedFlow) persistLocalFlowDraft(updatedFlow);
    return updatedFlow;
  }

  async function handleCreateFlow() {
    const flowName = (newSequenceName.trim() || flowForm.name.trim()).trim();
    if (!flowName) {
      notifyError("Nama sequence wajib diisi.");
      return;
    }

    const toastId = notifyLoading("Membuat flow...");
    try {
      await parseJson(
        await fetch("/api/whatsapp/flows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: flowName,
            status: flowForm.status,
            triggerType: flowForm.triggerType,
            nodes: [
              {
                key: "step_1_text",
                type: "SEND_TEXT",
                configJson: JSON.stringify({
                  text: "Halo, ini pesan pertama sequence WhatsApp."
                })
              },
              { key: "step_2_stop", type: "STOP", configJson: "{}" }
            ],
            edges: [{ fromNodeKey: "step_1_text", toNodeKey: "step_2_stop" }]
          })
        })
      );
      setFlowForm((prev) => ({ ...prev, name: "", templateName: "" }));
      setNewSequenceName("");
      await loadAll();
      setBuilderMode("editor");
      setNewSequenceModalOpen(false);
      dismissNotify(toastId);
      notifySuccess("Sequence berhasil dibuat.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal membuat flow.");
    }
  }

  async function handleFlowAction(flowId: string, action: "pause" | "resume" | "stop") {
    const toastId = notifyLoading(`${action.toUpperCase()} flow...`);
    try {
      await parseJson(
        await fetch(`/api/whatsapp/flows/${flowId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
      );
      await loadAll();
      dismissNotify(toastId);
      notifySuccess(`Sequence berhasil di-${action}.`);
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : `Gagal ${action} sequence.`);
    }
  }

  async function updateFlowDefinition(input: {
    flowId: string;
    name?: string;
    triggerType?: "MANUAL" | "CHAT_INCOMING";
    status?: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
    nodes?: FlowNode[];
    edges?: FlowEdge[];
  }) {
    const flow = flows.find((item) => item.id === input.flowId);
    if (!flow) {
      throw new Error("Flow tidak ditemukan.");
    }
    const response = await fetch("/api/whatsapp/flows", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: flow.id,
        name: input.name ?? flow.name,
        triggerType: input.triggerType ?? flow.triggerType ?? "MANUAL",
        status: input.status ?? flow.status,
        nodes: (input.nodes ?? flow.nodes).map((node) => ({
          key: node.key,
          type: node.type,
          configJson: node.configJson
        })),
        edges: (input.edges ?? flow.edges).map((edge) => ({
          fromNodeKey: edge.fromNodeKey,
          toNodeKey: edge.toNodeKey,
          conditionKey: edge.conditionKey ?? undefined
        }))
      })
    });
    await parseJson(response);
  }

  async function handleAddStep() {
    if (!selectedFlow) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    const newKey = `step_${selectedFlow.nodes.length + 1}_${Date.now()}`;
    const defaultConfigByType: Record<FlowNodeType, string> = {
      SEND_TEMPLATE: JSON.stringify({
        templateName: "template_name",
        templateLanguageCode: "id",
        templateComponents: [{ type: "body", parameters: [{ type: "text", text: "Halo" }] }]
      }),
      SEND_TEXT: JSON.stringify({ text: "Pesan follow-up" }),
      DELAY: JSON.stringify({ delaySeconds: 300 }),
      STOP: "{}"
    };
    const newNode: FlowNode = {
      id: newKey,
      key: newKey,
      type: newStepType,
      configJson: defaultConfigByType[newStepType]
    };
    const nextFlow = updateLocalFlow(selectedFlow.id, (flow) => {
      const nextNodes = [...flow.nodes, newNode];
      const nextEdges = selectedNode
        ? [
            ...flow.edges,
            {
              id: `edge_${Date.now()}`,
              fromNodeKey: selectedNode.key,
              toNodeKey: newKey,
              conditionKey: null
            }
          ]
        : flow.edges;
      return {
        ...flow,
        nodes: nextNodes,
        edges: nextEdges
      };
    });
    if (nextFlow) {
      setSelectedNodeKey(newKey);
      notifySuccess("Step baru ditambahkan (tersimpan lokal).");
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  async function handleSaveStep(silent = false) {
    if (!selectedFlow || !selectedNode) {
      notifyError("Pilih step dulu.");
      return;
    }
    let configJson = selectedNode.configJson;
    if (selectedNode.type === "SEND_TEMPLATE") {
      if (!stepDraft.templateName.trim()) {
        notifyError("Template name wajib diisi.");
        return;
      }
      configJson = JSON.stringify({
        templateName: stepDraft.templateName.trim(),
        templateLanguageCode: "id",
        templateComponents: [{ type: "body", parameters: [{ type: "text", text: stepDraft.text.trim() || "Halo" }] }]
      });
    } else if (selectedNode.type === "SEND_TEXT") {
      if (!stepDraft.text.trim()) {
        if (!silent) notifyError("Text message wajib diisi.");
        return;
      }
      configJson = JSON.stringify({
        text: stepDraft.text.trim(),
        timingMode: stepDraft.timingMode,
        delaySeconds: stepDraft.timingMode === "delay" ? Math.max(1, Number(stepDraft.delaySeconds) || 1) : 0,
        delayUnit: stepDraft.delayUnit
      });
    } else if (selectedNode.type === "DELAY") {
      const unitMultiplier = stepDraft.delayUnit === "day" ? 86400 : stepDraft.delayUnit === "hour" ? 3600 : 60;
      const delayRaw = Math.max(1, Number(stepDraft.delaySeconds) || 1);
      const delay = stepDraft.timingMode === "delay" ? delayRaw * unitMultiplier : 0;
      configJson = JSON.stringify({ delaySeconds: delay });
    }

    const nextFlow = updateLocalFlow(selectedFlow.id, (flow) => ({
      ...flow,
      nodes: flow.nodes.map((node) => (node.key === selectedNode.key ? { ...node, configJson } : node))
    }));
    if (nextFlow && !silent) {
      notifySuccess("Step disimpan di browser (lokal).");
    }
  }

  async function handleCreateBroadcast() {
    const name = (newBroadcastName.trim() || broadcastForm.name.trim()).trim();
    if (!name) {
      notifyError("Broadcast name is required.");
      return;
    }

    const toastId = notifyLoading("Membuat broadcast...");
    try {
      const config = getBroadcastConfigPayload();
      await parseJson(
        await fetch("/api/whatsapp/broadcasts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            ...config
          })
        })
      );
      await loadBroadcasts();
      setBroadcastForm((prev) => ({ ...prev, name: "", templateName: "", text: "" }));
      setNewBroadcastName("");
      setNewBroadcastModalOpen(false);
      const latest = await fetch("/api/whatsapp/broadcasts", { cache: "no-store" });
      const latestPayload = await parseJson<{ data?: { items?: BroadcastItem[] } }>(latest);
      const created = (latestPayload.data?.items ?? []).find((item) => item.name === name) ?? null;
      if (created) {
        setSelectedBroadcastId(created.id);
      }
      setBroadcastBuilderMode("editor");
      dismissNotify(toastId);
      notifySuccess("Broadcast draft dibuat.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal membuat broadcast.");
    }
  }

  function persistBroadcastDraft(partial?: Partial<BroadcastDraftMap[string]>) {
    if (!selectedBroadcastId) return;
    setBroadcastDrafts((prev) => ({
      ...prev,
      [selectedBroadcastId]: {
        typeOfMessage: partial?.typeOfMessage ?? broadcastTypeOfMessage,
        selectedCustomerIds: partial?.selectedCustomerIds ?? broadcastSelectedCustomerIds,
        scheduleDate: partial?.scheduleDate ?? broadcastScheduleDate,
        recipientsCount: partial?.recipientsCount ?? broadcastRecipientsCount,
        intervalValue: partial?.intervalValue ?? broadcastIntervalValue,
        intervalUnit: partial?.intervalUnit ?? broadcastIntervalUnit,
        text: partial?.text ?? broadcastForm.text
      }
    }));
  }

  async function handleUpdateBroadcast() {
    if (!selectedBroadcastId) {
      notifyError("Select broadcast first.");
      return;
    }
    const toastId = notifyLoading("Menyimpan broadcast draft...");
    try {
      const config = getBroadcastConfigPayload();
      await parseJson(
        await fetch("/api/whatsapp/broadcasts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            broadcastId: selectedBroadcastId,
            name: (selectedBroadcast?.name || broadcastForm.name || "Broadcast").trim(),
            ...config
          })
        })
      );
      persistBroadcastDraft();
      await loadBroadcasts();
      dismissNotify(toastId);
      notifySuccess("Broadcast draft tersimpan.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal menyimpan broadcast.");
    }
  }

  function handleSelectBroadcastEditor(broadcastId: string) {
    setSelectedBroadcastId(broadcastId);
    setBroadcastBuilderMode("editor");
  }

  async function handleLaunchBroadcast(broadcastId: string) {
    const target = broadcasts.find((item) => item.id === broadcastId) ?? null;
    if (!target) {
      notifyError("Broadcast tidak ditemukan.");
      return;
    }
    const configSummary = [
      `Mode: ${target.recipientMode ?? "SEGMENT"}`,
      `Segment: ${target.segment ?? "all_leads"}`,
      `Schedule: ${target.scheduledAt ? new Date(target.scheduledAt).toLocaleString("id-ID") : "Immediate"}`,
      `Rate: ${target.batchSize ?? 5} recipient / ${Math.max(1, Math.floor((target.batchIntervalSeconds ?? 600) / 60))} menit`,
      `Current recipients: ${target._count?.recipients ?? 0}`
    ].join("\n");
    const ok = window.confirm(`Launch broadcast ini?\n\n${configSummary}`);
    if (!ok) return;
    const toastId = notifyLoading("Launch broadcast...");
    try {
      await parseJson(
        await fetch(`/api/whatsapp/broadcasts/${broadcastId}/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
      );
      await loadBroadcasts();
      dismissNotify(toastId);
      notifySuccess("Broadcast diluncurkan.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal launch broadcast.");
    }
  }

  async function handleCancelBroadcast(broadcastId: string) {
    const ok = window.confirm("Batalkan broadcast ini? Semua recipient pending/queued akan dihentikan.");
    if (!ok) return;
    const toastId = notifyLoading("Cancel broadcast...");
    try {
      await parseJson(
        await fetch(`/api/whatsapp/broadcasts/${broadcastId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
      );
      await loadBroadcasts();
      dismissNotify(toastId);
      notifySuccess("Broadcast dibatalkan.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal cancel broadcast.");
    }
  }

  async function handleDeleteBroadcast(broadcastId: string) {
    const ok = window.confirm("Delete this broadcast?");
    if (!ok) return;
    const toastId = notifyLoading("Deleting broadcast...");
    try {
      await parseJson(
        await fetch("/api/whatsapp/broadcasts", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ broadcastId })
        })
      );
      await loadBroadcasts();
      dismissNotify(toastId);
      notifySuccess("Broadcast deleted.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Failed to delete broadcast.");
    }
  }

  async function handleArchiveSequence(flowId: string) {
    const ok = window.confirm("Delete this sequence?");
    if (!ok) return;
    const toastId = notifyLoading("Deleting sequence...");
    try {
      await updateFlowDefinition({
        flowId,
        status: "ARCHIVED"
      });
      await loadFlows();
      dismissNotify(toastId);
      notifySuccess("Sequence deleted.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Failed to delete sequence.");
    }
  }

  async function handleSaveRuleDraft() {
    const flowId = selectedFlowId.trim();
    if (!flowId) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    const normalizedName = (ruleEditorName.trim() || newRuleName.trim()).trim();
    if (!normalizedName) {
      notifyError("Nama rule wajib diisi.");
      return;
    }
    if (ruleTriggers.length === 0) {
      notifyError("Minimal harus ada 1 trigger.");
      return;
    }
    if (ruleActions.length === 0) {
      notifyError("Minimal harus ada 1 action.");
      return;
    }

    for (const trigger of ruleTriggers) {
      if ((trigger.eventType === "TAG_APPLIED" || trigger.eventType === "TAG_REMOVED") && !trigger.tagId) {
        notifyError("Trigger tag harus memilih tag.");
        return;
      }
      if (
        (trigger.eventType === "SUBSCRIBED_SEQUENCE" || trigger.eventType === "UNSUBSCRIBED_SEQUENCE" || trigger.eventType === "COMPLETED_SEQUENCE") &&
        !trigger.sequenceId
      ) {
        notifyError("Trigger sequence harus memilih sequence.");
        return;
      }
      if ((trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "SEQUENCE" && !trigger.sequenceId) {
        notifyError("Pilih sequence untuk trigger baca pesan.");
        return;
      }
      if ((trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "BROADCAST" && !trigger.broadcastId) {
        notifyError("Pilih broadcast untuk trigger baca pesan.");
        return;
      }
      if (trigger.eventType === "INVOICE_SENDING" && !trigger.invoiceId) {
        notifyError("Trigger invoice harus memilih invoice.");
        return;
      }
      if (trigger.eventType === "STATUS_LEAD_UPDATE" && !trigger.leadStatus) {
        notifyError("Trigger status lead harus memilih status.");
        return;
      }
      if (trigger.eventType === "FOLLOWUP_UPDATE" && !trigger.followUpStatus) {
        notifyError("Trigger follow-up harus memilih status.");
        return;
      }
      if (trigger.eventType === "BUSINESS_CATEGORY_UPDATE" && !trigger.businessCategory) {
        notifyError("Trigger business category harus memilih kategori.");
        return;
      }
      if (trigger.eventType === "ASSIGN_UPDATE" && !trigger.assigneeId) {
        notifyError("Trigger assign harus memilih CS.");
        return;
      }
      if (trigger.eventType === "PIPELINE_STAGE_UPDATE" && !trigger.pipelineStage) {
        notifyError("Trigger pipeline stage harus memilih stage.");
        return;
      }
    }

    for (const action of ruleActions) {
      if ((action.actionType === "APPLY_TAG" || action.actionType === "REMOVE_TAG") && !action.tagId) {
        notifyError("Action tag harus memilih tag.");
        return;
      }
      if ((action.actionType === "SUBSCRIBE_SEQUENCE" || action.actionType === "UNSUBSCRIBE_SEQUENCE") && !action.sequenceId) {
        notifyError("Action sequence harus memilih sequence.");
        return;
      }
      if (action.actionType === "MOVE_SEQUENCE" && (!action.fromSequenceId || !action.toSequenceId)) {
        notifyError("Action move sequence harus memilih from dan to sequence.");
        return;
      }
      if (action.actionType === "SEND_INVOICE" && !action.invoiceId) {
        notifyError("Action send invoice harus memilih invoice.");
        return;
      }
      if (action.actionType === "UPDATE_STATUS_LEAD" && !action.leadStatus) {
        notifyError("Action update status lead harus memilih status.");
        return;
      }
      if (action.actionType === "UPDATE_FOLLOWUP" && !action.followUpStatus) {
        notifyError("Action update follow-up harus memilih status.");
        return;
      }
      if (action.actionType === "UPDATE_BUSINESS_CATEGORY" && !action.businessCategory) {
        notifyError("Action update business category harus memilih kategori.");
        return;
      }
      if (action.actionType === "UPDATE_ASSIGN" && !action.assigneeId) {
        notifyError("Action update assign harus memilih CS.");
        return;
      }
      if (action.actionType === "UPDATE_PIPELINE_STAGE" && !action.pipelineStage) {
        notifyError("Action update pipeline stage harus memilih stage.");
        return;
      }
    }

    const conditionExpr = JSON.stringify({
      name: normalizedName,
      operator: "OR",
      triggers: ruleTriggers
    });
    const actionExpr = JSON.stringify({
      operator: "AND",
      actions: ruleActions
    });

    const toastId = notifyLoading("Menyimpan rule...");
    try {
      const response = await fetch(`/api/whatsapp/flows/${flowId}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          triggerType: "RULES_V2",
          conditionExpr,
          actionType: actionExpr,
          isActive: ruleEditorEnabled
        })
      });
      const payload = await parseJson<{ data?: { item?: RuleItem } }>(response);
      if (payload.data?.item) {
        setRules((prev) => [payload.data!.item!, ...prev]);
      }
      setNewRuleName("");
      setRuleEditorName("");
      setRuleTriggers([]);
      setRuleActions([]);
      setNewRuleModalOpen(false);
      setRulesBuilderMode("list");
      dismissNotify(toastId);
      notifySuccess("Rule disimpan.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal simpan rule.");
    }
  }

  function applyTextFormatting(format: "bold" | "italic" | "bullet" | "number" | "link") {
    if (format === "bold") {
      setStepDraft((prev) => ({ ...prev, text: `${prev.text}*teks tebal*` }));
      return;
    }
    if (format === "italic") {
      setStepDraft((prev) => ({ ...prev, text: `${prev.text}_teks miring_` }));
      return;
    }
    if (format === "bullet") {
      setStepDraft((prev) => ({ ...prev, text: `${prev.text}${prev.text ? "\n" : ""}- item` }));
      return;
    }
    if (format === "number") {
      setStepDraft((prev) => ({ ...prev, text: `${prev.text}${prev.text ? "\n" : ""}1. item` }));
      return;
    }
    if (format === "link") {
      setStepDraft((prev) => ({ ...prev, text: `${prev.text} https://` }));
    }
  }

  function commitFlowNameInlineEdit() {
    if (!selectedFlow) return;
    const nextName = pendingFlowName.trim();
    if (!nextName) {
      setPendingFlowName(selectedFlow.name);
      setIsEditingFlowName(false);
      return;
    }
    updateLocalFlow(selectedFlow.id, (flow) => ({ ...flow, name: nextName }));
    setIsEditingFlowName(false);
  }

  function handleAttachSequenceFile(file: File) {
    if (!selectedNode) {
      notifyError("Pilih step dulu.");
      return;
    }
    if (!isAllowedAttachmentType(file.type)) {
      notifyError("Tipe lampiran belum didukung.");
      return;
    }
    setAttachedFilesByNode((prev) => {
      const current = prev[selectedNode.key] ?? [];
      const nextAttachments = [...current, { fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size }];
      updateLocalFlow(selectedFlowId, (flow) => ({
        ...flow,
        nodes: flow.nodes.map((node) => {
          if (node.key !== selectedNode.key) return node;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(node.configJson) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          return {
            ...node,
            configJson: JSON.stringify({
              ...parsed,
              attachments: nextAttachments
            })
          };
        })
      }));
      return {
        ...prev,
        [selectedNode.key]: nextAttachments
      };
    });
    notifySuccess("Lampiran ditambahkan ke step (draft lokal).");
  }

  function handleCreateRuleEditor() {
    const flowId = selectedFlowId.trim();
    if (!flowId) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    const normalizedName = newRuleName.trim();
    if (!normalizedName) {
      notifyError("Nama rule wajib diisi.");
      return;
    }
    setRuleEditorName(normalizedName);
    setRuleEditorEnabled(true);
    setRuleTriggers([createDefaultRuleTrigger()]);
    setRuleActions([createDefaultRuleAction()]);
    setRulesBuilderMode("editor");
    setNewRuleModalOpen(false);
  }

  function handleRemoveSequenceAttachment(index: number) {
    if (!selectedNode) {
      return;
    }
    const current = attachedFilesByNode[selectedNode.key] ?? [];
    const nextAttachments = current.filter((_, idx) => idx !== index);
    setAttachedFilesByNode((prev) => ({
      ...prev,
      [selectedNode.key]: nextAttachments
    }));

    updateLocalFlow(selectedFlowId, (flow) => ({
      ...flow,
      nodes: flow.nodes.map((node) => {
        if (node.key !== selectedNode.key) return node;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(node.configJson) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        return {
          ...node,
          configJson: JSON.stringify({
            ...parsed,
            attachments: nextAttachments
          })
        };
      })
    }));
  }

  function handleToggleStepEnabled(nodeKey: string, enabled: boolean) {
    updateLocalFlow(selectedFlowId, (flow) => ({
      ...flow,
      nodes: flow.nodes.map((node) => {
        if (node.key !== nodeKey) return node;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(node.configJson) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        return {
          ...node,
          configJson: JSON.stringify({
            ...parsed,
            enabled
          })
        };
      })
    }));
  }

  function handleDeleteStepByKey(nodeKey: string) {
    if (!selectedFlow) return;
    if (selectedFlow.nodes.length <= 1) {
      notifyError("Sequence minimal harus punya 1 step.");
      return;
    }
    const nextNodes = selectedFlow.nodes.filter((node) => node.key !== nodeKey);
    const nextEdges = selectedFlow.edges.filter((edge) => edge.fromNodeKey !== nodeKey && edge.toNodeKey !== nodeKey);
    const fallbackSelected = nextNodes[0]?.key ?? "";
    updateLocalFlow(selectedFlow.id, (flow) => ({
      ...flow,
      nodes: nextNodes,
      edges: nextEdges
    }));
    setSelectedNodeKey(fallbackSelected);
    notifySuccess("Step dihapus (lokal).");
  }

  async function handleDropStep(targetNodeKey: string) {
    if (!selectedFlow || !draggingNodeKey || draggingNodeKey === targetNodeKey) {
      setDraggingNodeKey("");
      return;
    }
    const fromIndex = selectedFlow.nodes.findIndex((node) => node.key === draggingNodeKey);
    const toIndex = selectedFlow.nodes.findIndex((node) => node.key === targetNodeKey);
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingNodeKey("");
      return;
    }

    const nextFlow = updateLocalFlow(selectedFlow.id, (flow) => {
      const nextNodes = [...flow.nodes];
      const [moved] = nextNodes.splice(fromIndex, 1);
      nextNodes.splice(toIndex, 0, moved);
      return { ...flow, nodes: nextNodes };
    });
    if (nextFlow) {
      setSelectedNodeKey(draggingNodeKey);
      notifySuccess("Urutan step diperbarui (lokal).");
    }
    setDraggingNodeKey("");
  }

  async function handleUpdateSequence() {
    if (!selectedFlow) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    const toastId = notifyLoading("Update sequence...");
    try {
      await updateFlowDefinition({
        flowId: selectedFlow.id,
        name: selectedFlow.name,
        status: selectedFlow.status,
        triggerType: selectedFlow.triggerType ?? "MANUAL",
        nodes: selectedFlow.nodes,
        edges: selectedFlow.edges
      });
      setLocalDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedFlow.id];
        return next;
      });
      dismissNotify(toastId);
      notifySuccess("Sequence berhasil di-update.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal update sequence.");
    }
  }

  async function handleGoLiveSequence() {
    if (!selectedFlow) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    const toastId = notifyLoading("Go Live sequence...");
    try {
      await updateFlowDefinition({
        flowId: selectedFlow.id,
        name: selectedFlow.name,
        status: "ACTIVE",
        triggerType: selectedFlow.triggerType ?? "MANUAL",
        nodes: selectedFlow.nodes,
        edges: selectedFlow.edges
      });
      updateLocalFlow(selectedFlow.id, (flow) => ({ ...flow, status: "ACTIVE" }));
      setLocalDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedFlow.id];
        return next;
      });
      dismissNotify(toastId);
      notifySuccess("Sequence sekarang ACTIVE.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal Go Live sequence.");
    }
  }

  async function handleToggleRule(ruleId: string) {
    const flowId = selectedFlowId.trim();
    if (!flowId) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    const current = rules.find((item) => item.id === ruleId);
    if (!current) return;

    const nextActive = !current.isActive;
    try {
      const response = await fetch(`/api/whatsapp/flows/${flowId}/rules`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId, isActive: nextActive })
      });
      const payload = await parseJson<{ data?: { item?: RuleItem } }>(response);
      if (payload.data?.item) {
        setRules((prev) => prev.map((item) => (item.id === ruleId ? payload.data!.item! : item)));
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal ubah status rule.");
    }
  }

  async function handleDeleteRule(ruleId: string) {
    const flowId = selectedFlowId.trim();
    if (!flowId) {
      notifyError("Pilih sequence dulu.");
      return;
    }
    try {
      await parseJson(
        await fetch(`/api/whatsapp/flows/${flowId}/rules`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ruleId })
        })
      );
      setRules((prev) => prev.filter((item) => item.id !== ruleId));
      notifySuccess("Rule dihapus.");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal hapus rule.");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as TabId)}
        className="grid min-h-0 flex-1 gap-4 overflow-hidden xl:gap-0 xl:grid-cols-[280px_minmax(0,1fr)]"
      >
        <aside className="flex min-h-0 flex-col rounded-3xl border border-border/60 bg-card p-4 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] xl:rounded-r-none xl:border-r-0">
          <div className="mb-3 shrink-0 px-2 pt-1">
            <p className="text-sm font-semibold text-foreground">Sequences & Broadcast</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Build sequences, manage rules, and launch broadcasts.</p>
          </div>
          <TabsList className="inbox-scroll flex h-auto w-full flex-col gap-2 overflow-y-auto bg-transparent p-0">
          {MAIN_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className="group flex w-full items-center justify-start gap-3 rounded-2xl border border-transparent px-4 py-3 text-left transition-colors data-[state=active]:border-primary/20 data-[state=active]:bg-gradient-to-br data-[state=active]:from-primary/10 data-[state=active]:to-transparent data-[state=active]:text-primary"
              >
                <div className="rounded-xl bg-muted p-2 text-muted-foreground group-data-[state=active]:bg-primary/20 group-data-[state=active]:text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <span className="text-sm font-semibold">{tab.label}</span>
              </TabsTrigger>
            );
          })}
          </TabsList>
        </aside>
        <div className="inbox-scroll flex min-h-0 flex-col overflow-y-auto rounded-3xl border border-border/60 bg-gradient-to-br from-card to-background/50 px-3 py-2 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] md:px-6 md:py-5 xl:rounded-l-none">

        <TabsContent value="sequences" className="h-full overflow-auto">
              <div className="space-y-4">
                {builderMode === "list" ? (
                  <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                  <div className="flex flex-wrap items-center justify-end gap-3 lg:col-span-2">
                    <Button
                      className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500"
                      onClick={() => setNewSequenceModalOpen(true)}
                      disabled={isLoading}
                    >
                      + New Sequence
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <Card>
                      <CardHeader className="border-b pb-3">
                        <CardTitle className="text-center text-sm tracking-wide">STATUS</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 pt-4 text-sm">
                        <label className="flex items-center gap-2">
                          <input type="radio" name="seq-status" defaultChecked />
                          <Check className="h-4 w-4 text-muted-foreground" />
                          <span>Live</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="seq-status" />
                          <span className="h-4 w-4 rounded-full border bg-muted" />
                          <span>Paused</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="seq-status" />
                          <Pencil className="h-4 w-4 text-muted-foreground" />
                          <span>Draft</span>
                        </label>
                      </CardContent>
                    </Card>

                  </div>

                  <div>
                    <p className="mb-4 text-muted-foreground">
                      {flows.length} Sequences Found; Stats updated every 10 minutes
                    </p>
                    {isLoadingFlows ? <p className="mb-4 text-sm text-muted-foreground">Loading sequences...</p> : null}
                    {flows.length === 0 ? (
                      <div className="mt-16 flex flex-col items-center justify-center text-center text-muted-foreground">
                        <X className="mb-3 h-9 w-9 opacity-50" />
                        <p className="italic">No Sequences match filters</p>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-2">
                        {flows.map((flow) => (
                          <div
                            key={flow.id}
                            className="w-full rounded-lg border bg-background p-3"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <button
                                type="button"
                                className="min-w-0 flex-1 text-left hover:opacity-80"
                                onClick={() => {
                                  setSelectedFlowId(flow.id);
                                  setSelectedNodeKey(flow.nodes[0]?.key ?? "");
                                  setBuilderMode("editor");
                                }}
                              >
                                <p className="text-sm font-semibold">{flow.name}</p>
                                <p className="text-xs text-muted-foreground">{flow.nodes.length} step • {flow.status}</p>
                              </button>
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={flow.status === "ACTIVE"}
                                  onCheckedChange={(checked) => void handleFlowAction(flow.id, checked ? "resume" : "pause")}
                                  aria-label={`Toggle ${flow.name}`}
                                />
                                <button
                                  type="button"
                                  className="rounded border p-1 text-muted-foreground hover:bg-muted"
                                  aria-label={`Delete ${flow.name}`}
                                  onClick={() => void handleArchiveSequence(flow.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                ) : (
                  <div className="mt-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <Button variant="outline" size="sm" onClick={() => setBuilderMode("list")}>
                        Back to list
                      </Button>
                      <div className="flex items-center gap-2">
                        <Button className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500" onClick={handleUpdateSequence}>
                          Update
                        </Button>
                        <Button className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500" onClick={handleGoLiveSequence}>
                          Go Live
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_520px]">
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                              {isEditingFlowName ? (
                                <Input
                                  value={pendingFlowName}
                                  onChange={(event) => setPendingFlowName(event.target.value)}
                                  onBlur={commitFlowNameInlineEdit}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      commitFlowNameInlineEdit();
                                    }
                                    if (event.key === "Escape") {
                                      setPendingFlowName(selectedFlow?.name ?? "");
                                      setIsEditingFlowName(false);
                                    }
                                  }}
                                  autoFocus
                                  className="h-8"
                                />
                              ) : (
                                <>
                                  <CardTitle className="truncate">{selectedFlow?.name ?? "Sequence"}</CardTitle>
                                  <button
                                    type="button"
                                    aria-label="Edit sequence name"
                                    className="rounded border p-1 text-muted-foreground hover:bg-muted"
                                    onClick={() => setIsEditingFlowName(true)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                            {selectedFlow ? <Badge variant={statusVariant(selectedFlow.status)}>{selectedFlow.status}</Badge> : null}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex flex-wrap items-center gap-2 text-lg text-muted-foreground">
                            <span className="text-base">This message will be sent</span>
                            <Select
                              value={stepDraft.timingMode}
                              onValueChange={(value) =>
                                setStepDraft((prev) => ({ ...prev, timingMode: value as "immediately" | "delay" }))
                              }
                            >
                              <SelectTrigger className="w-[170px] bg-background">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="immediately">immediately</SelectItem>
                                <SelectItem value="delay">delay</SelectItem>
                              </SelectContent>
                            </Select>
                            {stepDraft.timingMode === "delay" ? (
                              <>
                                <Input
                                  value={stepDraft.delaySeconds}
                                  onChange={(event) => setStepDraft((prev) => ({ ...prev, delaySeconds: event.target.value }))}
                                  className="w-[96px] bg-background"
                                />
                                <Select
                                  value={stepDraft.delayUnit}
                                  onValueChange={(value) =>
                                    setStepDraft((prev) => ({ ...prev, delayUnit: value as "day" | "hour" | "minute" }))
                                  }
                                >
                                  <SelectTrigger className="w-[140px] bg-background">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="day">day(s)</SelectItem>
                                    <SelectItem value="hour">hour(s)</SelectItem>
                                    <SelectItem value="minute">minute(s)</SelectItem>
                                  </SelectContent>
                                </Select>
                              </>
                            ) : null}
                            <span className="text-base">after subscribed</span>
                          </div>

                          <div className="rounded-md border bg-background">
                            <div className="flex items-center justify-between border-b p-2">
                              <div className="text-xs text-muted-foreground">Attachment</div>
                              <button
                                type="button"
                                aria-label="Attach file"
                                className="rounded-md border p-2 text-muted-foreground hover:bg-muted"
                                onClick={() => attachmentInputRef.current?.click()}
                              >
                                <Paperclip className="h-4 w-4" />
                              </button>
                              <input
                                ref={attachmentInputRef}
                                type="file"
                                className="hidden"
                                accept="image/*,video/*,audio/*,application/pdf"
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (!file) return;
                                  handleAttachSequenceFile(file);
                                  event.currentTarget.value = "";
                                }}
                              />
                            </div>
                            {(selectedNode ? attachedFilesByNode[selectedNode.key] ?? [] : []).length > 0 ? (
                              <div className="flex flex-wrap gap-2 border-b p-2">
                                {(selectedNode ? attachedFilesByNode[selectedNode.key] ?? [] : []).map((file, idx) => (
                                  <span key={`${file.fileName}-${idx}`} className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs">
                                    {file.fileName}
                                    <button
                                      type="button"
                                      aria-label={`Hapus lampiran ${file.fileName}`}
                                      className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                                      onClick={() => handleRemoveSequenceAttachment(idx)}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <div className="flex flex-wrap gap-2 border-b p-2">
                              <Button type="button" size="sm" variant="ghost" onClick={() => applyTextFormatting("bold")}>B</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => applyTextFormatting("italic")}>I</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => applyTextFormatting("bullet")}>• List</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => applyTextFormatting("number")}>1. List</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => applyTextFormatting("link")}>Link</Button>
                            </div>
                            <Textarea
                              rows={12}
                              placeholder="Tulis pesan WhatsApp sequence..."
                              value={stepDraft.text}
                              onChange={(event) => setStepDraft((prev) => ({ ...prev, text: event.target.value }))}
                              className="min-h-[280px] border-0 focus-visible:ring-0"
                            />
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle>Step Rail (Drag & Drop)</CardTitle>
                          <CardDescription>Drag between steps to reorder delivery.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          <div className="relative pl-8">
                            <div className="absolute left-[14px] top-1 bottom-12 w-px bg-yellow-400" />
                          {(selectedFlow?.nodes ?? []).map((node, index) => (
                            <div
                              key={node.key}
                              draggable
                              onDragStart={() => setDraggingNodeKey(node.key)}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={() => void handleDropStep(node.key)}
                              className={`relative mb-2 rounded-lg border p-3 ${selectedNodeKey === node.key ? "border-yellow-400 bg-yellow-50" : "bg-background hover:bg-muted/30"}`}
                            >
                              <span className="absolute -left-8 top-4 inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-yellow-400 bg-background text-xs font-semibold text-yellow-600">
                                {index + 1}
                              </span>
                              <div className="flex items-start justify-between gap-2">
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedNodeKey(node.key)}>
                                  <p className="text-xs text-muted-foreground">Step {index + 1}</p>
                                  <p className="font-medium">{readableNodeType(node.type)}</p>
                                  {node.type === "SEND_TEXT" ? (
                                    <p className="text-sm italic text-muted-foreground">{readableNodeTiming(node)}</p>
                                  ) : null}
                                </button>
                                <div className="flex items-center gap-2">
                                  <Switch
                                    checked={readNodeEnabled(node)}
                                    onCheckedChange={(checked) => handleToggleStepEnabled(node.key, checked)}
                                    aria-label={`Toggle step ${index + 1}`}
                                  />
                                  <button
                                    type="button"
                                    className="rounded border p-1 text-muted-foreground hover:bg-muted"
                                    onClick={() => handleDeleteStepByKey(node.key)}
                                    aria-label={`Delete step ${index + 1}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                          </div>
                          {selectedFlow && selectedFlow.nodes.length === 0 ? (
                            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No steps yet.</div>
                          ) : null}
                          <div className="pt-2 text-center">
                            <Button
                              variant="secondary"
                              className="rounded-full bg-muted px-5"
                              onClick={async () => {
                                setNewStepType("SEND_TEXT");
                                await handleAddStep();
                              }}
                            >
                              + New Step
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}
              </div>
        </TabsContent>

        <TabsContent value="rules" className="h-full overflow-auto">
              <div className="space-y-4">
                {rulesBuilderMode === "list" ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Button
                        className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500"
                        onClick={() => setNewRuleModalOpen(true)}
                        disabled={!selectedFlowId}
                      >
                        + New Rule
                      </Button>
                    </div>

                    <div className="mt-6">
                      <p className="mb-4 text-muted-foreground">{rules.length} Rules Found</p>
                      {isLoadingRules ? <p className="mb-4 text-sm text-muted-foreground">Loading rules...</p> : null}
                      {rules.length === 0 ? (
                        <div className="mt-16 flex flex-col items-center justify-center text-center text-muted-foreground">
                          <X className="mb-3 h-9 w-9 opacity-50" />
                          <p className="italic">No rules found</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {rules.map((rule) => (
                            <div key={rule.id} className="rounded-lg border bg-background p-3">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold">{rule.conditionExpr}</p>
                                  <p className="text-xs text-muted-foreground">{rule.triggerType}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Switch checked={rule.isActive} onCheckedChange={() => void handleToggleRule(rule.id)} aria-label={`Toggle rule ${rule.id}`} />
                                  <button type="button" className="rounded border p-1 text-muted-foreground hover:bg-muted" onClick={() => void handleDeleteRule(rule.id)}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Button variant="outline" size="sm" onClick={() => setRulesBuilderMode("list")}>
                        Back to list
                      </Button>
                      <div className="flex items-center gap-2">
                        <Badge variant={rulesRuntimeValidation.valid ? "secondary" : "destructive"}>
                          {rulesRuntimeValidation.valid ? "Runtime Valid" : "Runtime Invalid"}
                        </Badge>
                        <Button onClick={handleSaveRuleDraft}>Save Rule</Button>
                      </div>
                    </div>

                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Switch checked={ruleEditorEnabled} onCheckedChange={setRuleEditorEnabled} />
                            <Input value={ruleEditorName} onChange={(event) => setRuleEditorName(event.target.value)} className="h-9 w-[320px]" />
                          </div>
                        </div>
                        <CardDescription>
                          When This Happens... {rulesRuntimeValidation.valid ? "" : `• ${rulesRuntimeValidation.message}`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)]">
                        <div className="rounded-lg border bg-background">
                          <div className="border-b p-4">
                            <h3 className="text-2xl font-medium">Triggers</h3>
                          </div>
                          <div className="space-y-4 p-4">
                            {ruleTriggers.map((trigger, index) => (
                              <div key={trigger.id} className="space-y-2">
                                {index > 0 ? <div className="text-center text-xs font-semibold text-muted-foreground">OR</div> : null}
                                <div className="grid gap-2">
                                  <div className="flex items-center gap-2">
                                    <Select
                                      value={trigger.source}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, source: value as TriggerSource } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="20BYTE">20Byte</SelectItem>
                                        <SelectItem value="DAEKANAPP">DaekanApp (Coming Soon)</SelectItem>
                                        <SelectItem value="META_CAPI">Meta CAPI (Coming Soon)</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <button
                                      type="button"
                                      className="rounded border p-2 text-destructive"
                                      onClick={() => setRuleTriggers((prev) => prev.filter((item) => item.id !== trigger.id))}
                                    >
                                      <X className="h-4 w-4" />
                                    </button>
                                  </div>

                                  <Select
                                    value={trigger.eventType}
                                    onValueChange={(value) =>
                                      setRuleTriggers((prev) =>
                                        prev.map((item) =>
                                          item.id === trigger.id
                                            ? {
                                                ...item,
                                                eventType: value as TriggerEventType,
                                                messageScope: "ANY",
                                                sequenceId: "",
                                                broadcastId: "",
                                                tagId: "",
                                                invoiceId: "",
                                                leadStatus: "",
                                                followUpStatus: "",
                                                businessCategory: "",
                                                assigneeId: "",
                                                pipelineStage: ""
                                              }
                                            : item
                                        )
                                      )
                                    }
                                  >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="TAG_APPLIED">Tag Applied</SelectItem>
                                      <SelectItem value="TAG_REMOVED">Tag Removed</SelectItem>
                                      <SelectItem value="READ_MESSAGE">Read Message</SelectItem>
                                      <SelectItem value="DIDNT_READ_MESSAGE">Didn&apos;t Read Message</SelectItem>
                                      <SelectItem value="SUBSCRIBED_SEQUENCE">Subscribed to a Sequence</SelectItem>
                                      <SelectItem value="UNSUBSCRIBED_SEQUENCE">Unsubscribed from Sequence</SelectItem>
                                      <SelectItem value="COMPLETED_SEQUENCE">Complete a Sequence</SelectItem>
                                      <SelectItem value="INVOICE_SENDING">Invoice Sending</SelectItem>
                                      <SelectItem value="STATUS_LEAD_UPDATE">Status Lead Update</SelectItem>
                                      <SelectItem value="FOLLOWUP_UPDATE">Follow-Up Update</SelectItem>
                                      <SelectItem value="BUSINESS_CATEGORY_UPDATE">Business Category Update</SelectItem>
                                      <SelectItem value="ASSIGN_UPDATE">Assign Update</SelectItem>
                                      <SelectItem value="PIPELINE_STAGE_UPDATE">Pipeline Stage Update</SelectItem>
                                    </SelectContent>
                                  </Select>

                                  {(trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") ? (
                                    <Select
                                      value={trigger.messageScope}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) =>
                                          prev.map((item) =>
                                            item.id === trigger.id ? { ...item, messageScope: value as MessageScopeType, sequenceId: "", broadcastId: "" } : item
                                          )
                                        )
                                      }
                                    >
                                      <SelectTrigger><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="ANY">Any</SelectItem>
                                        <SelectItem value="SEQUENCE">Sequence</SelectItem>
                                        <SelectItem value="BROADCAST">Broadcast</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {(trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE" || trigger.eventType === "SUBSCRIBED_SEQUENCE" || trigger.eventType === "UNSUBSCRIBED_SEQUENCE" || trigger.eventType === "COMPLETED_SEQUENCE") &&
                                  (trigger.messageScope === "SEQUENCE" || trigger.eventType === "SUBSCRIBED_SEQUENCE" || trigger.eventType === "UNSUBSCRIBED_SEQUENCE" || trigger.eventType === "COMPLETED_SEQUENCE") ? (
                                    <Select
                                      value={trigger.sequenceId}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, sequenceId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select sequence" /></SelectTrigger>
                                      <SelectContent>
                                        {flows.map((flow) => (
                                          <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {(trigger.eventType === "READ_MESSAGE" || trigger.eventType === "DIDNT_READ_MESSAGE") && trigger.messageScope === "BROADCAST" ? (
                                    <Select
                                      value={trigger.broadcastId}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, broadcastId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select broadcast" /></SelectTrigger>
                                      <SelectContent>
                                        {broadcasts.map((item) => (
                                          <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {(trigger.eventType === "TAG_APPLIED" || trigger.eventType === "TAG_REMOVED") ? (
                                    <Select
                                      value={trigger.tagId}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, tagId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Search or add a new tag" /></SelectTrigger>
                                      <SelectContent>
                                        {tagOptions.map((tag) => (
                                          <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {trigger.eventType === "INVOICE_SENDING" ? (
                                    <Select
                                      value={trigger.invoiceId}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, invoiceId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select invoice" /></SelectTrigger>
                                      <SelectContent>
                                        {invoiceOptions.map((invoice) => (
                                          <SelectItem key={invoice.id} value={invoice.id}>{invoice.label}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {trigger.eventType === "STATUS_LEAD_UPDATE" ? (
                                    <Select
                                      value={trigger.leadStatus}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, leadStatus: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select lead status" /></SelectTrigger>
                                      <SelectContent>
                                        {leadStatusOptions.map((item) => (
                                          <SelectItem key={item} value={item}>{item}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {trigger.eventType === "FOLLOWUP_UPDATE" ? (
                                    <Select
                                      value={trigger.followUpStatus}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, followUpStatus: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select follow-up" /></SelectTrigger>
                                      <SelectContent>
                                        {followUpOptions.map((item) => (
                                          <SelectItem key={item} value={item}>{item}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {trigger.eventType === "BUSINESS_CATEGORY_UPDATE" ? (
                                    <Select
                                      value={trigger.businessCategory}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, businessCategory: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select business category" /></SelectTrigger>
                                      <SelectContent>
                                        {businessCategoryOptions.map((item) => (
                                          <SelectItem key={item} value={item}>{item}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {trigger.eventType === "ASSIGN_UPDATE" ? (
                                    <Select
                                      value={trigger.assigneeId}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, assigneeId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select assign CS" /></SelectTrigger>
                                      <SelectContent>
                                        {assigneeOptions.map((item) => (
                                          <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}

                                  {trigger.eventType === "PIPELINE_STAGE_UPDATE" ? (
                                    <Select
                                      value={trigger.pipelineStage}
                                      onValueChange={(value) =>
                                        setRuleTriggers((prev) => prev.map((item) => (item.id === trigger.id ? { ...item, pipelineStage: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="Select pipeline stage" /></SelectTrigger>
                                      <SelectContent>
                                        {pipelineStageOptions.map((item) => (
                                          <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : null}
                                </div>
                              </div>
                            ))}

                            <Button
                              variant="secondary"
                              className="rounded-full"
                              onClick={() => setRuleTriggers((prev) => [...prev, createDefaultRuleTrigger()])}
                            >
                              + New Trigger
                            </Button>
                          </div>
                        </div>
                        <div className="flex items-start justify-center pt-16 text-3xl text-muted-foreground">→</div>
                        <div className="rounded-lg border bg-background">
                          <div className="border-b p-4">
                            <h3 className="text-2xl font-medium">Actions</h3>
                          </div>
                          <div className="space-y-4 p-4">
                            {ruleActions.map((action, index) => (
                              <div key={action.id} className="space-y-2">
                                {index > 0 ? <div className="text-center text-xs font-semibold text-muted-foreground">AND</div> : null}
                                <div className="flex items-center gap-2">
                                  <Select
                                    value={action.actionType}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) =>
                                        prev.map((item) =>
                                          item.id === action.id
                                            ? {
                                                ...item,
                                                actionType: value as RuleActionType,
                                                tagId: "",
                                                sequenceId: "",
                                                fromSequenceId: "",
                                                toSequenceId: "",
                                                invoiceId: "",
                                                leadStatus: "",
                                                followUpStatus: "",
                                                businessCategory: "",
                                                assigneeId: "",
                                                pipelineStage: ""
                                              }
                                            : item
                                        )
                                      )
                                    }
                                  >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="APPLY_TAG">Apply Tag</SelectItem>
                                      <SelectItem value="REMOVE_TAG">Remove Tag</SelectItem>
                                      <SelectItem value="SUBSCRIBE_SEQUENCE">Subscribe to sequence</SelectItem>
                                      <SelectItem value="UNSUBSCRIBE_SEQUENCE">Unsubscribe from sequence</SelectItem>
                                      <SelectItem value="MOVE_SEQUENCE">Move from 1 to another sequence</SelectItem>
                                      <SelectItem value="SEND_INVOICE">Send Invoice</SelectItem>
                                      <SelectItem value="DELETE_CUSTOMER">Delete Customers</SelectItem>
                                      <SelectItem value="UPDATE_STATUS_LEAD">Update Status Lead</SelectItem>
                                      <SelectItem value="UPDATE_FOLLOWUP">Update Follow-Up</SelectItem>
                                      <SelectItem value="UPDATE_BUSINESS_CATEGORY">Update Business Category</SelectItem>
                                      <SelectItem value="UPDATE_ASSIGN">Update Assign</SelectItem>
                                      <SelectItem value="UPDATE_PIPELINE_STAGE">Update Pipeline Stage</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <button
                                    type="button"
                                    className="rounded border p-2 text-destructive"
                                    onClick={() => setRuleActions((prev) => prev.filter((item) => item.id !== action.id))}
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                </div>

                                {(action.actionType === "APPLY_TAG" || action.actionType === "REMOVE_TAG") ? (
                                  <Select
                                    value={action.tagId}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, tagId: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Search or add a new tag" /></SelectTrigger>
                                    <SelectContent>
                                      {tagOptions.map((tag) => (
                                        <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {(action.actionType === "SUBSCRIBE_SEQUENCE" || action.actionType === "UNSUBSCRIBE_SEQUENCE") ? (
                                  <Select
                                    value={action.sequenceId}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, sequenceId: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select sequence" /></SelectTrigger>
                                    <SelectContent>
                                      {flows.map((flow) => (
                                        <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {action.actionType === "MOVE_SEQUENCE" ? (
                                  <div className="grid gap-2 sm:grid-cols-2">
                                    <Select
                                      value={action.fromSequenceId}
                                      onValueChange={(value) =>
                                        setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, fromSequenceId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="From sequence" /></SelectTrigger>
                                      <SelectContent>
                                        {flows.map((flow) => (
                                          <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Select
                                      value={action.toSequenceId}
                                      onValueChange={(value) =>
                                        setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, toSequenceId: value } : item)))
                                      }
                                    >
                                      <SelectTrigger><SelectValue placeholder="To sequence" /></SelectTrigger>
                                      <SelectContent>
                                        {flows.map((flow) => (
                                          <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                ) : null}

                                {action.actionType === "SEND_INVOICE" ? (
                                  <Select
                                    value={action.invoiceId}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, invoiceId: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select invoice" /></SelectTrigger>
                                    <SelectContent>
                                      {invoiceOptions.map((invoice) => (
                                        <SelectItem key={invoice.id} value={invoice.id}>{invoice.label}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {action.actionType === "UPDATE_STATUS_LEAD" ? (
                                  <Select
                                    value={action.leadStatus}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, leadStatus: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select lead status" /></SelectTrigger>
                                    <SelectContent>
                                      {leadStatusOptions.map((item) => (
                                        <SelectItem key={item} value={item}>{item}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {action.actionType === "UPDATE_FOLLOWUP" ? (
                                  <Select
                                    value={action.followUpStatus}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, followUpStatus: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select follow-up" /></SelectTrigger>
                                    <SelectContent>
                                      {followUpOptions.map((item) => (
                                        <SelectItem key={item} value={item}>{item}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {action.actionType === "UPDATE_BUSINESS_CATEGORY" ? (
                                  <Select
                                    value={action.businessCategory}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, businessCategory: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select business category" /></SelectTrigger>
                                    <SelectContent>
                                      {businessCategoryOptions.map((item) => (
                                        <SelectItem key={item} value={item}>{item}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {action.actionType === "UPDATE_ASSIGN" ? (
                                  <Select
                                    value={action.assigneeId}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, assigneeId: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select assign CS" /></SelectTrigger>
                                    <SelectContent>
                                      {assigneeOptions.map((item) => (
                                        <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                {action.actionType === "UPDATE_PIPELINE_STAGE" ? (
                                  <Select
                                    value={action.pipelineStage}
                                    onValueChange={(value) =>
                                      setRuleActions((prev) => prev.map((item) => (item.id === action.id ? { ...item, pipelineStage: value } : item)))
                                    }
                                  >
                                    <SelectTrigger><SelectValue placeholder="Select pipeline stage" /></SelectTrigger>
                                    <SelectContent>
                                      {pipelineStageOptions.map((item) => (
                                        <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}
                              </div>
                            ))}

                            <Button
                              variant="secondary"
                              className="rounded-full"
                              onClick={() => setRuleActions((prev) => [...prev, createDefaultRuleAction()])}
                            >
                              + New Action
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>
        </TabsContent>

        <TabsContent value="broadcast" className="h-full overflow-auto">
          <div className="space-y-4">
            {broadcastBuilderMode === "list" ? (
              <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="flex flex-wrap items-center justify-end gap-3 lg:col-span-2">
                  <Button className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500" onClick={() => setNewBroadcastModalOpen(true)}>
                    + New Broadcast
                  </Button>
                </div>
                <div className="space-y-3">
                  <Card>
                    <CardHeader className="border-b pb-3">
                      <CardTitle className="text-center text-sm tracking-wide">STATUS</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-4 text-sm">
                      <RadioGroup value={broadcastStatusFilter} onValueChange={(value) => setBroadcastStatusFilter(value as typeof broadcastStatusFilter)}>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="ALL" id="bc-status-all" />
                          <Label htmlFor="bc-status-all">All</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="RUNNING" id="bc-status-running" />
                          <Label htmlFor="bc-status-running">Running</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="DRAFT" id="bc-status-draft" />
                          <Label htmlFor="bc-status-draft">Draft</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="COMPLETED" id="bc-status-completed" />
                          <Label htmlFor="bc-status-completed">Completed</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="CANCELED" id="bc-status-canceled" />
                          <Label htmlFor="bc-status-canceled">Canceled</Label>
                        </div>
                      </RadioGroup>
                    </CardContent>
                  </Card>
                </div>
                <div>
                  <p className="mb-4 text-muted-foreground">{visibleBroadcasts.length} Broadcasts Found</p>
                  {isLoadingBroadcasts ? <p className="text-sm text-muted-foreground">Loading broadcasts...</p> : null}
                  {!isLoadingBroadcasts && visibleBroadcasts.length === 0 ? (
                    <div className="mt-16 flex flex-col items-center justify-center text-center text-muted-foreground">
                      <X className="mb-3 h-9 w-9 opacity-50" />
                      <p className="italic">No broadcasts found</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {visibleBroadcasts.map((item) => (
                        <div key={item.id} className="rounded-lg border bg-background p-3">
                          <div className="flex items-start justify-between gap-2">
                            <button type="button" className="text-left" onClick={() => handleSelectBroadcastEditor(item.id)}>
                              <p className="text-sm font-medium">{item.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {item.messageMode} • recipients: {item._count?.recipients ?? 0} • {item.status}
                              </p>
                            </button>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={item.status === "RUNNING"}
                                onCheckedChange={(checked) => void (checked ? handleLaunchBroadcast(item.id) : handleCancelBroadcast(item.id))}
                                aria-label={`Toggle broadcast ${item.name}`}
                              />
                              <button type="button" className="rounded border p-1 text-muted-foreground hover:bg-muted" onClick={() => void handleDeleteBroadcast(item.id)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button variant="outline" onClick={() => setBroadcastBuilderMode("list")}>Back to list</Button>
                  <div className="flex items-center gap-2">
                    <Button
                      className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500"
                      onClick={() => void handleUpdateBroadcast()}
                    >
                      Update
                    </Button>
                    <Button
                      className="rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500"
                      onClick={() => (selectedBroadcastId ? void handleLaunchBroadcast(selectedBroadcastId) : notifyError("Select broadcast first."))}
                    >
                      Go Live
                    </Button>
                    {selectedBroadcast ? <Badge variant="secondary">{selectedBroadcast.status}</Badge> : null}
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-[35%_65%]">
                  <Card>
                    <CardContent className="space-y-4 pt-6">
                      <div className="space-y-1">
                        <p className="text-lg font-semibold">{selectedBroadcast?.name ?? "Broadcast"}</p>
                        <p className="text-sm text-muted-foreground">Compose your WhatsApp broadcast message.</p>
                      </div>
                      <div className="rounded-md border">
                        <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
                          <span>Attachment</span>
                          <Button size="icon" variant="ghost" className="h-7 w-7">
                            <Paperclip className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="border-b px-3 py-2 text-sm">B &nbsp; I &nbsp; • List &nbsp; 1. List &nbsp; Link</div>
                        <Textarea
                          value={broadcastForm.text}
                          onChange={(event) => {
                            const value = event.target.value;
                            setBroadcastForm((prev) => ({ ...prev, text: value }));
                            persistBroadcastDraft({ text: value });
                          }}
                          className="min-h-[280px] rounded-none border-0 focus-visible:ring-0"
                          placeholder="Write your broadcast message..."
                        />
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Settings2 className="h-5 w-5" />
                        Settings
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Type of message</p>
                        <RadioGroup
                          value={broadcastTypeOfMessage}
                          onValueChange={(value) => {
                            const next = value === "PHONE_NUMBERS" ? "PHONE_NUMBERS" : "WINDOW_24H";
                            setBroadcastTypeOfMessage(next);
                            persistBroadcastDraft({ typeOfMessage: next });
                          }}
                        >
                          <div className="flex items-start gap-2 text-sm">
                            <RadioGroupItem value="WINDOW_24H" id="bc-msg-window24" className="mt-0.5" />
                            <Label htmlFor="bc-msg-window24" className="font-normal">
                              <span className="font-medium">Messages within 24 hours</span>
                              <span className="mt-0.5 block text-muted-foreground">Send messages to customers within 24-hour conversation window.</span>
                            </Label>
                          </div>
                          <div className="flex items-start gap-2 text-sm">
                            <RadioGroupItem value="PHONE_NUMBERS" id="bc-msg-numbers" className="mt-0.5" />
                            <Label htmlFor="bc-msg-numbers" className="font-normal">
                              <span className="font-medium">Messages to WhatsApp phone numbers</span>
                              <span className="mt-0.5 block text-muted-foreground">Promotional message to selected WhatsApp numbers.</span>
                            </Label>
                          </div>
                        </RadioGroup>
                      </div>

                      {broadcastTypeOfMessage === "PHONE_NUMBERS" ? (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Object</p>
                          <p className="text-xs text-muted-foreground">Set recipients and apply filters to match suitable customers.</p>
                          <div className="grid gap-2 md:grid-cols-2">
                            <Select value={broadcastFilterAssignee} onValueChange={setBroadcastFilterAssignee}>
                              <SelectTrigger><SelectValue placeholder="All Assignee" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ALL">All Assignee</SelectItem>
                                {assigneeOptions.map((item) => (
                                  <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select value={broadcastFilterStatus} onValueChange={setBroadcastFilterStatus}>
                              <SelectTrigger><SelectValue placeholder="All Status" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ALL">All Status</SelectItem>
                                {leadStatusOptions.map((item) => (
                                  <SelectItem key={item} value={item}>{item}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select value={broadcastFilterPipeline} onValueChange={setBroadcastFilterPipeline}>
                              <SelectTrigger><SelectValue placeholder="All Pipeline Stages" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ALL">All Pipeline Stages</SelectItem>
                                {pipelineStageOptions.map((item) => (
                                  <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select value={broadcastFilterSource} onValueChange={setBroadcastFilterSource}>
                              <SelectTrigger><SelectValue placeholder="All Source" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ALL">All Source</SelectItem>
                                {broadcastSourceOptions.map((item) => (
                                  <SelectItem key={item} value={item}>{item}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Input
                            value={broadcastCustomerSearch}
                            onChange={(event) => setBroadcastCustomerSearch(event.target.value)}
                            placeholder="Search customers..."
                          />
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>{broadcastSelectedCustomerIds.length} selected</span>
                            <button
                              type="button"
                              className="underline underline-offset-2"
                              onClick={() => {
                                const next = areAllFilteredCustomersSelected
                                  ? broadcastSelectedCustomerIds.filter((id) => !filteredBroadcastCustomers.some((item) => item.id === id))
                                  : Array.from(new Set([...broadcastSelectedCustomerIds, ...filteredBroadcastCustomers.map((item) => item.id)]));
                                setBroadcastSelectedCustomerIds(next);
                                persistBroadcastDraft({ selectedCustomerIds: next });
                              }}
                            >
                              {areAllFilteredCustomersSelected ? "Unselect all" : "Select all recipients"}
                            </button>
                          </div>
                          <div className="max-h-64 overflow-auto rounded-md border">
                            <table className="w-full text-left text-sm">
                              <thead className="sticky top-0 bg-muted/60">
                                <tr>
                                  <th className="px-3 py-2">
                                    <Checkbox
                                      checked={areAllFilteredCustomersSelected}
                                      onCheckedChange={(checked) => {
                                        const next = checked
                                          ? Array.from(new Set([...broadcastSelectedCustomerIds, ...filteredBroadcastCustomers.map((item) => item.id)]))
                                          : broadcastSelectedCustomerIds.filter((id) => !filteredBroadcastCustomers.some((item) => item.id === id));
                                        setBroadcastSelectedCustomerIds(next);
                                        persistBroadcastDraft({ selectedCustomerIds: next });
                                      }}
                                    />
                                  </th>
                                  <th className="px-3 py-2">Name</th>
                                  <th className="px-3 py-2">WhatsApp</th>
                                  <th className="px-3 py-2">Lead Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredBroadcastCustomers.map((customer) => (
                                  <tr key={customer.id} className="border-t">
                                    <td className="px-3 py-2">
                                      <Checkbox
                                        checked={broadcastSelectedCustomerIds.includes(customer.id)}
                                        onCheckedChange={(checked) => {
                                          const next = checked
                                            ? [...broadcastSelectedCustomerIds, customer.id]
                                            : broadcastSelectedCustomerIds.filter((id) => id !== customer.id);
                                          setBroadcastSelectedCustomerIds(next);
                                          persistBroadcastDraft({ selectedCustomerIds: next });
                                        }}
                                      />
                                    </td>
                                    <td className="px-3 py-2">{customer.name || "-"}</td>
                                    <td className="px-3 py-2">{customer.phoneE164 || "-"}</td>
                                    <td className="px-3 py-2">{customer.leadStatus || "-"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-2">
                        <p className="text-sm font-medium">Schedule Broadcast</p>
                        <div className="relative">
                          <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            type="date"
                            value={broadcastScheduleDate}
                            onChange={(event) => {
                              setBroadcastScheduleDate(event.target.value);
                              persistBroadcastDraft({ scheduleDate: event.target.value });
                            }}
                            className="pl-9"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="text-sm font-medium">Number of customers</p>
                        <p className="text-xs text-muted-foreground">Example: 5 customers, every 10 minutes.</p>
                        <div className="grid grid-cols-3 gap-2">
                          <Input
                            type="number"
                            min={1}
                            value={broadcastRecipientsCount}
                            onChange={(event) => {
                              setBroadcastRecipientsCount(event.target.value);
                              persistBroadcastDraft({ recipientsCount: event.target.value });
                            }}
                          />
                          <Input
                            type="number"
                            min={1}
                            value={broadcastIntervalValue}
                            onChange={(event) => {
                              setBroadcastIntervalValue(event.target.value);
                              persistBroadcastDraft({ intervalValue: event.target.value });
                            }}
                          />
                          <Select
                            value={broadcastIntervalUnit}
                            onValueChange={(value: "minute" | "hour" | "day") => {
                              setBroadcastIntervalUnit(value);
                              persistBroadcastDraft({ intervalUnit: value });
                            }}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="minute">Minute</SelectItem>
                              <SelectItem value="hour">Hour</SelectItem>
                              <SelectItem value="day">Day</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
                        <div className="mb-1 flex items-center gap-2 font-medium">
                          <AlertTriangle className="h-4 w-4" />
                          Warning
                        </div>
                        <ul className="list-disc pl-5">
                          <li>Recommended max rate: 5 contacts per 10 minutes.</li>
                          <li>Always follow WhatsApp policy to avoid spam reports and number blocking.</li>
                          <li>20Byte is not responsible for account penalties caused by policy-violating broadcast usage.</li>
                        </ul>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="recipients">
          <Card>
            <CardHeader>
              <CardTitle>Recipients</CardTitle>
              <CardDescription>Quick actions: suppression (opt-out) dan clear suppression.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Conversation ID</Label>
                <Input value={suppressionForm.conversationId} onChange={(event) => setSuppressionForm((prev) => ({ ...prev, conversationId: event.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <Input value={suppressionForm.reason} onChange={(event) => setSuppressionForm((prev) => ({ ...prev, reason: event.target.value }))} />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const id = suppressionForm.conversationId.trim();
                    if (!id) {
                      notifyError("conversationId wajib diisi.");
                      return;
                    }
                    const toastId = notifyLoading("Set suppression...");
                    try {
                      await parseJson(
                        await fetch("/api/whatsapp/suppressions", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ conversationId: id, reason: suppressionForm.reason })
                        })
                      );
                      dismissNotify(toastId);
                      notifySuccess("Suppression aktif.");
                    } catch (error) {
                      dismissNotify(toastId);
                      notifyError(error instanceof Error ? error.message : "Gagal set suppression.");
                    }
                  }}
                >
                  Set Suppression
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    const id = suppressionForm.conversationId.trim();
                    if (!id) {
                      notifyError("conversationId wajib diisi.");
                      return;
                    }
                    const toastId = notifyLoading("Clear suppression...");
                    try {
                      await parseJson(
                        await fetch("/api/whatsapp/suppressions", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ conversationId: id })
                        })
                      );
                      dismissNotify(toastId);
                      notifySuccess("Suppression dinonaktifkan.");
                    } catch (error) {
                      dismissNotify(toastId);
                      notifyError(error instanceof Error ? error.message : "Gagal clear suppression.");
                    }
                  }}
                >
                  Clear Suppression
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analytics">
          <Card>
            <CardHeader>
              <CardTitle>Funnel</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoadingAnalytics ? <p className="mb-3 text-sm text-muted-foreground">Memuat analytics...</p> : null}
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Enrolled</p><p className="text-xl font-semibold">{analytics?.funnel?.enrolled ?? 0}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Queued</p><p className="text-xl font-semibold">{analytics?.funnel?.queued ?? 0}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Sent</p><p className="text-xl font-semibold">{analytics?.funnel?.sent ?? 0}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Failed</p><p className="text-xl font-semibold">{analytics?.funnel?.failed ?? 0}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Stopped</p><p className="text-xl font-semibold">{analytics?.funnel?.stopped ?? 0}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Skipped</p><p className="text-xl font-semibold">{analytics?.funnel?.skipped ?? 0}</p></div>
              </div>
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium">Broadcast Recipients</p>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Pending</p><p className="text-xl font-semibold">{analytics?.broadcasts?.pending ?? 0}</p></div>
                  <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Queued</p><p className="text-xl font-semibold">{analytics?.broadcasts?.queued ?? 0}</p></div>
                  <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Sent</p><p className="text-xl font-semibold">{analytics?.broadcasts?.sent ?? 0}</p></div>
                  <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Failed</p><p className="text-xl font-semibold">{analytics?.broadcasts?.failed ?? 0}</p></div>
                  <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Skipped</p><p className="text-xl font-semibold">{analytics?.broadcasts?.skipped ?? 0}</p></div>
                  <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Stopped</p><p className="text-xl font-semibold">{analytics?.broadcasts?.stopped ?? 0}</p></div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        </div>
      </Tabs>

      <Dialog open={newSequenceModalOpen} onOpenChange={setNewSequenceModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enter your sequence name:</DialogTitle>
            <DialogDescription>Create a sequence name before opening the builder.</DialogDescription>
          </DialogHeader>
          <Input value={newSequenceName} onChange={(event) => setNewSequenceName(event.target.value)} />
          <DialogFooter>
            <Button className="rounded-full bg-emerald-600 text-white hover:bg-emerald-500" onClick={handleCreateFlow}>
              Create
            </Button>
            <Button variant="outline" className="rounded-full" onClick={() => setNewSequenceModalOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newRuleModalOpen} onOpenChange={setNewRuleModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>For your reference, enter your rule name:</DialogTitle>
            <DialogDescription>The rule name will be used as the condition label.</DialogDescription>
          </DialogHeader>
          <Input value={newRuleName} onChange={(event) => setNewRuleName(event.target.value)} />
          <DialogFooter>
            <Button className="rounded-full bg-emerald-600 text-white hover:bg-emerald-500" onClick={handleCreateRuleEditor}>
              Create
            </Button>
            <Button variant="outline" className="rounded-full" onClick={() => setNewRuleModalOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newBroadcastModalOpen} onOpenChange={setNewBroadcastModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enter your broadcast name:</DialogTitle>
            <DialogDescription>Create a broadcast name before opening the editor.</DialogDescription>
          </DialogHeader>
          <Input value={newBroadcastName} onChange={(event) => setNewBroadcastName(event.target.value)} />
          <DialogFooter>
            <Button className="rounded-full bg-emerald-600 text-white hover:bg-emerald-500" onClick={handleCreateBroadcast}>
              Create
            </Button>
            <Button variant="outline" className="rounded-full" onClick={() => setNewBroadcastModalOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

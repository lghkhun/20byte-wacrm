import { ServiceError } from "@/server/services/serviceError";

function aiDisabledError(): never {
  throw new ServiceError(503, "AI_AUTOMATION_DISABLED", "AI & Automation belum diaktifkan pada deployment ini.");
}

export async function processAiAutomationTrigger(_input: Record<string, unknown>): Promise<void> {
  return;
}

export async function getAiAgentConfig(_actorUserId: string, _orgId: string) {
  return {
    enabled: false,
    role: "CUSTOM",
    goal: "ANSWER_QUESTION",
    tone: "PROFESSIONAL",
    salesMode: "INFORMATIVE",
    businessName: null,
    advancedPrompt: null,
    stopIfHumanReply: true,
    typingDelayMs: 0,
    multiBubbleReply: false,
    confidenceThreshold: 0,
    modelFree: null,
    modelPaid: null,
    activeModelTier: "free"
  };
}

export async function updateAiAgentConfig(_actorUserId: string, _orgId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function listAiAutomations(_actorUserId: string, _orgId: string) {
  return [];
}

export async function createAiAutomation(_actorUserId: string, _orgId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function updateAiAutomation(_actorUserId: string, _orgId: string, _automationId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function deleteAiAutomation(_actorUserId: string, _orgId: string, _automationId: string) {
  aiDisabledError();
}

export async function listAiKnowledge(_actorUserId: string, _orgId: string, _filter?: Record<string, unknown>) {
  return [];
}

export async function createAiKnowledge(_actorUserId: string, _orgId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function updateAiKnowledge(_actorUserId: string, _orgId: string, _knowledgeId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function deleteAiKnowledge(_actorUserId: string, _orgId: string, _knowledgeId: string) {
  aiDisabledError();
}

export async function importAiKnowledgeFromUrl(_actorUserId: string, _orgId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function uploadAiKnowledgeDocument(_actorUserId: string, _orgId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

export async function previewAiReply(_actorUserId: string, _orgId: string, _input: Record<string, unknown>) {
  aiDisabledError();
}

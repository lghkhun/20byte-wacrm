"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Brain, FileText, HelpCircle, Link2, Settings2, Sparkles, Type, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownEditor } from "@/components/ai/MarkdownEditor";
import { dismissNotify, notifyError, notifyLoading, notifySuccess } from "@/lib/ui/notify";

type TabId = "agent" | "knowledge" | "automation" | "settings";
type KnowledgeMode = "text" | "qna" | "file" | "url";

type AiConfig = {
  enabled: boolean;
  role: string;
  goal: string;
  tone: string;
  salesMode: string;
  advancedPrompt: string | null;
  stopIfHumanReply: boolean;
  typingDelayMs: number;
  multiBubbleReply: boolean;
  confidenceThreshold: number;
  modelFree: string;
  modelPaid: string;
  activeModelTier: string;
};

type AiKnowledge = {
  id: string;
  type: string;
  title: string;
  content: string;
  question: string | null;
  answer: string | null;
  sourceUrl: string | null;
  fileName?: string | null;
  fileUrl?: string | null;
  isActive: boolean;
  priority: number;
};

type AiAutomation = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  delayMinutes: number;
  conditions: Array<{ id: string; type: string; operator: string; value: string }>;
  actions: Array<{ id: string; type: string; payloadJson: string }>;
};

type TextDraft = { title: string; content: string };
type QnaDraft = { question: string; answer: string };
type UrlDraft = { url: string; title: string };

const MAX_KNOWLEDGE_ITEMS = 5;

const TABS: Array<{ id: TabId; label: string; icon: typeof Bot }> = [
  { id: "agent", label: "Agent", icon: Bot },
  { id: "knowledge", label: "Knowledge", icon: Brain },
  { id: "automation", label: "Automation", icon: Workflow },
  { id: "settings", label: "Settings", icon: Settings2 }
];

const KNOWLEDGE_MODES: Array<{ id: KnowledgeMode; label: string; icon: typeof Type }> = [
  { id: "text", label: "Dari Teks", icon: Type },
  { id: "qna", label: "Dari Q&A", icon: HelpCircle },
  { id: "file", label: "Dari File", icon: FileText },
  { id: "url", label: "Belajar dari URL", icon: Link2 }
];

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Request failed.");
  }
  return payload;
}

function knowledgeModeToType(mode: KnowledgeMode): string {
  if (mode === "qna") return "FAQ";
  if (mode === "text") return "PRODUCT";
  if (mode === "file") return "SOP";
  return "CUSTOM";
}

export function AiAutomationWorkspace() {
  const [activeTab, setActiveTab] = useState<TabId>("agent");
  const [knowledgeMode, setKnowledgeMode] = useState<KnowledgeMode>("text");
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isKnowledgeSaving, setIsKnowledgeSaving] = useState(false);
  const [isAutomationSaving, setIsAutomationSaving] = useState(false);

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [knowledge, setKnowledge] = useState<AiKnowledge[]>([]);
  const [editingKnowledge, setEditingKnowledge] = useState<Record<string, { title: string; content: string; question: string; answer: string; sourceUrl: string }>>({});
  const [automations, setAutomations] = useState<AiAutomation[]>([]);

  const [textDrafts, setTextDrafts] = useState<TextDraft[]>([{ title: "", content: "" }]);
  const [qnaDrafts, setQnaDrafts] = useState<QnaDraft[]>([{ question: "", answer: "" }]);
  const [urlDrafts, setUrlDrafts] = useState<UrlDraft[]>([{ url: "", title: "" }]);
  const [fileDrafts, setFileDrafts] = useState<Array<{ file: File | null; title: string }>>([{ file: null, title: "" }]);

  const [automationForm, setAutomationForm] = useState({
    name: "",
    description: "",
    trigger: "CHAT_INCOMING",
    delayMinutes: 0,
    conditionType: "CONVERSATION_STATUS",
    conditionValue: "OPEN",
    actionType: "SEND_MESSAGE",
    actionPayloadJson: '{"message":"Halo, ada yang bisa dibantu?"}',
    notifyCsOnFailure: false,
    stopMessage: "[AI Notice] AI reply dihentikan. Percakapan di-takeover manusia."
  });

  const [previewPrompt, setPreviewPrompt] = useState("");
  const [previewResult, setPreviewResult] = useState<string>("");

  const roleOptions = useMemo(() => ["SALES_ASSISTANT", "CUSTOMER_SUPPORT", "ADMIN_ASSISTANT", "CUSTOM"], []);
  const goalOptions = useMemo(() => ["ANSWER_QUESTION", "COLLECT_LEAD", "PUSH_TO_BUY", "CLOSE_DEAL"], []);
  const toneOptions = useMemo(() => ["FRIENDLY", "CASUAL", "PROFESSIONAL", "PERSUASIVE"], []);
  const modeOptions = useMemo(() => ["SOFT_SELLING", "HARD_SELLING", "INFORMATIVE"], []);

  async function loadAll() {
    setIsLoading(true);
    try {
      const [configRes, knowledgeRes, automationRes] = await Promise.all([
        fetch("/api/ai/config", { cache: "no-store" }),
        fetch("/api/ai/knowledge", { cache: "no-store" }),
        fetch("/api/ai/automation", { cache: "no-store" })
      ]);

      const configPayload = await parseJson<{ data?: { config?: AiConfig } }>(configRes);
      const knowledgePayload = await parseJson<{ data?: { items?: AiKnowledge[] } }>(knowledgeRes);
      const automationPayload = await parseJson<{ data?: { items?: AiAutomation[] } }>(automationRes);

      setConfig(configPayload.data?.config ?? null);
      setKnowledge(knowledgePayload.data?.items ?? []);
      setAutomations(automationPayload.data?.items ?? []);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal memuat modul AI.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function saveConfig(patch: Record<string, unknown>) {
    const toastId = notifyLoading("Menyimpan konfigurasi AI...");
    setIsSavingConfig(true);
    try {
      const response = await fetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const payload = await parseJson<{ data?: { config?: AiConfig } }>(response);
      setConfig(payload.data?.config ?? null);
      dismissNotify(toastId);
      notifySuccess("Konfigurasi AI tersimpan.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal menyimpan konfigurasi AI.");
    } finally {
      setIsSavingConfig(false);
    }
  }

  const promptVariables = [
    { label: "{name}", value: "{name}" },
    { label: "{phone}", value: "{phone}" },
    { label: "{business_name}", value: "{business_name}" },
    { label: "{invoice_status}", value: "{invoice_status}" }
  ];

  function addDraft<T>(items: T[], setItems: (items: T[]) => void, emptyItem: T) {
    if (items.length >= MAX_KNOWLEDGE_ITEMS) {
      notifyError(`Maksimal ${MAX_KNOWLEDGE_ITEMS} item per mode.`);
      return;
    }
    setItems([...items, emptyItem]);
  }

  async function submitTextDrafts() {
    const valid = textDrafts.filter((item) => item.title.trim() && item.content.trim());
    if (valid.length === 0) {
      notifyError("Minimal 1 item teks harus diisi.");
      return;
    }
    const toastId = notifyLoading("Menyimpan knowledge teks...");
    setIsKnowledgeSaving(true);
    try {
      const type = knowledgeModeToType("text");
      for (const item of valid) {
        await parseJson(await fetch("/api/ai/knowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            title: item.title,
            content: item.content
          })
        }));
      }
      dismissNotify(toastId);
      notifySuccess(`${valid.length} knowledge teks tersimpan.`);
      setTextDrafts([{ title: "", content: "" }]);
      await loadAll();
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal simpan knowledge teks.");
    } finally {
      setIsKnowledgeSaving(false);
    }
  }

  async function submitQnaDrafts() {
    const valid = qnaDrafts.filter((item) => item.question.trim() && item.answer.trim());
    if (valid.length === 0) {
      notifyError("Minimal 1 item Q&A harus diisi.");
      return;
    }
    const toastId = notifyLoading("Menyimpan knowledge Q&A...");
    setIsKnowledgeSaving(true);
    try {
      const type = knowledgeModeToType("qna");
      for (const item of valid) {
        await parseJson(await fetch("/api/ai/knowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            title: item.question.slice(0, 80),
            content: `${item.question}\n\n${item.answer}`,
            question: item.question,
            answer: item.answer
          })
        }));
      }
      dismissNotify(toastId);
      notifySuccess(`${valid.length} item Q&A tersimpan.`);
      setQnaDrafts([{ question: "", answer: "" }]);
      await loadAll();
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal simpan Q&A.");
    } finally {
      setIsKnowledgeSaving(false);
    }
  }

  async function submitFileDrafts() {
    const valid = fileDrafts.filter((item) => item.file);
    if (valid.length === 0) {
      notifyError("Minimal 1 file harus dipilih.");
      return;
    }
    const toastId = notifyLoading("Upload dokumen knowledge...");
    setIsKnowledgeSaving(true);
    try {
      const type = knowledgeModeToType("file");
      for (const item of valid) {
        if (!item.file) continue;
        const formData = new FormData();
        formData.append("file", item.file);
        formData.append("type", type);
        formData.append("title", item.title || item.file.name);
        await parseJson(await fetch("/api/ai/knowledge/upload", { method: "POST", body: formData }));
      }
      dismissNotify(toastId);
      notifySuccess(`${valid.length} dokumen tersimpan.`);
      setFileDrafts([{ file: null, title: "" }]);
      await loadAll();
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal upload dokumen.");
    } finally {
      setIsKnowledgeSaving(false);
    }
  }

  async function submitUrlDrafts() {
    const valid = urlDrafts.filter((item) => item.url.trim());
    if (valid.length === 0) {
      notifyError("Minimal 1 URL harus diisi.");
      return;
    }
    const toastId = notifyLoading("Scraping URL knowledge...");
    setIsKnowledgeSaving(true);
    try {
      const type = knowledgeModeToType("url");
      for (const item of valid) {
        await parseJson(await fetch("/api/ai/knowledge/import-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: item.url,
            title: item.title || undefined,
            type
          })
        }));
      }
      dismissNotify(toastId);
      notifySuccess(`${valid.length} URL berhasil diproses.`);
      setUrlDrafts([{ url: "", title: "" }]);
      await loadAll();
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal proses URL.");
    } finally {
      setIsKnowledgeSaving(false);
    }
  }

  async function toggleKnowledge(id: string, nextValue: boolean) {
    try {
      await parseJson(await fetch("/api/ai/knowledge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeId: id, isActive: nextValue })
      }));
      await loadAll();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal update knowledge.");
    }
  }

  async function removeKnowledge(id: string) {
    try {
      await parseJson(await fetch("/api/ai/knowledge", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ knowledgeId: id })
      }));
      notifySuccess("Knowledge dihapus.");
      await loadAll();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal menghapus knowledge.");
    }
  }

  function startEditKnowledge(item: AiKnowledge) {
    setEditingKnowledge((current) => ({
      ...current,
      [item.id]: {
        title: item.title ?? "",
        content: item.content ?? "",
        question: item.question ?? "",
        answer: item.answer ?? "",
        sourceUrl: item.sourceUrl ?? ""
      }
    }));
  }

  function cancelEditKnowledge(id: string) {
    setEditingKnowledge((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function saveEditKnowledge(id: string) {
    const draft = editingKnowledge[id];
    if (!draft) return;

    const toastId = notifyLoading("Menyimpan perubahan knowledge...");
    try {
      await parseJson(await fetch("/api/ai/knowledge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledgeId: id,
          title: draft.title,
          content: draft.content,
          question: draft.question || null,
          answer: draft.answer || null,
          sourceUrl: draft.sourceUrl || null
        })
      }));
      dismissNotify(toastId);
      notifySuccess("Knowledge diperbarui.");
      cancelEditKnowledge(id);
      await loadAll();
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal update knowledge.");
    }
  }

  async function createAutomation() {
    if (!automationForm.name.trim()) {
      notifyError("Nama automation wajib diisi.");
      return;
    }
    if (!automationForm.conditionValue.trim()) {
      notifyError("Condition value wajib diisi.");
      return;
    }
    const delayMinutes = Number.isFinite(automationForm.delayMinutes)
      ? Math.max(0, Math.floor(automationForm.delayMinutes))
      : 0;
    let payloadJson = "{}";
    if (automationForm.actionType === "SEND_AI_REPLY") {
      payloadJson = JSON.stringify({ notifyCsOnFailure: automationForm.notifyCsOnFailure });
    } else if (automationForm.actionType === "STOP_AI_REPLY") {
      payloadJson = JSON.stringify({ message: automationForm.stopMessage });
    } else {
      try {
        const parsed = JSON.parse(automationForm.actionPayloadJson || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          notifyError("Action payload harus JSON object yang valid.");
          return;
        }
        payloadJson = JSON.stringify(parsed);
      } catch {
        notifyError("Action payload harus JSON valid.");
        return;
      }
    }

    const toastId = notifyLoading("Membuat automation...");
    setIsAutomationSaving(true);
    try {
      await parseJson(await fetch("/api/ai/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: automationForm.name,
          description: automationForm.description,
          trigger: automationForm.trigger,
          delayMinutes,
          conditions: [{ type: automationForm.conditionType, operator: "EQUALS", value: automationForm.conditionValue }],
          actions: [{ type: automationForm.actionType, payloadJson }]
        })
      }));
      dismissNotify(toastId);
      notifySuccess("Automation berhasil dibuat.");
      setAutomationForm({
        name: "",
        description: "",
        trigger: "CHAT_INCOMING",
        delayMinutes: 0,
        conditionType: "CONVERSATION_STATUS",
        conditionValue: "OPEN",
        actionType: "SEND_MESSAGE",
        actionPayloadJson: '{"message":"Halo, ada yang bisa dibantu?"}',
        notifyCsOnFailure: false,
        stopMessage: "[AI Notice] AI reply dihentikan. Percakapan di-takeover manusia."
      });
      await loadAll();
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal membuat automation.");
    } finally {
      setIsAutomationSaving(false);
    }
  }

  async function toggleAutomation(id: string, nextValue: boolean) {
    try {
      await parseJson(await fetch("/api/ai/automation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: id, enabled: nextValue })
      }));
      await loadAll();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal update automation.");
    }
  }

  async function removeAutomation(id: string) {
    try {
      await parseJson(await fetch("/api/ai/automation", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: id })
      }));
      notifySuccess("Automation dihapus.");
      await loadAll();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "Gagal menghapus automation.");
    }
  }

  async function runPreview() {
    if (!previewPrompt.trim()) {
      notifyError("Isi prompt preview terlebih dahulu.");
      return;
    }

    const toastId = notifyLoading("Menjalankan AI Preview...");
    setIsPreviewLoading(true);
    try {
      const response = await fetch("/api/ai/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: previewPrompt, type: "KNOWLEDGE_TEST" })
      });
      const payload = await parseJson<{ data?: { blocked?: boolean; blockedReason?: string | null; responseText?: string | null; heldResponse?: string | null; providerMode?: string } }>(response);
      const blocked = payload.data?.blocked;
      const result = blocked
        ? `Preview diblokir: ${payload.data?.blockedReason ?? "UNKNOWN"}`
        : `${payload.data?.providerMode === "openrouter" ? "[OpenRouter]" : "[Stub]"} ${payload.data?.responseText ?? payload.data?.heldResponse ?? "Tidak ada response"}`;
      setPreviewResult(result);
      dismissNotify(toastId);
      notifySuccess("Preview selesai.");
    } catch (error) {
      dismissNotify(toastId);
      notifyError(error instanceof Error ? error.message : "Gagal menjalankan preview.");
    } finally {
      setIsPreviewLoading(false);
    }
  }

  if (isLoading) {
    return <section className="p-6 text-sm text-muted-foreground">Memuat AI & Automation...</section>;
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <section className="grid min-h-0 flex-1 gap-4 overflow-hidden xl:gap-0 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col rounded-3xl border border-border/60 bg-card p-4 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] xl:rounded-r-none xl:border-r-0">
          <div className="mb-3 shrink-0 px-2 pt-1">
            <p className="text-sm font-semibold text-foreground">AI & Automation</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Konfigurasi agent, knowledge, dan workflow otomatis.</p>
          </div>
          <nav className="inbox-scroll flex gap-2 overflow-x-auto pb-1 xl:min-h-0 xl:flex-1 xl:flex-col xl:overflow-y-auto xl:overflow-x-hidden" aria-label="AI navigation">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={
                    isActive
                      ? "flex min-w-[180px] items-center gap-3 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 to-transparent px-4 py-3 text-left shadow-sm xl:min-w-0"
                      : "group flex min-w-[180px] items-center gap-3 rounded-2xl border border-transparent px-4 py-3 text-left transition-colors hover:bg-muted/40 xl:min-w-0"
                  }
                >
                  <div className={isActive ? "rounded-xl bg-primary/20 p-2 text-primary ring-1 ring-primary/20" : "rounded-xl bg-muted p-2 text-muted-foreground group-hover:bg-muted/80"}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <span className={isActive ? "text-[14px] font-bold text-primary" : "text-[14px] font-semibold text-foreground group-hover:text-primary"}>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="inbox-scroll flex min-h-0 flex-col overflow-y-auto rounded-3xl border border-border/60 bg-gradient-to-br from-card to-background/50 px-3 py-2 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] md:px-6 md:py-5 xl:rounded-l-none">
          <div className="space-y-4 px-2 pb-4">
            {activeTab === "agent" && config ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Agent Behavior</CardTitle>
                  <CardDescription>Atur role, goal, tone, dan prompt agent.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl border border-border/60 p-3">
                    <div>
                      <p className="text-sm font-semibold">AI Enabled</p>
                      <p className="text-xs text-muted-foreground">Jika nonaktif, AI preview dan automation diblokir.</p>
                    </div>
                    <Switch checked={config.enabled} onCheckedChange={(next) => void saveConfig({ enabled: next })} disabled={isSavingConfig} />
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Role</Label>
                      <Select value={config.role} onValueChange={(value) => void saveConfig({ role: value })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{roleOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Goal</Label>
                      <Select value={config.goal} onValueChange={(value) => void saveConfig({ goal: value })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{goalOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Tone</Label>
                      <Select value={config.tone} onValueChange={(value) => void saveConfig({ tone: value })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{toneOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Sales Mode</Label>
                      <Select value={config.salesMode} onValueChange={(value) => void saveConfig({ salesMode: value })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{modeOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Advanced Prompt</Label>
                      <Button size="sm" variant="outline" onClick={() => void saveConfig({ advancedPrompt: config.advancedPrompt ?? "" })} disabled={isSavingConfig}>Simpan Prompt</Button>
                    </div>
                    <MarkdownEditor 
                      value={config.advancedPrompt ?? ""} 
                      onChange={(value) => setConfig({ ...config, advancedPrompt: value })}
                      placeholder="Ketik prompt di sini..."
                      rows={7}
                      variables={promptVariables}
                    />
                  </div>

                  <div className="rounded-xl border border-dashed border-border/80 p-3 text-xs text-muted-foreground">
                    Variabel dinamis: <code>{"{name}"}</code>, <code>{"{phone}"}</code>, <code>{"{business_name}"}</code>, <code>{"{invoice_status}"}</code>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {activeTab === "knowledge" ? (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Knowledge Base</CardTitle>
                      <CardDescription>Kelola knowledge per mode. Maksimal {MAX_KNOWLEDGE_ITEMS} item per mode sebelum submit.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap gap-2 border-b border-border/60 pb-3">
                        {KNOWLEDGE_MODES.map((mode) => {
                          const Icon = mode.icon;
                          const isActive = knowledgeMode === mode.id;
                          return (
                            <Button key={mode.id} variant={isActive ? "default" : "ghost"} onClick={() => setKnowledgeMode(mode.id)} className="gap-2">
                              <Icon className="h-4 w-4" />
                              {mode.label}
                            </Button>
                          );
                        })}
                      </div>

                      {knowledgeMode === "text" ? (
                        <div className="space-y-3">
                          {textDrafts.map((item, index) => (
                            <div key={`text-${index}`} className="rounded-xl border border-border/60 p-3 space-y-2">
                              <Label>Item Teks #{index + 1}</Label>
                              <Input placeholder="Judul / topik" value={item.title} onChange={(event) => setTextDrafts((current) => current.map((row, idx) => idx === index ? { ...row, title: event.target.value } : row))} />
                              <MarkdownEditor placeholder="Konten knowledge..." rows={4} value={item.content} onChange={(value) => setTextDrafts((current) => current.map((row, idx) => idx === index ? { ...row, content: value } : row))} />
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <Button variant="outline" onClick={() => addDraft(textDrafts, setTextDrafts, { title: "", content: "" })}>Tambah Item</Button>
                            <Button onClick={() => void submitTextDrafts()} disabled={isKnowledgeSaving}>Simpan Semua ({textDrafts.length}/{MAX_KNOWLEDGE_ITEMS})</Button>
                          </div>
                        </div>
                      ) : null}

                      {knowledgeMode === "qna" ? (
                        <div className="space-y-3">
                          {qnaDrafts.map((item, index) => (
                            <div key={`qna-${index}`} className="rounded-xl border border-border/60 p-3 space-y-2">
                              <Label>Q&A #{index + 1}</Label>
                              <MarkdownEditor rows={3} placeholder="Pertanyaan (Question)" value={item.question} onChange={(value) => setQnaDrafts((current) => current.map((row, idx) => idx === index ? { ...row, question: value } : row))} />
                              <MarkdownEditor rows={4} placeholder="Jawaban (Answer)" value={item.answer} onChange={(value) => setQnaDrafts((current) => current.map((row, idx) => idx === index ? { ...row, answer: value } : row))} />
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <Button variant="outline" onClick={() => addDraft(qnaDrafts, setQnaDrafts, { question: "", answer: "" })}>Tambah Q&A</Button>
                            <Button onClick={() => void submitQnaDrafts()} disabled={isKnowledgeSaving}>Simpan Semua ({qnaDrafts.length}/{MAX_KNOWLEDGE_ITEMS})</Button>
                          </div>
                        </div>
                      ) : null}

                      {knowledgeMode === "file" ? (
                        <div className="space-y-3">
                          {fileDrafts.map((item, index) => (
                            <div key={`file-${index}`} className="rounded-xl border border-border/60 p-3 space-y-2">
                              <Label>Dokumen #{index + 1} (hanya PDF / MD)</Label>
                              <Input placeholder="Judul (opsional)" value={item.title} onChange={(event) => setFileDrafts((current) => current.map((row, idx) => idx === index ? { ...row, title: event.target.value } : row))} />
                              <Input type="file" accept="application/pdf,text/markdown,.pdf,.md" onChange={(event) => setFileDrafts((current) => current.map((row, idx) => idx === index ? { ...row, file: event.target.files?.[0] ?? null } : row))} />
                              <p className="text-xs text-muted-foreground">{item.file?.name ?? "Belum ada file dipilih"}</p>
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <Button variant="outline" onClick={() => addDraft(fileDrafts, setFileDrafts, { file: null, title: "" })}>Tambah Dokumen</Button>
                            <Button onClick={() => void submitFileDrafts()} disabled={isKnowledgeSaving}>Upload Semua ({fileDrafts.length}/{MAX_KNOWLEDGE_ITEMS})</Button>
                          </div>
                        </div>
                      ) : null}

                      {knowledgeMode === "url" ? (
                        <div className="space-y-3">
                          {urlDrafts.map((item, index) => (
                            <div key={`url-${index}`} className="rounded-xl border border-border/60 p-3 space-y-2">
                              <Label>URL #{index + 1}</Label>
                              <Input placeholder="https://contoh.com/halaman" value={item.url} onChange={(event) => setUrlDrafts((current) => current.map((row, idx) => idx === index ? { ...row, url: event.target.value } : row))} />
                              <Input placeholder="Judul (opsional)" value={item.title} onChange={(event) => setUrlDrafts((current) => current.map((row, idx) => idx === index ? { ...row, title: event.target.value } : row))} />
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <Button variant="outline" onClick={() => addDraft(urlDrafts, setUrlDrafts, { url: "", title: "" })}>Tambah URL</Button>
                            <Button onClick={() => void submitUrlDrafts()} disabled={isKnowledgeSaving}>Scrape Semua ({urlDrafts.length}/{MAX_KNOWLEDGE_ITEMS})</Button>
                          </div>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Daftar Knowledge Tersimpan</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {knowledge.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada knowledge.</p> : null}
                      {knowledge.length > 0 ? (
                        <Accordion type="single" collapsible className="rounded-xl border border-border/60 px-3">
                          {knowledge.map((item) => {
                            const draft = editingKnowledge[item.id];
                            return (
                              <AccordionItem value={item.id} key={item.id} className="border-border/60">
                                <AccordionTrigger className="hover:no-underline">
                                  <div className="flex w-full items-center justify-between gap-3 pr-2">
                                    <div className="text-left">
                                      <p className="text-sm font-semibold">{item.title}</p>
                                      <p className="text-xs text-muted-foreground">{item.type} {item.fileName ? `· ${item.fileName}` : ""}</p>
                                    </div>
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                  <div className="space-y-3 rounded-xl border border-border/60 p-3">
                                    <div className="flex items-center justify-between">
                                      <div className="text-xs text-muted-foreground">Aktifkan/nonaktifkan knowledge</div>
                                      <Switch checked={item.isActive} onCheckedChange={(next) => void toggleKnowledge(item.id, next)} />
                                    </div>

                                    {draft ? (
                                      <>
                                        <div className="space-y-2">
                                          <Label>Judul</Label>
                                          <Input value={draft.title} onChange={(event) => setEditingKnowledge((current) => ({ ...current, [item.id]: { ...current[item.id], title: event.target.value } }))} />
                                        </div>
                                        <div className="space-y-2">
                                          <Label>Konten</Label>
                                          <MarkdownEditor rows={4} value={draft.content} onChange={(value) => setEditingKnowledge((current) => ({ ...current, [item.id]: { ...current[item.id], content: value } }))} />
                                        </div>
                                        <div className="grid gap-3 md:grid-cols-2">
                                          <div className="space-y-2">
                                            <Label>Question</Label>
                                            <MarkdownEditor rows={2} value={draft.question} onChange={(value) => setEditingKnowledge((current) => ({ ...current, [item.id]: { ...current[item.id], question: value } }))} />
                                          </div>
                                          <div className="space-y-2">
                                            <Label>Answer</Label>
                                            <MarkdownEditor rows={2} value={draft.answer} onChange={(value) => setEditingKnowledge((current) => ({ ...current, [item.id]: { ...current[item.id], answer: value } }))} />
                                          </div>
                                        </div>
                                        <div className="space-y-2">
                                          <Label>Source URL</Label>
                                          <Input value={draft.sourceUrl} onChange={(event) => setEditingKnowledge((current) => ({ ...current, [item.id]: { ...current[item.id], sourceUrl: event.target.value } }))} />
                                        </div>
                                        <div className="flex gap-2">
                                          <Button size="sm" onClick={() => void saveEditKnowledge(item.id)}>Simpan</Button>
                                          <Button size="sm" variant="outline" onClick={() => cancelEditKnowledge(item.id)}>Batal</Button>
                                          <Button size="sm" variant="outline" onClick={() => void removeKnowledge(item.id)}>Hapus</Button>
                                        </div>
                                      </>
                                    ) : (
                                      <>
                                        <p className="text-sm text-muted-foreground">{item.content.slice(0, 320)}</p>
                                        {item.sourceUrl ? <p className="text-xs text-muted-foreground">Source: {item.sourceUrl}</p> : null}
                                        <div className="flex gap-2">
                                          <Button size="sm" variant="outline" onClick={() => startEditKnowledge(item)}>Edit</Button>
                                          <Button size="sm" variant="outline" onClick={() => void removeKnowledge(item.id)}>Hapus</Button>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </AccordionContent>
                              </AccordionItem>
                            );
                          })}
                        </Accordion>
                      ) : null}
                    </CardContent>
                  </Card>
                </div>

                <div className="xl:sticky xl:top-4 xl:self-start">
                  <Card className="h-[680px]">
                    <CardHeader className="border-b border-border/60 pb-3">
                      <CardTitle className="text-lg">AI Preview</CardTitle>
                      <CardDescription>Panel chat untuk testing respons AI.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex h-[calc(100%-84px)] flex-col gap-3 p-3">
                      <div className="inbox-scroll flex-1 space-y-3 overflow-y-auto rounded-xl border border-border/60 bg-muted/20 p-3">
                        {previewPrompt ? (
                          <div className="flex justify-end">
                            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground">
                              {previewPrompt}
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">Ketik prompt untuk memulai simulasi chat.</p>
                        )}

                        {previewResult ? (
                          <div className="flex justify-start">
                            <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-border/60 bg-card px-3 py-2 text-sm text-foreground">
                              {previewResult}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <Textarea rows={4} value={previewPrompt} onChange={(event) => setPreviewPrompt(event.target.value)} placeholder="Tulis pesan customer..." />
                      <Button onClick={() => void runPreview()} disabled={isPreviewLoading}><Sparkles className="mr-2 h-4 w-4" />Kirim ke AI</Button>
                    </CardContent>
                  </Card>
                </div>
              </div>
            ) : null}

            {activeTab === "automation" ? (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Buat Rule Automation</CardTitle>
                    <CardDescription>Trigger - Condition - Action.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2"><Label>Nama</Label><Input value={automationForm.name} onChange={(event) => setAutomationForm((current) => ({ ...current, name: event.target.value }))} /></div>
                      <div className="space-y-2"><Label>Delay (menit)</Label><Input type="number" value={automationForm.delayMinutes} onChange={(event) => setAutomationForm((current) => ({ ...current, delayMinutes: Number(event.target.value || "0") }))} /></div>
                    </div>
                    <div className="space-y-2"><Label>Deskripsi</Label><Input value={automationForm.description} onChange={(event) => setAutomationForm((current) => ({ ...current, description: event.target.value }))} /></div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="space-y-2">
                        <Label>Trigger</Label>
                        <Select value={automationForm.trigger} onValueChange={(value) => setAutomationForm((current) => ({ ...current, trigger: value }))}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CHAT_INCOMING">CHAT_INCOMING</SelectItem>
                            <SelectItem value="NO_REPLY">NO_REPLY</SelectItem>
                            <SelectItem value="INVOICE_CREATED">INVOICE_CREATED</SelectItem>
                            <SelectItem value="INVOICE_UNPAID">INVOICE_UNPAID</SelectItem>
                            <SelectItem value="TAG_ADDED">TAG_ADDED</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Condition</Label>
                        <Select value={automationForm.conditionType} onValueChange={(value) => setAutomationForm((current) => ({ ...current, conditionType: value }))}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CUSTOMER_TAG">CUSTOMER_TAG</SelectItem>
                            <SelectItem value="INVOICE_STATUS">INVOICE_STATUS</SelectItem>
                            <SelectItem value="CONVERSATION_STATUS">CONVERSATION_STATUS</SelectItem>
                            <SelectItem value="NO_HUMAN_REPLY">NO_HUMAN_REPLY</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2"><Label>Condition Value</Label><Input value={automationForm.conditionValue} onChange={(event) => setAutomationForm((current) => ({ ...current, conditionValue: event.target.value }))} /></div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Action</Label>
                        <Select value={automationForm.actionType} onValueChange={(value) => setAutomationForm((current) => ({ ...current, actionType: value }))}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="SEND_MESSAGE">SEND_MESSAGE</SelectItem>
                            <SelectItem value="SEND_AI_REPLY">SEND_AI_REPLY</SelectItem>
                            <SelectItem value="STOP_AI_REPLY">STOP_AI_REPLY</SelectItem>
                            <SelectItem value="SEND_INVOICE">SEND_INVOICE</SelectItem>
                            <SelectItem value="ASSIGN_CS">ASSIGN_CS</SelectItem>
                            <SelectItem value="NOTIFY_CS">NOTIFY_CS</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {automationForm.actionType === "SEND_AI_REPLY" ? (
                        <div className="space-y-2 rounded-xl border border-border/60 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <Label className="text-sm">Notify CS saat gagal</Label>
                              <p className="text-xs text-muted-foreground">Jika AI gagal/low-confidence, kirim system notice ke conversation.</p>
                            </div>
                            <Switch
                              checked={automationForm.notifyCsOnFailure}
                              onCheckedChange={(next) => setAutomationForm((current) => ({ ...current, notifyCsOnFailure: next }))}
                            />
                          </div>
                        </div>
                      ) : automationForm.actionType === "STOP_AI_REPLY" ? (
                        <div className="space-y-2 rounded-xl border border-border/60 p-3">
                          <Label className="text-sm">Pesan Sistem Takeover</Label>
                          <Input
                            value={automationForm.stopMessage}
                            onChange={(event) => setAutomationForm((current) => ({ ...current, stopMessage: event.target.value }))}
                          />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Label>Action Payload JSON</Label>
                          <Input value={automationForm.actionPayloadJson} onChange={(event) => setAutomationForm((current) => ({ ...current, actionPayloadJson: event.target.value }))} />
                        </div>
                      )}
                    </div>

                    <Button onClick={() => void createAutomation()} disabled={isAutomationSaving}>Simpan Automation</Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Daftar Rule</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {automations.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada automation.</p> : null}
                    {automations.map((item) => (
                      <div key={item.id} className="rounded-xl border border-border/60 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{item.trigger} · delay {item.delayMinutes}m</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch checked={item.enabled} onCheckedChange={(next) => void toggleAutomation(item.id, next)} />
                            <Button size="sm" variant="outline" onClick={() => void removeAutomation(item.id)}>Hapus</Button>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">Condition: {item.conditions[0]?.type ?? "-"} {item.conditions[0]?.operator ?? ""} {item.conditions[0]?.value ?? ""}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Action: {item.actions[0]?.type ?? "-"}
                          {item.actions[0]?.type === "SEND_AI_REPLY" ? " (AI Dynamic Reply)" : ""}
                          {" | "}
                          {item.actions[0]?.payloadJson ?? "{}"}
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </>
            ) : null}

            {activeTab === "settings" && config ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">AI Runtime Settings</CardTitle>
                  <CardDescription>Kontrol guardrail utama untuk MVP.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl border border-border/60 p-3">
                    <div>
                      <p className="text-sm font-semibold">Stop AI jika CS reply</p>
                      <p className="text-xs text-muted-foreground">Jika aktif, AI tidak lanjut reply setelah takeover manusia.</p>
                    </div>
                    <Switch checked={config.stopIfHumanReply} onCheckedChange={(next) => void saveConfig({ stopIfHumanReply: next })} disabled={isSavingConfig} />
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-border/60 p-3">
                    <div>
                      <p className="text-sm font-semibold">Multi bubble message</p>
                      <p className="text-xs text-muted-foreground">Pisah response AI menjadi beberapa bubble (flag konfigurasi).</p>
                    </div>
                    <Switch checked={config.multiBubbleReply} onCheckedChange={(next) => void saveConfig({ multiBubbleReply: next })} disabled={isSavingConfig} />
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Typing Delay (ms)</Label>
                      <Input type="number" value={config.typingDelayMs} onChange={(event) => setConfig({ ...config, typingDelayMs: Number(event.target.value || "0") })} />
                      <Button size="sm" variant="outline" onClick={() => void saveConfig({ typingDelayMs: config.typingDelayMs })} disabled={isSavingConfig}>Simpan Delay</Button>
                    </div>
                    <div className="space-y-2">
                      <Label>Confidence Threshold</Label>
                      <Input type="number" min={0} max={100} value={config.confidenceThreshold} onChange={(event) => setConfig({ ...config, confidenceThreshold: Number(event.target.value || "0") })} />
                      <Button size="sm" variant="outline" onClick={() => void saveConfig({ confidenceThreshold: config.confidenceThreshold })} disabled={isSavingConfig}>Simpan Threshold</Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="space-y-2 md:col-span-2">
                      <Label>Model Free</Label>
                      <Input value={config.modelFree} onChange={(event) => setConfig({ ...config, modelFree: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Model Tier</Label>
                      <Select value={config.activeModelTier} onValueChange={(value) => setConfig({ ...config, activeModelTier: value })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="FREE">FREE</SelectItem>
                          <SelectItem value="PAID">PAID</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Model Paid</Label>
                    <Input value={config.modelPaid} onChange={(event) => setConfig({ ...config, modelPaid: event.target.value })} />
                  </div>

                  <Button onClick={() => void saveConfig({ modelFree: config.modelFree, modelPaid: config.modelPaid, activeModelTier: config.activeModelTier })} disabled={isSavingConfig}>Simpan Model Settings</Button>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

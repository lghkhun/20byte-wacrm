import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  bindWaitForConnectionUpdate,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  isHostedLidUser,
  isJidGroup,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAVersion,
  type WASocket,
  type WAMessage
} from "baileys";

import { publishConversationTypingEvent } from "@/lib/ably/publisher";
import { prisma } from "@/lib/db/prisma";
import { canAccessOrganizationSettings } from "@/lib/permissions/orgPermissions";
import { normalizePossibleE164 } from "@/lib/whatsapp/e164";
import { assertOrgBillingAccess } from "@/server/services/billingService";
import { processBaileysOutboundStatusUpdate } from "@/server/services/message/baileysOutboundStatus";
import { storeExternalOutboundMessage } from "@/server/services/message/externalOutbound";
import { storeInboundMessage } from "@/server/services/message/inbound";
import { ServiceError } from "@/server/services/serviceError";
import { writeAuditLogSafe } from "@/server/services/auditLogService";

type BaileysConnectionStatus = "DISCONNECTED" | "CONNECTING" | "PAIRING" | "CONNECTED" | "ERROR";

type ConnectedAccountSummary = {
  id: string;
  displayPhone: string;
  phoneNumberId: string;
  connectedAt: Date;
};

type PairingCodeResult = {
  orgId: string;
  connectionStatus: BaileysConnectionStatus;
  pairingCode: string;
  expiresInSeconds: number;
};

type ConnectionContext = {
  orgId: string;
  provider: "BAILEYS";
  connectionStatus: BaileysConnectionStatus;
  lastError: string | null;
  qrCode: string | null;
  qrCodeExpiresAt: Date | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: Date | null;
  connectedAccount: ConnectedAccountSummary | null;
};

type BaileysAccountReport = {
  connectedAccount: ConnectedAccountSummary | null;
  metrics: {
    incomingToday: number;
    outgoingToday: number;
    failedToday: number;
    broadcastMonth: number;
  };
  agentActivity: Array<{
    memberId: string;
    agentName: string;
    role: string;
    messagesSent: number;
    performance: string;
  }>;
  technical: {
    sessionId: string;
    connectedSince: string | null;
    uptimeLabel: string;
    status: BaileysConnectionStatus;
    lastError: string | null;
  };
};

type SessionEntry = {
  orgId: string;
  socket: WASocket | null;
  status: BaileysConnectionStatus;
  lastError: string | null;
  qrCode: string | null;
  qrCodeExpiresAt: Date | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: Date | null;
  initPromise: Promise<WASocket> | null;
  allowReconnect: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

const BAILEYS_PAIRING_TTL_MS = 3 * 60 * 1000;
const BAILEYS_QR_TTL_MS = 60 * 1000;
const BAILEYS_QR_GENERATION_TIMEOUT_MS = 30 * 1000;
const BAILEYS_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BAILEYS_RECONNECT_BASE_DELAY_MS = 1_000;
const BAILEYS_RECONNECT_MAX_DELAY_MS = 30_000;
const BAILEYS_TYPING_EVENT_TTL_MS = 6_000;
const DEBUG_BAILEYS_INBOUND = process.env.DEBUG_BAILEYS_INBOUND === "1";
const BAILEYS_RUNTIME_DIR = path.join(process.cwd(), ".runtime");
const BAILEYS_AUTH_DIR = path.join(BAILEYS_RUNTIME_DIR, "baileys-auth");
const BAILEYS_MEDIA_DIR = path.join(BAILEYS_RUNTIME_DIR, "baileys-media");

declare global {
  var __twentyByteBaileysSessions: Map<string, SessionEntry> | undefined;
  var __twentyByteBaileysVersionCache:
    | {
        version: WAVersion;
        expiresAt: number;
      }
    | undefined;
  var __twentyByteBaileysBootstrapStarted: boolean | undefined;
  var __twentyByteBaileysTypingCache: Map<string, { isTyping: boolean; expiresAt: number }> | undefined;
  var __twentyByteBaileysConversationByPhoneCache: Map<string, { conversationId: string; expiresAt: number }> | undefined;
  var __twentyByteBaileysPhoneByChatJidCache: Map<string, { phoneE164: string; expiresAt: number }> | undefined;
  var __twentyByteBaileysGroupSubjectCache: Map<string, { subject: string; expiresAt: number }> | undefined;
}

function getTypingCache(): Map<string, { isTyping: boolean; expiresAt: number }> {
  if (!globalThis.__twentyByteBaileysTypingCache) {
    globalThis.__twentyByteBaileysTypingCache = new Map();
  }
  return globalThis.__twentyByteBaileysTypingCache;
}

function getConversationByPhoneCache(): Map<string, { conversationId: string; expiresAt: number }> {
  if (!globalThis.__twentyByteBaileysConversationByPhoneCache) {
    globalThis.__twentyByteBaileysConversationByPhoneCache = new Map();
  }
  return globalThis.__twentyByteBaileysConversationByPhoneCache;
}

function getPhoneByChatJidCache(): Map<string, { phoneE164: string; expiresAt: number }> {
  if (!globalThis.__twentyByteBaileysPhoneByChatJidCache) {
    globalThis.__twentyByteBaileysPhoneByChatJidCache = new Map();
  }
  return globalThis.__twentyByteBaileysPhoneByChatJidCache;
}

function getGroupSubjectCache(): Map<string, { subject: string; expiresAt: number }> {
  if (!globalThis.__twentyByteBaileysGroupSubjectCache) {
    globalThis.__twentyByteBaileysGroupSubjectCache = new Map();
  }
  return globalThis.__twentyByteBaileysGroupSubjectCache;
}

function getSessionsStore(): Map<string, SessionEntry> {
  if (!globalThis.__twentyByteBaileysSessions) {
    globalThis.__twentyByteBaileysSessions = new Map();
  }

  return globalThis.__twentyByteBaileysSessions;
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim();
}

function getSessionEntry(orgId: string): SessionEntry {
  const sessions = getSessionsStore();
  const existing = sessions.get(orgId);
  if (existing) {
    return existing;
  }

  const created: SessionEntry = {
    orgId,
    socket: null,
    status: "DISCONNECTED",
    lastError: null,
    qrCode: null,
    qrCodeExpiresAt: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    initPromise: null,
    allowReconnect: true,
    reconnectAttempts: 0,
    reconnectTimer: null
  };
  sessions.set(orgId, created);
  return created;
}

function clearReconnectTimer(entry: SessionEntry): void {
  if (!entry.reconnectTimer) {
    return;
  }

  clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = null;
}

function scheduleReconnect(orgId: string, reason: string): void {
  const entry = getSessionEntry(orgId);
  if (!entry.allowReconnect) {
    return;
  }

  if (entry.reconnectTimer) {
    return;
  }

  const nextAttempt = Math.min(entry.reconnectAttempts + 1, 8);
  const delayMs = Math.min(BAILEYS_RECONNECT_BASE_DELAY_MS * 2 ** (nextAttempt - 1), BAILEYS_RECONNECT_MAX_DELAY_MS);
  entry.reconnectAttempts = nextAttempt;

  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (!entry.allowReconnect) {
      return;
    }

    void ensureBaileysSocket(orgId, true)
      .then(() => {
        const latest = getSessionEntry(orgId);
        latest.reconnectAttempts = 0;
      })
      .catch((error) => {
        const latest = getSessionEntry(orgId);
        latest.lastError = error instanceof Error ? error.message : "Failed to reconnect WhatsApp session.";
        scheduleReconnect(orgId, "retry-after-failure");
      });
  }, delayMs);

  entry.lastError = `Reconnecting WhatsApp session (${reason}) in ${Math.round(delayMs / 1000)}s.`;
}

function getAuthFolder(orgId: string): string {
  return path.join(BAILEYS_AUTH_DIR, orgId);
}

function getMediaFolder(orgId: string): string {
  return path.join(BAILEYS_MEDIA_DIR, orgId);
}

function isSocketOpen(socket: WASocket | null): boolean {
  return Boolean(socket?.ws?.isOpen);
}

function isSocketConnecting(socket: WASocket | null): boolean {
  return Boolean(socket?.ws?.isConnecting);
}

async function getPreferredBaileysVersion(): Promise<WAVersion | undefined> {
  const cache = globalThis.__twentyByteBaileysVersionCache;
  if (cache && cache.expiresAt > Date.now()) {
    return cache.version;
  }

  try {
    const latest = await fetchLatestWaWebVersion();
    globalThis.__twentyByteBaileysVersionCache = {
      version: latest.version,
      expiresAt: Date.now() + BAILEYS_VERSION_CACHE_TTL_MS
    };
    return latest.version;
  } catch {
    return cache?.version;
  }
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function requireSettingsAccess(userId: string, orgId: string): Promise<void> {
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId
      }
    },
    select: {
      role: true
    }
  });

  if (!membership) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }

  if (!canAccessOrganizationSettings(membership.role)) {
    throw new ServiceError(403, "FORBIDDEN_SETTINGS_ACCESS", "Your role cannot manage WhatsApp settings.");
  }

  await assertOrgBillingAccess(orgId, "write");
}

async function getConnectedAccount(orgId: string): Promise<ConnectedAccountSummary | null> {
  return prisma.waAccount.findFirst({
    where: {
      orgId,
      metaBusinessId: "baileys",
      wabaId: "baileys"
    },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      displayPhone: true,
      phoneNumberId: true,
      connectedAt: true
    }
  });
}

async function hasUsableStoredAuth(orgId: string): Promise<boolean> {
  try {
    const credsStats = await stat(path.join(getAuthFolder(orgId), "creds.json"));
    return credsStats.isFile() && credsStats.size > 0;
  } catch {
    return false;
  }
}

async function markStoredAuthAsDisconnected(
  orgId: string,
  reason: string,
  options?: { clearRuntimeFiles?: boolean }
): Promise<void> {
  const entry = getSessionEntry(orgId);
  entry.socket = null;
  entry.initPromise = null;
  entry.allowReconnect = false;
  clearReconnectTimer(entry);
  entry.reconnectAttempts = 0;
  entry.status = "DISCONNECTED";
  entry.lastError = reason;
  entry.qrCode = null;
  entry.qrCodeExpiresAt = null;
  entry.pairingCode = null;
  entry.pairingCodeExpiresAt = null;
  await clearConnectedAccount(orgId);
  if (options?.clearRuntimeFiles) {
    await clearRuntimeFiles(orgId);
  }
}

async function pruneInvalidStoredAuth(): Promise<void> {
  try {
    const entries = await readdir(BAILEYS_AUTH_DIR, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          if (await hasUsableStoredAuth(entry.name)) {
            return;
          }

          await clearRuntimeFiles(entry.name);
        })
    );
  } catch {
    // Ignore runtime cleanup failures; reconnect flow can still recover per org.
  }
}

async function bootstrapConnectedBaileysSessions(): Promise<void> {
  if (globalThis.__twentyByteBaileysBootstrapStarted) {
    return;
  }
  globalThis.__twentyByteBaileysBootstrapStarted = true;

  try {
    await pruneInvalidStoredAuth();
    const accounts = await prisma.waAccount.findMany({
      where: {
        metaBusinessId: "baileys",
        wabaId: "baileys"
      },
      select: {
        orgId: true
      }
    });

    const uniqueOrgIds = Array.from(new Set(accounts.map((item) => item.orgId).filter(Boolean)));
    uniqueOrgIds.forEach((orgId, index) => {
      setTimeout(() => {
        void (async () => {
          if (!(await hasUsableStoredAuth(orgId))) {
            await markStoredAuthAsDisconnected(
              orgId,
              "Stored WhatsApp credentials are missing or invalid. Reconnect from Settings.",
              { clearRuntimeFiles: true }
            );
            return;
          }

          await ensureBaileysSocket(orgId);
        })().catch((error) => {
          const entry = getSessionEntry(orgId);
          entry.lastError = error instanceof Error ? error.message : "Failed to bootstrap WhatsApp session.";
          scheduleReconnect(orgId, "bootstrap-failed");
        });
      }, index * 500);
    });
  } catch {
    // Ignore bootstrap failure; runtime operations can still trigger reconnect lazily.
  }
}

function extractDigits(raw: string | undefined): string {
  return normalize(raw).replace(/\D/g, "");
}

function formatDisplayPhone(digits: string): string {
  return digits ? `+${digits}` : "Connected via Baileys";
}

function extractJidUserPart(jid: string): string {
  const localPart = jid.split("@")[0] ?? "";
  return localPart.split(":")[0] ?? localPart;
}

async function readReverseLidMappingDigits(orgId: string, lidUserDigits: string): Promise<string | null> {
  const normalizedLidUserDigits = extractDigits(lidUserDigits);
  if (!normalizedLidUserDigits) {
    return null;
  }

  const mappingPath = path.join(getAuthFolder(orgId), `lid-mapping-${normalizedLidUserDigits}_reverse.json`);
  try {
    const raw = await readFile(mappingPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "string") {
      return null;
    }
    const mappedDigits = extractDigits(parsed);
    return mappedDigits || null;
  } catch {
    return null;
  }
}

async function readForwardLidMappingDigits(orgId: string, phoneDigits: string): Promise<string | null> {
  const normalizedPhoneDigits = extractDigits(phoneDigits);
  if (!normalizedPhoneDigits) {
    return null;
  }

  const mappingPath = path.join(getAuthFolder(orgId), `lid-mapping-${normalizedPhoneDigits}.json`);
  try {
    const raw = await readFile(mappingPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "string") {
      return null;
    }
    const mappedDigits = extractDigits(parsed);
    return mappedDigits || null;
  } catch {
    return null;
  }
}

async function resolvePnJidFromLid(orgId: string, lidJid: string, socket: WASocket): Promise<string | null> {
  const normalizedLidJid = jidNormalizedUser(lidJid);
  if (!normalizedLidJid || (!isLidUser(normalizedLidJid) && !isHostedLidUser(normalizedLidJid))) {
    return null;
  }

  try {
    const mappedPnJid = normalize(await socket.signalRepository.lidMapping.getPNForLID(normalizedLidJid) ?? undefined);
    const normalizedMappedPnJid = jidNormalizedUser(mappedPnJid || undefined);
    if (normalizedMappedPnJid && normalizedMappedPnJid.endsWith("@s.whatsapp.net")) {
      return normalizedMappedPnJid;
    }
  } catch {
    // fallback to local auth mapping files below
  }

  const lidUserDigits = extractDigits(extractJidUserPart(normalizedLidJid));
  const mappedPnDigits = await readReverseLidMappingDigits(orgId, lidUserDigits);
  if (!mappedPnDigits) {
    return null;
  }

  return `${mappedPnDigits}@s.whatsapp.net`;
}

async function resolveCustomerPhoneE164ForInboundJid(orgId: string, remoteJid: string, socket: WASocket): Promise<string | null> {
  const normalizedRemoteJid = jidNormalizedUser(remoteJid);
  if (!normalizedRemoteJid) {
    return null;
  }

  let sourceJid = normalizedRemoteJid;
  if (isLidUser(normalizedRemoteJid) || isHostedLidUser(normalizedRemoteJid)) {
    const mappedPnJid = await resolvePnJidFromLid(orgId, normalizedRemoteJid, socket);
    if (!mappedPnJid) {
      return null;
    }
    sourceJid = mappedPnJid;
  }

  const sourceDigits = extractDigits(extractJidUserPart(sourceJid));
  if (!sourceDigits) {
    return null;
  }

  if (!isLidUser(sourceJid) && !isHostedLidUser(sourceJid)) {
    const mappedPnJid = await resolvePnJidFromLid(orgId, `${sourceDigits}@lid`, socket);
    if (mappedPnJid) {
      const mappedDigits = extractDigits(extractJidUserPart(mappedPnJid));
      const normalizedMapped = normalizePossibleE164(mappedDigits);
      if (normalizedMapped) {
        return normalizedMapped;
      }
    }
  }

  const reverseMappedDigits = await readReverseLidMappingDigits(orgId, sourceDigits);
  const normalizedDigits = reverseMappedDigits && reverseMappedDigits !== sourceDigits ? reverseMappedDigits : sourceDigits;
  return normalizePossibleE164(normalizedDigits);
}

function toStablePseudoGroupPhoneE164(remoteJid: string): string {
  const normalized = normalize(remoteJid);
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) % 10_000_000_000;
  }
  const digits = String(hash).padStart(10, "0");
  return `+999${digits}`;
}

async function resolveCustomerPhoneByChatJid(orgId: string, chatJid: string): Promise<string | null> {
  const normalizedChatJid = jidNormalizedUser(chatJid);
  if (!normalizedChatJid) {
    return null;
  }

  const cache = getPhoneByChatJidCache();
  const cacheKey = `${orgId}:${normalizedChatJid}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.phoneE164;
  }

  const row = await prisma.conversation.findFirst({
    where: {
      orgId,
      waChatJid: normalizedChatJid
    },
    select: {
      customer: {
        select: {
          phoneE164: true
        }
      }
    }
  });

  const phoneE164 = row?.customer.phoneE164 ?? null;
  if (phoneE164) {
    cache.set(cacheKey, {
      phoneE164,
      expiresAt: Date.now() + 5 * 60_000
    });
  }

  return phoneE164;
}

function extractQuotedContext(content: WAMessage["message"]): { replyToWaMessageId?: string; replyPreviewText?: string } {
  const normalized = unwrapMessageContent(content);
  if (!normalized) {
    return {};
  }

  const contextInfo =
    normalized.extendedTextMessage?.contextInfo ??
    normalized.imageMessage?.contextInfo ??
    normalized.videoMessage?.contextInfo ??
    normalized.audioMessage?.contextInfo ??
    normalized.documentMessage?.contextInfo;

  const replyToWaMessageId = normalize(contextInfo?.stanzaId ?? undefined);
  if (!replyToWaMessageId) {
    return {};
  }

  const quotedKind = resolveMessageKind(contextInfo?.quotedMessage as WAMessage["message"] | undefined);
  const replyPreviewText = normalize(
    quotedKind.text ??
      (quotedKind.type === "IMAGE"
        ? "Foto"
        : quotedKind.type === "VIDEO"
          ? "Video"
          : quotedKind.type === "AUDIO"
            ? "Audio"
            : quotedKind.type === "DOCUMENT"
              ? "Dokumen"
              : "Pesan")
  );

  return {
    replyToWaMessageId,
    replyPreviewText: replyPreviewText || undefined
  };
}

async function resolveGroupDisplayName(remoteJid: string, socket: WASocket): Promise<string | undefined> {
  const normalizedRemoteJid = jidNormalizedUser(remoteJid);
  if (!normalizedRemoteJid || !isJidGroup(normalizedRemoteJid)) {
    return undefined;
  }

  const cache = getGroupSubjectCache();
  const cached = cache.get(normalizedRemoteJid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.subject;
  }

  try {
    const metadata = await socket.groupMetadata(normalizedRemoteJid);
    const subject = normalize(metadata?.subject ?? undefined);
    if (!subject) {
      return undefined;
    }
    cache.set(normalizedRemoteJid, {
      subject,
      expiresAt: Date.now() + 5 * 60_000
    });
    return subject;
  } catch {
    return undefined;
  }
}

async function resolveOutboundDestinationJid(
  orgId: string,
  toPhoneE164: string,
  socket: WASocket,
  preferredJid?: string
): Promise<string> {
  const normalizedPreferredJid = jidNormalizedUser(preferredJid ?? undefined);
  if (normalizedPreferredJid) {
    if (isLidUser(normalizedPreferredJid) || isHostedLidUser(normalizedPreferredJid)) {
      const mappedPnJid = await resolvePnJidFromLid(orgId, normalizedPreferredJid, socket);
      if (mappedPnJid) {
        return mappedPnJid;
      }
    } else {
      return normalizedPreferredJid;
    }
  }

  const directJid = toJid(toPhoneE164);
  const destinationDigits = extractDigits(toPhoneE164);
  if (!destinationDigits) {
    return directJid;
  }

  const forwardMappedDigits = await readForwardLidMappingDigits(orgId, destinationDigits);
  if (forwardMappedDigits && forwardMappedDigits !== destinationDigits) {
    const forwardMappedJid = `${forwardMappedDigits}@s.whatsapp.net`;
    if (DEBUG_BAILEYS_INBOUND) {
      console.info(`[baileys] outbound mapped-forward-lid org=${orgId} from=${directJid} to=${forwardMappedJid}`);
    }
    return forwardMappedJid;
  }

  const reverseMappedDigits = await readReverseLidMappingDigits(orgId, destinationDigits);
  if (reverseMappedDigits && reverseMappedDigits !== destinationDigits) {
    const reverseMappedJid = `${reverseMappedDigits}@s.whatsapp.net`;
    if (DEBUG_BAILEYS_INBOUND) {
      console.info(`[baileys] outbound reverse-mapped-lid org=${orgId} from=${directJid} to=${reverseMappedJid}`);
    }
    return reverseMappedJid;
  }

  const mappedPnJid = await resolvePnJidFromLid(orgId, `${destinationDigits}@lid`, socket);
  if (mappedPnJid && mappedPnJid !== directJid) {
    if (DEBUG_BAILEYS_INBOUND) {
      console.info(`[baileys] outbound remapped-lid org=${orgId} from=${directJid} to=${mappedPnJid}`);
    }
    return mappedPnJid;
  }

  return directJid;
}

function unwrapMessageContent(message: WAMessage["message"]): WAMessage["message"] {
  if (!message) {
    return message;
  }

  if ("ephemeralMessage" in message && message.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }

  if ("viewOnceMessage" in message && message.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }

  if ("viewOnceMessageV2" in message && message.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }

  if ("documentWithCaptionMessage" in message && message.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(message.documentWithCaptionMessage.message);
  }

  return message;
}

function resolveMessageKind(content: WAMessage["message"]): {
  type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | null;
  text?: string;
  mimeType?: string;
  fileName?: string;
  fileLength?: number;
  durationSec?: number;
} {
  const normalized = unwrapMessageContent(content);
  if (!normalized) {
    return { type: null };
  }

  if (typeof normalized.conversation === "string" && normalized.conversation.trim()) {
    return { type: "TEXT", text: normalized.conversation.trim() };
  }

  if (normalized.extendedTextMessage?.text?.trim()) {
    return { type: "TEXT", text: normalized.extendedTextMessage.text.trim() };
  }

  if (normalized.imageMessage) {
    return {
      type: "IMAGE",
      text: normalize(normalized.imageMessage.caption ?? undefined),
      mimeType: normalize(normalized.imageMessage.mimetype ?? "image/jpeg"),
      fileName: "image",
      fileLength: Number(normalized.imageMessage.fileLength ?? 0) || undefined
    };
  }

  if (normalized.videoMessage) {
    return {
      type: "VIDEO",
      text: normalize(normalized.videoMessage.caption ?? undefined),
      mimeType: normalize(normalized.videoMessage.mimetype ?? "video/mp4"),
      fileName: "video",
      fileLength: Number(normalized.videoMessage.fileLength ?? 0) || undefined,
      durationSec: Number(normalized.videoMessage.seconds ?? 0) || undefined
    };
  }

  if (normalized.audioMessage) {
    return {
      type: "AUDIO",
      mimeType: normalize(normalized.audioMessage.mimetype ?? "audio/ogg"),
      fileName: "audio",
      fileLength: Number(normalized.audioMessage.fileLength ?? 0) || undefined,
      durationSec: Number(normalized.audioMessage.seconds ?? 0) || undefined
    };
  }

  if (normalized.documentMessage) {
    return {
      type: "DOCUMENT",
      text: normalize(normalized.documentMessage.caption ?? undefined),
      mimeType: normalize(normalized.documentMessage.mimetype ?? "application/octet-stream"),
      fileName: normalize(normalized.documentMessage.fileName ?? "document"),
      fileLength: Number(normalized.documentMessage.fileLength ?? 0) || undefined
    };
  }

  if (normalized.stickerMessage) {
    return {
      type: "IMAGE",
      mimeType: normalize(normalized.stickerMessage.mimetype ?? "image/webp"),
      fileName: "sticker",
      fileLength: Number(normalized.stickerMessage.fileLength ?? 0) || undefined
    };
  }

  return { type: null };
}

function toMediaExtension(mimeType: string | undefined, fallback: string): string {
  const normalized = normalize(mimeType).toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("pdf")) return "pdf";
  return fallback;
}

function startOfLocalDay(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalMonth(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatUptimeLabel(connectedAt: Date | null, status: BaileysConnectionStatus): string {
  if (!connectedAt || status !== "CONNECTED") {
    return "Not connected";
  }

  const diffMs = Math.max(0, Date.now() - connectedAt.getTime());
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${Math.max(1, minutes)}m`;
}

function toPerformanceLabel(messagesSent: number): string {
  if (messagesSent >= 100) return "High";
  if (messagesSent >= 25) return "Active";
  if (messagesSent > 0) return "Light";
  return "Idle";
}

async function downloadInboundMedia(orgId: string, message: WAMessage, mimeType?: string): Promise<{
  mediaPath: string;
  mediaUrl: string;
}> {
  const mediaFolder = getMediaFolder(orgId);
  await ensureDirectory(mediaFolder);

  const extension = toMediaExtension(mimeType, "bin");
  const fileName = `${Date.now()}-${randomUUID()}.${extension}`;
  const diskPath = path.join(mediaFolder, fileName);
  const mediaBuffer = await downloadMediaMessage(message, "buffer", {});
  await writeFile(diskPath, mediaBuffer);

  return {
    mediaPath: fileName,
    mediaUrl: `/api/media/${encodeURIComponent(orgId)}/${encodeURIComponent(fileName)}`
  };
}

export async function storeBaileysMediaBuffer(input: {
  orgId: string;
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
}): Promise<{
  mediaPath: string;
  mediaUrl: string;
}> {
  const mediaFolder = getMediaFolder(input.orgId);
  await ensureDirectory(mediaFolder);

  const rawExtension = path.extname(input.fileName).toLowerCase().replace(".", "");
  const extension = rawExtension || toMediaExtension(input.mimeType, "bin");
  const safeBaseName = path.basename(input.fileName, path.extname(input.fileName)).replace(/[^a-zA-Z0-9_-]/g, "-") || "upload";
  const fileName = `${Date.now()}-${safeBaseName}-${randomUUID()}.${extension}`;
  const diskPath = path.join(mediaFolder, fileName);

  await writeFile(diskPath, input.buffer);

  return {
    mediaPath: fileName,
    mediaUrl: `/api/media/${encodeURIComponent(input.orgId)}/${encodeURIComponent(fileName)}`
  };
}

async function persistConnectedAccount(orgId: string, socket: WASocket): Promise<void> {
  const normalizedJid = jidNormalizedUser(socket.user?.id ?? undefined);
  const phoneDigits = extractDigits(normalizedJid.split("@")[0]);
  const displayPhone = formatDisplayPhone(phoneDigits);
  const placeholderValue = "baileys-session";

  await prisma.waAccount.upsert({
    where: {
      orgId
    },
    create: {
      orgId,
      metaBusinessId: "baileys",
      wabaId: "baileys",
      phoneNumberId: phoneDigits || `baileys-${orgId}`,
      displayPhone,
      accessTokenEnc: placeholderValue,
      connectedAt: new Date()
    },
    update: {
      metaBusinessId: "baileys",
      wabaId: "baileys",
      phoneNumberId: phoneDigits || `baileys-${orgId}`,
      displayPhone,
      accessTokenEnc: placeholderValue,
      connectedAt: new Date()
    }
  });
}

async function clearConnectedAccount(orgId: string): Promise<void> {
  await prisma.waAccount.deleteMany({
    where: {
      orgId
    }
  });
}

async function clearRuntimeFiles(orgId: string): Promise<void> {
  await Promise.all([
    rm(getAuthFolder(orgId), { recursive: true, force: true }),
    rm(getMediaFolder(orgId), { recursive: true, force: true })
  ]);
}

async function resetBaileysLinkState(orgId: string): Promise<void> {
  const entry = getSessionEntry(orgId);
  entry.allowReconnect = false;
  clearReconnectTimer(entry);
  entry.reconnectAttempts = 0;
  if (entry.socket) {
    try {
      entry.socket.end(undefined);
    } catch {
      // ignore
    }
  }

  entry.socket = null;
  entry.status = "DISCONNECTED";
  entry.lastError = null;
  entry.qrCode = null;
  entry.qrCodeExpiresAt = null;
  entry.pairingCode = null;
  entry.pairingCodeExpiresAt = null;
  entry.initPromise = null;
  entry.allowReconnect = true;

  await clearRuntimeFiles(orgId);
}

async function processInboundMessage(orgId: string, message: WAMessage, socket: WASocket): Promise<void> {
  const remoteJid = jidNormalizedUser(message.key.remoteJid ?? undefined);
  if (!remoteJid || isJidStatusBroadcast(remoteJid)) {
    return;
  }
  const isFromMe = Boolean(message.key.fromMe);
  const isGroupChat = isJidGroup(remoteJid);

  const quotedContext = extractQuotedContext(message.message);
  const resolvedByChatJid = await resolveCustomerPhoneByChatJid(orgId, remoteJid);
  const customerPhoneE164 =
    resolvedByChatJid ??
    (isGroupChat
      ? toStablePseudoGroupPhoneE164(remoteJid)
      : await resolveCustomerPhoneE164ForInboundJid(orgId, remoteJid, socket));
  if (!customerPhoneE164) {
    if (DEBUG_BAILEYS_INBOUND) {
      console.info(`[baileys] inbound ignored-unresolved-phone org=${orgId} remoteJid=${remoteJid}`);
    }
    return;
  }

  let customerAvatarUrl: string | undefined;
  try {
    customerAvatarUrl = normalize(await socket.profilePictureUrl(remoteJid, "image"));
  } catch {
    customerAvatarUrl = undefined;
  }

  const kind = resolveMessageKind(message.message);
  if (!kind.type) {
    return;
  }
  const referralMeta = extractReferralMeta(message);
  const waAccountMeta = await prisma.waAccount.findUnique({
    where: {
      orgId
    },
    select: {
      wabaId: true
    }
  });
  const wabaId = normalize(waAccountMeta?.wabaId ?? undefined);

  const participantJid = normalize(
    (message.key as { participant?: string | null } | undefined)?.participant ?? undefined
  );
  const senderWaJid = isGroupChat ? participantJid ?? remoteJid : remoteJid;
  const senderPhoneE164 = isGroupChat
    ? (participantJid ? await resolveCustomerPhoneE164ForInboundJid(orgId, participantJid, socket) : undefined)
    : customerPhoneE164;
  const senderDisplayName = normalize(message.pushName ?? undefined) ?? senderPhoneE164;

  let mediaPath: string | undefined;
  let mediaUrl: string | undefined;
  if (kind.type !== "TEXT") {
    try {
      const downloaded = await downloadInboundMedia(orgId, message, kind.mimeType);
      mediaPath = downloaded.mediaPath;
      mediaUrl = downloaded.mediaUrl;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown download error";
      console.error(`[baileys] failed to download media for org ${orgId}: ${errorMessage}`);
    }
  }

  const waMessageId = normalize(message.key.id ?? undefined);
  if (!waMessageId) {
    return;
  }

  if (isFromMe) {
    const outboundCustomerDisplayName = isGroupChat
      ? normalize((await resolveGroupDisplayName(remoteJid, socket)) ?? undefined)
      : undefined;
    const outboundResult = await storeExternalOutboundMessage({
      orgId,
      customerPhoneE164,
      waChatJid: remoteJid,
      customerDisplayName: outboundCustomerDisplayName,
      customerAvatarUrl,
      senderWaJid: senderWaJid ?? undefined,
      senderPhoneE164: senderPhoneE164 ?? undefined,
      senderDisplayName: senderDisplayName ?? undefined,
      waMessageId,
      replyToWaMessageId: quotedContext.replyToWaMessageId,
      replyPreviewText: quotedContext.replyPreviewText,
      type: kind.type,
      text: kind.text,
      mediaId: mediaPath,
      mediaUrl,
      mimeType: kind.mimeType,
      fileName: kind.fileName,
      fileSize: kind.fileLength,
      durationSec: kind.durationSec
    });

    if (DEBUG_BAILEYS_INBOUND && !outboundResult.stored) {
      const reason = outboundResult.duplicate ? "duplicate" : "ignored";
      console.info(`[baileys] outbound-from-device ${reason} org=${orgId} waMessageId=${waMessageId || "-"} remoteJid=${remoteJid}`);
    }
    return;
  }

  const inboundResult = await storeInboundMessage({
    orgId,
    customerPhoneE164,
    waChatJid: remoteJid,
    customerDisplayName: normalize((await resolveGroupDisplayName(remoteJid, socket)) ?? message.pushName ?? undefined),
    customerAvatarUrl,
    senderWaJid: senderWaJid ?? undefined,
    senderPhoneE164: senderPhoneE164 ?? undefined,
    senderDisplayName: senderDisplayName ?? undefined,
    ctwaClid: referralMeta.ctwaClid ?? undefined,
    fbclid: referralMeta.fbclid ?? undefined,
    fbc: referralMeta.fbc ?? undefined,
    fbp: referralMeta.fbp ?? undefined,
    wabaId: wabaId || undefined,
    waMessageId,
    replyToWaMessageId: quotedContext.replyToWaMessageId,
    replyPreviewText: quotedContext.replyPreviewText,
    type: kind.type,
    text: kind.text,
    mediaId: mediaPath,
    mediaUrl,
    mimeType: kind.mimeType,
    fileName: kind.fileName,
    fileSize: kind.fileLength,
    durationSec: kind.durationSec
  });

  if (DEBUG_BAILEYS_INBOUND && !inboundResult.stored) {
    const reason = inboundResult.duplicate ? "duplicate" : "ignored";
    console.info(`[baileys] inbound ${reason} org=${orgId} waMessageId=${waMessageId || "-"} remoteJid=${remoteJid}`);
  }
}

function normalizeReferralValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 191);
}

function extractReferralMeta(message: WAMessage): {
  ctwaClid: string | null;
  fbclid: string | null;
  fbc: string | null;
  fbp: string | null;
} {
  const seen = new Set<unknown>();
  let ctwaClid: string | null = null;
  let fbclid: string | null = null;
  let fbc: string | null = null;
  let fbp: string | null = null;

  function absorbUrl(rawUrl: string | null): void {
    if (!rawUrl) {
      return;
    }
    try {
      const url = new URL(rawUrl);
      fbclid = fbclid ?? normalizeReferralValue(url.searchParams.get("fbclid"));
      fbc = fbc ?? normalizeReferralValue(url.searchParams.get("fbc"));
      fbp = fbp ?? normalizeReferralValue(url.searchParams.get("fbp"));
    } catch {
      // ignore malformed URL
    }
  }

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    ctwaClid = ctwaClid ?? normalizeReferralValue(record.ctwa_clid ?? record.ctwaClid);
    fbclid = fbclid ?? normalizeReferralValue(record.fbclid);
    fbc = fbc ?? normalizeReferralValue(record.fbc);
    fbp = fbp ?? normalizeReferralValue(record.fbp);
    absorbUrl(normalizeReferralValue(record.source_url ?? record.sourceUrl));

    for (const item of Object.values(record)) {
      visit(item);
    }
  }

  visit(message);
  return {
    ctwaClid,
    fbclid,
    fbc,
    fbp
  };
}

async function processOutboundStatusUpdate(
  orgId: string,
  update: {
    key?: {
      id?: string | null;
      fromMe?: boolean | null;
    } | null;
    update?: {
      status?: number | null;
    } | null;
  }
): Promise<void> {
  const updated = await processBaileysOutboundStatusUpdate(orgId, update);
  if (!updated) {
    return;
  }
}

async function resolveOpenConversationIdByCustomerPhone(orgId: string, customerPhoneE164: string): Promise<string | null> {
  const cache = getConversationByPhoneCache();
  const cacheKey = `${orgId}:${customerPhoneE164}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.conversationId;
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      orgId,
      status: "OPEN",
      customer: {
        phoneE164: customerPhoneE164
      }
    },
    orderBy: [{ updatedAt: "desc" }, { lastMessageAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true
    }
  });

  if (!conversation) {
    return null;
  }

  cache.set(cacheKey, {
    conversationId: conversation.id,
    expiresAt: Date.now() + 60_000
  });
  return conversation.id;
}

async function processPresenceUpdate(
  orgId: string,
  update: {
    id: string;
    presences: Record<string, { lastKnownPresence: "unavailable" | "available" | "composing" | "recording" | "paused" }>;
  },
  socket: WASocket
): Promise<void> {
  const remoteJid = jidNormalizedUser(update.id ?? undefined);
  if (!remoteJid || isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
    return;
  }

  const customerPhoneE164 = await resolveCustomerPhoneE164ForInboundJid(orgId, remoteJid, socket);
  if (!customerPhoneE164) {
    return;
  }

  const isTyping = Object.values(update.presences ?? {}).some((presence) => {
    const state = presence?.lastKnownPresence;
    return state === "composing" || state === "recording";
  });

  const conversationId = await resolveOpenConversationIdByCustomerPhone(orgId, customerPhoneE164);
  if (!conversationId) {
    return;
  }

  const typingCache = getTypingCache();
  const cacheKey = `${orgId}:${conversationId}`;
  const cached = typingCache.get(cacheKey);
  const now = Date.now();
  const nextExpiresAt = now + BAILEYS_TYPING_EVENT_TTL_MS;

  if (cached && cached.isTyping === isTyping && cached.expiresAt > now) {
    return;
  }

  typingCache.set(cacheKey, { isTyping, expiresAt: nextExpiresAt });

  void publishConversationTypingEvent({
    orgId,
    conversationId,
    isTyping
  });
}

async function createSocketForOrg(orgId: string, entry: SessionEntry): Promise<WASocket> {
  await ensureDirectory(getAuthFolder(orgId));
  await ensureDirectory(getMediaFolder(orgId));

  const { state, saveCreds } = await useMultiFileAuthState(getAuthFolder(orgId));
  const version = await getPreferredBaileysVersion();
  const socket = makeWASocket({
    auth: state,
    browser: Browsers.macOS("20byte"),
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    syncFullHistory: false,
    version,
    getMessage: async () => undefined
  });

  entry.socket = socket;
  entry.status = state.creds.registered ? "CONNECTING" : "PAIRING";
  entry.lastError = null;
  entry.allowReconnect = true;

  socket.ev.on("creds.update", () => {
    void saveCreds();
  });

  socket.ev.on("connection.update", (update) => {
    if (entry.socket !== socket) {
      return;
    }

    const connection = update.connection;
    if (update.qr) {
      entry.status = "PAIRING";
      entry.qrCode = update.qr;
      entry.qrCodeExpiresAt = new Date(Date.now() + BAILEYS_QR_TTL_MS);
      entry.pairingCode = null;
      entry.pairingCodeExpiresAt = null;
    }

    if (connection === "connecting") {
      entry.status = state.creds.registered ? "CONNECTING" : "PAIRING";
      return;
    }

    if (connection === "open") {
      entry.status = "CONNECTED";
      entry.lastError = null;
      clearReconnectTimer(entry);
      entry.reconnectAttempts = 0;
      entry.qrCode = null;
      entry.qrCodeExpiresAt = null;
      entry.pairingCode = null;
      entry.pairingCodeExpiresAt = null;
      void persistConnectedAccount(orgId, socket);
      return;
    }

    if (connection === "close") {
      const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      entry.socket = null;

      if (statusCode === DisconnectReason.loggedOut) {
        entry.allowReconnect = false;
        entry.status = "DISCONNECTED";
        entry.lastError = "WhatsApp session logged out.";
        entry.qrCode = null;
        entry.qrCodeExpiresAt = null;
        entry.pairingCode = null;
        entry.pairingCodeExpiresAt = null;
        clearReconnectTimer(entry);
        entry.reconnectAttempts = 0;
        void clearConnectedAccount(orgId);
        void clearRuntimeFiles(orgId);
        return;
      }

      entry.status = "DISCONNECTED";
      entry.lastError = statusCode ? `Connection closed (${statusCode}).` : "Connection closed.";
      entry.qrCode = null;
      entry.qrCodeExpiresAt = null;
      entry.pairingCode = null;
      entry.pairingCodeExpiresAt = null;
      if (entry.allowReconnect) {
        scheduleReconnect(orgId, statusCode === DisconnectReason.restartRequired ? "restart-required" : "socket-closed");
      }
    }
  });

  socket.ev.on("messages.upsert", async (event) => {
    for (const message of event.messages ?? []) {
      try {
        await processInboundMessage(orgId, message, socket);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown inbound processing error";
        console.error(`[baileys] inbound processing failed for org ${orgId}: ${errorMessage}`);
      }
    }
  });

  socket.ev.on("messages.update", async (updates) => {
    for (const update of updates ?? []) {
      try {
        await processOutboundStatusUpdate(orgId, update);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown outbound status processing error";
        console.error(`[baileys] outbound status processing failed for org ${orgId}: ${errorMessage}`);
      }
    }
  });

  socket.ev.on("presence.update", async (presenceUpdate) => {
    try {
      await processPresenceUpdate(orgId, presenceUpdate, socket);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown presence processing error";
      console.error(`[baileys] presence update processing failed for org ${orgId}: ${errorMessage}`);
    }
  });

  return socket;
}

async function ensureBaileysSocket(orgId: string, forceRestart = false): Promise<WASocket> {
  const normalizedOrgId = normalize(orgId);
  if (!normalizedOrgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const entry = getSessionEntry(normalizedOrgId);
  if (forceRestart && entry.socket) {
    entry.allowReconnect = false;
    try {
      entry.socket.end(undefined);
    } catch {
      // ignore
    }
    entry.socket = null;
    entry.allowReconnect = true;
  }

  if (entry.socket && !forceRestart) {
    if (isSocketOpen(entry.socket) || isSocketConnecting(entry.socket) || entry.status === "PAIRING") {
      return entry.socket;
    }

    entry.socket = null;
  }

  if (entry.initPromise) {
    return entry.initPromise;
  }

  entry.initPromise = createSocketForOrg(normalizedOrgId, entry)
    .catch((error) => {
      entry.status = "ERROR";
      entry.lastError = error instanceof Error ? error.message : "Failed to initialize Baileys socket.";
      throw error;
    })
    .finally(() => {
      entry.initPromise = null;
    });

  return entry.initPromise;
}

export async function getBaileysConnectionContext(
  actorUserId: string,
  orgId: string,
  options?: { refresh?: boolean }
): Promise<ConnectionContext> {
  const normalizedOrgId = normalize(orgId);
  if (!normalizedOrgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  await requireSettingsAccess(actorUserId, normalizedOrgId);
  if (options?.refresh && !(await hasUsableStoredAuth(normalizedOrgId))) {
    await markStoredAuthAsDisconnected(
      normalizedOrgId,
      "Stored WhatsApp credentials are missing or invalid. Reconnect from Settings.",
      { clearRuntimeFiles: true }
    );
  }

  const connectedAccount = await getConnectedAccount(normalizedOrgId);
  if (options?.refresh && connectedAccount) {
    if (!(await hasUsableStoredAuth(normalizedOrgId))) {
      await markStoredAuthAsDisconnected(
        normalizedOrgId,
        "Stored WhatsApp credentials are missing or invalid. Reconnect from Settings.",
        { clearRuntimeFiles: true }
      );
    } else {
      try {
        await ensureConnectedSocketForOrg(normalizedOrgId);
      } catch {
        // surface latest state via entry.lastError
      }
    }
  }

  const entry = getSessionEntry(normalizedOrgId);
  return {
    orgId: normalizedOrgId,
    provider: "BAILEYS",
    connectionStatus: entry.status,
    lastError: entry.lastError,
    qrCode: entry.qrCode,
    qrCodeExpiresAt: entry.qrCodeExpiresAt,
    pairingCode: entry.pairingCode,
    pairingCodeExpiresAt: entry.pairingCodeExpiresAt,
    connectedAccount
  };
}

export async function startBaileysQrSession(input: {
  actorUserId: string;
  orgId: string;
}): Promise<{
  orgId: string;
  connectionStatus: BaileysConnectionStatus;
  qrCode: string;
  expiresInSeconds: number;
}> {
  const orgId = normalize(input.orgId);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  await requireSettingsAccess(input.actorUserId, orgId);
  const connectedAccount = await getConnectedAccount(orgId);
  if (connectedAccount) {
    const entry = getSessionEntry(orgId);
    if (entry.status === "CONNECTED") {
      return {
        orgId,
        connectionStatus: entry.status,
        qrCode: "ALREADY_CONNECTED",
        expiresInSeconds: 0
      };
    }
  }

  await resetBaileysLinkState(orgId);
  await ensureBaileysSocket(orgId, true);
  const entry = getSessionEntry(orgId);

  const deadline = Date.now() + BAILEYS_QR_GENERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (entry.qrCode) {
      return {
        orgId,
        connectionStatus: entry.status,
        qrCode: entry.qrCode,
        expiresInSeconds: Math.max(
          1,
          Math.floor(((entry.qrCodeExpiresAt?.getTime() ?? Date.now() + BAILEYS_QR_TTL_MS) - Date.now()) / 1000)
        )
      };
    }

    if (entry.status === "ERROR" && entry.lastError) {
      throw new ServiceError(500, "BAILEYS_QR_FAILED", entry.lastError);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new ServiceError(
    504,
    "BAILEYS_QR_TIMEOUT",
    entry.lastError ? `QR code was not generated in time. ${entry.lastError}` : "QR code was not generated in time. Please retry."
  );
}

export async function startBaileysPairing(input: {
  actorUserId: string;
  orgId: string;
  phoneNumber: string;
}): Promise<PairingCodeResult> {
  const orgId = normalize(input.orgId);
  const phoneNumber = extractDigits(input.phoneNumber);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!phoneNumber) {
    throw new ServiceError(400, "INVALID_PHONE_NUMBER", "Phone number is required to generate a pairing code.");
  }

  await requireSettingsAccess(input.actorUserId, orgId);
  const connectedAccount = await getConnectedAccount(orgId);
  if (connectedAccount) {
    const existingEntry = getSessionEntry(orgId);
    if (existingEntry.status === "CONNECTED") {
      return {
        orgId,
        connectionStatus: existingEntry.status,
        pairingCode: "ALREADY_CONNECTED",
        expiresInSeconds: 0
      };
    }
  }

  await resetBaileysLinkState(orgId);
  const socket = await ensureBaileysSocket(orgId, true);
  const entry = getSessionEntry(orgId);

  const waitForConnectionUpdate = bindWaitForConnectionUpdate(socket.ev);
  await waitForConnectionUpdate(
    async (update) => update.connection === "connecting" || typeof update.qr === "string",
    15_000
  ).catch((error) => {
    const message = error instanceof Error ? error.message : "Baileys socket did not become ready for pairing.";
    throw new ServiceError(504, "BAILEYS_PAIRING_PREP_TIMEOUT", message);
  });

  const pairingCode = await socket.requestPairingCode(phoneNumber);
  entry.status = "PAIRING";
  entry.qrCode = null;
  entry.qrCodeExpiresAt = null;
  entry.pairingCode = pairingCode;
  entry.pairingCodeExpiresAt = new Date(Date.now() + BAILEYS_PAIRING_TTL_MS);
  entry.lastError = null;

  return {
    orgId,
    connectionStatus: entry.status,
    pairingCode,
    expiresInSeconds: BAILEYS_PAIRING_TTL_MS / 1000
  };
}

export async function disconnectBaileysSession(input: {
  actorUserId: string;
  orgId: string;
}): Promise<void> {
  const orgId = normalize(input.orgId);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  await requireSettingsAccess(input.actorUserId, orgId);
  const entry = getSessionEntry(orgId);
  entry.allowReconnect = false;
  clearReconnectTimer(entry);
  entry.reconnectAttempts = 0;
  if (entry.socket) {
    try {
      entry.socket.end(undefined);
    } catch {
      // ignore
    }
  }

  entry.socket = null;
  entry.status = "DISCONNECTED";
  entry.lastError = null;
  entry.qrCode = null;
  entry.qrCodeExpiresAt = null;
  entry.pairingCode = null;
  entry.pairingCodeExpiresAt = null;
  entry.initPromise = null;

  await clearConnectedAccount(orgId);
  await clearRuntimeFiles(orgId);
}

async function waitForSocketOpen(socket: WASocket, timeoutMs: number): Promise<void> {
  if (isSocketOpen(socket)) {
    return;
  }

  const waitForConnectionUpdate = bindWaitForConnectionUpdate(socket.ev);
  await waitForConnectionUpdate(async (update) => update.connection === "open", timeoutMs);
}

async function ensureConnectedSocketForOrg(
  orgId: string,
  options?: { forceRestart?: boolean }
): Promise<WASocket> {
  let socket = await ensureBaileysSocket(orgId, options?.forceRestart ?? false);
  let entry = getSessionEntry(orgId);

  if (isSocketOpen(socket)) {
    entry.status = "CONNECTED";
    entry.lastError = null;
    return socket;
  }

  try {
    await waitForSocketOpen(socket, 15_000);
    entry = getSessionEntry(orgId);
    if (isSocketOpen(entry.socket)) {
      entry.status = "CONNECTED";
      entry.lastError = null;
      return entry.socket as WASocket;
    }
  } catch {
    // fall through to hard reconnect
  }

  socket = await ensureBaileysSocket(orgId, true);
  entry = getSessionEntry(orgId);

  try {
    await waitForSocketOpen(socket, 15_000);
  } catch {
    const detail = entry.lastError ? ` ${entry.lastError}` : "";
    throw new ServiceError(400, "WHATSAPP_NOT_CONNECTED", `Baileys session is not connected for this business.${detail}`);
  }

  entry = getSessionEntry(orgId);
  if (!isSocketOpen(entry.socket)) {
    const detail = entry.lastError ? ` ${entry.lastError}` : "";
    throw new ServiceError(400, "WHATSAPP_NOT_CONNECTED", `Baileys session is not connected for this business.${detail}`);
  }

  entry.status = "CONNECTED";
  entry.lastError = null;
  return entry.socket as WASocket;
}

function toJid(phoneE164: string): string {
  const digits = extractDigits(phoneE164);
  if (!digits) {
    throw new ServiceError(400, "INVALID_PHONE_NUMBER", "Valid destination phone number is required.");
  }

  return `${digits}@s.whatsapp.net`;
}

export async function sendBaileysTextMessage(input: {
  orgId: string;
  toPhoneE164: string;
  toJid?: string;
  text: string;
  quotedWaMessageId?: string;
}): Promise<string | null> {
  const send = async (socket: WASocket) => {
    const jid = await resolveOutboundDestinationJid(input.orgId, input.toPhoneE164, socket, input.toJid);
    return socket.sendMessage(jid, {
      text: input.text,
      ...(normalize(input.quotedWaMessageId ?? undefined)
        ? {
            contextInfo: {
              stanzaId: normalize(input.quotedWaMessageId ?? undefined)
            }
          }
        : {})
    });
  };

  let socket = await ensureConnectedSocketForOrg(input.orgId);

  try {
    const response = await send(socket);
    return normalize(response?.key?.id ?? undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/closed|disconnect|not open|428|440/i.test(message)) {
      throw error;
    }

    socket = await ensureConnectedSocketForOrg(input.orgId, { forceRestart: true });
    const response = await send(socket);
    return normalize(response?.key?.id ?? undefined);
  }
}

export async function sendBaileysMediaMessage(input: {
  orgId: string;
  toPhoneE164: string;
  toJid?: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";
  fileName: string;
  mimeType?: string;
  caption?: string;
  quotedWaMessageId?: string;
  buffer: Buffer;
}): Promise<string | null> {
  const send = async (socket: WASocket) => {
    const jid = await resolveOutboundDestinationJid(input.orgId, input.toPhoneE164, socket, input.toJid);
    const contextInfo = normalize(input.quotedWaMessageId ?? undefined)
      ? {
          stanzaId: normalize(input.quotedWaMessageId ?? undefined)
        }
      : undefined;
    if (input.type === "IMAGE") {
      const response = await socket.sendMessage(jid, {
        image: input.buffer,
        caption: normalize(input.caption ?? undefined) || undefined,
        mimetype: normalize(input.mimeType ?? "image/jpeg"),
        ...(contextInfo ? { contextInfo } : {})
      });
      return normalize(response?.key?.id ?? undefined);
    }

    if (input.type === "VIDEO") {
      const response = await socket.sendMessage(jid, {
        video: input.buffer,
        caption: normalize(input.caption ?? undefined) || undefined,
        mimetype: normalize(input.mimeType ?? "video/mp4"),
        ...(contextInfo ? { contextInfo } : {})
      });
      return normalize(response?.key?.id ?? undefined);
    }

    if (input.type === "AUDIO") {
      const response = await socket.sendMessage(jid, {
        audio: input.buffer,
        mimetype: normalize(input.mimeType ?? "audio/ogg"),
        ptt: false,
        ...(contextInfo ? { contextInfo } : {})
      });
      return normalize(response?.key?.id ?? undefined);
    }

    const response = await socket.sendMessage(jid, {
      document: input.buffer,
      fileName: normalize(input.fileName) || "document",
      caption: normalize(input.caption ?? undefined) || undefined,
      mimetype: normalize(input.mimeType ?? "application/octet-stream"),
      ...(contextInfo ? { contextInfo } : {})
    });
    return normalize(response?.key?.id ?? undefined);
  };

  let socket = await ensureConnectedSocketForOrg(input.orgId);

  try {
    return await send(socket);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/closed|disconnect|not open|428|440/i.test(message)) {
      throw error;
    }

    socket = await ensureConnectedSocketForOrg(input.orgId, { forceRestart: true });
    return send(socket);
  }
}

export async function sendBaileysTemplateLikeMessage(input: {
  orgId: string;
  toPhoneE164: string;
  toJid?: string;
  templateName: string;
  languageCode: string;
  components: Array<Record<string, unknown>>;
  quotedWaMessageId?: string;
}): Promise<string | null> {
  const renderedComponents = input.components.length > 0 ? `\n\n${JSON.stringify(input.components)}` : "";
  return sendBaileysTextMessage({
    orgId: input.orgId,
    toPhoneE164: input.toPhoneE164,
    toJid: input.toJid,
    text: `[Template:${input.templateName}][${input.languageCode}]${renderedComponents}`,
    quotedWaMessageId: input.quotedWaMessageId
  });
}

export async function sendBaileysTestMessage(input: {
  actorUserId: string;
  orgId: string;
  toPhoneE164: string;
}): Promise<{
  orgId: string;
  toPhoneE164: string;
  waMessageId: string | null;
  sentAt: Date;
}> {
  const orgId = normalize(input.orgId);
  const toPhoneE164 = normalizePossibleE164(input.toPhoneE164);
  if (!orgId || !toPhoneE164) {
    throw new ServiceError(400, "INVALID_TEST_MESSAGE_INPUT", "orgId and valid destination phone are required.");
  }

  await requireSettingsAccess(input.actorUserId, orgId);
  const waMessageId = await sendBaileysTextMessage({
    orgId,
    toPhoneE164,
    text: "20byte Baileys connection test. Jika pesan ini masuk, pairing berhasil."
  });

  return {
    orgId,
    toPhoneE164,
    waMessageId,
    sentAt: new Date()
  };
}

export async function ensureBaileysConnectedForOrg(orgId: string): Promise<void> {
  const connectedAccount = await getConnectedAccount(orgId);
  if (!connectedAccount) {
    throw new ServiceError(400, "WHATSAPP_NOT_CONNECTED", "Baileys session is not connected for this organization.");
  }

  await ensureConnectedSocketForOrg(orgId);
}

export async function getBaileysQrStatusForOrg(orgIdInput: string): Promise<{
  orgId: string;
  connectionStatus: BaileysConnectionStatus;
  qrCode: string | null;
  qrCodeExpiresAt: Date | null;
  connected: boolean;
}> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const connectedAccount = await getConnectedAccount(orgId);
  const entry = getSessionEntry(orgId);
  return {
    orgId,
    connectionStatus: entry.status,
    qrCode: entry.qrCode,
    qrCodeExpiresAt: entry.qrCodeExpiresAt,
    connected: Boolean(connectedAccount)
  };
}

export async function startBaileysQrSessionForOrg(orgIdInput: string): Promise<{
  orgId: string;
  connectionStatus: BaileysConnectionStatus;
  qrCode: string;
  expiresInSeconds: number;
}> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const connectedAccount = await getConnectedAccount(orgId);
  if (connectedAccount) {
    const entry = getSessionEntry(orgId);
    if (entry.status === "CONNECTED") {
      return {
        orgId,
        connectionStatus: entry.status,
        qrCode: "ALREADY_CONNECTED",
        expiresInSeconds: 0
      };
    }
  }

  await resetBaileysLinkState(orgId);
  await ensureBaileysSocket(orgId, true);
  const entry = getSessionEntry(orgId);

  const deadline = Date.now() + BAILEYS_QR_GENERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (entry.qrCode) {
      return {
        orgId,
        connectionStatus: entry.status,
        qrCode: entry.qrCode,
        expiresInSeconds: Math.max(
          1,
          Math.floor(((entry.qrCodeExpiresAt?.getTime() ?? Date.now() + BAILEYS_QR_TTL_MS) - Date.now()) / 1000)
        )
      };
    }

    if (entry.status === "ERROR" && entry.lastError) {
      throw new ServiceError(500, "BAILEYS_QR_FAILED", entry.lastError);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new ServiceError(
    504,
    "BAILEYS_QR_TIMEOUT",
    entry.lastError ? `QR code was not generated in time. ${entry.lastError}` : "QR code was not generated in time. Please retry."
  );
}

export async function disconnectBaileysSessionForOrg(orgIdInput: string): Promise<void> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const entry = getSessionEntry(orgId);
  entry.allowReconnect = false;
  clearReconnectTimer(entry);
  entry.reconnectAttempts = 0;
  if (entry.socket) {
    try {
      entry.socket.end(undefined);
    } catch {
      // ignore
    }
  }

  entry.socket = null;
  entry.status = "DISCONNECTED";
  entry.lastError = null;
  entry.qrCode = null;
  entry.qrCodeExpiresAt = null;
  entry.pairingCode = null;
  entry.pairingCodeExpiresAt = null;

  await clearConnectedAccount(orgId);
  await clearRuntimeFiles(orgId);
}

export async function checkBaileysContactNumber(input: { orgId: string; phoneE164: string }): Promise<{
  orgId: string;
  phoneE164: string;
  jid: string;
  exists: boolean;
}> {
  const orgId = normalize(input.orgId);
  const phoneE164 = normalizePossibleE164(input.phoneE164);
  if (!orgId || !phoneE164) {
    throw new ServiceError(400, "INVALID_CONTACT_CHECK_INPUT", "orgId and valid phone number are required.");
  }

  const socket = await ensureConnectedSocketForOrg(orgId);
  const jid = toJid(phoneE164);
  const result = await socket.onWhatsApp(jid);
  const exists = Boolean(Array.isArray(result) && result[0]?.exists);
  return {
    orgId,
    phoneE164,
    jid,
    exists
  };
}

export async function listBaileysGroupsForOrg(orgIdInput: string): Promise<Array<{
  id: string;
  subject: string;
  owner: string | null;
  participantCount: number;
}>> {
  const orgId = normalize(orgIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  const socket = await ensureConnectedSocketForOrg(orgId);
  const groups = await socket.groupFetchAllParticipating();
  return Object.values(groups).map((group) => ({
    id: group.id,
    subject: normalize(group.subject) || group.id,
    owner: normalize(group.owner) || null,
    participantCount: Array.isArray(group.participants) ? group.participants.length : 0
  }));
}

export async function listBaileysGroupMembersForOrg(input: {
  orgId: string;
  groupId: string;
}): Promise<Array<{ id: string; isAdmin: boolean; isSuperAdmin: boolean }>> {
  const orgId = normalize(input.orgId);
  const groupId = normalize(input.groupId);
  if (!orgId || !groupId) {
    throw new ServiceError(400, "INVALID_GROUP_INPUT", "orgId and groupId are required.");
  }

  const socket = await ensureConnectedSocketForOrg(orgId);
  const groups = await socket.groupFetchAllParticipating();
  const group = groups[groupId];
  if (!group) {
    throw new ServiceError(404, "GROUP_NOT_FOUND", "Group not found.");
  }

  return (group.participants ?? []).map((participant) => ({
    id: participant.id,
    isAdmin: participant.admin === "admin",
    isSuperAdmin: participant.admin === "superadmin"
  }));
}

export async function getBaileysAccountReport(actorUserId: string, orgId: string): Promise<BaileysAccountReport> {
  const normalizedOrgId = normalize(orgId);
  if (!normalizedOrgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  await requireSettingsAccess(actorUserId, normalizedOrgId);

  const connectedAccount = await getConnectedAccount(normalizedOrgId);
  const entry = getSessionEntry(normalizedOrgId);
  const todayStart = startOfLocalDay();
  const monthStart = startOfLocalMonth();
  const lastThirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [incomingToday, outgoingToday, failedToday, broadcastMonth, outboundMessages] = await Promise.all([
    prisma.message.count({
      where: {
        orgId: normalizedOrgId,
        direction: "INBOUND",
        createdAt: { gte: todayStart }
      }
    }),
    prisma.message.count({
      where: {
        orgId: normalizedOrgId,
        direction: "OUTBOUND",
        sendStatus: "SENT",
        createdAt: { gte: todayStart }
      }
    }),
    prisma.message.count({
      where: {
        orgId: normalizedOrgId,
        direction: "OUTBOUND",
        sendStatus: "FAILED",
        createdAt: { gte: todayStart }
      }
    }),
    prisma.message.count({
      where: {
        orgId: normalizedOrgId,
        direction: "OUTBOUND",
        type: "TEMPLATE",
        createdAt: { gte: monthStart }
      }
    }),
    prisma.message.findMany({
      where: {
        orgId: normalizedOrgId,
        direction: "OUTBOUND",
        sendStatus: "SENT",
        createdAt: { gte: lastThirtyDays }
      },
      select: {
        conversation: {
          select: {
            assignedToMemberId: true
          }
        }
      }
    })
  ]);

  const memberCounts = new Map<string, number>();
  for (const message of outboundMessages) {
    const memberId = message.conversation.assignedToMemberId;
    if (!memberId) {
      continue;
    }

    memberCounts.set(memberId, (memberCounts.get(memberId) ?? 0) + 1);
  }

  const members = memberCounts.size
    ? await prisma.orgMember.findMany({
        where: {
          orgId: normalizedOrgId,
          id: {
            in: [...memberCounts.keys()]
          }
        },
        select: {
          id: true,
          role: true,
          user: {
            select: {
              name: true,
              email: true
            }
          }
        }
      })
    : [];

  const agentActivity = members
    .map((member) => {
      const messagesSent = memberCounts.get(member.id) ?? 0;
      return {
        memberId: member.id,
        agentName: normalize(member.user.name ?? undefined) || normalize(member.user.email ?? undefined) || "Agent",
        role: member.role,
        messagesSent,
        performance: toPerformanceLabel(messagesSent)
      };
    })
    .sort((left, right) => right.messagesSent - left.messagesSent)
    .slice(0, 8);

  return {
    connectedAccount,
    metrics: {
      incomingToday,
      outgoingToday,
      failedToday,
      broadcastMonth
    },
    agentActivity,
    technical: {
      sessionId: connectedAccount?.id ?? normalizedOrgId,
      connectedSince: connectedAccount?.connectedAt.toISOString() ?? null,
      uptimeLabel: formatUptimeLabel(connectedAccount?.connectedAt ?? null, entry.status),
      status: entry.status,
      lastError: entry.lastError
    }
  };
}

export async function listBaileysRuntimeMedia(orgId: string): Promise<string[]> {
  const mediaFolder = getMediaFolder(orgId);
  try {
    return await readdir(mediaFolder);
  } catch {
    return [];
  }
}

export async function readBaileysMediaFile(orgId: string, fileName: string): Promise<Buffer> {
  const safeFileName = path.basename(fileName);
  const candidatePaths = [
    path.join(getMediaFolder(orgId), safeFileName),
    // Backward-compat: media lama pernah tersimpan tanpa subfolder org.
    path.join(BAILEYS_MEDIA_DIR, safeFileName)
  ];

  for (const diskPath of candidatePaths) {
    let fileStats;
    try {
      fileStats = await stat(diskPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      throw error;
    }

    if (!fileStats.isFile()) {
      continue;
    }

    try {
      return await readFile(diskPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
  }

  throw new ServiceError(404, "MEDIA_FILE_NOT_FOUND", "Media file does not exist.");
}

export async function writeBaileysAuditLog(actorUserId: string, orgId: string, action: string, entityId: string, meta?: Record<string, unknown>) {
  await writeAuditLogSafe({
    actorUserId,
    orgId,
    action,
    entityType: "baileys_session",
    entityId,
    meta
  });
}

const shouldBootstrapBaileysSessions =
  process.env.NODE_ENV !== "test" &&
  process.env.NEXT_PHASE !== "phase-production-build" &&
  process.env.DISABLE_BAILEYS_BOOTSTRAP !== "1" &&
  process.env.WHATSAPP_MOCK_MODE !== "true";

if (shouldBootstrapBaileysSessions) {
  void bootstrapConnectedBaileysSessions();
}

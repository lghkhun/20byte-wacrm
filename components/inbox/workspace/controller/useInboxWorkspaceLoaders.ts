"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import type {
  CrmActivityItem,
  CrmInvoiceItem,
  CustomerTagItem,
  ConversationCrmContextResponse,
  ConversationFetchResponse,
  CustomerTagsResponse,
  ListConversationsResponse,
  ListMessagesResponse
} from "@/components/inbox/workspace/types";
import type { ConversationItem, MessageItem } from "@/components/inbox/types";
import { fetchJsonCached } from "@/lib/client/fetchCache";
import { fetchOrganizationsCached } from "@/lib/client/orgsCache";
import { subscribeToOrgMessageEvents } from "@/lib/ably/client";
import { recordInboxTelemetry } from "@/components/inbox/workspace/controller/inboxTelemetry";
import { isRequestVersionCurrent, issueRequestVersion } from "@/components/inbox/workspace/controller/requestVersionGuard";
import {
  pruneConversationMessagesLocalCache,
  readConversationMessagesLocalCache,
  writeConversationMessagesLocalCache
} from "@/components/inbox/workspace/controller/messageLocalCache";
import {
  pruneConversationCrmContextLocalCache,
  readConversationCrmContextLocalCache,
  writeConversationCrmContextLocalCache
} from "@/components/inbox/workspace/controller/crmContextLocalCache";

import type { InboxWorkspaceState } from "./useInboxWorkspaceState";

type MessageStoreEntry = {
  rows: MessageItem[];
  hasMore: boolean;
  nextBeforeMessageId: string | null;
  snapshot: string;
};

type CrmContextStoreEntry = {
  customerId: string;
  tags: CustomerTagItem[];
  invoices: CrmInvoiceItem[];
  activity: CrmActivityItem[];
};

type LoadMessagesOptions = {
  background?: boolean;
  beforeMessageId?: string;
  appendOlder?: boolean;
};

type LoadConversationsOptions = {
  background?: boolean;
  append?: boolean;
  query?: string;
};

const CONVERSATION_PAGE_LIMIT = 20;
const MESSAGE_PAGE_LIMIT = 30;
const REALTIME_FALLBACK_POLL_INTERVAL_MS = 8_000;

export function useInboxWorkspaceLoaders(state: InboxWorkspaceState) {
  const {
    organizations,
    setOrganizations,
    hasLoadedOrganizations,
    setHasLoadedOrganizations,
    orgId,
    setOrgId,
    filter,
    statusFilter,
    conversationSearchQuery,
    selectedConversationId,
    setSelectedConversationId,
    setSelectedConversation,
    setIsLoadingList,
    setIsLoadingMoreConversations,
    setHasMoreConversations,
    setIsLoadingConversation,
    setMessages,
    setIsLoadingMessages,
    setIsLoadingOlderMessages,
    setHasMoreMessages,
    setError,
    setMessageError,
    setCrmError,
    setIsLoadingCrm,
    setSelectedProofMessageId,
    setTags,
    setCrmInvoices,
    setCrmActivity,
    metaTotal,
    conversations,
    messages,
    setMetaTotal,
    setConversations,
    setTypingConversationId,
    setRealtimeConnectionState
  } = state;

  const hasLoadedConversationListRef = useRef(false);
  const hasLoadedMessagesRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastNotificationAtRef = useRef(0);
  const previousUnreadTotalRef = useRef(0);
  const conversationSnapshotRef = useRef<string>("");
  const conversationsRef = useRef(conversations);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const messagesLengthRef = useRef(messages.length);
  const markReadInFlightRef = useRef(new Set<string>());
  const markReadDebounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const realtimeMessageRefreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const typingResetTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const loadMessagesAbortRef = useRef<AbortController | null>(null);
  const loadMessagesRequestVersionsRef = useRef<Map<string, number>>(new Map());
  const loadConversationAbortRef = useRef<AbortController | null>(null);
  const loadConversationRequestVersionsRef = useRef<Map<string, number>>(new Map());
  const loadConversationForegroundRequestVersionRef = useRef(0);
  const loadConversationsAbortRef = useRef<AbortController | null>(null);
  const loadConversationsRequestIdRef = useRef(0);
  const loadCustomerCrmContextRequestIdRef = useRef(0);
  const loadConversationCrmContextRequestVersionsRef = useRef<Map<string, number>>(new Map());
  const currentConversationsPageRef = useRef(1);
  const lastBackgroundConversationsLoadAtRef = useRef(0);
  const conversationSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationSearchQueryRef = useRef(conversationSearchQuery);
  const realtimeFallbackCountRef = useRef(0);
  const realtimeMessageStatusMismatchCountRef = useRef(0);
  const realtimeConnectionAttemptCountRef = useRef(0);
  const messageStoreRef = useRef<Map<string, MessageStoreEntry>>(new Map());
  const crmContextStoreRef = useRef<Map<string, CrmContextStoreEntry>>(new Map());

  const recalculateConversationSnapshot = useCallback((rows: ConversationItem[] | null | undefined) => {
    const safeRows = rows ?? [];
    conversationSnapshotRef.current = JSON.stringify(
      safeRows.map((row) => ({
        id: row.id,
        unreadCount: row.unreadCount,
        lastMessageAt: row.lastMessageAt,
        lastMessageType: row.lastMessageType,
        lastMessageDirection: row.lastMessageDirection,
        status: row.status,
        assignedToMemberId: row.assignedToMemberId,
        updatedAt: row.updatedAt
      }))
    );
    previousUnreadTotalRef.current = safeRows.reduce((total, row) => total + row.unreadCount, 0);
  }, []);

  const buildMessagesSnapshot = useCallback((rows: MessageItem[] | null | undefined) => {
    const safeRows = rows ?? [];
    return JSON.stringify(
      safeRows.map((message) => ({
        id: message.id,
        sendStatus: message.sendStatus,
        deliveryStatus: message.deliveryStatus,
        sendError: message.sendError,
        retryable: message.retryable,
        sendAttemptCount: message.sendAttemptCount,
        deliveredAt: message.deliveredAt,
        readAt: message.readAt,
        createdAt: message.createdAt
      }))
    );
  }, []);

  const upsertMessageStore = useCallback(
    (conversationId: string, rows: MessageItem[], hasMore: boolean, nextBeforeMessageId: string | null) => {
      const snapshot = buildMessagesSnapshot(rows);
      messageStoreRef.current.set(conversationId, {
        rows,
        hasMore,
        nextBeforeMessageId,
        snapshot
      });
      if (orgId) {
        writeConversationMessagesLocalCache(orgId, conversationId, rows, hasMore, nextBeforeMessageId);
      }
      return snapshot;
    },
    [buildMessagesSnapshot, orgId]
  );

  const getMessageStoreEntry = useCallback(
    (conversationId: string): MessageStoreEntry | null => {
      const inMemory = messageStoreRef.current.get(conversationId);
      if (inMemory) {
        return inMemory;
      }

      if (!orgId) {
        return null;
      }

      const fromLocal = readConversationMessagesLocalCache(orgId, conversationId);
      if (!fromLocal) {
        return null;
      }

      const snapshot = buildMessagesSnapshot(fromLocal.rows);
      const hydrated: MessageStoreEntry = {
        rows: fromLocal.rows,
        hasMore: fromLocal.hasMore,
        nextBeforeMessageId: fromLocal.nextBeforeMessageId,
        snapshot
      };
      messageStoreRef.current.set(conversationId, hydrated);
      return hydrated;
    },
    [buildMessagesSnapshot, orgId]
  );

  const getCrmContextStoreEntry = useCallback(
    (conversationId: string, expectedCustomerId?: string | null): CrmContextStoreEntry | null => {
      const normalizedExpectedCustomerId = (expectedCustomerId ?? "").trim();
      const inMemory = crmContextStoreRef.current.get(conversationId);
      if (inMemory) {
        if (!normalizedExpectedCustomerId || inMemory.customerId === normalizedExpectedCustomerId) {
          return inMemory;
        }
      }

      if (!orgId) {
        return null;
      }

      const fromLocal = readConversationCrmContextLocalCache(orgId, conversationId, normalizedExpectedCustomerId || null);
      if (!fromLocal) {
        return null;
      }

      const hydrated: CrmContextStoreEntry = {
        customerId: fromLocal.customerId,
        tags: fromLocal.tags,
        invoices: fromLocal.invoices,
        activity: fromLocal.activity
      };
      crmContextStoreRef.current.set(conversationId, hydrated);
      return hydrated;
    },
    [orgId]
  );

  const upsertCrmContextStore = useCallback(
    (
      conversationId: string,
      patch: {
        customerId?: string | null;
        tags?: CustomerTagItem[];
        invoices?: CrmInvoiceItem[];
        activity?: CrmActivityItem[];
      }
    ): CrmContextStoreEntry | null => {
      const existing = crmContextStoreRef.current.get(conversationId);
      const customerId = (patch.customerId ?? existing?.customerId ?? "").trim();
      if (!customerId) {
        return existing ?? null;
      }

      const next: CrmContextStoreEntry = {
        customerId,
        tags: patch.tags ?? existing?.tags ?? [],
        invoices: patch.invoices ?? existing?.invoices ?? [],
        activity: patch.activity ?? existing?.activity ?? []
      };
      crmContextStoreRef.current.set(conversationId, next);
      if (orgId) {
        writeConversationCrmContextLocalCache(orgId, conversationId, next);
      }
      return next;
    },
    [orgId]
  );

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    messagesLengthRef.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    conversationSearchQueryRef.current = conversationSearchQuery;
  }, [conversationSearchQuery]);

  useEffect(() => {
    return () => {
      loadMessagesAbortRef.current?.abort();
      loadConversationAbortRef.current?.abort();
      loadConversationsAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    messageStoreRef.current.clear();
    crmContextStoreRef.current.clear();
  }, [orgId]);

  useEffect(() => {
    pruneConversationMessagesLocalCache();
    pruneConversationCrmContextLocalCache();
  }, []);

  const playInboundNotification = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (Date.now() - lastNotificationAtRef.current < 1500) {
      return;
    }
    lastNotificationAtRef.current = Date.now();

    const AudioContextCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    try {
      const audioContext = audioContextRef.current ?? new AudioContextCtor();
      audioContextRef.current = audioContext;

      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => {
          // ignore autoplay resume failure
        });
      }

      const now = audioContext.currentTime;
      [0, 0.11].forEach((offset) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, now + offset);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);

        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.07, now + offset + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);

        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.15);
      });
    } catch {
      // ignore audio failures
    }
  }, []);

  const clearUnreadLocally = useCallback(
    (conversationId: string) => {
      setConversations((previousRows) => {
        let changed = false;
        const nextRows = previousRows.map((row) => {
          if (row.id !== conversationId || row.unreadCount <= 0) {
            return row;
          }

          changed = true;
          return {
            ...row,
            unreadCount: 0
          };
        });

        if (!changed) {
          return previousRows;
        }

        recalculateConversationSnapshot(nextRows);
        return nextRows;
      });

      setSelectedConversation((current) => {
        if (!current || current.id !== conversationId || current.unreadCount <= 0) {
          return current;
        }

        return {
          ...current,
          unreadCount: 0
        };
      });
    },
    [recalculateConversationSnapshot, setConversations, setSelectedConversation]
  );

  const markConversationRead = useCallback(
    async (conversationId: string) => {
      if (!orgId || markReadInFlightRef.current.has(conversationId)) {
        return;
      }

      clearUnreadLocally(conversationId);
      markReadInFlightRef.current.add(conversationId);
      try {
        await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/read?orgId=${encodeURIComponent(orgId)}`, {
          method: "POST"
        });
      } catch {
        // Ignore transient failures; next refresh will reconcile unread count.
      } finally {
        markReadInFlightRef.current.delete(conversationId);
      }
    },
    [clearUnreadLocally, orgId]
  );

  const scheduleMarkConversationRead = useCallback(
    (conversationId: string, delayMs = 420) => {
      const existingTimer = markReadDebounceTimersRef.current.get(conversationId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        markReadDebounceTimersRef.current.delete(conversationId);
        void markConversationRead(conversationId);
      }, delayMs);

      markReadDebounceTimersRef.current.set(conversationId, timer);
    },
    [markConversationRead]
  );

  const loadMessages = useCallback(
    async (conversationId: string, options?: LoadMessagesOptions) => {
      if (!orgId) {
        return;
      }

      const isAppendOlder = Boolean(options?.appendOlder);
      const requestKey = `${conversationId}:${isAppendOlder ? "older" : "latest"}`;
      const requestVersion = issueRequestVersion(loadMessagesRequestVersionsRef.current, requestKey);

      let abortController: AbortController | null = null;
      if (!options?.background && !isAppendOlder) {
        loadMessagesAbortRef.current?.abort();
        abortController = new AbortController();
        loadMessagesAbortRef.current = abortController;
      }

      if (isAppendOlder) {
        setIsLoadingOlderMessages(true);
      } else if (!options?.background) {
        setIsLoadingMessages(true);
        setMessageError(null);
      }

      try {
        const query = new URLSearchParams({
          conversationId,
          limit: String(MESSAGE_PAGE_LIMIT),
          orgId
        });
        if (options?.beforeMessageId) {
          query.set("beforeMessageId", options.beforeMessageId);
        }

        const response = await fetch(`/api/messages?${query.toString()}`, {
          signal: abortController?.signal
        });
        const payload = (await response.json().catch(() => null)) as ListMessagesResponse | null;
        if (!isRequestVersionCurrent(loadMessagesRequestVersionsRef.current, requestKey, requestVersion)) {
          return;
        }

        if (!response.ok) {
          if (!options?.background && !isAppendOlder) {
            setMessageError(payload?.error?.message ?? "Gagal memuat pesan.");
          }
          return;
        }

        const nextRows = payload?.data?.messages ?? [];
        const hasMore = Boolean(payload?.meta?.hasMore);
        const nextBeforeMessageId = payload?.meta?.nextBeforeMessageId ?? null;

        if (isAppendOlder) {
          const currentEntry = messageStoreRef.current.get(conversationId);
          const merged = [...nextRows, ...(currentEntry?.rows ?? [])];
          const dedupedMap = new Map<string, MessageItem>();
          merged.forEach((item) => {
            if (!dedupedMap.has(item.id)) {
              dedupedMap.set(item.id, item);
            }
          });
          const deduped = [...dedupedMap.values()].sort((left, right) => {
            const timeDiff = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
            if (timeDiff !== 0) {
              return timeDiff;
            }
            return left.id.localeCompare(right.id);
          });

          upsertMessageStore(conversationId, deduped, hasMore, nextBeforeMessageId);
          if (selectedConversationIdRef.current === conversationId) {
            setMessages(deduped);
            setHasMoreMessages(hasMore);
          }
          return;
        }

        upsertMessageStore(conversationId, nextRows, hasMore, nextBeforeMessageId);

        const shouldApplyToUi = options?.background ? selectedConversationIdRef.current === conversationId : true;
        if (!shouldApplyToUi) {
          return;
        }

        const previousLength = messagesLengthRef.current;
        setMessages(nextRows);
        setHasMoreMessages(hasMore);

        if (hasLoadedMessagesRef.current && nextRows.length > previousLength) {
          const latestMessage = nextRows[nextRows.length - 1] ?? null;
          if (latestMessage?.direction === "INBOUND" && !options?.background) {
            playInboundNotification();
          }
        }
        hasLoadedMessagesRef.current = true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (!options?.background && !isAppendOlder) {
          setMessageError("Network error while loading messages.");
        }
      } finally {
        if (isAppendOlder) {
          setIsLoadingOlderMessages(false);
        } else if (!options?.background) {
          setIsLoadingMessages(false);
        }
      }
    },
    [
      orgId,
      playInboundNotification,
      setHasMoreMessages,
      setIsLoadingMessages,
      setIsLoadingOlderMessages,
      setMessageError,
      setMessages,
      upsertMessageStore
    ]
  );

  const loadOlderMessages = useCallback(async () => {
    const conversationId = selectedConversationIdRef.current;
    if (!conversationId) {
      return;
    }

    const cached = getMessageStoreEntry(conversationId);
    const beforeMessageId = cached?.nextBeforeMessageId ?? cached?.rows[0]?.id ?? null;
    if (!beforeMessageId || !cached?.hasMore) {
      return;
    }

    await loadMessages(conversationId, {
      background: true,
      appendOlder: true,
      beforeMessageId
    });
  }, [getMessageStoreEntry, loadMessages]);

  const loadCustomerCrmContext = useCallback(
    async (customerId: string, options?: { conversationId?: string; background?: boolean }) => {
      if (!orgId) {
        return;
      }

      const requestId = ++loadCustomerCrmContextRequestIdRef.current;
      const targetConversationId = options?.conversationId ?? selectedConversationIdRef.current;
      if (!options?.background) {
        setIsLoadingCrm(true);
        setCrmError(null);
      }
      try {
        const tagsPayload = await fetchJsonCached<CustomerTagsResponse>(
          `/api/customers/${encodeURIComponent(customerId)}/tags?orgId=${encodeURIComponent(orgId)}`,
          {
            ttlMs: 12_000,
            init: { cache: "no-store" }
          }
        );
        if (requestId !== loadCustomerCrmContextRequestIdRef.current) {
          return;
        }
        if (targetConversationId && selectedConversationIdRef.current !== targetConversationId) {
          return;
        }
        const nextTags = tagsPayload?.data?.tags ?? [];
        if (targetConversationId) {
          upsertCrmContextStore(targetConversationId, {
            customerId,
            tags: nextTags
          });
        }
        setTags(nextTags);
      } catch {
        if (requestId !== loadCustomerCrmContextRequestIdRef.current) {
          return;
        }
        if (targetConversationId && selectedConversationIdRef.current !== targetConversationId) {
          return;
        }
        if (!options?.background) {
          setCrmError("Network error while loading CRM context.");
        }
      } finally {
        if (!options?.background && requestId === loadCustomerCrmContextRequestIdRef.current) {
          setIsLoadingCrm(false);
        }
      }
    },
    [orgId, setCrmError, setIsLoadingCrm, setTags, upsertCrmContextStore]
  );

  const loadConversationCrmContext = useCallback(
    async (conversationId: string, options?: { background?: boolean; customerId?: string | null }) => {
      if (!orgId) {
        return;
      }

      const requestVersion = issueRequestVersion(loadConversationCrmContextRequestVersionsRef.current, conversationId);
      if (!options?.background) {
        setIsLoadingCrm(true);
        setCrmError(null);
      }
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/crm-context?orgId=${encodeURIComponent(orgId)}`,
          { cache: "no-store" }
        );
        const payload = (await response.json().catch(() => null)) as ConversationCrmContextResponse | null;
        if (!isRequestVersionCurrent(loadConversationCrmContextRequestVersionsRef.current, conversationId, requestVersion)) {
          return;
        }
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? "Gagal memuat konteks invoice.");
        }
        if (selectedConversationIdRef.current !== conversationId) {
          return;
        }
        const nextInvoices = payload?.data?.invoices ?? [];
        const nextActivity = payload?.data?.events ?? [];
        const cachedEntry = getCrmContextStoreEntry(conversationId, options?.customerId ?? null);
        const resolvedCustomerId = (options?.customerId ?? cachedEntry?.customerId ?? "").trim();
        if (resolvedCustomerId) {
          upsertCrmContextStore(conversationId, {
            customerId: resolvedCustomerId,
            invoices: nextInvoices,
            activity: nextActivity
          });
        }
        setCrmInvoices(nextInvoices);
        setCrmActivity(nextActivity);
      } catch {
        if (!isRequestVersionCurrent(loadConversationCrmContextRequestVersionsRef.current, conversationId, requestVersion)) {
          return;
        }
        if (selectedConversationIdRef.current !== conversationId) {
          return;
        }
        if (!options?.background) {
          setCrmError("Network error while loading invoice timeline.");
          const cachedEntry = getCrmContextStoreEntry(conversationId, options?.customerId ?? null);
          if (!cachedEntry) {
            setCrmInvoices([]);
            setCrmActivity([]);
          }
        }
      } finally {
        if (!options?.background) {
          setIsLoadingCrm(false);
        }
      }
    },
    [getCrmContextStoreEntry, orgId, setCrmActivity, setCrmError, setCrmInvoices, setIsLoadingCrm, upsertCrmContextStore]
  );

  const loadConversation = useCallback(
    async (conversationId: string, options?: { background?: boolean }) => {
      if (!orgId) {
        return;
      }
      const foregroundRequestVersion = !options?.background ? ++loadConversationForegroundRequestVersionRef.current : null;

      if (!options?.background) {
        setIsLoadingConversation(true);
        setError(null);
      }

      let hasLocalMessageCache = false;
      let hasLocalCrmCache = false;
      if (!options?.background) {
        const rowSnapshot = conversationsRef.current.find((row) => row.id === conversationId);
        if (rowSnapshot) {
          setSelectedConversation({
            ...rowSnapshot,
            unreadCount: 0
          });
        }

        const cached = getMessageStoreEntry(conversationId);
        if (cached) {
          hasLocalMessageCache = true;
          setMessages(cached.rows);
          setHasMoreMessages(cached.hasMore);
          setIsLoadingMessages(false);
          setMessageError(null);
        }

        const cachedCrm = getCrmContextStoreEntry(conversationId, rowSnapshot?.customerId ?? null);
        if (cachedCrm) {
          hasLocalCrmCache = true;
          setTags(cachedCrm.tags);
          setCrmInvoices(cachedCrm.invoices);
          setCrmActivity(cachedCrm.activity);
          setIsLoadingCrm(false);
          setCrmError(null);
        }
      }

      if (!options?.background) {
        scheduleMarkConversationRead(conversationId, 0);
      }

      const requestVersion = issueRequestVersion(loadConversationRequestVersionsRef.current, conversationId);

      let abortController: AbortController | null = null;
      if (!options?.background) {
        loadConversationAbortRef.current?.abort();
        abortController = new AbortController();
        loadConversationAbortRef.current = abortController;
      }

      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}?orgId=${encodeURIComponent(orgId)}`,
          {
            signal: abortController?.signal
          }
        );
        const payload = (await response.json().catch(() => null)) as ConversationFetchResponse | null;
        if (!isRequestVersionCurrent(loadConversationRequestVersionsRef.current, conversationId, requestVersion)) {
          return;
        }
        if (
          !options?.background &&
          foregroundRequestVersion !== null &&
          foregroundRequestVersion !== loadConversationForegroundRequestVersionRef.current
        ) {
          return;
        }

        const shouldApplyToUi = options?.background ? selectedConversationIdRef.current === conversationId : true;
        if (!shouldApplyToUi) {
          return;
        }

        if (!response.ok) {
          if (response.status === 404) {
            setSelectedConversationId(null);
            setSelectedConversation(null);
            setMessages([]);
            setHasMoreMessages(false);
            setSelectedProofMessageId(null);
            setTags([]);
            setCrmInvoices([]);
            setCrmActivity([]);
            return;
          }

          if (!options?.background) {
            setError(payload?.error?.message ?? "Failed to fetch conversation.");
          }
          return;
        }

        const rawConversation = payload?.data?.conversation ?? null;
        const conversation =
          rawConversation && !options?.background
            ? {
                ...rawConversation,
                unreadCount: 0
              }
            : rawConversation;

        setSelectedConversation(conversation);

        if (!options?.background) {
          if (conversation?.customerId) {
            const crmBackgroundRefresh = hasLocalCrmCache;
            void Promise.all([
              loadCustomerCrmContext(conversation.customerId, {
                conversationId: conversation.id,
                background: crmBackgroundRefresh
              }),
              loadConversationCrmContext(conversation.id, {
                background: crmBackgroundRefresh,
                customerId: conversation.customerId
              })
            ]);
          } else {
            setTags([]);
            setCrmInvoices([]);
            setCrmActivity([]);
          }
        }

        const shouldBackgroundRefresh = Boolean(options?.background || hasLocalMessageCache);
        if (shouldBackgroundRefresh) {
          void loadMessages(conversationId, { background: true });
        } else {
          void loadMessages(conversationId, { background: false });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (
          !options?.background &&
          foregroundRequestVersion !== null &&
          foregroundRequestVersion !== loadConversationForegroundRequestVersionRef.current
        ) {
          return;
        }

        if (!options?.background) {
          setError("Network error while fetching conversation.");
        }
      } finally {
        if (
          !options?.background &&
          foregroundRequestVersion !== null &&
          foregroundRequestVersion !== loadConversationForegroundRequestVersionRef.current
        ) {
          return;
        }
        if (!options?.background) {
          setIsLoadingConversation(false);
        }
      }
    },
    [
      getCrmContextStoreEntry,
      loadConversationCrmContext,
      loadCustomerCrmContext,
      loadMessages,
      orgId,
      scheduleMarkConversationRead,
      setCrmActivity,
      setCrmError,
      setCrmInvoices,
      setError,
      setHasMoreMessages,
      setIsLoadingConversation,
      setIsLoadingCrm,
      setIsLoadingMessages,
      setMessages,
      setMessageError,
      setSelectedConversation,
      setSelectedConversationId,
      setSelectedProofMessageId,
      setTags,
      getMessageStoreEntry
    ]
  );

  const loadConversations = useCallback(
    async (options?: LoadConversationsOptions) => {
      if (!orgId) {
        return;
      }

      const isBackground = Boolean(options?.background);
      const isAppend = Boolean(options?.append);
      const effectiveQuery = (options?.query ?? conversationSearchQueryRef.current).trim();

      if (isBackground && Date.now() - lastBackgroundConversationsLoadAtRef.current < 1200) {
        return;
      }

      const targetPage = isAppend ? currentConversationsPageRef.current + 1 : 1;
      const requestId = loadConversationsRequestIdRef.current + 1;
      loadConversationsRequestIdRef.current = requestId;

      let abortController: AbortController | null = null;
      if (!isBackground) {
        loadConversationsAbortRef.current?.abort();
        abortController = new AbortController();
        loadConversationsAbortRef.current = abortController;
      }

      if (isAppend) {
        setIsLoadingMoreConversations(true);
      } else if (!isBackground) {
        setIsLoadingList(true);
        setError(null);
      }

      try {
        const params = new URLSearchParams({
          filter,
          status: statusFilter,
          page: String(targetPage),
          limit: String(CONVERSATION_PAGE_LIMIT),
          orgId
        });

        if (effectiveQuery) {
          params.set("query", effectiveQuery);
        }

        const response = await fetch(`/api/conversations?${params.toString()}`, {
          signal: abortController?.signal
        });

        const payload = (await response.json().catch(() => null)) as ListConversationsResponse | null;
        if (!response.ok) {
          if (response.status === 404 && payload?.error?.code === "ORG_NOT_FOUND") {
            setConversations([]);
            setMetaTotal(0);
            setHasMoreConversations(false);
            setSelectedConversationId(null);
            setSelectedConversation(null);
            setMessages([]);
            setHasMoreMessages(false);
            setSelectedProofMessageId(null);
            setTags([]);
            setCrmInvoices([]);
            setCrmActivity([]);
            return;
          }

          if (!isBackground) {
            setError(payload?.error?.message ?? "Failed to load conversations.");
          }
          return;
        }

        if (requestId !== loadConversationsRequestIdRef.current) {
          return;
        }

        const incomingRows = payload?.data?.conversations ?? [];
        const total = payload?.meta?.total ?? incomingRows.length;

        const normalizedIncomingRows = incomingRows.map((row) =>
          row.id === selectedConversationIdRef.current && row.unreadCount > 0
            ? {
                ...row,
                unreadCount: 0
              }
            : row
        );

        const nextRows = isAppend
          ? (() => {
              const dedup = new Map<string, ConversationItem>();
              [...conversationsRef.current, ...normalizedIncomingRows].forEach((row) => {
                dedup.set(row.id, row);
              });
              return [...dedup.values()].sort((left, right) => {
                const leftMs = new Date(left.lastMessageAt ?? left.updatedAt).getTime();
                const rightMs = new Date(right.lastMessageAt ?? right.updatedAt).getTime();
                if (leftMs !== rightMs) {
                  return rightMs - leftMs;
                }
                return right.id.localeCompare(left.id);
              });
            })()
          : normalizedIncomingRows;

        const nextUnreadTotal = nextRows.reduce((totalUnread, row) => totalUnread + row.unreadCount, 0);
        const nextSnapshot = JSON.stringify(
          nextRows.map((row) => ({
            id: row.id,
            unreadCount: row.unreadCount,
            lastMessageAt: row.lastMessageAt,
            lastMessageType: row.lastMessageType,
            lastMessageDirection: row.lastMessageDirection,
            status: row.status,
            assignedToMemberId: row.assignedToMemberId,
            updatedAt: row.updatedAt
          }))
        );

        if (!isBackground || nextSnapshot !== conversationSnapshotRef.current || isAppend) {
          setConversations(nextRows);
          setMetaTotal(total);
          conversationSnapshotRef.current = nextSnapshot;
        }

        if (hasLoadedConversationListRef.current && nextUnreadTotal > previousUnreadTotalRef.current) {
          playInboundNotification();
        }
        previousUnreadTotalRef.current = nextUnreadTotal;
        hasLoadedConversationListRef.current = true;

        currentConversationsPageRef.current = targetPage;
        setHasMoreConversations(nextRows.length < total);

        if (nextRows.length === 0) {
          setSelectedConversationId(null);
          setSelectedConversation(null);
          setMessages([]);
          setHasMoreMessages(false);
          setSelectedProofMessageId(null);
          setTags([]);
          setCrmInvoices([]);
          setCrmActivity([]);
          return;
        }

        if (isAppend) {
          return;
        }

        const currentSelectedConversationId = selectedConversationIdRef.current;
        const nextConversationId =
          currentSelectedConversationId && nextRows.some((row) => row.id === currentSelectedConversationId)
            ? currentSelectedConversationId
            : null;

        setSelectedConversationId(nextConversationId);

        if (!nextConversationId && currentSelectedConversationId) {
          setSelectedConversation(null);
          setMessages([]);
          setHasMoreMessages(false);
          setSelectedProofMessageId(null);
          setTags([]);
          setCrmInvoices([]);
          setCrmActivity([]);
          return;
        }

        if (nextConversationId) {
          if (currentSelectedConversationId !== nextConversationId || !isBackground) {
            void loadConversation(nextConversationId, {
              background: isBackground
            });
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (!isBackground) {
          setError("Network error while loading conversations.");
        }
      } finally {
        if (isBackground) {
          lastBackgroundConversationsLoadAtRef.current = Date.now();
        }

        if (isAppend) {
          setIsLoadingMoreConversations(false);
        } else if (!isBackground) {
          setIsLoadingList(false);
        }
      }
    },
    [
      filter,
      loadConversation,
      orgId,
      playInboundNotification,
      setConversations,
      setCrmActivity,
      setCrmInvoices,
      setError,
      setHasMoreConversations,
      setHasMoreMessages,
      setIsLoadingList,
      setIsLoadingMoreConversations,
      setMessages,
      setMetaTotal,
      setSelectedConversation,
      setSelectedConversationId,
      setSelectedProofMessageId,
      setTags,
      statusFilter
    ]
  );

  const loadMoreConversations = useCallback(async () => {
    await loadConversations({
      append: true
    });
  }, [loadConversations]);

  useEffect(() => {
    let active = true;

    const loadOrganizations = async () => {
      try {
        const orgs = await fetchOrganizationsCached();
        if (active) {
          setOrganizations(orgs);
          setOrgId(orgs[0]?.id ?? null);
        }
      } catch {
        if (active) {
          setError("Network error while loading business.");
        }
      } finally {
        if (active) {
          setHasLoadedOrganizations(true);
        }
      }
    };

    void loadOrganizations();
    return () => {
      active = false;
    };
  }, [setError, setHasLoadedOrganizations, setOrgId, setOrganizations]);

  useEffect(() => {
    if (!hasLoadedOrganizations) {
      return;
    }

    currentConversationsPageRef.current = 1;
    void loadConversations();
  }, [filter, hasLoadedOrganizations, loadConversations, orgId, statusFilter]);

  useEffect(() => {
    if (!hasLoadedOrganizations) {
      return;
    }

    const nextQuery = conversationSearchQuery.trim();
    if (!nextQuery && !hasLoadedConversationListRef.current) {
      return;
    }

    if (conversationSearchDebounceRef.current) {
      clearTimeout(conversationSearchDebounceRef.current);
    }

    conversationSearchDebounceRef.current = setTimeout(() => {
      currentConversationsPageRef.current = 1;
      void loadConversations({
        query: conversationSearchQuery
      });
    }, 280);

    return () => {
      if (conversationSearchDebounceRef.current) {
        clearTimeout(conversationSearchDebounceRef.current);
        conversationSearchDebounceRef.current = null;
      }
    };
  }, [conversationSearchQuery, hasLoadedOrganizations, loadConversations]);

  useEffect(() => {
    if (!hasLoadedOrganizations || !orgId) {
      return;
    }

    const typingTimers = typingResetTimersRef.current;
    const realtimeMessageRefreshTimers = realtimeMessageRefreshTimersRef.current;
    const markReadTimers = markReadDebounceTimersRef.current;
    let active = true;
    let cleanup: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    const stopFallbackPolling = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const startFallbackPolling = () => {
      if (fallbackTimer) {
        return;
      }

      realtimeFallbackCountRef.current += 1;
      recordInboxTelemetry("realtime_fallback_activation_count", 1, { orgId });
      const attemptCount = Math.max(1, realtimeConnectionAttemptCountRef.current);
      recordInboxTelemetry("realtime_fallback_activation_rate", realtimeFallbackCountRef.current / attemptCount, {
        orgId
      });
      setRealtimeConnectionState("fallback");

      fallbackTimer = setInterval(() => {
        if (!active) {
          return;
        }
        if (document.visibilityState !== "visible") {
          return;
        }

        void loadConversations({ background: true });
        const currentSelectedId = selectedConversationIdRef.current;
        if (currentSelectedId) {
          void loadMessages(currentSelectedId, { background: true });
        }
      }, REALTIME_FALLBACK_POLL_INTERVAL_MS);
    };

    const scheduleRefresh = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      refreshTimer = setTimeout(() => {
        if (!active) {
          return;
        }

        void loadConversations({ background: true });
      }, 250);
    };

    const scheduleRealtimeMessagesRefresh = (conversationId: string, delayMs = 140) => {
      const existingTimer = realtimeMessageRefreshTimers.get(conversationId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        realtimeMessageRefreshTimers.delete(conversationId);
        void loadMessages(conversationId, { background: true });
      }, delayMs);

      realtimeMessageRefreshTimers.set(conversationId, timer);
    };

    const startSubscription = async () => {
      realtimeConnectionAttemptCountRef.current += 1;
      setRealtimeConnectionState("connecting");

      try {
        cleanup = await subscribeToOrgMessageEvents({
          orgId,
          onConnectionStateChange: (connectionState) => {
            if (!active) {
              return;
            }

            if (connectionState === "connected") {
              setRealtimeConnectionState("connected");
              stopFallbackPolling();
              return;
            }

            if (connectionState === "connecting" || connectionState === "initialized") {
              setRealtimeConnectionState(connectionState);
              return;
            }

            setRealtimeConnectionState(connectionState);
            startFallbackPolling();
          },
          onMessageNew: (payload) => {
            const parsedTimestamp = new Date(payload.timestamp);
            const eventTs = Number.isNaN(parsedTimestamp.getTime()) ? new Date().toISOString() : parsedTimestamp.toISOString();
            const selectedId = selectedConversationIdRef.current;

            setConversations((previousRows) => {
              const targetIndex = previousRows.findIndex((row) => row.id === payload.conversationId);
              if (targetIndex < 0) {
                return previousRows;
              }

              const target = previousRows[targetIndex];
              const currentLastMessageAtMs = target.lastMessageAt ? new Date(target.lastMessageAt).getTime() : 0;
              const eventTsMs = Number.isNaN(parsedTimestamp.getTime()) ? Date.now() : parsedTimestamp.getTime();
              const nextUnreadCount =
                payload.direction === "INBOUND"
                  ? selectedId === payload.conversationId
                    ? 0
                    : target.unreadCount + 1
                  : target.unreadCount;

              const nextTarget: ConversationItem = {
                ...target,
                status: "OPEN",
                unreadCount: nextUnreadCount,
                lastMessageAt: eventTsMs >= currentLastMessageAtMs ? eventTs : target.lastMessageAt,
                updatedAt: eventTsMs >= currentLastMessageAtMs ? eventTs : target.updatedAt,
                lastMessageDirection: payload.direction
              };

              const nextRows = previousRows.filter((row) => row.id !== payload.conversationId);
              nextRows.unshift(nextTarget);
              recalculateConversationSnapshot(nextRows);
              return nextRows;
            });

            if (selectedId === payload.conversationId) {
              setTypingConversationId(null);
              setSelectedConversation((current) => {
                if (!current || current.id !== payload.conversationId) {
                  return current;
                }

                return {
                  ...current,
                  status: "OPEN",
                  unreadCount: 0,
                  lastMessageAt: eventTs,
                  updatedAt: eventTs,
                  lastMessageDirection: payload.direction
                };
              });
              if (payload.direction === "INBOUND") {
                scheduleMarkConversationRead(payload.conversationId);
              }
              scheduleRealtimeMessagesRefresh(payload.conversationId);
            }

            if (payload.direction === "INBOUND" && payload.conversationId !== selectedId) {
              playInboundNotification();
            }

            scheduleRefresh();
          },
          onMessageStatus: (payload) => {
            let messageFound = false;

            const storeEntry = messageStoreRef.current.get(payload.conversationId);
            if (storeEntry) {
              const nextRows = storeEntry.rows.map((row) => {
                if (row.id !== payload.messageId) {
                  return row;
                }
                messageFound = true;
                return {
                  ...row,
                  sendStatus: payload.sendStatus,
                  deliveryStatus: payload.deliveryStatus,
                  sendError: payload.sendError,
                  retryable: payload.retryable,
                  sendAttemptCount: payload.sendAttemptCount,
                  deliveredAt: payload.deliveredAt,
                  readAt: payload.readAt
                };
              });

              if (messageFound) {
                upsertMessageStore(payload.conversationId, nextRows, storeEntry.hasMore, storeEntry.nextBeforeMessageId);
              }
            }

            if (selectedConversationIdRef.current === payload.conversationId) {
              setMessages((previousRows) => {
                let updated = false;
                const nextRows = previousRows.map((row) => {
                  if (row.id !== payload.messageId) {
                    return row;
                  }
                  updated = true;
                  return {
                    ...row,
                    sendStatus: payload.sendStatus,
                    deliveryStatus: payload.deliveryStatus,
                    sendError: payload.sendError,
                    retryable: payload.retryable,
                    sendAttemptCount: payload.sendAttemptCount,
                    deliveredAt: payload.deliveredAt,
                    readAt: payload.readAt
                  };
                });

                if (updated) {
                  messageFound = true;
                  return nextRows;
                }
                return previousRows;
              });

              if (!messageFound) {
                realtimeMessageStatusMismatchCountRef.current += 1;
                recordInboxTelemetry("realtime_status_mismatch_count", 1, {
                  orgId,
                  conversationId: payload.conversationId
                });
                if (realtimeMessageStatusMismatchCountRef.current % 5 === 0) {
                  console.info(`[realtime] message.status mismatch count=${realtimeMessageStatusMismatchCountRef.current}`);
                }
                scheduleRealtimeMessagesRefresh(payload.conversationId, 80);
              }
            }
          },
          onConversationUpdated: (payload) => {
            setConversations((previousRows) => {
              let changed = false;
              const nextRows = previousRows.map((row) => {
                if (row.id !== payload.conversationId) {
                  return row;
                }
                changed = true;
                return {
                  ...row,
                  status: payload.status,
                  assignedToMemberId: payload.assignedToMemberId,
                  crmPipelineId: payload.crmPipelineId === undefined ? row.crmPipelineId : payload.crmPipelineId,
                  crmStageId: payload.crmStageId === undefined ? row.crmStageId : payload.crmStageId,
                  crmStageName: payload.crmStageName === undefined ? row.crmStageName : payload.crmStageName,
                  updatedAt: payload.timestamp
                };
              });
              if (changed) {
                recalculateConversationSnapshot(nextRows);
              }
              return changed ? nextRows : previousRows;
            });
            setSelectedConversation((current) => {
              if (!current || current.id !== payload.conversationId) {
                return current;
              }
              return {
                ...current,
                status: payload.status,
                assignedToMemberId: payload.assignedToMemberId,
                crmPipelineId: payload.crmPipelineId === undefined ? current.crmPipelineId : payload.crmPipelineId,
                crmStageId: payload.crmStageId === undefined ? current.crmStageId : payload.crmStageId,
                crmStageName: payload.crmStageName === undefined ? current.crmStageName : payload.crmStageName,
                updatedAt: payload.timestamp
              };
            });
          },
          onAssignmentChanged: (payload) => {
            setConversations((previousRows) => {
              let changed = false;
              const nextRows = previousRows.map((row) => {
                if (row.id !== payload.conversationId) {
                  return row;
                }
                changed = true;
                return {
                  ...row,
                  status: payload.status,
                  assignedToMemberId: payload.assignedToMemberId,
                  updatedAt: payload.timestamp
                };
              });
              if (changed) {
                recalculateConversationSnapshot(nextRows);
              }
              return changed ? nextRows : previousRows;
            });
            setSelectedConversation((current) => {
              if (!current || current.id !== payload.conversationId) {
                return current;
              }
              return {
                ...current,
                status: payload.status,
                assignedToMemberId: payload.assignedToMemberId,
                updatedAt: payload.timestamp
              };
            });
          },
          onConversationTyping: (payload) => {
            const timerKey = payload.conversationId;
            const existingTimer = typingTimers.get(timerKey);
            if (existingTimer) {
              clearTimeout(existingTimer);
              typingTimers.delete(timerKey);
            }

            if (payload.isTyping) {
              setTypingConversationId(payload.conversationId);
              const resetTimer = setTimeout(() => {
                setTypingConversationId((current) => (current === payload.conversationId ? null : current));
                typingTimers.delete(timerKey);
              }, 6500);
              typingTimers.set(timerKey, resetTimer);
              return;
            }

            setTypingConversationId((current) => (current === payload.conversationId ? null : current));
          },
          onInvoiceCreated: () => {
            scheduleRefresh();
            const currentConversationId = selectedConversationIdRef.current;
            if (currentConversationId) {
              void loadConversationCrmContext(currentConversationId, { background: true });
              void loadConversation(currentConversationId, { background: true });
            }
          },
          onInvoiceUpdated: () => {
            scheduleRefresh();
            const currentConversationId = selectedConversationIdRef.current;
            if (currentConversationId) {
              void loadConversationCrmContext(currentConversationId, { background: true });
              void loadConversation(currentConversationId, { background: true });
            }
          },
          onInvoicePaid: () => {
            scheduleRefresh();
            const currentConversationId = selectedConversationIdRef.current;
            if (currentConversationId) {
              void loadConversationCrmContext(currentConversationId, { background: true });
              void loadConversation(currentConversationId, { background: true });
            }
          },
          onProofAttached: () => {
            scheduleRefresh();
            const currentConversationId = selectedConversationIdRef.current;
            if (currentConversationId) {
              void loadConversationCrmContext(currentConversationId, { background: true });
            }
          },
          onCustomerUpdated: scheduleRefresh,
          onStorageUpdated: scheduleRefresh
        });
      } catch (subscriptionError) {
        const message = subscriptionError instanceof Error ? subscriptionError.message : "Unknown realtime subscribe error";
        console.error(`[realtime] inbox subscription failed: ${message}`);
        startFallbackPolling();
      }
    };

    void startSubscription();

    return () => {
      active = false;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      stopFallbackPolling();

      if (cleanup) {
        cleanup();
      }

      typingTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      typingTimers.clear();

      markReadTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      markReadTimers.clear();

      realtimeMessageRefreshTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      realtimeMessageRefreshTimers.clear();
    };
  }, [
    hasLoadedOrganizations,
    loadConversation,
    loadConversationCrmContext,
    loadConversations,
    loadMessages,
    orgId,
    playInboundNotification,
    recalculateConversationSnapshot,
    scheduleMarkConversationRead,
    setConversations,
    setRealtimeConnectionState,
    setSelectedConversation,
    setTypingConversationId,
    upsertMessageStore,
    setMessages
  ]);

  const workspaceSubtitle = useMemo(() => {
    if (!orgId) {
      return "Belum ada bisnis tersedia.";
    }

    if (conversations.length > 0 && metaTotal > conversations.length) {
      return `${conversations.length}+ percakapan`;
    }

    return `${metaTotal} percakapan`;
  }, [conversations.length, metaTotal, orgId]);

  const activeOrgRole = useMemo(() => {
    if (!orgId) {
      return null;
    }

    return organizations.find((item) => item.id === orgId)?.role ?? null;
  }, [orgId, organizations]);

  return {
    workspaceSubtitle,
    activeOrgRole,
    loadMessages,
    loadOlderMessages,
    loadConversation,
    loadConversations,
    loadMoreConversations,
    loadCustomerCrmContext,
    loadConversationCrmContext
  };
}

export type InboxWorkspaceLoaders = ReturnType<typeof useInboxWorkspaceLoaders>;

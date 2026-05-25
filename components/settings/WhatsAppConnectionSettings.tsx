"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";
import { AlertCircle, CheckCircle2, Link2, Menu, MessageCircle, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";

import { useModalAccessibility } from "@/lib/a11y/useModalAccessibility";
import { fetchJsonCached, invalidateFetchCache } from "@/lib/client/fetchCache";
import { fetchOrganizationsCached } from "@/lib/client/orgsCache";
import { WhatsAppPublicApiPanel } from "@/components/settings/WhatsAppPublicApiPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsHeaderAction } from "@/components/settings/settings-header-actions";
import type {
  BusinessesResponse,
  BusinessSummary,
  StartPairingResponse,
  VerifyTestMessageResponse,
  WhatsAppReportResponse,
  WhatsAppConnectionContext,
  WhatsAppConnectionResponse
} from "@/components/settings/whatsapp/types";

type ApiErrorResponse = {
  error?: {
    message?: string;
  };
};

type WhatsAppReportData = NonNullable<WhatsAppReportResponse["data"]>["report"];

type ConnectMode = "qr" | "pairing_code";
type ActionPopupTone = "success" | "info" | "error";

const CONNECT_STEPS = [
  {
    title: "Buka WhatsApp",
    description: "Buka aplikasi WhatsApp di HP utama Anda.",
    icon: MessageCircle
  },
  {
    title: "Buka Menu Pengaturan",
    description: "Ketuk Titik Tiga di Android atau Pengaturan di iOS.",
    icon: Menu
  },
  {
    title: "Pilih Perangkat Tertaut",
    description: "Masuk ke menu Linked Devices lalu pilih Link a Device.",
    icon: Link2
  },
  {
    title: "Scan QR Code",
    description: "Arahkan kamera HP Anda ke QR code di sebelah kanan.",
    icon: Smartphone
  }
] as const;

function toErrorMessage(payload: ApiErrorResponse | null, fallback: string): string {
  return payload?.error?.message ?? fallback;
}

function shortSessionLabel(value: string): string {
  if (!value) {
    return "-";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...`;
}

function formatConnectedSince(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function WhatsAppConnectionSettings() {
  const [activeBusiness, setActiveBusiness] = useState<BusinessSummary | null>(null);
  const [connectionContext, setConnectionContext] = useState<WhatsAppConnectionContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingConnection, setIsLoadingConnection] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showConnectedSplash, setShowConnectedSplash] = useState(false);
  const [connectMode, setConnectMode] = useState<ConnectMode>("qr");
  const [pairingPhoneNumber, setPairingPhoneNumber] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [testPhoneE164, setTestPhoneE164] = useState("");
  const [isSendingTestMessage, setIsSendingTestMessage] = useState(false);
  const [isRequestingConnect, setIsRequestingConnect] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [qrCountdownSeconds, setQrCountdownSeconds] = useState(0);
  const [actionPopup, setActionPopup] = useState<{
    title: string;
    description: string;
    tone: ActionPopupTone;
  } | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [reportData, setReportData] = useState<WhatsAppReportData | null>(null);
  const connectModalContainerRef = useRef<HTMLDivElement | null>(null);
  const connectModalCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const reportModalContainerRef = useRef<HTMLDivElement | null>(null);
  const reportModalCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const silentRefreshInFlightRef = useRef(false);
  const connectionContextRef = useRef<WhatsAppConnectionContext | null>(null);

  useModalAccessibility({
    open: isModalOpen,
    onClose: () => setIsModalOpen(false),
    containerRef: connectModalContainerRef,
    initialFocusRef: connectModalCloseButtonRef
  });

  useModalAccessibility({
    open: isReportOpen,
    onClose: () => setIsReportOpen(false),
    containerRef: reportModalContainerRef,
    initialFocusRef: reportModalCloseButtonRef
  });

  const showActionPopup = useCallback((title: string, description: string, tone: ActionPopupTone) => {
    setActionPopup({ title, description, tone });
  }, []);

  useEffect(() => {
    connectionContextRef.current = connectionContext;
  }, [connectionContext]);

  const loadBusiness = useCallback(async () => {
    const organizations = ((await fetchOrganizationsCached()) as NonNullable<BusinessesResponse["data"]>["organizations"] | undefined) ?? [];
    const business = organizations[0] ?? null;
    setActiveBusiness(business);
    return business;
  }, []);

  const loadConnectionContext = useCallback(async (options?: { refresh?: boolean; silent?: boolean }) => {
    if (options?.silent && silentRefreshInFlightRef.current) {
      return connectionContextRef.current;
    }

    if (options?.silent) {
      silentRefreshInFlightRef.current = true;
    } else {
      setIsLoadingConnection(true);
    }
    try {
      const searchParams = new URLSearchParams();
      if (options?.refresh) {
        searchParams.set("refresh", "1");
      }

      const payload = await fetchJsonCached<WhatsAppConnectionResponse | null>(
        `/api/whatsapp/baileys${searchParams.size ? `?${searchParams.toString()}` : ""}`,
        {
          ttlMs: options?.silent ? 2_000 : 8_000,
          init: { cache: "no-store" }
        }
      );

      const context = payload?.data?.connection ?? null;
      setConnectionContext(context);
      return context;
    } finally {
      if (options?.silent) {
        silentRefreshInFlightRef.current = false;
      } else {
        setIsLoadingConnection(false);
      }
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        setIsLoading(true);
        setError(null);
        const [business] = await Promise.all([loadBusiness(), loadConnectionContext()]);
        if (!mounted) {
          return;
        }

        if (!business) {
          setConnectionContext(null);
        }
      } catch (loadError) {
        if (mounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to initialize WhatsApp settings.");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [loadBusiness, loadConnectionContext]);

  useEffect(() => {
    if (!connectionContext?.connectedAccount?.displayPhone || testPhoneE164) {
      return;
    }

    setTestPhoneE164(connectionContext.connectedAccount.displayPhone);
  }, [connectionContext?.connectedAccount?.displayPhone, testPhoneE164]);

  useEffect(() => {
    if (!isModalOpen) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadConnectionContext({ silent: true }).catch(() => {
        // keep last known state
      });
    }, 2500);

    return () => {
      window.clearInterval(timer);
    };
  }, [isModalOpen, loadConnectionContext]);

  useEffect(() => {
    let cancelled = false;

    if (!connectionContext?.qrCode || connectionContext.qrCode === "ALREADY_CONNECTED") {
      setQrDataUrl(null);
      return;
    }

    void QRCode.toDataURL(connectionContext.qrCode, {
      margin: 1,
      width: 280,
      color: {
        dark: "#111827",
        light: "#ffffff"
      }
    })
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectionContext?.qrCode]);

  useEffect(() => {
    const expiresAtValue = connectionContext?.qrCodeExpiresAt;
    if (!expiresAtValue || !connectionContext?.qrCode || connectionContext.qrCode === "ALREADY_CONNECTED") {
      setQrCountdownSeconds(0);
      return;
    }

    const computeRemaining = () => {
      const remaining = Math.max(0, Math.ceil((new Date(expiresAtValue).getTime() - Date.now()) / 1000));
      setQrCountdownSeconds(remaining);
    };

    computeRemaining();
    const timer = window.setInterval(computeRemaining, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [connectionContext?.qrCode, connectionContext?.qrCodeExpiresAt]);

  const effectiveConnectionStatus = useMemo(() => {
    return connectionContext?.connectionStatus ?? "DISCONNECTED";
  }, [connectionContext]);
  const requiresReconnect = useMemo(() => {
    return connectionContext?.lastError?.includes("Reconnect from Settings.") ?? false;
  }, [connectionContext?.lastError]);

  useEffect(() => {
    if (!isModalOpen || effectiveConnectionStatus !== "CONNECTED") {
      return;
    }

    setShowConnectedSplash(true);
    setInfo("WhatsApp connected successfully.");
    showActionPopup("WhatsApp Connected", "Perangkat berhasil tertaut dan siap dipakai.", "success");

    const closeTimer = window.setTimeout(() => {
      setShowConnectedSplash(false);
      setIsModalOpen(false);
      setConnectMode("qr");
      setQrDataUrl(null);
    }, 1800);

    return () => {
      window.clearTimeout(closeTimer);
    };
  }, [effectiveConnectionStatus, isModalOpen, showActionPopup]);

  useEffect(() => {
    if (!actionPopup) {
      return;
    }

    const timer = window.setTimeout(() => {
      setActionPopup(null);
    }, 2600);

    return () => {
      window.clearTimeout(timer);
    };
  }, [actionPopup]);

  const primaryConnectLabel = useMemo(() => {
    if (effectiveConnectionStatus === "CONNECTED") {
      return "Reconnect WhatsApp";
    }

    if (connectionContext?.connectedAccount || connectionContext?.lastError) {
      return "Reconnect WhatsApp";
    }

    return "Hubungkan WhatsApp";
  }, [connectionContext?.connectedAccount, connectionContext?.lastError, effectiveConnectionStatus]);

  const qrIsExpired = connectMode === "qr" && Boolean(connectionContext?.qrCode) && qrCountdownSeconds === 0;

  const requestQrCode = useCallback(async () => {
    setIsRequestingConnect(true);
    setError(null);
    setInfo(null);
    try {
      const response = await fetch("/api/whatsapp/baileys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ mode: "qr" })
      });
      const payload = (await response.json().catch(() => null)) as StartPairingResponse | null;
      if (!response.ok) {
        throw new Error(toErrorMessage(payload, "Failed to generate QR code."));
      }

      const qrPayload = payload?.data?.qr;
      invalidateFetchCache("GET:/api/whatsapp/baileys");
      if (qrPayload?.qrCode) {
        setConnectionContext((current) => ({
          orgId: current?.orgId ?? activeBusiness?.id ?? "",
          provider: "BAILEYS",
          connectionStatus: qrPayload.connectionStatus,
          lastError: null,
          qrCode: qrPayload.qrCode,
          qrCodeExpiresAt: new Date(Date.now() + qrPayload.expiresInSeconds * 1000).toISOString(),
          pairingCode: null,
          pairingCodeExpiresAt: null,
          connectedAccount: current?.connectedAccount ?? null
        }));
      }

      const message = qrPayload?.qrCode === "ALREADY_CONNECTED" ? "WhatsApp is already connected." : "QR code generated.";
      setInfo(message);
      showActionPopup("QR Updated", message, "success");
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Failed to generate QR code.";
      setError(message);
      showActionPopup("QR Failed", message, "error");
      throw requestError;
    } finally {
      setIsRequestingConnect(false);
    }
  }, [activeBusiness?.id, showActionPopup]);

  const handleOpenModal = useCallback(async () => {
    if (!activeBusiness) {
      setError("No business is available for this account.");
      return;
    }

    setError(null);
    setInfo(null);
    setShowConnectedSplash(false);
    setIsModalOpen(true);
    setConnectMode("qr");

    try {
      await requestQrCode();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Failed to start QR connection.";
      setError(message);
      showActionPopup("QR Failed", message, "error");
    }
  }, [activeBusiness, requestQrCode, showActionPopup]);

  async function handleGeneratePairingCode() {
    if (!activeBusiness) {
      setError("No business is available for this account.");
      return;
    }

    setIsRequestingConnect(true);
    setError(null);
    setInfo(null);

    try {
      const response = await fetch("/api/whatsapp/baileys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          mode: "pairing_code",
          phoneNumber: pairingPhoneNumber
        })
      });
      const payload = (await response.json().catch(() => null)) as StartPairingResponse | null;
      if (!response.ok) {
        throw new Error(toErrorMessage(payload, "Failed to generate pairing code."));
      }

      const pairingPayload = payload?.data?.pairing;
      invalidateFetchCache("GET:/api/whatsapp/baileys");
      if (pairingPayload?.pairingCode) {
        setConnectionContext((current) => ({
          orgId: current?.orgId ?? activeBusiness.id,
          provider: "BAILEYS",
          connectionStatus: pairingPayload.connectionStatus,
          lastError: null,
          qrCode: null,
          qrCodeExpiresAt: null,
          pairingCode: pairingPayload.pairingCode,
          pairingCodeExpiresAt: new Date(Date.now() + pairingPayload.expiresInSeconds * 1000).toISOString(),
          connectedAccount: current?.connectedAccount ?? null
        }));
      }

      const pairingCode = pairingPayload?.pairingCode ?? "";
      const message = pairingCode === "ALREADY_CONNECTED" ? "WhatsApp is already connected." : `Pairing code generated: ${pairingCode}`;
      setInfo(message);
      showActionPopup("Auth Code Ready", pairingCode === "ALREADY_CONNECTED" ? message : "Gunakan kode ini di perangkat WhatsApp Anda.", "success");
      if (!testPhoneE164 && pairingPhoneNumber.trim()) {
        setTestPhoneE164(`+${pairingPhoneNumber.trim().replace(/\D/g, "")}`);
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Failed to generate pairing code.";
      setError(message);
      showActionPopup("Auth Code Failed", message, "error");
    } finally {
      setIsRequestingConnect(false);
    }
  }

  async function handleDisconnect() {
    if (!activeBusiness) {
      return;
    }

    setIsDisconnecting(true);
    setError(null);
    setInfo(null);
    try {
      const response = await fetch("/api/whatsapp/baileys", { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as ApiErrorResponse | null;
      if (!response.ok) {
        throw new Error(toErrorMessage(payload, "Failed to disconnect WhatsApp."));
      }

      invalidateFetchCache("GET:/api/whatsapp/baileys");
      setConnectionContext((current) => ({
        orgId: current?.orgId ?? activeBusiness.id,
        provider: "BAILEYS",
        connectionStatus: "DISCONNECTED",
        lastError: null,
        qrCode: null,
        qrCodeExpiresAt: null,
        pairingCode: null,
        pairingCodeExpiresAt: null,
        connectedAccount: null
      }));
      setInfo("WhatsApp session disconnected.");
      showActionPopup("WhatsApp Disconnected", "Sesi berhasil diputus dari perangkat ini.", "info");
      setQrDataUrl(null);
      setShowConnectedSplash(false);
    } catch (disconnectError) {
      const message = disconnectError instanceof Error ? disconnectError.message : "Failed to disconnect WhatsApp.";
      setError(message);
      showActionPopup("Disconnect Failed", message, "error");
    } finally {
      setIsDisconnecting(false);
    }
  }

  const handleRefreshStatus = useCallback(async () => {
    setError(null);
    setInfo(null);

    try {
      const context = await loadConnectionContext({ refresh: true });
      if (context?.lastError?.includes("Reconnect from Settings.")) {
        setInfo("Status refreshed. Session lama sudah dibersihkan dan perlu dipair ulang.");
        showActionPopup("Reconnect Required", "Session WhatsApp lama tidak valid. Silakan reconnect dari Settings.", "info");
        return;
      }

      if (context?.connectionStatus === "CONNECTED" || context?.connectedAccount) {
        setInfo("Status refreshed. WhatsApp session is online.");
        showActionPopup("Status Refreshed", "Koneksi WhatsApp aktif dan siap dicek ulang.", "success");
        return;
      }

      setInfo("Status refreshed. Jika perangkat baru selesai pair, tunggu beberapa detik lalu coba lagi.");
      showActionPopup("Status Updated", "Belum online. Anda bisa reconnect atau generate QR ulang.", "info");
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : "Failed to refresh WhatsApp status.";
      setError(message);
      showActionPopup("Refresh Failed", message, "error");
    }
  }, [loadConnectionContext, showActionPopup]);

  const refreshAction = useMemo(
    () => (
      <Button variant="secondary" onClick={() => void handleRefreshStatus()} disabled={isLoadingConnection} className="h-10 rounded-xl">
        <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingConnection ? "animate-spin" : ""}`} />
        Refresh Status
      </Button>
    ),
    [handleRefreshStatus, isLoadingConnection]
  );
  const connectAction = useMemo(
    () => (
      <Button onClick={() => void handleOpenModal()} disabled={!activeBusiness} className="h-10 rounded-xl">
        {primaryConnectLabel}
      </Button>
    ),
    [activeBusiness, handleOpenModal, primaryConnectLabel]
  );

  useSettingsHeaderAction("10-whatsapp-refresh", refreshAction);
  useSettingsHeaderAction("20-whatsapp-connect", connectAction);

  async function handleSendTestMessage() {
    if (!activeBusiness || !testPhoneE164.trim()) {
      setError("Enter a valid test phone number first.");
      return;
    }

    setIsSendingTestMessage(true);
    setError(null);
    setInfo(null);

    try {
      const response = await fetch("/api/whatsapp/test-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          toPhoneE164: testPhoneE164.trim()
        })
      });
      const payload = (await response.json().catch(() => null)) as VerifyTestMessageResponse | null;
      if (!response.ok) {
        throw new Error(toErrorMessage(payload, "Failed to send test message."));
      }

      const message = payload?.data?.verification?.waMessageId
        ? `Test message sent: ${payload.data.verification.waMessageId}`
        : "Test message sent.";
      setInfo(message);
      showActionPopup("Test Message Sent", "Pesan uji berhasil dikirim ke nomor tujuan.", "success");
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Failed to send test message.";
      setError(message);
      showActionPopup("Test Message Failed", message, "error");
    } finally {
      setIsSendingTestMessage(false);
    }
  }

  async function handleOpenReport() {
    if (!activeBusiness) {
      return;
    }

    setIsReportOpen(true);
    setIsLoadingReport(true);
    setError(null);

    try {
      const payload = await fetchJsonCached<WhatsAppReportResponse | null>("/api/whatsapp/report", {
        ttlMs: 8_000,
        init: { cache: "no-store" }
      });

      setReportData(payload?.data?.report ?? null);
      showActionPopup("Report Loaded", "Informasi nomor WhatsApp berhasil diperbarui.", "success");
    } catch (reportError) {
      const message = reportError instanceof Error ? reportError.message : "Failed to load WhatsApp report.";
      setError(message);
      showActionPopup("Report Failed", message, "error");
    } finally {
      setIsLoadingReport(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="rounded-[28px] border border-border/70 bg-gradient-to-b from-card to-card/90 p-5 md:p-6 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] relative overflow-hidden group">
          <div className="flex items-center justify-between gap-3 relative z-10">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-muted-foreground/80">Business</p>
              <h2 className="mt-1.5 text-[20px] font-bold tracking-tight text-foreground">{activeBusiness?.name ?? "No business found"}</h2>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/50 px-3 py-1.5 text-[13px] font-semibold text-foreground shadow-sm">
              {activeBusiness?.role ?? "OWNER"}
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 relative z-10">
            <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-background/80 to-muted/20 p-5 shadow-sm transition-all hover:border-primary/20 hover:shadow-md">
              <p className="text-[13px] font-semibold text-muted-foreground">Status</p>
              <div className="mt-3">
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-[13px] font-semibold shadow-sm ${
                    effectiveConnectionStatus === "CONNECTED"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20"
                      : effectiveConnectionStatus === "PAIRING"
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20"
                        : "bg-muted text-muted-foreground ring-1 ring-inset ring-border/50"
                  }`}
                >
                  {effectiveConnectionStatus}
                </span>
              </div>
            </div>
            <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-background/80 to-muted/20 p-5 shadow-sm transition-all hover:border-primary/20 hover:shadow-md flex flex-col justify-between items-start">
              <p className="text-[13px] font-semibold text-muted-foreground">Connected Number</p>
              <div className="mt-1 flex w-full items-center justify-between">
                <p className="text-[16px] font-bold text-foreground font-mono">{connectionContext?.connectedAccount?.displayPhone ?? "-"}</p>
                {connectionContext?.connectedAccount ? (
                  <Button size="sm" variant="ghost" className="h-8 rounded-xl px-2.5 text-primary hover:bg-primary/10" onClick={() => void handleOpenReport()}>
                    Lihat Report
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-[24px] border border-border/60 bg-gradient-to-br from-background/80 to-muted/20 p-5 shadow-sm relative z-10">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-bold text-foreground">Session Health</h3>
                <p className="mt-1 text-[13px] font-medium text-muted-foreground/80">Pantau status koneksi sebelum testing real device.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {effectiveConnectionStatus === "CONNECTED" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[13px] font-semibold text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20 shadow-sm">
                    <CheckCircle2 className="h-4 w-4" />
                    Connected
                  </span>
                ) : null}
                {effectiveConnectionStatus === "DISCONNECTED" ? (
                  <Button size="sm" variant="secondary" className="rounded-xl h-8 text-[13px]" onClick={() => void handleOpenModal()} disabled={isRequestingConnect}>
                    {requiresReconnect ? "Pair Ulang" : "Reconnect"}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border/50 bg-background/50 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">Session ID</p>
                <div className="mt-2.5 rounded-xl border border-border/60 bg-background px-3 py-2 shadow-sm">
                   <p className="font-mono text-[14px] font-medium text-foreground break-all">
                    {shortSessionLabel(connectionContext?.connectedAccount?.id ?? activeBusiness?.id ?? "")}
                   </p>
                </div>
                <p className="mt-2.5 text-[12px] font-medium text-muted-foreground/70">Disimpan secara lokal untuk MVP Baileys.</p>
              </div>

              <div className="rounded-2xl border border-border/50 bg-background/50 p-4 flex flex-col justify-center">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">Encrypted Channel</p>
                <div className="mt-3 flex items-start gap-2.5 text-[13px] font-medium leading-relaxed text-muted-foreground/80">
                  <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                  <span>End-to-end encrypted by WhatsApp multi-device</span>
                </div>
              </div>
            </div>

            {connectionContext?.lastError ? (
              <div
                className={`mt-5 rounded-xl px-4 py-3 text-[13px] font-medium shadow-sm ${
                  requiresReconnect
                    ? "border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border border-destructive/20 bg-destructive/10 text-destructive"
                }`}
              >
                <p>{connectionContext.lastError}</p>
                {requiresReconnect ? (
                  <p className="mt-1.5 text-[12px] font-medium text-amber-700/90 dark:text-amber-300/90">
                    Session lama sudah tidak bisa dipakai. Gunakan QR atau Auth Code untuk menautkan ulang perangkat.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-[28px] border border-border/70 bg-gradient-to-b from-card to-card/90 p-5 md:p-6 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] relative overflow-hidden group">
          <div className="flex items-start justify-between gap-3 relative z-10">
            <div>
              <h2 className="text-[20px] font-bold tracking-tight text-foreground">Quick Verification</h2>
              <p className="mt-1.5 text-[13px] font-medium leading-relaxed text-muted-foreground/80">Kirim test message setelah perangkat berhasil terhubung.</p>
            </div>
            <Button variant="secondary" size="sm" className="rounded-xl h-9 whitespace-nowrap" onClick={() => void handleDisconnect()} disabled={!activeBusiness || isDisconnecting}>
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </Button>
          </div>

          <div className="mt-6 flex flex-col sm:flex-row items-center gap-3 relative z-10 w-full">
            <Input
              className="h-10 rounded-xl border-border/60 bg-background/50 focus-visible:ring-primary shadow-sm flex-1 w-full"
              value={testPhoneE164}
              onChange={(event) => setTestPhoneE164(event.target.value)}
              placeholder="Target phone (+628...)"
            />
            <Button
              className="h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shrink-0 px-5 w-full sm:w-auto"
              onClick={() => void handleSendTestMessage()}
              disabled={!activeBusiness || isSendingTestMessage || effectiveConnectionStatus !== "CONNECTED"}
            >
              {isSendingTestMessage ? "Sending..." : "Send Test Message"}
            </Button>
          </div>

          <div className="mt-6 rounded-2xl border border-border/60 bg-gradient-to-br from-background/80 to-muted/20 p-5 shadow-sm relative z-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">Readiness</p>
            <p className="mt-2.5 text-[13.5px] font-medium leading-relaxed text-foreground">
              {effectiveConnectionStatus === "CONNECTED"
                ? "Perangkat sudah online. Anda bisa refresh status sekali lalu kirim pesan uji."
                : effectiveConnectionStatus === "PAIRING"
                  ? "WhatsApp masih menyelesaikan pairing. Tunggu status berubah menjadi Connected."
                  : requiresReconnect
                    ? "Session lama sudah invalid dan telah dibersihkan. Lakukan pair ulang dari Settings sebelum verifikasi."
                  : connectionContext?.connectedAccount
                    ? "Nomor sudah tertaut, tetapi socket sedang tertutup. Klik Refresh Status atau Reconnect WhatsApp."
                    : "Hubungkan perangkat WhatsApp terlebih dahulu sebelum verifikasi."}
            </p>
          </div>

          {isLoading || isLoadingConnection ? <p className="mt-5 text-[13px] font-medium text-muted-foreground animate-pulse relative z-10">Loading connection state...</p> : null}
          {error ? <p className="mt-5 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-[13px] font-medium text-destructive shadow-sm relative z-10">{error}</p> : null}
          {info ? <p className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-[13px] font-medium text-emerald-600 dark:text-emerald-400 shadow-sm relative z-10">{info}</p> : null}
        </div>
      </div>

      <WhatsAppPublicApiPanel activeBusiness={activeBusiness} />

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 px-4 py-8" role="dialog" aria-modal="true" aria-label="Tautkan perangkat WhatsApp">
          <div
            ref={connectModalContainerRef}
            className="relative grid w-full max-w-5xl overflow-hidden rounded-[32px] border border-border/80 bg-background shadow-2xl shadow-black/35 lg:grid-cols-[400px_minmax(0,1fr)]"
          >
            <div className="bg-background p-8 lg:border-r lg:border-border/70">
              <div className="absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,hsl(var(--primary)),hsl(var(--primary))/0.3)]" />
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
                <Smartphone className="h-6 w-6" />
              </div>
              <h2 className="mt-6 text-3xl font-semibold tracking-tight text-foreground">Tautkan Perangkat</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                Ikuti langkah-langkah di bawah ini untuk menghubungkan WhatsApp Anda ke sistem 20byte.
              </p>

              <div className="mt-10 space-y-5">
                {CONNECT_STEPS.map((step, index) => {
                  const Icon = step.icon;
                  const isActive = index === 3 && connectMode === "qr";
                  return (
                    <div key={step.title} className="flex items-start gap-4">
                      <div
                        className={`flex h-11 w-11 items-center justify-center rounded-full border ${
                          isActive
                            ? "border-primary/30 bg-primary text-primary-foreground"
                            : "border-border/80 bg-background text-primary"
                        }`}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-base font-semibold text-foreground">{step.title}</p>
                        <p className={`mt-1 text-sm ${isActive ? "text-primary" : "text-muted-foreground"}`}>{step.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="relative bg-card p-8">
              {showConnectedSplash ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/92 backdrop-blur-sm">
                  <div className="settings-success-pop flex max-w-sm flex-col items-center rounded-[28px] border border-emerald-500/20 bg-card px-8 py-10 text-center shadow-xl">
                    <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-10 w-10" />
                    </div>
                    <h3 className="mt-5 text-2xl font-semibold text-foreground">WhatsApp Connected</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Perangkat berhasil terhubung. Popup akan ditutup otomatis dan settings diperbarui.
                    </p>
                  </div>
                </div>
              ) : null}

              <button
                ref={connectModalCloseButtonRef}
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="absolute right-5 top-5 inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/80 bg-background/80 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <X className="h-5 w-5" />
                <span className="sr-only">Close</span>
              </button>

              <div className="pr-12">
                <div className="inline-flex rounded-full border border-border/80 bg-background/70 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setConnectMode("qr");
                      void requestQrCode().catch((requestError: unknown) => {
                        setError(requestError instanceof Error ? requestError.message : "Failed to refresh QR code.");
                      });
                    }}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                      connectMode === "qr" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Scan QR
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnectMode("pairing_code")}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                      connectMode === "pairing_code" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Auth Code
                  </button>
                </div>
              </div>

              <div className="mt-12 flex min-h-[460px] flex-col items-center justify-center">
                {connectMode === "qr" ? (
                  <>
                    <div className="relative rounded-[28px] border-2 border-primary/60 bg-white p-5 shadow-[0_20px_60px_-20px_rgba(17,24,39,0.35)]">
                      <div className="pointer-events-none absolute inset-0 rounded-[28px] border-2 border-primary/20" />
                      {qrDataUrl ? (
                        <Image src={qrDataUrl} alt="WhatsApp QR code" width={280} height={280} unoptimized className="h-[280px] w-[280px]" />
                      ) : (
                        <div className="flex h-[280px] w-[280px] items-center justify-center rounded-2xl bg-muted/40 text-sm text-muted-foreground">
                          {isRequestingConnect ? "Generating QR..." : "QR akan muncul di sini"}
                        </div>
                      )}
                    </div>

                    <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                      <div className="rounded-full border border-border/80 bg-background/70 px-4 py-2 text-sm text-foreground">
                        {qrDataUrl && !qrIsExpired ? `QR berlaku ${qrCountdownSeconds} detik` : "QR code expired"}
                      </div>
                      <Button variant="secondary" onClick={() => void requestQrCode()} disabled={isRequestingConnect}>
                        {isRequestingConnect ? "Generating..." : "Generate Ulang QR"}
                      </Button>
                    </div>

                    <div className="mt-10 w-full max-w-sm rounded-2xl border border-border/80 bg-background/70 px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Session ID</span>
                        <span className="rounded-xl bg-muted px-3 py-1.5 font-mono text-sm text-foreground">
                          {shortSessionLabel(connectionContext?.connectedAccount?.id ?? activeBusiness?.id ?? "")}
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                      Terenkripsi end-to-end oleh WhatsApp
                    </div>
                  </>
                ) : (
                  <div className="w-full max-w-md rounded-[28px] border border-border/80 bg-background/70 p-6 shadow-sm">
                    <h3 className="text-xl font-semibold text-foreground">Generate Pairing Code</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Gunakan auth code jika Anda tidak ingin scan QR. Masukkan nomor WhatsApp utama dalam format numerik dengan
                      kode negara.
                    </p>
                    <div className="mt-5 space-y-3">
                      <Input
                        value={pairingPhoneNumber}
                        onChange={(event) => setPairingPhoneNumber(event.target.value)}
                        placeholder="628123456789"
                      />
                      <Button onClick={() => void handleGeneratePairingCode()} disabled={isRequestingConnect || !pairingPhoneNumber.trim()}>
                        {isRequestingConnect ? "Generating..." : "Generate Pairing Code"}
                      </Button>
                    </div>

                    {connectionContext?.pairingCode ? (
                      <div className="mt-6 rounded-2xl border border-primary/30 bg-primary/10 px-5 py-4">
                        <p className="text-xs uppercase tracking-[0.22em] text-primary">Auth Code</p>
                        <p className="mt-2 break-all font-mono text-3xl font-semibold tracking-[0.24em] text-foreground">
                          {connectionContext.pairingCode}
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isReportOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 px-4 py-8" role="dialog" aria-modal="true" aria-label="WhatsApp report">
          <div ref={reportModalContainerRef} className="relative w-full max-w-5xl overflow-hidden rounded-[32px] border border-border/80 bg-background shadow-2xl shadow-black/35">
            <button
              ref={reportModalCloseButtonRef}
              type="button"
              onClick={() => setIsReportOpen(false)}
              className="absolute right-5 top-5 inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/80 bg-background/80 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-5 w-5" />
              <span className="sr-only">Close report</span>
            </button>

            <div className="border-b border-border/70 px-8 py-7">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
                  <RefreshCw className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-3xl font-semibold tracking-tight text-foreground">
                    {activeBusiness?.name ?? "WhatsApp Report"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {reportData?.connectedAccount?.displayPhone ?? connectionContext?.connectedAccount?.displayPhone ?? "-"}
                    {" • "}
                    {reportData?.technical.connectedSince ? "connected" : "created"}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-6 px-8 py-7">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    label: "Incoming Today",
                    value: reportData?.metrics.incomingToday ?? 0,
                    helper: "Messages",
                    color: "text-blue-600"
                  },
                  {
                    label: "Outgoing Today",
                    value: reportData?.metrics.outgoingToday ?? 0,
                    helper: "Messages",
                    color: "text-emerald-600"
                  },
                  {
                    label: "Failed Today",
                    value: reportData?.metrics.failedToday ?? 0,
                    helper: "Errors",
                    color: "text-slate-400"
                  },
                  {
                    label: "Broadcast (Month)",
                    value: reportData?.metrics.broadcastMonth ?? 0,
                    helper: "Template sends",
                    color: "text-violet-600"
                  }
                ].map((item) => (
                  <div key={item.label} className="rounded-[24px] border border-border/80 bg-card px-5 py-5 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{item.label}</p>
                    <p className={`mt-3 text-4xl font-semibold ${item.color}`}>{item.value}</p>
                    <p className="mt-2 text-sm text-muted-foreground">{item.helper}</p>
                  </div>
                ))}
              </div>

              <div className="overflow-hidden rounded-[24px] border border-border/80 bg-card shadow-sm">
                <div className="border-b border-border/70 px-5 py-4">
                  <h3 className="text-xl font-semibold text-foreground">Agent Activity (Last 30 Days)</h3>
                </div>
                <div className="grid grid-cols-[minmax(0,1.2fr)_180px_160px] gap-4 border-b border-border/70 px-5 py-4 text-sm font-semibold text-muted-foreground">
                  <div>Agent Name</div>
                  <div>Messages Sent</div>
                  <div>Performance</div>
                </div>
                {isLoadingReport ? (
                  <div className="px-5 py-14 text-center text-sm text-muted-foreground">Loading report...</div>
                ) : reportData?.agentActivity?.length ? (
                  reportData.agentActivity.map((item: NonNullable<WhatsAppReportData>["agentActivity"][number]) => (
                    <div key={item.memberId} className="grid grid-cols-[minmax(0,1.2fr)_180px_160px] gap-4 px-5 py-4 text-sm">
                      <div className="font-medium text-foreground">{item.agentName}</div>
                      <div className="text-foreground">{item.messagesSent}</div>
                      <div className="text-muted-foreground">{item.performance}</div>
                    </div>
                  ))
                ) : (
                  <div className="px-5 py-14 text-center text-sm text-muted-foreground">No agent activity recorded yet.</div>
                )}
              </div>

              <div className="rounded-[24px] border border-slate-800/80 bg-slate-900 px-5 py-5 text-slate-100 shadow-sm">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <ShieldCheck className="h-4 w-4" />
                  Technical Details
                </h3>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                  <div className="flex items-center justify-between gap-4 border-b border-slate-700/80 py-2">
                    <span className="text-slate-400">Session ID</span>
                    <span className="font-mono text-right">{shortSessionLabel(reportData?.technical.sessionId ?? activeBusiness?.id ?? "-")}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-slate-700/80 py-2">
                    <span className="text-slate-400">Connected Since</span>
                    <span className="text-right">{formatConnectedSince(reportData?.technical.connectedSince)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-slate-700/80 py-2">
                    <span className="text-slate-400">Uptime</span>
                    <span className={reportData?.technical.status === "CONNECTED" ? "text-emerald-400" : "text-amber-300"}>
                      {reportData?.technical.uptimeLabel ?? "Not connected"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-slate-700/80 py-2">
                    <span className="text-slate-400">Status</span>
                    <span className="text-right">{reportData?.technical.status ?? effectiveConnectionStatus}</span>
                  </div>
                </div>
                {reportData?.technical.lastError ? (
                  <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {reportData.technical.lastError}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {actionPopup ? (
        <div className="pointer-events-none fixed right-6 top-6 z-[60] max-w-sm">
          <div
            className={`settings-success-pop rounded-[24px] border px-4 py-4 shadow-2xl ${
              actionPopup.tone === "success"
                ? "border-emerald-500/25 bg-background text-foreground"
                : actionPopup.tone === "error"
                  ? "border-destructive/30 bg-background text-foreground"
                  : "border-primary/25 bg-background text-foreground"
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full ${
                  actionPopup.tone === "success"
                    ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                    : actionPopup.tone === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-primary"
                }`}
              >
                {actionPopup.tone === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              </div>
              <div>
                <p className="text-sm font-semibold">{actionPopup.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{actionPopup.description}</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

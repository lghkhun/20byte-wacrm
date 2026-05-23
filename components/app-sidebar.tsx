"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, BarChart3, Bot, FileText, LayoutDashboard, Link2, MessageCircle, Shield, Users, Wallet, Workflow, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";

import { BusinessSwitcher } from "@/components/layout/BusinessSwitcher";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { SidebarOnboardingCard } from "@/components/onboarding/OwnerOnboardingView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail
} from "@/components/ui/sidebar";
import { fetchJsonCached, invalidateFetchCache } from "@/lib/client/fetchCache";
import { resolveCheckoutPaymentMethod } from "@/lib/payment/checkoutFallback";
import { dismissNotify, notifyLoading } from "@/lib/ui/notify";
import type { OwnerOnboardingStatus } from "@/server/services/onboardingService";

type AppSidebarProps = {
  user: {
    email: string;
    name: string | null;
    avatarUrl?: string | null;
    isSuperadmin?: boolean;
    primaryOrgId?: string | null;
    primaryOrgRole?: "OWNER" | "ADMIN" | "CS" | "ADVERTISER" | null;
  } | null;
  ownerOnboardingStatus?: OwnerOnboardingStatus | null;
};

type BillingReminderPayload = {
  data?: {
    reminder?: {
      shouldShowBanner?: boolean;
      message?: string;
    };
  };
};

type BillingChargeItem = {
  id: string;
  status: string;
  requestedAmountCents?: number;
  providerFeeCents?: number | null;
  payableAmountCents?: number;
  totalAmountCents: number;
  paymentMethod: string;
  paymentNumber: string | null;
  expiredAt: string | null;
};

type BillingChargesPayload = {
  data?: {
    charges?: BillingChargeItem[];
  };
};

type BillingCheckoutPayload = {
  data?: {
    charge?: {
      totalAmountCents?: number;
    };
    payment?: {
      amount?: number;
      fee?: number;
      total_payment?: number;
      payment_number?: string;
      payment_method?: string;
      expired_at?: string;
    } | null;
    paymentSummary?: {
      requestedAmountCents?: number;
      providerFeeCents?: number | null;
      payableAmountCents?: number;
    };
  };
  error?: {
    message?: string;
  };
};

type WalletSummaryPayload = {
  data?: {
    summary?: {
      walletBalanceCents?: number;
    };
  };
};

const CARD_DISMISS_MS = 24 * 60 * 60 * 1000;
const ONBOARDING_CARD_DISMISS_STORAGE_KEY = "app-sidebar:onboarding-card-dismiss-until";
const COMMUNITY_CARD_DISMISS_STORAGE_KEY = "app-sidebar:community-card-dismiss-until";

function formatIdr(cents: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(cents);
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function hasNotExpired(value: string | null | undefined, nowMs = Date.now()): boolean {
  if (!value) {
    return false;
  }

  const expiresAtMs = new Date(value).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return expiresAtMs > nowMs;
}

function formatCountdown(value: string | null | undefined, nowMs: number): string {
  if (!value) {
    return "-";
  }

  const expiresAtMs = new Date(value).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return "-";
  }

  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

export function AppSidebar({ user, ownerOnboardingStatus = null }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [billingReminderMessage, setBillingReminderMessage] = useState<string | null>(null);
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false);
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutPaymentNumber, setCheckoutPaymentNumber] = useState<string | null>(null);
  const [checkoutPaymentMethod, setCheckoutPaymentMethod] = useState<string | null>(null);
  const [checkoutPaymentTotalCents, setCheckoutPaymentTotalCents] = useState<number | null>(null);
  const [, setCheckoutProviderFeeCents] = useState<number | null>(null);
  const [checkoutPaymentExpiresAt, setCheckoutPaymentExpiresAt] = useState<string | null>(null);
  const [checkoutQrDataUrl, setCheckoutQrDataUrl] = useState<string | null>(null);
  const [checkoutNowMs, setCheckoutNowMs] = useState(() => Date.now());
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [isCommunityDialogOpen, setIsCommunityDialogOpen] = useState(false);
  const [communityQrDataUrl, setCommunityQrDataUrl] = useState<string | null>(null);
  const [walletBalanceCents, setWalletBalanceCents] = useState<number | null>(null);
  const [isWalletLoading, setIsWalletLoading] = useState(false);
  const [isOnboardingCardDismissed, setIsOnboardingCardDismissed] = useState(false);
  const [isCommunityCardDismissed, setIsCommunityCardDismissed] = useState(false);
  const loadingToastIdRef = useRef<string | number | null>(null);
  const billingReminderCacheRef = useRef<{ checkedAt: number; message: string | null } | null>(null);

  useEffect(() => {
    const updateVisibility = () => {
      setIsPageVisible(document.visibilityState === "visible");
    };

    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("focus", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", updateVisibility);
    };
  }, []);

  useEffect(() => {
    const syncDismissState = (
      storageKey: string,
      setDismissed: (value: boolean) => void
    ) => {
      try {
        const dismissedUntilRaw = window.localStorage.getItem(storageKey);
        if (!dismissedUntilRaw) {
          return;
        }

        const dismissedUntil = Number.parseInt(dismissedUntilRaw, 10);
        if (Number.isFinite(dismissedUntil) && dismissedUntil > Date.now()) {
          setDismissed(true);
          return;
        }

        window.localStorage.removeItem(storageKey);
      } catch {
        // Ignore read error from localStorage and keep card visible.
      }
    };

    syncDismissState(ONBOARDING_CARD_DISMISS_STORAGE_KEY, setIsOnboardingCardDismissed);
    syncDismissState(COMMUNITY_CARD_DISMISS_STORAGE_KEY, setIsCommunityCardDismissed);
  }, []);

  useEffect(() => {
    if (!ownerOnboardingStatus?.isComplete) {
      return;
    }

    setIsOnboardingCardDismissed(false);
    try {
      window.localStorage.removeItem(ONBOARDING_CARD_DISMISS_STORAGE_KEY);
    } catch {
      // Ignore write error from localStorage.
    }
  }, [ownerOnboardingStatus?.isComplete]);

  const dismissOnboardingCard = () => {
    setIsOnboardingCardDismissed(true);
    try {
      window.localStorage.setItem(ONBOARDING_CARD_DISMISS_STORAGE_KEY, String(Date.now() + CARD_DISMISS_MS));
    } catch {
      // Ignore write error from localStorage.
    }
  };

  const dismissCommunityCard = () => {
    setIsCommunityCardDismissed(true);
    try {
      window.localStorage.setItem(COMMUNITY_CARD_DISMISS_STORAGE_KEY, String(Date.now() + CARD_DISMISS_MS));
    } catch {
      // Ignore write error from localStorage.
    }
  };

  useEffect(() => {
    let canceled = false;
    QRCode.toDataURL("https://chat.whatsapp.com/Da8N0AS3OT8743sWOyYwCZ?mode=gi_t", {
      width: 320,
      margin: 1
    }).then(url => {
       if (!canceled) setCommunityQrDataUrl(url);
    }).catch(() => {});
    return () => { canceled = true };
  }, []);

  const navMain = useMemo(
    () => [
      {
        title: "Dashboard",
        url: "/dashboard",
        icon: LayoutDashboard
      },
      {
        title: "Inbox",
        url: "/inbox",
        icon: MessageCircle
      },
      {
        title: "Customers",
        url: "/customers",
        icon: Users
      },
      {
        title: "Report",
        url: "/report",
        icon: BarChart3
      },
      {
        title: "Invoices",
        url: "/invoices",
        icon: FileText
      },
      {
        title: "Shortlink",
        url: "/shortlinks",
        icon: Link2
      },
      {
        title: "CRM Pipeline",
        url: "/crm/pipelines",
        icon: Workflow
      },
      {
        title: "Sequences & Broadcast",
        url: "/whatsapp-campaigns",
        icon: Workflow
      },
      {
        title: "AI & Automation",
        url: "/ai-automation",
        icon: Bot
      },
      ...(user?.isSuperadmin
        ? [
            {
              title: "Superadmin",
              url: "/sa",
              icon: Shield
            }
          ]
        : [])
    ],
    [user?.isSuperadmin]
  );

  const isOwnerRole = user?.primaryOrgRole === "OWNER";
  const isQrisPayment =
    resolveCheckoutPaymentMethod({
      paymentMethod: checkoutPaymentMethod,
      paymentNumber: checkoutPaymentNumber,
      fallbackMethod: "qris"
    }) === "qris";

  useEffect(() => {
    if (!user || !isOwnerRole) {
      setWalletBalanceCents(null);
      setIsWalletLoading(false);
      return;
    }

    let active = true;

    async function loadWalletSummary() {
      if (!isPageVisible) {
        return;
      }
      if (active) {
        setIsWalletLoading(true);
      }
      try {
        const payload = await fetchJsonCached<WalletSummaryPayload>("/api/wallet/summary", {
          ttlMs: 15_000,
          init: { cache: "no-store" }
        });
        if (!active) {
          return;
        }
        setWalletBalanceCents(payload?.data?.summary?.walletBalanceCents ?? 0);
      } catch {
        if (!active) {
          return;
        }
        setWalletBalanceCents(0);
      } finally {
        if (active) {
          setIsWalletLoading(false);
        }
      }
    }

    void loadWalletSummary();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadWalletSummary();
    }, 120_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [isOwnerRole, isPageVisible, user]);

  useEffect(() => {
    setPendingPath(null);
    if (loadingToastIdRef.current !== null) {
      dismissNotify(loadingToastIdRef.current);
      loadingToastIdRef.current = null;
    }
  }, [pathname]);

  useEffect(() => {
    if (!user) {
      setBillingReminderMessage(null);
      billingReminderCacheRef.current = null;
      return;
    }

    let active = true;

    async function loadReminder() {
      if (!isPageVisible) {
        return;
      }
      const cached = billingReminderCacheRef.current;
      const now = Date.now();
      if (cached && now - cached.checkedAt < 60_000) {
        if (active) {
          setBillingReminderMessage(cached.message);
        }
        return;
      }

      try {
        const payload = await fetchJsonCached<BillingReminderPayload>("/api/billing/subscription", {
          ttlMs: 15_000,
          init: { cache: "no-store" }
        });

        const reminder = payload?.data?.reminder;
        const nextMessage = reminder?.shouldShowBanner && reminder.message ? reminder.message : null;
        billingReminderCacheRef.current = { checkedAt: Date.now(), message: nextMessage };
        if (active) {
          setBillingReminderMessage(nextMessage);
        }
      } catch {
        if (active) {
          setBillingReminderMessage(null);
        }
      }
    }

    void loadReminder();
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadReminder();
    }, 120_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [isPageVisible, user]);

  useEffect(() => {
    let canceled = false;

    async function generateQrDataUrl(value: string) {
      try {
        const qrDataUrl = await QRCode.toDataURL(value, {
          width: 320,
          margin: 1
        });
        if (!canceled) {
          setCheckoutQrDataUrl(qrDataUrl);
        }
      } catch {
        if (!canceled) {
          setCheckoutQrDataUrl(null);
        }
      }
    }

    if (!checkoutPaymentNumber || !isQrisPayment) {
      setCheckoutQrDataUrl(null);
      return () => {
        canceled = true;
      };
    }

    void generateQrDataUrl(checkoutPaymentNumber);
    return () => {
      canceled = true;
    };
  }, [checkoutPaymentNumber, isQrisPayment]);

  useEffect(() => {
    if (!isCheckoutDialogOpen || !checkoutPaymentExpiresAt) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setCheckoutNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isCheckoutDialogOpen, checkoutPaymentExpiresAt]);

  function applyCheckoutPayment(input: {
    paymentNumber: string | null;
    paymentMethod: string | null;
    totalAmountCents: number | null;
    providerFeeCents: number | null;
    expiredAt: string | null;
  }) {
    setCheckoutPaymentNumber(input.paymentNumber);
    setCheckoutPaymentMethod(
      resolveCheckoutPaymentMethod({
        paymentMethod: input.paymentMethod,
        paymentNumber: input.paymentNumber,
        fallbackMethod: "qris"
      })
    );
    setCheckoutPaymentTotalCents(input.totalAmountCents);
    setCheckoutProviderFeeCents(input.providerFeeCents);
    setCheckoutPaymentExpiresAt(input.expiredAt);
    setCheckoutNowMs(Date.now());
  }

  async function handleOpenBillingCheckout() {
    if (!isOwnerRole) {
      router.push("/billing");
      return;
    }

    setIsCheckoutDialogOpen(true);
    setIsCheckoutLoading(true);
    setCheckoutError(null);

    try {
      const chargesPayload = await fetchJsonCached<BillingChargesPayload>("/api/billing/charges", {
        ttlMs: 1_500,
        init: { cache: "no-store" }
      });
      const latestPending = (chargesPayload?.data?.charges ?? []).find(
        (charge) => charge.status === "PENDING" && Boolean(charge.paymentNumber) && hasNotExpired(charge.expiredAt)
      );

      if (latestPending) {
        applyCheckoutPayment({
          paymentNumber: latestPending.paymentNumber,
          paymentMethod: latestPending.paymentMethod,
          totalAmountCents: latestPending.payableAmountCents ?? latestPending.totalAmountCents,
          providerFeeCents: latestPending.providerFeeCents ?? null,
          expiredAt: latestPending.expiredAt
        });
        return;
      }

      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ paymentMethod: "qris" })
      });
      const payload = (await response.json().catch(() => null)) as BillingCheckoutPayload | null;

      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Gagal menyiapkan checkout.");
      }

      applyCheckoutPayment({
        paymentNumber: payload?.data?.payment?.payment_number ?? null,
        paymentMethod: payload?.data?.payment?.payment_method ?? null,
        totalAmountCents:
          payload?.data?.paymentSummary?.payableAmountCents ??
          payload?.data?.payment?.total_payment ??
          payload?.data?.charge?.totalAmountCents ??
          null,
        providerFeeCents:
          payload?.data?.paymentSummary?.providerFeeCents ??
          (typeof payload?.data?.payment?.fee === "number" ? payload.data.payment.fee : null),
        expiredAt: payload?.data?.payment?.expired_at ?? null
      });

      invalidateFetchCache("GET:/api/billing/subscription");
      invalidateFetchCache("GET:/api/billing/charges");
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Gagal menyiapkan checkout.");
    } finally {
      setIsCheckoutLoading(false);
    }
  }

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="20byte">
              <Link href="/inbox">
                <div className="hidden aspect-square size-7 items-center justify-center rounded-lg bg-transparent p-0 group-data-[collapsible=icon]:flex">
                  <Image
                    src="/branding/20byte-pavicon.svg"
                    alt="20byte icon"
                    width={24}
                    height={24}
                    className="h-6 w-6 object-contain"
                    priority
                  />
                </div>
                <div className="flex items-center group-data-[collapsible=icon]:hidden">
                  <Image
                    src="/branding/20byte-logo-dark.svg"
                    alt="20byte"
                    width={160}
                    height={48}
                    className="h-7 w-auto object-contain dark:hidden"
                    unoptimized
                    priority
                  />
                  <Image
                    src="/branding/20byte-logo-light.svg"
                    alt="20byte"
                    width={160}
                    height={48}
                    className="hidden h-7 w-auto object-contain dark:block"
                    unoptimized
                    priority
                  />
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <div className="px-3 pt-1 pb-3 group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:pt-1 group-data-[collapsible=icon]:pb-2">
          <BusinessSwitcher
            isOwnerRole={isOwnerRole}
            onActiveOrgChanged={() => {
              setPendingPath(null);
            }}
          />
        </div>
        {isOwnerRole ? (
          <div className="mx-3 mb-3 group-data-[collapsible=icon]:hidden">
            <Link
              href="/finance"
              prefetch={false}
              onMouseEnter={() => router.prefetch("/finance")}
              onFocus={() => router.prefetch("/finance")}
              onClick={() => {
                if (pathname === "/finance") {
                  return;
                }
                setPendingPath("/finance");
                if (loadingToastIdRef.current !== null) {
                  dismissNotify(loadingToastIdRef.current);
                }
                loadingToastIdRef.current = notifyLoading("Sedang memuat halaman...");
              }}
              className="group/wallet block rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-emerald-100/60 px-3.5 py-2.5 text-left transition-all hover:border-emerald-400 hover:shadow-md hover:shadow-emerald-500/10 dark:border-emerald-800/50 dark:from-emerald-950/50 dark:to-emerald-900/30 dark:hover:border-emerald-700/70"
            >
              <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
                <Wallet className="h-3.5 w-3.5" />
                E-Payment Balance
              </p>
              <p className="mt-1 text-[18px] font-extrabold leading-none tracking-tight text-emerald-800 dark:text-emerald-200">
                {isWalletLoading ? "Memuat..." : formatIdr(walletBalanceCents ?? 0)}
              </p>
            </Link>
          </div>
        ) : null}
        <NavMain
          currentPath={pathname}
          pendingPath={pendingPath}
          onNavigateStart={(url) => {
            setPendingPath(url);
            if (loadingToastIdRef.current !== null) {
              dismissNotify(loadingToastIdRef.current);
            }
            loadingToastIdRef.current = notifyLoading("Sedang memuat halaman...");
          }}
          items={navMain.map((item) => ({ ...item, isActive: pathname === item.url || pathname.startsWith(`${item.url}/`) }))}
        />
      </SidebarContent>
      <SidebarFooter>
        {billingReminderMessage && isOwnerRole ? (
          <button
            type="button"
            onClick={() => {
              void handleOpenBillingCheckout();
            }}
            className="group relative mx-3 mb-3 w-[calc(100%-1.5rem)] overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5 px-4 py-3 text-left transition-all hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 group-data-[collapsible=icon]:hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary/0 via-primary/5 to-primary/0 opacity-0 transition-opacity group-hover:opacity-100" />
            <div className="relative z-10">
              <p className="flex items-center gap-2 text-[13px] font-bold text-primary">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[11px]">✨</span>
                Suka platform kami?
              </p>
              <p className="mt-1.5 text-[12px] font-medium leading-relaxed text-foreground/80">
                Berlangganan sekarang untuk terus menggunakan fitur tanpa henti.
              </p>
              <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-primary/80 transition-colors group-hover:text-primary">
                Tampilkan QRIS &rarr;
              </p>
            </div>
          </button>
        ) : null}
        {billingReminderMessage && !isOwnerRole ? (
          <div className="mx-3 mb-3 w-[calc(100%-1.5rem)] rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-amber-500/5 px-4 py-3 text-left group-data-[collapsible=icon]:hidden">
            <p className="flex items-center gap-2 text-[13px] font-bold text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              Masa Trial Segera Habis
            </p>
            <p className="mt-1.5 text-[12px] font-medium leading-relaxed text-amber-900/80">
              Beri tahu Owner workspace Anda untuk segera melakukan perpanjangan.
            </p>
          </div>
        ) : null}
        {ownerOnboardingStatus && !ownerOnboardingStatus.isComplete && !isOnboardingCardDismissed ? (
          <div className="mx-2 group-data-[collapsible=icon]:hidden">
            <div className="mb-1 flex justify-end pr-1">
              <button
                type="button"
                onClick={dismissOnboardingCard}
                aria-label="Tutup card setup workspace"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground/70 transition hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <SidebarOnboardingCard status={ownerOnboardingStatus} />
          </div>
        ) : null}
        {!isCommunityCardDismissed ? (
          <div className="relative mx-3 mb-2 group-data-[collapsible=icon]:hidden">
            <button
              type="button"
              onClick={dismissCommunityCard}
              aria-label="Tutup card komunitas"
              className="absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-500/20 bg-white/80 text-emerald-700/80 backdrop-blur transition hover:bg-white hover:text-emerald-700"
            >
              <X className="h-4 w-4" />
            </button>
          <button
            onClick={() => setIsCommunityDialogOpen(true)}
            className="group relative w-full overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 px-4 py-3 pr-11 text-left transition-all hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-500/10"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/0 via-emerald-500/10 to-emerald-500/0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <div className="relative z-10">
              <p className="flex items-center gap-2 text-[13px] font-bold text-emerald-600 dark:text-emerald-500">
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-emerald-500/20 text-[11px] ring-2 ring-emerald-500/10">💚</span>
                Komunitas 20byte
              </p>
              <p className="mt-1.5 text-[11px] font-medium leading-[1.5] text-emerald-900/70 dark:text-emerald-100/70">
                Gabung grup WhatsApp kami untuk tanya-jawab, diskusi, dan request fitur!
              </p>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-emerald-600/80 transition-colors group-hover:text-emerald-600 dark:text-emerald-400/80 dark:group-hover:text-emerald-400">
                Join Grup WA &rarr;
              </p>
            </div>
          </button>
          </div>
        ) : null}
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail side="left" />

      <Dialog open={isCheckoutDialogOpen} onOpenChange={setIsCheckoutDialogOpen}>
        <DialogContent className="sm:max-w-[420px] p-6 rounded-[24px] gap-0">
          <DialogHeader className="space-y-1.5 pb-2">
            <DialogTitle className="text-[18px] font-bold text-foreground">Scan QR Pembayaran</DialogTitle>
            <DialogDescription className="text-[13px] font-medium leading-relaxed text-muted-foreground/80">
              Gunakan aplikasi e-wallet atau mobile banking untuk menyelesaikan pembayaran.
            </DialogDescription>
          </DialogHeader>

          {isCheckoutLoading ? (
            <div className="py-12 flex flex-col items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
              <p className="mt-4 text-sm font-medium text-muted-foreground">Menyiapkan QR Pembayaran...</p>
            </div>
          ) : null}

          {!isCheckoutLoading && checkoutError ? (
            <div className="py-4 space-y-4">
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-[13px] font-medium text-rose-600">
                {checkoutError}
              </div>
              <Button
                className="w-full h-11 rounded-xl font-bold"
                onClick={() => {
                  router.push("/billing");
                  setIsCheckoutDialogOpen(false);
                }}
              >
                Buka Halaman Billing
              </Button>
            </div>
          ) : null}

          {!isCheckoutLoading && !checkoutError ? (
            <div className="py-2">
              <div className="flex flex-col items-center pb-6 pt-4">
                {checkoutQrDataUrl && isQrisPayment ? (
                  <div className="flex items-center justify-center rounded-[20px] border border-border/40 bg-white p-4 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.08)] dark:border-border/20 dark:bg-white dark:shadow-none">
                    <Image src={checkoutQrDataUrl} alt="QR pembayaran" width={280} height={280} unoptimized className="object-contain" />
                  </div>
                ) : (
                  <div className="flex h-[280px] w-[280px] items-center justify-center rounded-[20px] border border-dashed border-border/50 bg-muted/30 dark:bg-muted/10">
                    {checkoutPaymentNumber ? (
                      <p className="break-all px-6 text-center text-[12px] font-medium text-foreground">{checkoutPaymentNumber}</p>
                    ) : (
                      <p className="px-6 text-center text-[13px] font-medium text-muted-foreground">
                        Menyiapkan tautan bayar...<br />Dialihkan ke halaman billing jika gagal.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 space-y-1.5 shadow-inner">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-muted-foreground/80">Nominal bayar:</span>
                  <span className="text-[14px] font-bold tracking-tight text-foreground">{formatIdr(checkoutPaymentTotalCents ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-muted-foreground/80">Sisa waktu bayar:</span>
                  <span className="text-[13px] font-bold text-amber-600 tracking-tight">{formatCountdown(checkoutPaymentExpiresAt, checkoutNowMs)}</span>
                </div>
              </div>

              <p className="mt-4 text-center text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                Expired: {formatDate(checkoutPaymentExpiresAt)}
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={isCommunityDialogOpen} onOpenChange={setIsCommunityDialogOpen}>
        <DialogContent className="sm:max-w-[380px] p-0 rounded-[28px] overflow-hidden gap-0 border border-emerald-500/20 bg-white shadow-2xl dark:bg-zinc-900 dark:border-emerald-500/10">
          <div className="bg-gradient-to-br from-emerald-500 to-emerald-600 px-6 py-8 text-center text-white relative">
            <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.4),_transparent_60%)]"></div>
            <div className="relative z-10">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 ring-4 ring-white/10 backdrop-blur-sm">
                <MessageCircle className="h-7 w-7 text-white" />
              </div>
              <h2 className="text-[20px] font-bold tracking-tight">Komunitas 20byte</h2>
              <p className="mt-2 text-[13px] font-medium leading-relaxed text-emerald-50">
                Wadah resmi untuk Anda bertanya, berbagi tips, serta memberi masukan dan request fitur langsung ke tim kami!
              </p>
            </div>
          </div>

          <div className="px-6 py-8 flex flex-col items-center bg-gradient-to-b from-emerald-500/5 to-transparent dark:from-emerald-500/10 dark:to-transparent">
            {communityQrDataUrl ? (
              <div className="flex items-center justify-center rounded-[20px] border-2 border-emerald-100 bg-white p-3 shadow-xl shadow-emerald-900/5 dark:border-emerald-900/60">
                <Image src={communityQrDataUrl} alt="QR Komunitas" width={220} height={220} unoptimized className="object-contain" />
              </div>
            ) : (
              <div className="h-[220px] w-[220px] animate-pulse rounded-[20px] border-2 border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40" />
            )}

            <div className="my-5 flex w-full items-center gap-3 px-4">
              <div className="h-px flex-1 bg-border/60" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Atau via link</span>
              <div className="h-px flex-1 bg-border/60" />
            </div>

            <Button
              asChild
              className="w-full rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold h-12 shadow-lg shadow-emerald-600/20"
            >
              <a href="https://chat.whatsapp.com/Da8N0AS3OT8743sWOyYwCZ?mode=gi_t" target="_blank" rel="noopener noreferrer">
                Klik untuk Bergabung ke Grup
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}

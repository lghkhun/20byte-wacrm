"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { fetchJsonCached, invalidateFetchCache } from "@/lib/client/fetchCache";
import { resolveCheckoutPaymentMethod } from "@/lib/payment/checkoutFallback";
import type { OwnerOnboardingStatus } from "@/server/services/onboardingService";

type AppShellProps = {
  user: {
    email: string;
    name: string | null;
    avatarUrl?: string | null;
    isSuperadmin?: boolean;
    primaryOrgId?: string | null;
    primaryOrgRole?: "OWNER" | "ADMIN" | "CS" | "ADVERTISER" | null;
  } | null;
  ownerOnboardingStatus?: OwnerOnboardingStatus | null;
  children: React.ReactNode;
};

type PricingPlan = {
  months: 1 | 3 | 12;
  label: string;
  discountBps: number;
  rawBaseAmountCents: number;
  discountCents: number;
  netBaseAmountCents: number;
  gatewayFeeCents: number;
  totalAmountCents: number;
  renewalDays: number;
};

type BillingSubscriptionPayload = {
  data?: {
    subscription?: {
      status?: string;
      trialEndAt?: string;
      currentPeriodEndAt?: string | null;
    };
    state?: {
      isLocked?: boolean;
      graceEndAt?: string;
    };
    pricing?: {
      plans?: PricingPlan[];
      defaultPlanMonths?: 1 | 3 | 12;
    };
  };
};

type BillingChargeItem = {
  status: string;
  paymentMethod: string;
  paymentNumber: string | null;
  expiredAt: string | null;
  totalAmountCents: number;
  payableAmountCents?: number;
  providerFeeCents?: number | null;
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
      fee?: number;
      total_payment?: number;
      payment_number?: string;
      payment_method?: string;
      expired_at?: string;
    } | null;
    paymentSummary?: {
      providerFeeCents?: number | null;
      payableAmountCents?: number;
    };
  };
  error?: {
    message?: string;
  };
};

type LockModalState = {
  isLocked: boolean;
  subscriptionStatus: string | null;
  dueAt: string | null;
  graceEndAt: string | null;
  plans: PricingPlan[];
};

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

/* ── Scroll-aware public header ── */
function PublicLayout({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    function onScroll() {
      if (!header) return;
      if (window.scrollY > 20) {
        header.classList.add("header-scrolled");
      } else {
        header.classList.remove("header-scrolled");
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative min-h-screen">
      <header
        ref={headerRef}
        className="landing-header fixed left-0 right-0 top-0 z-50 flex h-20 items-center justify-between px-6 transition-all duration-500 md:px-12"
      >
        <Link className="inline-flex items-center" href="/">
          <Image
            src="/branding/20byte-logo-dark.svg"
            alt="20byte"
            width={168}
            height={52}
            className="h-8 w-auto object-contain dark:hidden"
            unoptimized
            priority
          />
          <Image
            src="/branding/20byte-logo-light.svg"
            alt="20byte"
            width={168}
            height={52}
            className="hidden h-8 w-auto object-contain dark:block"
            unoptimized
            priority
          />
        </Link>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          {pathname !== "/login" && (
            <Link
              href="/login"
              className="inline-flex h-10 items-center justify-center rounded-xl bg-transparent px-5 text-sm font-semibold text-foreground transition-all duration-300 hover:bg-foreground/5"
            >
              Login
            </Link>
          )}
          {pathname !== "/register" && (
            <Link
              href="/register"
              className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-[0_4px_14px_hsl(var(--primary)/0.3)] transition-all duration-300 hover:scale-105 hover:bg-primary/90 hover:shadow-[0_6px_20px_hsl(var(--primary)/0.4)]"
            >
              Mulai Trial
            </Link>
          )}
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

const publicRoutes = new Set([
  "/",
  "/login",
  "/forgot-password",
  "/register",
  "/set-password",
  "/privacy",
  "/terms",
  "/faq",
  "/developers/whatsapp-api"
]);

export function AppShell({ user, ownerOnboardingStatus = null, children }: AppShellProps) {
  const pathname = usePathname() ?? "";
  const isOwnerRole = user?.primaryOrgRole === "OWNER";
  const [lockModalState, setLockModalState] = useState<LockModalState | null>(null);
  const [isLockStateLoading, setIsLockStateLoading] = useState(false);
  const [lockStateError, setLockStateError] = useState<string | null>(null);
  const [selectedPlanMonths, setSelectedPlanMonths] = useState<1 | 3 | 12>(1);
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutPaymentNumber, setCheckoutPaymentNumber] = useState<string | null>(null);
  const [checkoutPaymentMethod, setCheckoutPaymentMethod] = useState<string | null>(null);
  const [checkoutPaymentTotalCents, setCheckoutPaymentTotalCents] = useState<number | null>(null);
  const [checkoutPaymentExpiresAt, setCheckoutPaymentExpiresAt] = useState<string | null>(null);
  const [checkoutQrDataUrl, setCheckoutQrDataUrl] = useState<string | null>(null);
  const [checkoutNowMs, setCheckoutNowMs] = useState(() => Date.now());
  const isQrisPayment =
    resolveCheckoutPaymentMethod({
      paymentMethod: checkoutPaymentMethod,
      paymentNumber: checkoutPaymentNumber,
      fallbackMethod: "qris"
    }) === "qris";
  const lastLockStateRef = useRef<{ checkedAt: number; state: LockModalState | null } | null>(null);

  const isPublicInvoiceRoute = pathname.startsWith("/i/");
  const isPublicDeveloperRoute = pathname.startsWith("/developers/");
  const isPublicRoute = publicRoutes.has(pathname) || isPublicInvoiceRoute || isPublicDeveloperRoute;

  const selectedPlan = useMemo(() => {
    const plans = lockModalState?.plans ?? [];
    return plans.find((plan) => plan.months === selectedPlanMonths) ?? plans[0] ?? null;
  }, [lockModalState?.plans, selectedPlanMonths]);

  useEffect(() => {
    if (!checkoutPaymentNumber || !isQrisPayment) {
      setCheckoutQrDataUrl(null);
      return;
    }

    let canceled = false;
    QRCode.toDataURL(checkoutPaymentNumber, { width: 320, margin: 1 })
      .then((url) => {
        if (!canceled) {
          setCheckoutQrDataUrl(url);
        }
      })
      .catch(() => {
        if (!canceled) {
          setCheckoutQrDataUrl(null);
        }
      });

    return () => {
      canceled = true;
    };
  }, [checkoutPaymentNumber, isQrisPayment]);

  useEffect(() => {
    if (!lockModalState?.isLocked || !checkoutPaymentExpiresAt) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setCheckoutNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkoutPaymentExpiresAt, lockModalState?.isLocked]);

  useEffect(() => {
    if (!user || isPublicRoute) {
      setLockModalState(null);
      setCheckoutError(null);
      setLockStateError(null);
      return;
    }

    let active = true;

    async function checkBillingLock(force = false) {
      const now = Date.now();
      const cached = lastLockStateRef.current;
      if (!force && cached && now - cached.checkedAt < 30_000) {
        if (!active) {
          return;
        }

        setLockModalState(cached.state);
        return;
      }

      if (active) {
        setIsLockStateLoading(true);
        setLockStateError(null);
      }

      try {
        const payload = await fetchJsonCached<BillingSubscriptionPayload>("/api/billing/subscription", {
          ttlMs: 15_000,
          init: { cache: "no-store" }
        });

        const isLocked = Boolean(payload?.data?.state?.isLocked);
        const plans = payload?.data?.pricing?.plans ?? [];
        const defaultPlanMonths = payload?.data?.pricing?.defaultPlanMonths ?? 1;
        const dueAt = payload?.data?.subscription?.status === "TRIALING"
          ? payload?.data?.subscription?.trialEndAt ?? null
          : payload?.data?.subscription?.currentPeriodEndAt ?? null;
        const nextState: LockModalState | null = isLocked
          ? {
              isLocked,
              subscriptionStatus: payload?.data?.subscription?.status ?? null,
              dueAt,
              graceEndAt: payload?.data?.state?.graceEndAt ?? null,
              plans
            }
          : null;

        lastLockStateRef.current = { checkedAt: Date.now(), state: nextState };

        if (!active) {
          return;
        }

        setLockModalState(nextState);
        if (nextState) {
          setSelectedPlanMonths((current) => {
            const hasCurrent = nextState.plans.some((plan) => plan.months === current);
            return hasCurrent ? current : defaultPlanMonths;
          });
        } else {
          setCheckoutError(null);
          setCheckoutPaymentNumber(null);
          setCheckoutPaymentMethod(null);
          setCheckoutPaymentTotalCents(null);
          setCheckoutPaymentExpiresAt(null);
        }
      } catch {
        if (!active) {
          return;
        }

        setLockStateError("Gagal memuat status langganan. Muat ulang halaman untuk mencoba lagi.");
      } finally {
        if (active) {
          setIsLockStateLoading(false);
        }
      }
    }

    void checkBillingLock();
    const intervalId = window.setInterval(() => {
      void checkBillingLock();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [isPublicRoute, user]);

  async function handleCreateCheckoutFromLock() {
    if (!isOwnerRole) {
      return;
    }

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
        setCheckoutPaymentNumber(latestPending.paymentNumber);
        setCheckoutPaymentMethod(
          resolveCheckoutPaymentMethod({
            paymentMethod: latestPending.paymentMethod,
            paymentNumber: latestPending.paymentNumber,
            fallbackMethod: "qris"
          })
        );
        setCheckoutPaymentTotalCents(latestPending.payableAmountCents ?? latestPending.totalAmountCents);
        setCheckoutPaymentExpiresAt(latestPending.expiredAt);
        setCheckoutNowMs(Date.now());
        return;
      }

      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ paymentMethod: "qris", planMonths: selectedPlanMonths })
      });
      const payload = (await response.json().catch(() => null)) as BillingCheckoutPayload | null;

      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Gagal menyiapkan checkout.");
      }

      setCheckoutPaymentNumber(payload?.data?.payment?.payment_number ?? null);
      setCheckoutPaymentMethod(
        resolveCheckoutPaymentMethod({
          paymentMethod: payload?.data?.payment?.payment_method ?? null,
          paymentNumber: payload?.data?.payment?.payment_number ?? null,
          fallbackMethod: "qris"
        })
      );
      setCheckoutPaymentTotalCents(
        payload?.data?.paymentSummary?.payableAmountCents ??
          payload?.data?.payment?.total_payment ??
          payload?.data?.charge?.totalAmountCents ??
          null
      );
      setCheckoutPaymentExpiresAt(payload?.data?.payment?.expired_at ?? null);
      setCheckoutNowMs(Date.now());

      invalidateFetchCache("GET:/api/billing/subscription");
      invalidateFetchCache("GET:/api/billing/charges");
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Gagal menyiapkan checkout.");
    } finally {
      setIsCheckoutLoading(false);
    }
  }

  if (isPublicInvoiceRoute) {
    return <main className="h-screen overflow-auto bg-background">{children}</main>;
  }

  if (isPublicRoute) {
    return (
      <PublicLayout pathname={pathname}>{children}</PublicLayout>
    );
  }

  return (
    <SidebarProvider defaultOpen={false} className="h-dvh overflow-hidden">
      <AppSidebar user={user} ownerOnboardingStatus={ownerOnboardingStatus} />
      <SidebarInset className="h-full min-h-0 overflow-hidden md:m-0 md:rounded-none md:shadow-none">
        <main className="app-shell-main flex h-full min-h-0 flex-1 overflow-hidden pb-16 md:p-4 md:pb-4">
          <div className="app-shell-surface flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background md:rounded-[28px] md:border md:border-border/80 md:bg-surface/90 md:shadow-[0_20px_60px_hsl(var(--foreground)/0.06)] md:backdrop-blur">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {children}
            </div>
          </div>
        </main>
      </SidebarInset>
      <MobileBottomNav pathname={pathname} isSuperadmin={Boolean(user?.isSuperadmin)} />

      {lockModalState?.isLocked ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="subscription-lock-title">
          <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-border/60 bg-background shadow-2xl">
            <div className="border-b border-border/60 px-6 pb-5 pt-6 md:px-8">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Akses Perlu Diperpanjang</p>
              <h2 id="subscription-lock-title" className="mt-2 text-2xl font-bold tracking-tight text-foreground">
                Masa langganan Anda sudah berakhir
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Agar bisa lanjut memakai 20byte seperti biasa, silakan pilih paket dan selesaikan pembayaran di bawah ini.
              </p>
              <p className="mt-2 text-xs font-medium text-muted-foreground/80">
                Status terakhir: {lockModalState.subscriptionStatus ?? "-"} • Berakhir: {formatDate(lockModalState.dueAt)}
              </p>
            </div>

            <div className="max-h-[70vh] overflow-y-auto px-6 py-5 md:px-8">
              {isOwnerRole ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(lockModalState.plans ?? []).map((plan) => {
                      const selected = plan.months === selectedPlanMonths;
                      return (
                        <button
                          key={plan.months}
                          type="button"
                          onClick={() => setSelectedPlanMonths(plan.months)}
                          className={`rounded-2xl border px-3 py-4 text-left transition-all ${selected ? "border-primary bg-primary/5 shadow-sm" : "border-border/70 bg-card hover:border-primary/50"}`}
                        >
                          <p className="text-sm font-bold text-foreground">{plan.label}</p>
                          <p className="mt-1 text-lg font-extrabold text-foreground">{formatIdr(plan.totalAmountCents)}</p>
                          {plan.discountBps > 0 ? (
                            <p className="mt-1 text-xs font-semibold text-emerald-600">Hemat {Math.round(plan.discountBps / 100)}%</p>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>

                  {selectedPlan ? (
                    <div className="mt-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Ringkasan Paket</p>
                      <div className="mt-2 space-y-1.5 text-sm text-foreground/90">
                        <p className="flex items-center justify-between"><span>Paket</span><span className="font-semibold">{selectedPlan.label}</span></p>
                        <p className="flex items-center justify-between"><span>Durasi aktif</span><span className="font-semibold">{selectedPlan.renewalDays} hari</span></p>
                        <p className="flex items-center justify-between"><span>Total bayar</span><span className="text-base font-bold">{formatIdr(selectedPlan.totalAmountCents)}</span></p>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 space-y-3">
                    <Button type="button" className="h-11 w-full rounded-xl text-sm font-bold" onClick={() => void handleCreateCheckoutFromLock()} disabled={isCheckoutLoading || isLockStateLoading}>
                      {isCheckoutLoading ? "Menyiapkan pembayaran..." : "Lanjutkan Pembayaran"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 w-full rounded-xl text-sm font-semibold"
                      onClick={() => {
                        lastLockStateRef.current = null;
                        void (async () => {
                          setIsLockStateLoading(true);
                          try {
                            const payload = await fetchJsonCached<BillingSubscriptionPayload>("/api/billing/subscription", {
                              ttlMs: 0,
                              init: { cache: "no-store" }
                            });
                            const stillLocked = Boolean(payload?.data?.state?.isLocked);
                            if (!stillLocked) {
                              setLockModalState(null);
                            }
                          } finally {
                            setIsLockStateLoading(false);
                          }
                        })();
                      }}
                      disabled={isCheckoutLoading || isLockStateLoading}
                    >
                      Saya Sudah Bayar, Cek Lagi
                    </Button>
                  </div>

                  {checkoutError ? (
                    <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-600">{checkoutError}</p>
                  ) : null}

                  {checkoutPaymentNumber ? (
                    <div className="mt-4 rounded-2xl border border-border/60 bg-card p-4">
                      <div className="flex flex-col items-center">
                        {checkoutQrDataUrl && isQrisPayment ? (
                          <div className="rounded-2xl border border-border/60 bg-white p-3">
                            <Image src={checkoutQrDataUrl} alt="QR pembayaran" width={240} height={240} unoptimized className="object-contain" />
                          </div>
                        ) : (
                          <p className="break-all text-sm font-semibold text-foreground">Kode bayar: {checkoutPaymentNumber}</p>
                        )}
                      </div>
                      <div className="mt-3 space-y-1.5 text-sm">
                        <p className="flex items-center justify-between"><span className="text-muted-foreground">Nominal</span><span className="font-bold text-foreground">{formatIdr(checkoutPaymentTotalCents ?? 0)}</span></p>
                        <p className="flex items-center justify-between"><span className="text-muted-foreground">Batas bayar</span><span className="font-semibold text-amber-600">{formatCountdown(checkoutPaymentExpiresAt, checkoutNowMs)}</span></p>
                        <p className="text-xs text-muted-foreground">Expired: {formatDate(checkoutPaymentExpiresAt)}</p>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-relaxed text-amber-900 dark:text-amber-100">
                  Akses workspace ini sedang terkunci karena masa aktifnya habis. Hubungi Owner workspace untuk memilih paket dan menyelesaikan pembayaran.
                </div>
              )}

              {lockStateError ? (
                <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-600">{lockStateError}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </SidebarProvider>
  );
}

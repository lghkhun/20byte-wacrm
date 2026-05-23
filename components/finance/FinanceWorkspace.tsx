"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { dismissNotify, notifyError, notifyLoading, notifySuccess } from "@/lib/ui/notify";

type WalletSummaryResponse = {
  data?: {
    summary?: {
      orgId: string;
      orgName: string;
      walletBalanceCents: number;
      ledgers: Array<{
        id: string;
        type: string;
        direction: string;
        amountCents: number;
        balanceAfterCents: number;
        referenceType: string;
        referenceId: string;
        createdAt: string;
      }>;
    };
  };
  error?: { message?: string };
};

type WalletTopupResponse = {
  data?: {
    topups?: Array<{
      id: string;
      status: string;
      amountCents: number;
      customerPayableCents: number;
      paymentMethod: string;
      paymentNumber: string | null;
      expiresAt: string | null;
      createdAt: string;
    }>;
    topup?: {
      id: string;
      status: string;
      amountCents: number;
      customerPayableCents: number;
      paymentMethod: string;
      paymentNumber: string | null;
      expiresAt: string | null;
      createdAt: string;
    };
  };
  error?: { message?: string };
};

type WithdrawResponse = {
  data?: {
    requests?: Array<{
      id: string;
      amountCents: number;
      bankName: string;
      accountNumber: string;
      accountHolder: string;
      status: string;
      createdAt: string;
    }>;
    request?: {
      id: string;
      amountCents: number;
      bankName: string;
      accountNumber: string;
      accountHolder: string;
      status: string;
      createdAt: string;
    };
  };
  error?: { message?: string };
};

type HistoryRow = {
  id: string;
  status: string;
  type: "TOPUP" | "WITHDRAW";
  channel: string;
  amountCents: number;
  createdAt: string;
  detail: string;
};

function formatIdr(cents: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Math.max(0, cents));
}

function formatDate(value: string | null): string {
  if (!value) return "-";
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

function normalizeMethod(value: string): string {
  return value.replace(/_/g, " ").toUpperCase();
}

export function FinanceWorkspace() {
  const [isLoading, setIsLoading] = useState(true);
  const [isForbidden, setIsForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balanceCents, setBalanceCents] = useState(0);
  const [topups, setTopups] = useState<NonNullable<WalletTopupResponse["data"]>["topups"]>([]);
  const [withdrawals, setWithdrawals] = useState<NonNullable<WithdrawResponse["data"]>["requests"]>([]);
  const [showWithdrawDialog, setShowWithdrawDialog] = useState(false);
  
  const [isWithdrawSubmitting, setIsWithdrawSubmitting] = useState(false);
  
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawBankName, setWithdrawBankName] = useState("");
  const [withdrawAccountNumber, setWithdrawAccountNumber] = useState("");
  const [withdrawAccountHolder, setWithdrawAccountHolder] = useState("");
  const [isPageVisible, setIsPageVisible] = useState(true);

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
    if (showWithdrawDialog) {
      setWithdrawAmount(balanceCents.toString());
    }
  }, [showWithdrawDialog, balanceCents]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [summaryRes, topupRes, withdrawRes] = await Promise.all([
        fetch("/api/wallet/summary", { cache: "no-store" }),
        fetch("/api/wallet/topups", { cache: "no-store" }),
        fetch("/api/wallet/withdrawals", { cache: "no-store" })
      ]);

      if (summaryRes.status === 403 || topupRes.status === 403 || withdrawRes.status === 403) {
        setIsForbidden(true);
        return;
      }

      const summaryPayload = (await summaryRes.json().catch(() => null)) as WalletSummaryResponse | null;
      const topupPayload = (await topupRes.json().catch(() => null)) as WalletTopupResponse | null;
      const withdrawPayload = (await withdrawRes.json().catch(() => null)) as WithdrawResponse | null;

      if (!summaryRes.ok || !summaryPayload?.data?.summary) {
        throw new Error(summaryPayload?.error?.message ?? "Gagal memuat ringkasan wallet.");
      }
      if (!topupRes.ok) {
        throw new Error(topupPayload?.error?.message ?? "Gagal memuat riwayat topup.");
      }
      if (!withdrawRes.ok) {
        throw new Error(withdrawPayload?.error?.message ?? "Gagal memuat riwayat withdraw.");
      }

      setIsForbidden(false);
      setBalanceCents(summaryPayload.data.summary.walletBalanceCents);
      setTopups(topupPayload?.data?.topups ?? []);
      setWithdrawals(withdrawPayload?.data?.requests ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Gagal memuat data finance.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isPageVisible) {
      return;
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadData();
    }, 60_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isPageVisible, loadData]);

  const pendingSettlementCents = useMemo(
    () =>
      (topups ?? [])
        .filter((item) => item.status === "PENDING")
        .reduce((total, item) => total + item.customerPayableCents, 0),
    [topups]
  );

  const inProcessWithdrawCents = useMemo(
    () =>
      (withdrawals ?? [])
        .filter((item) => item.status === "PENDING" || item.status === "APPROVED")
        .reduce((total, item) => total + item.amountCents, 0),
    [withdrawals]
  );

  const totalWithdrawnCents = useMemo(
    () =>
      (withdrawals ?? [])
        .filter((item) => item.status === "PAID")
        .reduce((total, item) => total + item.amountCents, 0),
    [withdrawals]
  );

  const historyRows = useMemo<HistoryRow[]>(() => {
    const rows: HistoryRow[] = [];
    for (const topup of topups ?? []) {
      rows.push({
        id: `topup:${topup.id}`,
        status: topup.status,
        type: "TOPUP",
        channel: normalizeMethod(topup.paymentMethod),
        amountCents: topup.customerPayableCents,
        createdAt: topup.createdAt,
        detail: topup.paymentNumber ? `Tujuan: ${topup.paymentNumber}` : "-"
      });
    }
    for (const item of withdrawals ?? []) {
      rows.push({
        id: `withdraw:${item.id}`,
        status: item.status,
        type: "WITHDRAW",
        channel: item.bankName || "-",
        amountCents: item.amountCents,
        createdAt: item.createdAt,
        detail: `${item.accountHolder} (${item.accountNumber})`
      });
    }
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return rows;
  }, [topups, withdrawals]);

  async function handleCreateWithdraw() {
    const amountCents = Number(withdrawAmount);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      notifyError("Nominal withdraw tidak valid.");
      return;
    }

    const toastId = notifyLoading("Membuat request withdraw...");
    setIsWithdrawSubmitting(true);
    try {
      const response = await fetch("/api/wallet/withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents,
          bankName: withdrawBankName,
          accountNumber: withdrawAccountNumber,
          accountHolder: withdrawAccountHolder
        })
      });

      const payload = (await response.json().catch(() => null)) as WithdrawResponse | null;
      if (!response.ok || !payload?.data?.request) {
        throw new Error(payload?.error?.message ?? "Gagal membuat request withdraw.");
      }

      dismissNotify(toastId);
      notifySuccess("Request withdraw berhasil dibuat.");
      setShowWithdrawDialog(false);
      await loadData();
    } catch (submitError) {
      dismissNotify(toastId);
      notifyError(submitError instanceof Error ? submitError.message : "Gagal membuat request withdraw.");
    } finally {
      setIsWithdrawSubmitting(false);
    }
  }

  if (isForbidden) {
    return (
      <div className="w-full flex-1 overflow-auto p-4 md:p-6 lg:p-8">
        <div className="rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          Menu Finance hanya bisa diakses oleh role owner.
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex-1 overflow-auto p-4 md:p-6 lg:p-8">
      <div className="space-y-6 max-w-6xl mx-auto">
        <header className="rounded-[28px] border border-border/70 bg-gradient-to-br from-card to-card/90 p-6 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.02)] relative overflow-hidden group">
          <div className="absolute inset-0 bg-grid-black/[0.02] dark:bg-grid-white/[0.02] [mask-image:linear-gradient(to_bottom_right,white,transparent)]" />
          <div className="flex items-center gap-4 relative z-10">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 shadow-sm">
              <Wallet className="h-7 w-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Finance</h1>
              <p className="mt-1.5 text-sm font-medium text-muted-foreground/80">Kelola saldo e-payment, withdraw, dan riwayat transaksi.</p>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid gap-4 xl:grid-cols-2">
            <Skeleton className="h-[200px] w-full rounded-3xl" />
            <Skeleton className="h-[200px] w-full rounded-3xl" />
            <Skeleton className="h-[120px] w-full rounded-3xl xl:col-span-2" />
          </div>
        ) : null}

        {!isLoading ? (
          <>
            <section className="grid gap-5 xl:grid-cols-2">
              <article className="rounded-[28px] border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 p-6 shadow-sm relative overflow-hidden">
                <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/10 blur-3xl lg:block hidden" />
                <div className="relative z-10 flex flex-col h-full">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-800 dark:text-emerald-400">Saldo E-Payment</p>
                    <p className="mt-2 text-4xl sm:text-5xl font-black tracking-tight text-emerald-950 dark:text-emerald-50">{formatIdr(balanceCents)}</p>

                    <div className="mt-5 rounded-2xl border border-emerald-500/20 bg-white/60 dark:bg-black/20 backdrop-blur-md px-5 py-3.5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Pending settlement</span>
                        <span className="text-sm font-bold text-emerald-900 dark:text-emerald-100">{formatIdr(pendingSettlementCents)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-auto pt-6 flex gap-3">
                    <Button type="button" className="h-12 w-full sm:w-auto rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold text-white shadow-[0_8px_20px_-6px_rgba(16,185,129,0.3)] transition-all px-6" onClick={() => setShowWithdrawDialog(true)}>
                      <ArrowDownToLine className="mr-2.5 h-5 w-5" />
                      Tarik Saldo
                    </Button>
                  </div>
                </div>
              </article>

              <article className="rounded-[28px] border border-border/70 bg-gradient-to-br from-card to-card/90 p-6 shadow-sm relative overflow-hidden flex flex-col justify-between">
                <div className="absolute -right-10 -bottom-10 h-40 w-40 rounded-full bg-primary/5 blur-3xl lg:block hidden" />
                <div className="relative z-10">
                  <p className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground/80">Saldo Bank Transfer</p>
                  <p className="mt-2 text-4xl sm:text-5xl font-black tracking-tight text-foreground">{formatIdr(0)}</p>
                </div>
                <div className="mt-6 rounded-2xl border border-border/60 bg-background/50 px-5 py-4 text-[13.5px] font-medium leading-relaxed text-muted-foreground shadow-sm relative z-10">
                  <p className="flex items-start gap-2.5"><span className="text-primary mt-px">•</span> <span>Dana bank transfer manual tetap masuk ke rekening bisnis Anda.</span></p>
                  <p className="flex items-start gap-2.5 mt-2"><span className="text-primary mt-px">•</span> <span>Saldo e-payment dipakai untuk biaya gateway yang ditanggung merchant.</span></p>
                </div>
              </article>
            </section>

            <section className="grid gap-5 md:grid-cols-3">
              <article className="rounded-[28px] border border-border/70 bg-gradient-to-br from-card to-card/90 p-6 shadow-sm relative overflow-hidden">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80 relative z-10">Total Saldo Ditarik</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-foreground relative z-10">{formatIdr(totalWithdrawnCents)}</p>
              </article>
              <article className="rounded-[28px] border border-border/70 bg-gradient-to-br from-card to-card/90 p-6 shadow-sm relative overflow-hidden">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80 relative z-10">Dalam Proses</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-foreground relative z-10">{formatIdr(inProcessWithdrawCents)}</p>
              </article>
              <article className="rounded-[28px] border border-border/70 bg-gradient-to-br from-card to-card/90 p-6 shadow-sm relative overflow-hidden">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80 relative z-10">Total Disbursement</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-foreground relative z-10">{formatIdr(totalWithdrawnCents)}</p>
              </article>
            </section>

            <section className="overflow-hidden rounded-[28px] border border-border/70 bg-card shadow-sm mt-8">
              <header className="border-b border-border/60 bg-gradient-to-r from-muted/30 to-transparent px-6 py-5 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2.5 text-[18px] font-bold tracking-tight text-foreground">
                    <Wallet className="h-5 w-5 text-emerald-500" />
                    Riwayat Transaksi
                  </p>
                  <p className="text-[13px] font-medium text-muted-foreground pt-1.5">Daftar transaksi e-payment terbaru.</p>
                </div>
              </header>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr className="text-left">
                      <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Settlement Status & Waktu</th>
                      <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Reference ID</th>
                      <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Type</th>
                      <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Channel</th>
                      <th className="px-6 py-4 text-[12px] font-bold uppercase tracking-wider text-muted-foreground text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map((row) => (
                      <tr key={row.id} className="border-t border-border/50 transition-colors hover:bg-muted/20">
                        <td className="px-6 py-4">
                          <p className="font-bold text-foreground text-[14px]">{row.status}</p>
                          <p className="text-[12px] font-medium text-muted-foreground mt-0.5">{formatDate(row.createdAt)}</p>
                        </td>
                        <td className="px-6 py-4 text-[13px] font-medium text-muted-foreground">{row.detail}</td>
                        <td className="px-6 py-4">
                           <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black uppercase tracking-wider ${row.type === 'TOPUP' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
                             {row.type}
                           </span>
                        </td>
                        <td className="px-6 py-4 text-[14px] font-medium text-foreground">{row.channel}</td>
                        <td className="px-6 py-4 font-bold text-foreground text-[15px] text-right">{formatIdr(row.amountCents)}</td>
                      </tr>
                    ))}
                    {historyRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-12 text-center text-[14px] font-medium text-muted-foreground">
                          Tidak ada data transaksi.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-rose-300/70 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
        ) : null}
      </div>

      <Dialog open={showWithdrawDialog} onOpenChange={setShowWithdrawDialog}>
        <DialogContent className="sm:max-w-[480px] p-0 border-border/60 rounded-[32px] overflow-hidden shadow-2xl">
          <div className="bg-background">
            <DialogHeader className="border-b border-border/50 px-8 py-7 bg-gradient-to-br from-muted/30 to-transparent">
              <DialogTitle className="flex items-center gap-3 text-[22px] font-bold tracking-tight text-foreground">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                  <ArrowDownToLine className="h-5 w-5" />
                </div>
                Tarik Saldo
              </DialogTitle>
              <DialogDescription className="text-[14px] font-medium text-muted-foreground mt-2 leading-relaxed">
                Withdraw saldo e-payment ke rekening bisnis Anda.
              </DialogDescription>
            </DialogHeader>
            <div className="px-8 py-7 space-y-6">
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-5 py-4 flex items-center justify-between col-span-full">
                <span className="text-[13px] font-semibold text-emerald-800 dark:text-emerald-400">Saldo yang dapat ditarik</span>
                <span className="text-[18px] font-bold text-emerald-900 dark:text-emerald-100">{formatIdr(balanceCents)}</span>
              </div>

              <label className="block space-y-2.5">
                <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Nominal Penarikan</span>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 font-semibold text-foreground/50">Rp</div>
                  <Input
                    value={withdrawAmount}
                    onChange={(event) => setWithdrawAmount(event.target.value)}
                    placeholder="Contoh: 50000"
                    type="number"
                    min={0}
                    max={balanceCents}
                    className="h-14 w-full rounded-2xl border-border/60 bg-background pl-12 pr-4 text-[16px] font-medium shadow-sm transition-all focus-visible:border-emerald-500/40 focus-visible:ring-4 focus-visible:ring-emerald-500/10"
                  />
                </div>
              </label>

              <div className="grid grid-cols-2 gap-4">
                 <label className="block space-y-2.5">
                    <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Nama Bank</span>
                    <Input
                      value={withdrawBankName}
                      onChange={(event) => setWithdrawBankName(event.target.value)}
                      placeholder="Contoh: BCA"
                      className="h-12 w-full rounded-2xl border-border/60 bg-background px-4 text-[14px] font-medium shadow-sm transition-all focus-visible:border-emerald-500/40 focus-visible:ring-4 focus-visible:ring-emerald-500/10"
                    />
                 </label>
                 <label className="block space-y-2.5">
                    <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Nomor Rekening</span>
                    <Input
                      value={withdrawAccountNumber}
                      onChange={(event) => setWithdrawAccountNumber(event.target.value)}
                      placeholder="Nomor rekening tujuan"
                      type="number"
                      className="h-12 w-full rounded-2xl border-border/60 bg-background px-4 text-[14px] font-medium shadow-sm transition-all focus-visible:border-emerald-500/40 focus-visible:ring-4 focus-visible:ring-emerald-500/10"
                    />
                 </label>
              </div>

              <label className="block space-y-2.5">
                 <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Atas Nama</span>
                 <Input
                   value={withdrawAccountHolder}
                   onChange={(event) => setWithdrawAccountHolder(event.target.value)}
                   placeholder="Nama pemilik rekening"
                   className="h-12 w-full rounded-2xl border-border/60 bg-background px-4 text-[14px] font-medium shadow-sm transition-all focus-visible:border-emerald-500/40 focus-visible:ring-4 focus-visible:ring-emerald-500/10"
                 />
              </label>

              <div className="pt-4">
                <Button
                  type="button"
                  className="w-full h-14 rounded-2xl bg-emerald-600 hover:bg-emerald-700 font-bold text-white shadow-[0_8px_20px_-6px_rgba(16,185,129,0.3)] transition-all text-[16px]"
                  onClick={() => void handleCreateWithdraw()}
                  disabled={isWithdrawSubmitting}
                >
                  Buat Request Withdraw
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

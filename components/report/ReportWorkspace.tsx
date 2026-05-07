"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { Activity, RefreshCw, Users, UserRoundSearch, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { DashboardDateRangePicker } from "@/components/dashboard/dashboard-date-range-picker";
import { Button } from "@/components/ui/button";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
type TabValue = "leads" | "customers";

const palette = ["#2563eb", "#7c3aed", "#10b981", "#f59e0b", "#22c55e", "#64748b", "#14b8a6", "#e11d48"];

type DistributionItem = { label: string; value: number };
type TrendItem = { date: string; label: string; customers: number; activeCustomers: number };
type CustomerDetailRow = {
  id: string;
  name: string | null;
  whatsapp: string;
  statusLead: string;
  followUp: string | null;
  followUpAt: string | null;
  businessCategory: string | null;
  detail: string | null;
  source: string | null;
  pipelineStage: string;
  projectValueCents: number;
  assignee: string;
  notes: string | null;
};

type ReportPayload = {
  data?: {
    range: { from: string; to: string };
    leads: {
      total: number;
      leadStatus: DistributionItem[];
      hotness: DistributionItem[];
      stage: DistributionItem[];
      source: DistributionItem[];
      campaign: DistributionItem[];
      businessCategory: DistributionItem[];
      followUp: DistributionItem[];
      assigned: DistributionItem[];
      trend: TrendItem[];
    };
    customers: {
      total: number;
      stage: DistributionItem[];
      status: DistributionItem[];
      followUp: DistributionItem[];
      source: DistributionItem[];
      campaign: DistributionItem[];
      businessCategory: DistributionItem[];
      assigned: DistributionItem[];
      retention: TrendItem[];
      avgMessageDurationSec: number;
      connectedOutboundMessages: number;
      totalProjectValueCents: number;
      details: CustomerDetailRow[];
    };
  };
  error?: {
    message?: string;
  };
};

function startOfDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function toDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseTab(raw: string | undefined): TabValue {
  return raw === "customers" ? "customers" : "leads";
}

function formatDuration(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format((cents || 0) / 100);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
}

const barConfig = {
  value: {
    label: "Total",
    color: "hsl(var(--primary))"
  }
} satisfies ChartConfig;

const lineConfig = {
  customers: {
    label: "Customers",
    color: "hsl(220 90% 56%)"
  },
  activeCustomers: {
    label: "Active Customers",
    color: "hsl(338 82% 57%)"
  }
} satisfies ChartConfig;

function SummaryCard({ title, value, icon: Icon }: { title: string; value: string; icon: LucideIcon }) {
  return (
    <article className="rounded-2xl border border-border/50 bg-card/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70">{title}</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight text-foreground">{value}</p>
    </article>
  );
}

function DistributionBarChart({ title, data }: { title: string; data: DistributionItem[] }) {
  return (
    <article className="rounded-2xl border border-border/50 bg-card/40 p-4 md:p-5">
      <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
      <div className="mt-4 h-64">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/70 text-sm text-muted-foreground">
            No data available
          </div>
        ) : (
          <ChartContainer config={barConfig} className="h-full w-full">
            <BarChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={56} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip cursor={{ fill: "hsl(var(--muted)/0.2)" }} />
              <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                {data.map((entry, index) => (
                  <Cell key={`${entry.label}-${index}`} fill={palette[index % palette.length]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </div>
    </article>
  );
}

function DistributionDonutChart({ title, data }: { title: string; data: DistributionItem[] }) {
  return (
    <article className="rounded-2xl border border-border/50 bg-card/40 p-4 md:p-5">
      <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_200px] md:items-center">
        <div className="h-60">
          {data.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/70 text-sm text-muted-foreground">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="label" innerRadius={54} outerRadius={90} paddingAngle={2}>
                  {data.map((entry, index) => (
                    <Cell key={`${entry.label}-${index}`} fill={palette[index % palette.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="space-y-1.5">
          {data.slice(0, 8).map((item, index) => (
            <div key={`${item.label}-${index}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette[index % palette.length] }} />
                {item.label}
              </span>
              <span className="font-semibold text-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function LeadsStageFunnel({ data }: { data: DistributionItem[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const funnelColors = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#22c55e"];
  const ordered = [...data].sort((a, b) => {
    const aUnassigned = a.label.trim().toLowerCase() === "unassigned";
    const bUnassigned = b.label.trim().toLowerCase() === "unassigned";
    if (aUnassigned && !bUnassigned) return -1;
    if (!aUnassigned && bUnassigned) return 1;
    return 0;
  });
  const blocks = ordered.slice(0, 5).map((item, index) => ({
    ...item,
    color: funnelColors[index % funnelColors.length]
  }));

  const stageCount = blocks.length;
  const widthStops =
    stageCount <= 1
      ? [82]
      : Array.from({ length: stageCount }, (_, i) => {
          const start = 82;
          const end = 36;
          return start - ((start - end) * i) / (stageCount - 1);
        });

  const chartWidth = 700;
  const chartHeight = 360;
  const centerX = 280;
  const segmentHeight = stageCount > 0 ? 300 / stageCount : 0;
  const topY = 24;
  const rightLabelX = 520;

  return (
    <article className="rounded-2xl border border-border/50 bg-card/40 p-4 md:p-5">
      <h3 className="text-sm font-bold tracking-tight text-foreground">Leads Stage</h3>
      <div className="mt-4 min-h-[420px]">
        {blocks.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/70 text-sm text-muted-foreground">
            No data available
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="h-[360px] w-full min-w-[640px]">
              {Array.from({ length: stageCount + 1 }).map((_, idx) => {
                const y = topY + idx * segmentHeight;
                return <line key={`grid-${idx}`} x1={20} y1={y} x2={rightLabelX - 20} y2={y} stroke="hsl(var(--border))" strokeWidth="1" />;
              })}

              {blocks.map((item, idx) => {
                const y1 = topY + idx * segmentHeight;
                const y2 = y1 + segmentHeight;
                const topWidth = widthStops[idx];
                const bottomWidth = widthStops[Math.min(idx + 1, widthStops.length - 1)];
                const topHalf = (topWidth / 100) * 210;
                const bottomHalf = (bottomWidth / 100) * 210;

                const xTopLeft = centerX - topHalf;
                const xTopRight = centerX + topHalf;
                const xBottomLeft = centerX - bottomHalf;
                const xBottomRight = centerX + bottomHalf;

                const path = `M ${xTopLeft} ${y1} L ${xTopRight} ${y1} L ${xBottomRight} ${y2} L ${xBottomLeft} ${y2} Z`;
                const labelY = y1 + segmentHeight / 2 + 6;
                const labelX = centerX;
                const lineStartX = xTopRight - 4;
                const lineEndX = rightLabelX - 28;
                const rightTextY = y1 + segmentHeight / 2 + 5;

                return (
                  <g
                    key={`${item.label}-${idx}`}
                    className="cursor-pointer transition-all duration-200"
                    onMouseEnter={() => setHoveredIndex(idx)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    <path
                      d={path}
                      fill={item.color}
                      stroke={hoveredIndex === idx ? "rgba(15,23,42,0.35)" : "transparent"}
                      strokeWidth={hoveredIndex === idx ? 2 : 0}
                      opacity={hoveredIndex === null || hoveredIndex === idx ? 1 : 0.82}
                    />
                    <title>{`${item.label}: ${item.value.toLocaleString("id-ID")}`}</title>
                    <text x={labelX} y={labelY} textAnchor="middle" fontSize="28" fontWeight="600" fill={idx === 3 ? "#0f172a" : "#ffffff"}>
                      {item.value.toLocaleString("id-ID")}
                    </text>
                    <line x1={lineStartX} y1={y1 + segmentHeight / 2} x2={lineEndX} y2={y1 + segmentHeight / 2} stroke="hsl(var(--muted-foreground))" strokeOpacity="0.45" strokeDasharray="4 4" />
                    <text x={rightLabelX - 16} y={rightTextY} textAnchor="start" fontSize="14" fontWeight="500" fill="hsl(var(--muted-foreground))">
                      {item.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </article>
  );
}

function TrendChart({ title, data }: { title: string; data: TrendItem[] }) {
  return (
    <article className="rounded-2xl border border-border/50 bg-card/40 p-4 md:p-5">
      <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
      <div className="mt-4 h-72">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/70 text-sm text-muted-foreground">
            No data available
          </div>
        ) : (
          <ChartContainer config={lineConfig} className="h-full w-full">
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Line type="monotone" dataKey="customers" stroke="var(--color-customers)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="activeCustomers" stroke="var(--color-activeCustomers)" strokeWidth={2} dot={false} />
            </LineChart>
          </ChartContainer>
        )}
      </div>
    </article>
  );
}

function CustomerDetailsTable({ rows }: { rows: CustomerDetailRow[] }) {
  return (
    <article className="rounded-2xl border border-border/50 bg-card/40 p-4 md:p-5">
      <h3 className="text-sm font-bold tracking-tight text-foreground">Customers Detail Snapshot</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-[1200px] w-full text-xs">
          <thead>
            <tr className="border-b border-border/60 text-left text-muted-foreground">
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">WhatsApp</th>
              <th className="px-2 py-2">Status Lead</th>
              <th className="px-2 py-2">Follow-up</th>
              <th className="px-2 py-2">Follow-up Date</th>
              <th className="px-2 py-2">Business Category</th>
              <th className="px-2 py-2">Detail</th>
              <th className="px-2 py-2">Source</th>
              <th className="px-2 py-2">Pipeline Stage</th>
              <th className="px-2 py-2">Project Value</th>
              <th className="px-2 py-2">Assignee</th>
              <th className="px-2 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-2 py-6 text-center text-muted-foreground">No data available</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-b border-border/30 align-top">
                  <td className="px-2 py-2 font-medium text-foreground">{row.name ?? "-"}</td>
                  <td className="px-2 py-2">{row.whatsapp}</td>
                  <td className="px-2 py-2">{row.statusLead}</td>
                  <td className="px-2 py-2">{row.followUp ?? "-"}</td>
                  <td className="px-2 py-2">{formatDateTime(row.followUpAt)}</td>
                  <td className="px-2 py-2">{row.businessCategory ?? "-"}</td>
                  <td className="px-2 py-2">{row.detail ?? "-"}</td>
                  <td className="px-2 py-2">{row.source ?? "-"}</td>
                  <td className="px-2 py-2">{row.pipelineStage}</td>
                  <td className="px-2 py-2">{formatMoney(row.projectValueCents)}</td>
                  <td className="px-2 py-2">{row.assignee}</td>
                  <td className="px-2 py-2">{row.notes ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

export function ReportWorkspace({
  initialTab,
  initialFrom,
  initialTo
}: {
  initialTab?: string;
  initialFrom?: string;
  initialTo?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const defaultTo = useMemo(() => startOfDay(new Date()), []);
  const defaultFrom = useMemo(() => new Date(defaultTo.getTime() - 29 * MS_PER_DAY), [defaultTo]);

  const from = searchParams.get("from") ?? initialFrom ?? toDateParam(defaultFrom);
  const to = searchParams.get("to") ?? initialTo ?? toDateParam(defaultTo);
  const tab = parseTab(searchParams.get("tab") ?? initialTab);

  const [payload, setPayload] = useState<ReportPayload["data"] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadData() {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
          cache: "no-store"
        });
        const body = (await response.json().catch(() => null)) as ReportPayload | null;
        if (!active) {
          return;
        }
        if (!response.ok || !body?.data) {
          throw new Error(body?.error?.message ?? "Gagal memuat report.");
        }
        setPayload(body.data);
      } catch (fetchError) {
        if (!active) {
          return;
        }
        setError(fetchError instanceof Error ? fetchError.message : "Gagal memuat report.");
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadData();
    return () => {
      active = false;
    };
  }, [from, to]);

  const leadsData = payload?.leads;
  const customersData = payload?.customers;

  function handleTabChange(nextTab: string) {
    const value = parseTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function handleRefresh() {
    router.refresh();
  }

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="inbox-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 pb-4 pt-3 md:gap-5 md:px-5 md:pb-6 md:pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground md:text-2xl">Report</h1>
            <p className="text-xs text-muted-foreground">Leads & Customers analytics berdasarkan data existing.</p>
          </div>
          <div className="flex items-center gap-2">
            <DashboardDateRangePicker from={from} to={to} />
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>

        <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-xl border border-border/60 bg-muted/30 p-1">
            <TabsTrigger value="leads" className="rounded-lg">Leads</TabsTrigger>
            <TabsTrigger value="customers" className="rounded-lg">Customers</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="rounded-2xl border border-border/60 bg-card/40 p-8 text-center text-sm text-muted-foreground">Loading report...</div>
        ) : error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
        ) : tab === "leads" && leadsData ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <SummaryCard title="Total Leads" value={String(leadsData.total)} icon={Users} />
              <SummaryCard title="Status Lead Variants" value={String(leadsData.leadStatus.length)} icon={UserRoundSearch} />
              <SummaryCard title="Follow-up Variants" value={String(leadsData.followUp.length)} icon={Activity} />
              <SummaryCard title="Assigned Variants" value={String(leadsData.assigned.length)} icon={Activity} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <LeadsStageFunnel data={leadsData.stage} />
              <DistributionDonutChart title="Status Lead" data={leadsData.leadStatus} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <DistributionBarChart title="Follow-up" data={leadsData.followUp} />
              <DistributionBarChart title="Assign" data={leadsData.assigned} />
            </div>

            <TrendChart title="Leads Daily Activity" data={leadsData.trend} />

            <div className="grid gap-4 xl:grid-cols-2">
              <DistributionDonutChart title="Lead Source" data={leadsData.source} />
              <DistributionBarChart title="Campaign" data={leadsData.campaign} />
            </div>

            <DistributionBarChart title="Business Category" data={leadsData.businessCategory} />
          </>
        ) : customersData ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <SummaryCard title="Total Customers" value={String(customersData.total)} icon={Users} />
              <SummaryCard title="Avg Message Duration" value={formatDuration(customersData.avgMessageDurationSec)} icon={Activity} />
              <SummaryCard title="Connected Outbound" value={String(customersData.connectedOutboundMessages)} icon={Activity} />
              <SummaryCard title="Total Project Value" value={formatMoney(customersData.totalProjectValueCents)} icon={Wallet} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <DistributionBarChart title="Customers Stage" data={customersData.stage} />
              <DistributionDonutChart title="Status Lead" data={customersData.status} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <DistributionBarChart title="Follow-up" data={customersData.followUp} />
              <DistributionBarChart title="Assign" data={customersData.assigned} />
            </div>

            <TrendChart title="Retention Activity" data={customersData.retention} />

            <div className="grid gap-4 xl:grid-cols-2">
              <DistributionDonutChart title="Customers Source" data={customersData.source} />
              <DistributionBarChart title="Campaign" data={customersData.campaign} />
            </div>

            <DistributionBarChart title="Business Category" data={customersData.businessCategory} />
            <CustomerDetailsTable rows={customersData.details} />
          </>
        ) : null}
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  MessageSquare,
  Users,
  Database,
  ArrowRight,
  CheckCircle2,
  Zap,
  Shield,
  BarChart3,
  Send,
  UserPlus,
  Receipt,
  Target,
  LineChart,
  MousePointerClick,
  Activity,
  FileText,
  TrendingUp,
  ChevronDown,
} from "lucide-react";

/* ── scroll-reveal hook ── */
function useScrollReveal() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );

    const targets = el.querySelectorAll(".reveal");
    targets.forEach((t) => observer.observe(t));

    return () => observer.disconnect();
  }, []);

  return ref;
}

/* ── animated counter ── */
function AnimatedStat({ value, suffix, label }: { value: number; suffix: string; label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const counted = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !counted.current) {
          counted.current = true;
          let start = 0;
          const duration = 1600;
          const startTime = performance.now();

          function tick(now: number) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 4);
            start = Math.floor(eased * value);
            if (el) el.textContent = `${start}${suffix}`;
            if (progress < 1) requestAnimationFrame(tick);
          }

          requestAnimationFrame(tick);
          observer.unobserve(el);
        }
      },
      { threshold: 0.5 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [value, suffix]);

  return (
    <div className="stat-item flex flex-col items-center gap-1 px-4 py-8 text-center">
      <span ref={ref} className="text-3xl font-bold text-foreground md:text-4xl lg:text-5xl">
        0{suffix}
      </span>
      <span className="text-xs text-muted-foreground md:text-sm">{label}</span>
    </div>
  );
}

export default function HomePage() {
  const containerRef = useScrollReveal();

  return (
    <div ref={containerRef} className="landing-page relative min-h-screen">
      
      {/* ━━━ GLOBAL AMBIENT BACKGROUND ━━━ 
          Utilizing a fixed background element prevents any cutoff between HTML sections and ensures 
          a massive continuous canvas feeling on scroll. */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background">
        <div className="absolute left-[10%] top-[-10%] h-[70vw] w-[70vw] max-w-[800px] rounded-full bg-primary/10 blur-[140px] mix-blend-screen" />
        <div className="absolute right-[-10%] top-[40%] h-[50vw] w-[50vw] max-w-[600px] rounded-full bg-blue-500/5 blur-[120px] mix-blend-screen" />
        <div className="absolute bottom-[-10%] left-[20%] h-[60vw] w-[60vw] max-w-[700px] rounded-full bg-violet-500/5 blur-[130px] mix-blend-screen" />
      </div>

      {/* ━━━ HERO ━━━ */}
      <section className="relative flex min-h-screen flex-col items-center justify-center px-4 pt-14 md:px-6">
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="reveal mb-8 inline-flex flex-wrap items-center justify-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-4 py-1.5 text-xs font-semibold text-primary backdrop-blur-md">
            <Zap className="h-3.5 w-3.5" />
            <span className="whitespace-nowrap">Didesain Khusus untuk Bisnis Berbasis WhatsApp</span>
          </div>

          <h1 className="reveal text-4xl font-extrabold leading-[1.1] tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
            Sistem operasi terlengkap untuk bisnis <span className="bg-gradient-to-r from-primary via-emerald-400 to-teal-400 bg-clip-text text-transparent">sentris WhatsApp</span>
          </h1>

          <p className="reveal mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            Berhenti memaksakan workflow pada aplikasi yang menolak WhatsApp. 20byte mengubah WhatsApp menjadi pusat operasi utuh: kelola jutaan chat, geser pipeline CRM, cetak invoice native, dan ukur ROAS presisi dari satu tab.
          </p>

          <div className="reveal mt-12 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/register"
              id="hero-register-btn"
              className="group inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary px-8 text-sm font-semibold text-primary-foreground shadow-[0_8px_30px_hsl(var(--primary)/0.3)] transition-all duration-300 hover:scale-[1.02] hover:bg-primary/90 hover:shadow-[0_12px_40px_hsl(var(--primary)/0.4)] sm:w-auto"
            >
              Mulai Trial Spesial Anda
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </Link>
            <Link
              href="/login"
              id="hero-login-btn"
              className="group inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-card/30 px-8 text-sm font-semibold text-foreground backdrop-blur-md transition-all duration-300 hover:border-foreground/30 hover:bg-card/60 sm:w-auto"
            >
              Buka Dashboard
              <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
            </Link>
          </div>

          <p className="reveal mt-8 flex flex-wrap items-center justify-center gap-3 text-xs font-medium text-muted-foreground">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-primary" /> Tanpa kartu kredit</span>
            <span className="hidden opacity-50 sm:block">•</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-primary" /> Setup &lt; 5 menit</span>
            <span className="hidden opacity-50 sm:block">•</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-primary" /> Batalkan kapan saja</span>
          </p>

          <a
            href="https://www.producthunt.com/products/20byte-crm?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-20byte-crm"
            target="_blank"
            rel="noopener noreferrer"
            className="reveal mt-8 inline-block transition-opacity hover:opacity-90"
          >
            {/* Product Hunt serves this badge as an external SVG widget. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt="20byte CRM - WhatsApp CRM + Meta Ads Attribution | Product Hunt"
              width="250"
              height="54"
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1188122&theme=light&t=1783221935246"
            />
          </a>
        </div>

        {/* scroll prompt */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 animate-bounce">
          <ChevronDown className="h-6 w-6 text-muted-foreground/50" />
        </div>
      </section>

      {/* ━━━ FEATURES ━━━ */}
      <section className="relative z-10 px-4 py-24 md:px-6 md:py-40" id="features">
        <div className="mx-auto max-w-6xl">
          <div className="reveal mb-16 text-center md:mb-24">
            <h2 className="text-3xl font-bold tracking-tight text-foreground md:text-5xl">
              Ekosistem jualan WhatsApp tanpa hambatan
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
              Berhenti menyuruh CS berpindah-pindah aplikasi saat mengejar konversi. 20byte menyatukan setiap senjata closing yang tercecer, meleburnya jadi satu mesin uang dalam harmoni.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: MessageSquare,
                title: "Shared Team Inbox",
                desc: "Kelola ribuan chat masuk tanpa bentrok. Assign agen, tulis internal note, dan balas lebih cepat dari satu dashboard.",
              },
              {
                icon: BarChart3,
                title: "Visual CRM Pipeline",
                desc: "Visualisasikan funnel sales Anda. Geser prospek antar stage dengan drag-and-drop dan pantau potensi revenue real-time.",
              },
              {
                icon: Database,
                title: "Smart Database",
                desc: "Setiap pelanggan memiliki profil komprehensif. Lacak riwayat percakapan, tag, notes, dan timeline aktivitas.",
              },
              {
                icon: Receipt,
                title: "e-Invoicing Native",
                desc: "Buat dan kirim tagihan profesional di tengah obrolan. Pantau status pembayaran (DP hingga Lunas) dengan bukti valid.",
              },
            ].map((f, i) => (
              <article
                key={f.title}
                className="reveal feature-card group relative overflow-hidden rounded-3xl border border-border/30 bg-card/40 p-8 shadow-sm backdrop-blur-md transition-all duration-500 hover:-translate-y-2 hover:border-primary/30 hover:bg-card/60 hover:shadow-2xl hover:shadow-primary/10"
                style={{ transitionDelay: `${i * 100}ms` }}
              >
                <div className="relative z-10">
                  <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform duration-500 group-hover:scale-110 group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-[0_0_20px_hsl(var(--primary)/0.5)]">
                    <f.icon className="h-6 w-6" />
                  </div>
                  <h3 className="mb-3 text-lg font-bold text-foreground transition-colors duration-300">{f.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ CTWA · CAPI · PIXEL  ━━━ */}
      <section className="relative z-10 px-4 py-24 md:px-6 md:py-40" id="ctwa-integration">
        <div className="mx-auto max-w-6xl">
          <div className="reveal mb-16 text-center md:mb-24">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-xs font-semibold text-violet-500 backdrop-blur-md">
              <Target className="h-3.5 w-3.5" />
              Advanced Attribution
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-foreground md:text-5xl">
              ROI iklan yang terukur pasti
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
              Lacak setiap klik dari iklan Meta hingga berujung pada invoice lunas. Sistem cerdas kami otomatis menyinkronkan setiap event konversi balik ke Ads Manager Anda.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {/* CTWA */}
            <div className="reveal group relative overflow-hidden rounded-3xl border border-border/30 bg-card/40 p-8 shadow-sm backdrop-blur-md transition-all duration-500 hover:-translate-y-2 hover:border-blue-500/40 hover:bg-card/60 hover:shadow-2xl hover:shadow-blue-500/10">
              <div className="relative z-10">
                <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500 transition-transform duration-500 group-hover:scale-110 group-hover:bg-blue-500 group-hover:text-white group-hover:shadow-[0_0_20px_rgba(59,130,246,0.5)]">
                  <MousePointerClick className="h-6 w-6" />
                </div>
                <h3 className="mb-3 text-xl font-bold text-foreground">Akurasi CTWA</h3>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
                  Gunakan shortlink cerdas. Setiap pesan masuk otomatis tagging Campaign, Adset, hingga Ad identifier tanpa meleset.
                </p>
                <ul className="space-y-3">
                  {[
                    "Shortlink otomatis per aset iklan",
                    "Tagging source lead real-time",
                    "Dashboard tracking performa",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-muted-foreground font-medium">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* CAPI */}
            <div className="reveal group relative overflow-hidden rounded-3xl border border-border/30 bg-card/40 p-8 shadow-sm backdrop-blur-md transition-all duration-500 hover:-translate-y-2 hover:border-emerald-500/40 hover:bg-card/60 hover:shadow-2xl hover:shadow-emerald-500/10">
              <div className="relative z-10">
                <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500 transition-transform duration-500 group-hover:scale-110 group-hover:bg-emerald-500 group-hover:text-white group-hover:shadow-[0_0_20px_rgba(16,185,129,0.5)]">
                  <Activity className="h-6 w-6" />
                </div>
                <h3 className="mb-3 text-xl font-bold text-foreground">Conversions API</h3>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
                  Laporkan konversi via koneksi server-side aman setiap kali invoice diterbitkan atau dibayar. Kebal ad-blocker.
                </p>
                <ul className="space-y-3">
                  {[
                    "Koneksi S2S absolut & aman",
                    "Tembakkan event saat invoice cair",
                    "Deduplikasi data otomatis",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-muted-foreground font-medium">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Pixel */}
            <div className="reveal group relative overflow-hidden rounded-3xl border border-border/30 bg-card/40 p-8 shadow-sm backdrop-blur-md transition-all duration-500 hover:-translate-y-2 hover:border-violet-500/40 hover:bg-card/60 hover:shadow-2xl hover:shadow-violet-500/10">
              <div className="relative z-10">
                <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-500 transition-transform duration-500 group-hover:scale-110 group-hover:bg-violet-500 group-hover:text-white group-hover:shadow-[0_0_20px_rgba(139,92,246,0.5)]">
                  <LineChart className="h-6 w-6" />
                </div>
                <h3 className="mb-3 text-xl font-bold text-foreground">Meta Pixel Native</h3>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
                  Halaman invoice publik tertanam Meta Pixel. Lacak ViewContent pelanggan untuk kampanye retargeting laser-focus.
                </p>
                <ul className="space-y-3">
                  {[
                    "Pixel di public invoice",
                    "Retargeting abandoned invoice",
                    "Pembangunan Custom Audience",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-muted-foreground font-medium">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Flow diagram */}
          <div className="reveal mt-12 overflow-hidden rounded-3xl border border-border/20 bg-card/20 p-8 backdrop-blur-xl md:p-12 lg:p-16">
            <h3 className="mb-10 text-center text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Arsitektur Alur Otomasi
            </h3>
            <div className="flow-diagram flex flex-col items-center gap-4 md:flex-row md:justify-center md:gap-0">
              {[
                { icon: MousePointerClick, label: "Klik Iklan", accent: "blue" as const },
                { icon: MessageSquare, label: "Chat Masuk", accent: "emerald" as const },
                { icon: Users, label: "Lead di Pipeline", accent: "emerald" as const },
                { icon: Receipt, label: "Penerbitan Invoice", accent: "amber" as const },
                { icon: Activity, label: "Server Event", accent: "violet" as const },
                { icon: TrendingUp, label: "Optimasi ROAS", accent: "blue" as const },
              ].map((step, i, arr) => {
                const colorMap = {
                  blue: "text-blue-500 bg-blue-500/10 border-blue-500/20",
                  emerald: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
                  amber: "text-amber-500 bg-amber-500/10 border-amber-500/20",
                  violet: "text-violet-500 bg-violet-500/10 border-violet-500/20",
                };
                return (
                  <div key={step.label} className="flow-step flex items-center gap-4 md:gap-0" style={{ animationDelay: `${i * 120}ms` }}>
                    <div className={`flex flex-col items-center justify-center gap-3 rounded-2xl border px-6 py-5 transition-all duration-300 hover:scale-110 ${colorMap[step.accent]}`}>
                      <step.icon className="h-6 w-6" />
                      <span className="whitespace-nowrap text-xs font-bold tracking-tight">{step.label}</span>
                    </div>
                    {i < arr.length - 1 && (
                      <>
                        <div className="flow-arrow hidden md:block"><ArrowRight className="mx-3 h-5 w-5 text-muted-foreground/40" /></div>
                        <div className="flow-arrow block md:hidden"><ArrowRight className="h-5 w-5 rotate-90 text-muted-foreground/40" /></div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-10 text-center text-sm font-medium text-muted-foreground">
              Protokol transparan. Tiada lagi closed-loop cycle yang membuat campaign Anda buta data konversi.
            </p>
          </div>
        </div>
      </section>

      {/* ━━━ HOW IT WORKS ━━━ */}
      <section className="relative z-10 px-4 py-24 md:px-6 md:py-40">
        <div className="mx-auto max-w-5xl">
          <div className="reveal mb-16 text-center md:mb-24">
            <h2 className="text-3xl font-bold tracking-tight text-foreground md:text-5xl">
              Alur adopsi instan
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
              Singkirkan instalasi rumit berhari-hari. 20byte didesain untuk live operation sesaat setelah tim Anda login.
            </p>
          </div>

          <div className="grid gap-10 md:grid-cols-3 md:gap-8">
            {[
              {
                icon: UserPlus,
                step: "01",
                title: "Otentikasi & Hubungkan",
                desc: "Hanya butuh 2 menit. Daftarkan entitas bisnis Anda, lalu scan QR Code WhatsApp Business. Infrastruktur seketika aktif.",
              },
              {
                icon: Users,
                step: "02",
                title: "Konfigurasi Kolaborasi",
                desc: "Delegasikan akses dengan Role-Based Guard. Susun stage Pipeline yang merefleksikan proses sales unik perusahaan Anda.",
              },
              {
                icon: Send,
                step: "03",
                title: "Mulai Interaksi Sales",
                desc: "Sambut prospek, negosiasikan deal, dan tutup penjualan via e-Invoice—selesai utuh tanpa harus berganti tab browser.",
              },
            ].map((s, i) => (
              <div
                key={s.step}
                className="reveal group relative flex flex-col items-center text-center"
                style={{ transitionDelay: `${i * 120}ms` }}
              >
                {i < 2 && (
                  <div className="pointer-events-none absolute right-0 top-[2.25rem] hidden h-px w-full bg-gradient-to-r from-transparent via-border/50 to-transparent md:block" />
                )}
                <div className="relative z-10 mb-8 flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-2xl bg-card border border-border/50 text-foreground shadow-sm transition-all duration-500 group-hover:scale-110 group-hover:border-primary/40 group-hover:text-primary group-hover:shadow-[0_10px_30px_hsl(var(--primary)/0.15)]">
                  <s.icon className="h-8 w-8" />
                  <span className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-[10px] font-extrabold text-background transition-colors duration-500 group-hover:bg-primary group-hover:text-primary-foreground">
                    {s.step}
                  </span>
                </div>
                <h3 className="mb-3 text-xl font-bold text-foreground">{s.title}</h3>
                <p className="px-4 text-sm leading-relaxed text-muted-foreground">
                  {s.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ STATS ━━━ */}
      <section className="relative z-10 px-4 py-16 md:px-6 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="reveal overflow-hidden rounded-3xl border border-border/20 bg-card/20 shadow-xl backdrop-blur-lg">
            <div className="grid grid-cols-2 divide-x divide-y divide-border/20 md:grid-cols-4 md:divide-y-0">
              <AnimatedStat value={5} suffix="K+" label="Log Interaksi Harian" />
              <AnimatedStat value={98} suffix="%" label="SLA Response Rate" />
              <AnimatedStat value={3} suffix="x" label="Akselerasi Closing" />
              <AnimatedStat value={500} suffix="+" label="Tenant Terdaftar" />
            </div>
          </div>
        </div>
      </section>

      {/* ━━━ WHY 20BYTE ━━━ */}
      <section className="relative z-10 px-4 py-24 md:px-6 md:py-40">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-16 lg:grid-cols-2 lg:gap-24">
            <div className="reveal">
              <h2 className="text-3xl font-bold leading-tight tracking-tight text-foreground md:text-5xl lg:text-[3.5rem] lg:leading-[1.1]">
                Karena WhatsApp Business biasa tak lagi memadai
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground md:text-lg">
                Bisnis yang mendulang omzet masif lewat WhatsApp tidak bisa bertahan hanya mengandalkan fitur standar. Kami membedah DNA komunikasi WhatsApp untuk merakit mesin konversi tingkat enterprise bagi Anda.
              </p>
            </div>
            <div className="space-y-6">
              {[
                {
                  icon: Shield,
                  title: "Hierarki Otorisasi Bertingkat",
                  desc: "Modul sekuritas memastikan Owner, Admin, dan CS bergerak terisolasi pada area wewenangnya. Tidak ada tabrakan penanganan chat.",
                },
                {
                  icon: Zap,
                  title: "Engine Notifikasi Latensi Rendah",
                  desc: "Push event seketika. Jangan biarkan momentum prospek dingin hanya karena kelambanan websocket sisi client.",
                },
                {
                  icon: FileText,
                  title: "Penerbitan Invoice Contextual",
                  desc: "Link penagihan di-generate tepat di dalam window chat yang berjalan. Tanpa perlu cross-reference identitas pelanggan.",
                },
                {
                  icon: BarChart3,
                  title: "Spektrum Analitik Funnel Penuh",
                  desc: "Data tersaji tak terputus. Dari impresi iklan awal, laju interaksi inbox, higga keberhasilan konversi menjadi revenue.",
                },
              ].map((item, i) => (
                <div
                  key={item.title}
                  className="reveal group flex items-start gap-5 rounded-2xl border border-transparent p-5 transition-all duration-300 hover:border-border/30 hover:bg-card/40 hover:shadow-lg"
                  style={{ transitionDelay: `${i * 100}ms` }}
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-card border border-border/50 text-foreground transition-all duration-500 group-hover:scale-110 group-hover:border-primary/40 group-hover:text-primary group-hover:shadow-[0_5px_20px_hsl(var(--primary)/0.2)]">
                    <item.icon className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-foreground">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {item.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ━━━ CTA ━━━ */}
      <section className="relative z-10 px-4 py-24 pb-32 md:px-6 md:py-40 md:pb-48">
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="reveal relative overflow-hidden rounded-[2.5rem] border border-primary/20 bg-card/60 p-10 shadow-2xl backdrop-blur-xl md:p-20">
            {/* Inner background glow for CTA */}
            <div className="pointer-events-none absolute inset-0 -z-10">
              <div className="absolute left-1/2 top-1/2 h-[300px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[80px]" />
            </div>

            <h2 className="text-3xl font-extrabold tracking-tight text-foreground md:text-5xl lg:text-6xl">
              Transformasi dimulai <span className="text-primary">sekarang.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
              Bergabung dengan para market leader yang telah mengoptimasi performa konversinya. Aktifkan lisensi trial Anda tanpa komitmen kartu kredit.
            </p>
            <div className="mt-12 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link
                href="/register"
                id="cta-register-btn"
                className="group inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary px-10 text-base font-bold text-primary-foreground shadow-[0_8px_30px_hsl(var(--primary)/0.3)] transition-all duration-300 hover:scale-[1.03] hover:shadow-[0_12px_40px_hsl(var(--primary)/0.4)] sm:w-auto"
              >
                Mulai Trial Gratis
                <ArrowRight className="h-5 w-5 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
              <Link
                href="/login"
                id="cta-login-btn"
                className="group inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-card/40 px-10 text-base font-bold text-foreground backdrop-blur-md transition-all duration-300 hover:border-foreground/40 hover:bg-card/80 sm:w-auto"
              >
                Akses Dashboard
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ━━━ FOOTER ━━━ */}
      <footer className="relative z-10 border-t border-border/10 bg-card/10 px-4 py-12 backdrop-blur-md md:px-6 md:py-16">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-8 text-center md:flex-row md:text-left">
          <div className="flex flex-col gap-1 md:items-start">
            <span className="text-xl font-black tracking-tighter text-foreground">20byte.</span>
            <span className="text-sm font-medium text-muted-foreground mt-1">
              © {new Date().getFullYear()} Hak Cipta Dilindungi.
            </span>
          </div>
          
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm font-semibold text-muted-foreground md:justify-end md:gap-8">
            <Link href="/faq" className="transition-colors hover:text-foreground">
              FAQ
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Syarat & Ketentuan
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Kebijakan Privasi
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

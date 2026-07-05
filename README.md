# 20byte — WhatsApp CRM + Meta Ads Attribution

> **Open-source WhatsApp-first CRM with built-in Meta CAPI integration.**
> Track every ad dollar from Meta straight to closed deals on WhatsApp.

---

## The Problem

Service businesses — catering, weddings, agencies, schools, consultants — run on WhatsApp.

But they juggle **4+ tools** just to stay organized:

| Tool | Purpose |
|------|---------|
| WhatsApp | Talking to customers |
| Spreadsheet | Tracking leads |
| Manual invoicing | Creating & sending invoices |
| Meta Ads Manager | Running ads (with zero attribution) |

**Result:** Lost leads, missed follow-ups, zero visibility on which ads actually make money.

---

## The Solution

**20byte** replaces all of that with a single workspace:

```
WhatsApp Inbox  →  CRM Pipeline  →  Invoice  →  Payment  →  Meta Attribution
```

Every conversation, every deal, every rupiah — tracked from first WhatsApp message to paid invoice, with full Meta Ads attribution showing exactly which ad generated the revenue.

---

## Key Features

### WhatsApp Shared Inbox
- Baileys multi-device session (scan QR, done)
- Team assignment (Owner, Admin, CS, Advertiser)
- Media support (images, videos, audio, documents)
- Real-time updates via WebSocket

### Visual CRM Pipeline
- Kanban board with drag-and-drop
- Configurable pipeline stages
- Customer tags, notes, activity timeline
- CSV export

### Invoice & Payment System
- Create invoices directly from chat
- Down payment (DP) + final payment milestones
- Payment proof from WhatsApp screenshots
- PDF generation with your branding
- Public invoice pages (customer-facing URL)

### Meta CAPI + Pixel Attribution
- Server-side event reporting to Meta Conversions API
- Pixel embedded on public invoice pages for retargeting
- Track `Purchase`, `Lead`, `AddToCart` events from WhatsApp conversations
- Close the loop: Meta ad → WhatsApp chat → Invoice → Revenue

### CTWA Shortlink Tracking
- Create Click-To-WhatsApp ad shortlinks
- Campaign, adset, and ad-level attribution
- Analytics dashboard with funnel metrics

### WhatsApp Campaign Sequences
- Visual flow editor (drag-and-drop nodes)
- Template messages, text messages, delays
- Auto-enrollment rules (e.g., new chat → enroll in welcome sequence)
- Broadcast messaging

### AI Sales Agent (OpenRouter)
- Configure AI agent with role, goal, tone
- Knowledge base (products, FAQ, SOPs, objection handling)
- Token-based usage tracking

### Multi-Role Team
- Owner, Admin, CS, Advertiser roles
- Max 5 members per organization
- Role-based access control

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 18, TypeScript, TailwindCSS, shadcn/ui |
| Backend | Next.js API Routes, Node.js services, Prisma ORM |
| Database | MySQL 8 |
| Queue | Redis 7 |
| Storage | Cloudflare R2 |
| Realtime | Ably WebSocket |
| WhatsApp | Baileys (multi-device, no official API needed) |
| PDF | PDFKit |
| AI | OpenRouter (Claude, LLaMA, Mistral) |
| Deploy | Docker, Docker Compose, GitHub Actions |

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/lghkhun/20byte-wacrm.git
cd 20byte
npm install
```

### 2. Start infrastructure

```bash
docker compose up -d mysql redis
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values (see Environment Variables below)
```

### 4. Run migrations & seed

```bash
npx prisma migrate dev
npx prisma generate
npm run db:seed
```

### 5. Start development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Login with:

- `owner@seed.20byte.local` / `DemoPass123!`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | MySQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `NEXTAUTH_SECRET` | Yes | Random secret for session encryption |
| `NEXTAUTH_URL` | Yes | App URL (e.g., `http://localhost:3000`) |
| `APP_URL` | Yes | Public app URL |
| `ABLY_API_KEY` | Yes | Ably API key for realtime |
| `WHATSAPP_MOCK_MODE` | No | Set `true` for dev without live WhatsApp |
| `R2_ACCOUNT_ID` | No | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | No | R2 access key |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key |
| `R2_BUCKET` | No | R2 bucket name |
| `R2_PUBLIC_URL` | No | R2 public URL |
| `LOUVIN_API_KEY` | No | Louvin payment gateway key (for billing) |
| `DISABLE_BILLING` | No | Set `true` to skip subscription enforcement |

---

## Self-Hosting (No Billing)

If you're self-hosting and don't need the billing/subscription system, set:

```bash
DISABLE_BILLING=true
```

in your `.env` file. This:

- Skips all subscription access checks
- Returns an active subscription status to the frontend
- Hides the billing lock modal

All core features (inbox, CRM, invoices, campaigns, Meta attribution) work without any payment gateway keys.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Next.js App                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Web UI   │  │ API Routes│  │  Worker Process   │  │
│  └─────┬────┘  └─────┬────┘  └────────┬──────────┘  │
│        │              │                │              │
│        └──────────────┼────────────────┘              │
│                       │                               │
│              ┌────────┴────────┐                      │
│              │   Prisma ORM    │                      │
│              └────────┬────────┘                      │
└───────────────────────┼──────────────────────────────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
     ┌────┴────┐  ┌─────┴────┐  ┌────┴────┐
     │  MySQL  │  │  Redis   │  │  R2     │
     │  (data) │  │  (queue) │  │  (files)│
     └─────────┘  └──────────┘  └─────────┘
                        │
                   ┌────┴────┐
                   │  Ably   │
                   │(realtime)│
                   └─────────┘
```

---

## Deployment

### Docker Compose (Recommended)

```bash
cp .env.docker.example .env
# Configure .env for production
docker compose -f docker-compose.yml up -d --build
```

### VPS with GitHub Actions

1. Add GitHub secrets: `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_SSH_KEY`
2. Push to `main` branch
3. Auto-deploys via `.github/workflows/deploy-vps.yml`

### Reverse Proxy

Place behind Nginx, Caddy, or Traefik. Example configs in `deploy/`.

---

## Repository Structure

```
app/                Next.js routes (32 route groups)
components/         React UI components
lib/                Integrations, utilities, auth
server/             Business logic services (44 services)
worker/             Background job processors
prisma/             Database schema & migrations
public/             Static assets (logos, branding)
scripts/            Dev, deploy, and seed scripts
deploy/             Nginx & Caddy configs
tests/              Unit & integration tests
```

---

## Testing

```bash
npm run test          # Unit tests
npm run test:integration  # Integration tests
npm run test:all      # All tests
npm run quality:check # Lint + typecheck + tests + coverage audit
```

---

## Contributing

Contributions are welcome! Whether it's bug fixes, new features, or documentation improvements — feel free to open a PR.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

For questions, ideas, or collaboration, reach out: **lghkhun@gmail.com**

---

## License & Commercial Use

This is a **free and open-source project**. You are free to:

- Use it for personal projects
- Self-host for your own business
- Modify and customize it
- Contribute back to the community

**Commercial use** (SaaS, reselling, or any revenue-generating deployment) requires explicit permission from the developer. Contact: **lghkhun@gmail.com**

See [LICENSE](LICENSE) for details.

---

## Links

- **GitHub:** [github.com/lghkhun/20byte-wacrm](https://github.com/lghkhun/20byte-wacrm)
- **Issues:** [github.com/lghkhun/20byte-wacrm/issues](https://github.com/lghkhun/20byte-wacrm/issues)
- **Contact:** lghkhun@gmail.com

---

Built with ❤️ for service businesses who live on WhatsApp.

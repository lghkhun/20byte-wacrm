# Shortcut Command Local Development

## Mulai Development (urutan wajib)
1. Buka tunnel ke VPS (terminal A):
```bash
npm run tunnel:vps
```

2. Jalankan app local (terminal B):
```bash
npm run dev
```

3. Cek health local (opsional):
```bash
curl http://127.0.0.1:3001/api/health
```

## Command Harian Saat Development
```bash
npm run db:migrate:vps
npm run db:push
npm run db:studio
```

## Catatan Tunnel (wajib)
- `tunnel:vps` sekarang pakai forward eksplisit:
  - `127.0.0.1:3307 -> VPS 127.0.0.1:3307` (MySQL)
  - `127.0.0.1:6379 -> VPS 127.0.0.1:6379` (Redis)

## Selesai Development Local
1. Stop `npm run dev` (terminal B): `Ctrl + C`
2. Stop tunnel VPS (terminal A): `Ctrl + C`

## Command Docker Local (hanya jika memang perlu jalankan stack lokal)
```bash
npm run up
npm run down
npm run restart
npm run rebuild
npm run logs
npm run ps
```

## Deploy ke VPS
```bash
npm run vps:deploy
```

## WhatsApp Sequence/Broadcast (Phase 1)

### Persiapan (urutan aman)
```bash
npm run tunnel:vps
npm run db:migrate:vps
npm run worker:start
```

### Variabel bantu (terminal baru)
```bash
BASE_URL="http://127.0.0.1:3001"
ORG_ID="ganti_dengan_org_id"
FLOW_ID="ganti_dengan_flow_id"
CONVERSATION_ID="ganti_dengan_conversation_id"
COOKIE="ganti_cookie_session"
```

### 1) List flow
```bash
curl -sS "$BASE_URL/api/whatsapp/flows?orgId=$ORG_ID" \
  -H "Cookie: $COOKIE"
```

### 2) Buat flow template-only (contoh minimal)
```bash
curl -sS -X POST "$BASE_URL/api/whatsapp/flows" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"name\": \"Welcome Sequence\",
    \"status\": \"ACTIVE\",
    \"nodes\": [
      {
        \"key\": \"start_template\",
        \"type\": \"SEND_TEMPLATE\",
        \"configJson\": \"{\\\"templateName\\\":\\\"welcome_template\\\",\\\"templateLanguageCode\\\":\\\"id\\\",\\\"templateComponents\\\":[{\\\"type\\\":\\\"body\\\",\\\"parameters\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"Halo\\\"}]}]}\"
      },
      {
        \"key\": \"done\",
        \"type\": \"STOP\",
        \"configJson\": \"{}\"
      }
    ],
    \"edges\": [
      {
        \"fromNodeKey\": \"start_template\",
        \"toNodeKey\": \"done\"
      }
    ]
  }"
```

### 3) Enroll conversation manual
```bash
curl -sS -X POST "$BASE_URL/api/whatsapp/flows/$FLOW_ID/enroll" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"conversationId\": \"$CONVERSATION_ID\"
  }"
```

### 4) Pause / Resume / Stop flow
```bash
curl -sS -X POST "$BASE_URL/api/whatsapp/flows/$FLOW_ID/pause" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{\"orgId\":\"$ORG_ID\"}"

curl -sS -X POST "$BASE_URL/api/whatsapp/flows/$FLOW_ID/resume" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{\"orgId\":\"$ORG_ID\"}"

curl -sS -X POST "$BASE_URL/api/whatsapp/flows/$FLOW_ID/stop" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{\"orgId\":\"$ORG_ID\"}"
```

### 5) Analytics funnel dasar
```bash
curl -sS "$BASE_URL/api/whatsapp/analytics/campaigns?orgId=$ORG_ID" \
  -H "Cookie: $COOKIE"
```

### 6) Rules (per flow)
```bash
curl -sS "$BASE_URL/api/whatsapp/flows/$FLOW_ID/rules?orgId=$ORG_ID" \
  -H "Cookie: $COOKIE"

curl -sS -X POST "$BASE_URL/api/whatsapp/flows/$FLOW_ID/rules" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"triggerType\": \"CHAT_INCOMING\",
    \"conditionExpr\": \"customer_has_tag:hot\",
    \"actionType\": \"ENROLL_SEQUENCE\"
  }"

RULE_ID="ganti_dengan_rule_id"
curl -sS -X PATCH "$BASE_URL/api/whatsapp/flows/$FLOW_ID/rules" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"ruleId\": \"$RULE_ID\",
    \"isActive\": false
  }"

curl -sS -X DELETE "$BASE_URL/api/whatsapp/flows/$FLOW_ID/rules" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"ruleId\": \"$RULE_ID\"
  }"
```

### 7) Broadcast draft / launch / cancel
```bash
curl -sS "$BASE_URL/api/whatsapp/broadcasts?orgId=$ORG_ID" \
  -H "Cookie: $COOKIE"

curl -sS -X POST "$BASE_URL/api/whatsapp/broadcasts" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"name\": \"Promo\",
    \"messageMode\": \"TEMPLATE\",
    \"templateName\": \"promo_template\",
    \"templateLanguageCode\": \"id\",
    \"templateComponentsJson\": \"[{\\\"type\\\":\\\"body\\\",\\\"parameters\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"Halo\\\"}]}]\"
  }"

BROADCAST_ID="ganti_dengan_broadcast_id"
curl -sS -X POST "$BASE_URL/api/whatsapp/broadcasts/$BROADCAST_ID/launch" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"orgId\": \"$ORG_ID\",
    \"segment\": \"all_leads\"
  }"

curl -sS -X POST "$BASE_URL/api/whatsapp/broadcasts/$BROADCAST_ID/cancel" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{\"orgId\":\"$ORG_ID\"}"
```

### Catatan operasional
- Phase 1 hanya jalur `template-only` untuk execution sequence.
- Worker sekarang auto-load env lokal via `npm run worker:start` dan tidak lagi bergantung env shell global.
- Jika `FLOW_NOT_ACTIVE`, ubah status flow ke `ACTIVE` dulu (atau `resume`).
- Jika baru pull perubahan schema campaign, jalankan `npm run db:migrate` lalu restart worker.

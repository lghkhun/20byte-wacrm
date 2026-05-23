#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { writeSmokeReport } from "./smoke-report.mjs";

const baseUrl = process.env.SMOKE_BASE_URL?.trim() || "http://localhost:3001";
const email = process.env.SMOKE_EMAIL?.trim() || "";
const password = process.env.SMOKE_PASSWORD?.trim() || "";

if (!email || !password) {
  console.error("Missing credentials. Set SMOKE_EMAIL and SMOKE_PASSWORD.");
  process.exit(1);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const failures = [];

  try {
    const loginRes = await context.request.post(`${baseUrl}/api/auth/login`, {
      data: { email, password }
    });
    if (!loginRes.ok()) {
      const body = await loginRes.text();
      throw new Error(`Login failed (${loginRes.status()}): ${body}`);
    }

    await page.goto(`${baseUrl}/report?tab=campaign`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const campaignTab = page.getByRole("tab", { name: /^Campaign$/i });
    if ((await campaignTab.count()) === 0) {
      failures.push("Report: tab Campaign tidak ditemukan.");
    }

    const executionOutcome = page.getByText("Execution Outcome", { exact: true });
    if ((await executionOutcome.count()) === 0) {
      failures.push("Report Campaign: section Execution Outcome tidak ditemukan.");
    }

    const topSequences = page.getByText("Top Sequences", { exact: true });
    if ((await topSequences.count()) === 0) {
      failures.push("Report Campaign: tabel Top Sequences tidak ditemukan.");
    }

    const rulesRuntimeHealth = page.getByText("Rules Runtime Health", { exact: true });
    if ((await rulesRuntimeHealth.count()) === 0) {
      failures.push("Report Campaign: panel Rules Runtime Health tidak ditemukan.");
    }
  } finally {
    await browser.close();
  }

  return { failures };
}

const startedAtMs = Date.now();
try {
  const result = await main();
  if (result.failures.length > 0) {
    console.error("Report campaign smoke checks failed:");
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    await writeSmokeReport({
      suite: "smoke-ui-report-campaign",
      startedAtMs,
      status: "failed",
      baseUrl,
      failures: result.failures,
      meta: {}
    });
    process.exit(1);
  }

  console.log("Report campaign smoke checks passed.");
  await writeSmokeReport({
    suite: "smoke-ui-report-campaign",
    startedAtMs,
    status: "passed",
    baseUrl,
    failures: [],
    meta: {}
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeSmokeReport({
    suite: "smoke-ui-report-campaign",
    startedAtMs,
    status: "failed",
    baseUrl,
    failures: [message],
    meta: {}
  });
  console.error(message);
  process.exit(1);
}

import test from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { GET as reportGet } from "@/app/api/report/route";

test("report route requires authenticated session", async () => {
  const request = new NextRequest(new Request("http://localhost/api/report?tab=campaign&from=2026-05-01&to=2026-05-23", {
    method: "GET"
  }));

  const response = await reportGet(request);
  assert.equal(response.status, 401);

  const payload = (await response.json()) as { error?: { code?: string } };
  assert.equal(payload.error?.code, "UNAUTHORIZED");
});

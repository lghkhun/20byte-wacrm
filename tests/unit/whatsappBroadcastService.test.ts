import assert from "node:assert/strict";
import test from "node:test";

import { __broadcastTestables } from "@/server/services/whatsappCampaignService";

test("parse recipient mode defaults to SEGMENT", () => {
  assert.equal(__broadcastTestables.parseBroadcastRecipientMode(""), "SEGMENT");
  assert.equal(__broadcastTestables.parseBroadcastRecipientMode("unknown"), "SEGMENT");
  assert.equal(__broadcastTestables.parseBroadcastRecipientMode("SELECTED_CUSTOMERS"), "SELECTED_CUSTOMERS");
});

test("parse segment defaults to all_leads", () => {
  assert.equal(__broadcastTestables.parseBroadcastSegment(""), "all_leads");
  assert.equal(__broadcastTestables.parseBroadcastSegment("invalid"), "all_leads");
  assert.equal(__broadcastTestables.parseBroadcastSegment("hot_leads"), "hot_leads");
});

test("broadcast config validation rejects invalid rate and empty selected recipients", () => {
  assert.throws(
    () =>
      __broadcastTestables.assertBroadcastConfigValid({
        messageMode: "TEXT",
        text: "Hello",
        recipientMode: "SELECTED_CUSTOMERS",
        batchSize: 0,
        batchIntervalSeconds: 30,
        selectedCustomerIdsJson: "[]"
      }),
    /batchSize must be at least 1/
  );

  assert.throws(
    () =>
      __broadcastTestables.assertBroadcastConfigValid({
        messageMode: "TEXT",
        text: "Hello",
        recipientMode: "SELECTED_CUSTOMERS",
        batchSize: 1,
        batchIntervalSeconds: 60,
        selectedCustomerIdsJson: "[]"
      }),
    /selectedCustomerIds is required/
  );
});

test("broadcast config validation enforces message mode requirements", () => {
  assert.throws(
    () =>
      __broadcastTestables.assertBroadcastConfigValid({
        messageMode: "TEXT",
        text: "",
        recipientMode: "SEGMENT",
        batchSize: 1,
        batchIntervalSeconds: 60
      }),
    /text is required/
  );

  assert.throws(
    () =>
      __broadcastTestables.assertBroadcastConfigValid({
        messageMode: "TEMPLATE",
        templateName: "promo_1",
        templateComponentsJson: "",
        recipientMode: "SEGMENT",
        batchSize: 1,
        batchIntervalSeconds: 60
      }),
    /templateComponentsJson is required/
  );

  assert.doesNotThrow(() =>
    __broadcastTestables.assertBroadcastConfigValid({
      messageMode: "TEMPLATE",
      templateName: "promo_1",
      templateComponentsJson: '[{"type":"body","parameters":[{"type":"text","text":"Halo"}]}]',
      recipientMode: "SEGMENT",
      batchSize: 1,
      batchIntervalSeconds: 60
    })
  );
});

test("dueAt scheduling follows batch size and interval", () => {
  const base = new Date("2026-05-23T10:00:00.000Z");
  const due0 = __broadcastTestables.computeBroadcastRecipientDueAt({
    baseDueAt: base,
    recipientIndex: 0,
    batchSize: 2,
    batchIntervalSeconds: 600
  });
  const due1 = __broadcastTestables.computeBroadcastRecipientDueAt({
    baseDueAt: base,
    recipientIndex: 1,
    batchSize: 2,
    batchIntervalSeconds: 600
  });
  const due2 = __broadcastTestables.computeBroadcastRecipientDueAt({
    baseDueAt: base,
    recipientIndex: 2,
    batchSize: 2,
    batchIntervalSeconds: 600
  });

  assert.equal(due0.toISOString(), "2026-05-23T10:00:00.000Z");
  assert.equal(due1.toISOString(), "2026-05-23T10:00:00.000Z");
  assert.equal(due2.toISOString(), "2026-05-23T10:10:00.000Z");
});

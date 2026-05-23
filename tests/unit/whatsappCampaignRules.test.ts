import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRuleActions,
  parseRuleConditionExpr,
  shouldRunRule,
  triggerMatchesEvent,
  validateRuleActionExpr,
  validateRuleConditionExpr,
  type CampaignRuleEvent
} from "@/server/services/whatsappCampaignRules";

test("parseRuleConditionExpr parses triggers and fallback operator", () => {
  const parsed = parseRuleConditionExpr(
    JSON.stringify({
      operator: "OR",
      triggers: [
        { eventType: "SUBSCRIBED_SEQUENCE", sequenceId: "flow_1" },
        { eventType: "READ_MESSAGE", messageScope: "SEQUENCE", sequenceId: "flow_2" }
      ]
    })
  );

  assert.equal(parsed.operator, "OR");
  assert.equal(parsed.triggers.length, 2);
  assert.equal(parsed.triggers[0]?.eventType, "SUBSCRIBED_SEQUENCE");
});

test("triggerMatchesEvent matches sequence read event with scope", () => {
  const event: CampaignRuleEvent = {
    eventType: "READ_MESSAGE",
    orgId: "org_1",
    flowId: "flow_1",
    sequenceId: "flow_1",
    messageScope: "SEQUENCE"
  };

  assert.equal(
    triggerMatchesEvent(
      {
        eventType: "READ_MESSAGE",
        messageScope: "SEQUENCE",
        sequenceId: "flow_1"
      },
      event
    ),
    true
  );

  assert.equal(
    triggerMatchesEvent(
      {
        eventType: "READ_MESSAGE",
        messageScope: "SEQUENCE",
        sequenceId: "flow_9"
      },
      event
    ),
    false
  );
});

test("shouldRunRule returns true when any OR trigger matches", () => {
  const rule = JSON.stringify({
    operator: "OR",
    triggers: [
      { eventType: "UNSUBSCRIBED_SEQUENCE", sequenceId: "flow_9" },
      { eventType: "SUBSCRIBED_SEQUENCE", sequenceId: "flow_1" }
    ]
  });

  const event: CampaignRuleEvent = {
    eventType: "SUBSCRIBED_SEQUENCE",
    orgId: "org_1",
    flowId: "flow_1",
    sequenceId: "flow_1"
  };

  assert.equal(shouldRunRule(rule, event), true);
});

test("parseRuleActions reads sequence actions", () => {
  const actions = parseRuleActions(
    JSON.stringify({
      actions: [
        { actionType: "SUBSCRIBE_SEQUENCE", sequenceId: "flow_1" },
        { actionType: "MOVE_SEQUENCE", fromSequenceId: "flow_1", toSequenceId: "flow_2" }
      ]
    })
  );

  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.actionType, "SUBSCRIBE_SEQUENCE");
  assert.equal(actions[1]?.toSequenceId, "flow_2");
});

test("validateRuleConditionExpr rejects invalid trigger payload", () => {
  const invalid = validateRuleConditionExpr(
    JSON.stringify({
      triggers: [{ eventType: "READ_MESSAGE", messageScope: "SEQUENCE" }]
    })
  );
  assert.equal(invalid.valid, false);

  const valid = validateRuleConditionExpr(
    JSON.stringify({
      operator: "OR",
      triggers: [{ eventType: "SUBSCRIBED_SEQUENCE", sequenceId: "flow_1" }]
    })
  );
  assert.equal(valid.valid, true);
});

test("validateRuleActionExpr rejects missing required action fields", () => {
  const invalid = validateRuleActionExpr(
    JSON.stringify({
      actions: [{ actionType: "APPLY_TAG" }]
    })
  );
  assert.equal(invalid.valid, false);

  const valid = validateRuleActionExpr(
    JSON.stringify({
      actions: [{ actionType: "MOVE_SEQUENCE", fromSequenceId: "flow_1", toSequenceId: "flow_2" }]
    })
  );
  assert.equal(valid.valid, true);
});

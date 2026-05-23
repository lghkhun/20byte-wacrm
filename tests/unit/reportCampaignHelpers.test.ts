import test from "node:test";
import assert from "node:assert/strict";

import { parseRuleActionTypeFromReasonCode } from "@/server/services/report/reportCampaignHelpers";

test("parseRuleActionTypeFromReasonCode extracts action type from dedupe reasonCode", () => {
  const result = parseRuleActionTypeFromReasonCode("rule_123:UPDATE_FOLLOWUP:SUBSCRIBED_SEQUENCE:flow");
  assert.equal(result, "UPDATE_FOLLOWUP");
});

test("parseRuleActionTypeFromReasonCode falls back to UNKNOWN_ACTION on malformed input", () => {
  assert.equal(parseRuleActionTypeFromReasonCode(""), "UNKNOWN_ACTION");
  assert.equal(parseRuleActionTypeFromReasonCode("RULE_ACTION_EXECUTED"), "UNKNOWN_ACTION");
  assert.equal(parseRuleActionTypeFromReasonCode(null), "UNKNOWN_ACTION");
});

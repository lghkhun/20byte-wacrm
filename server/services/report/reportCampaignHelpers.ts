export function parseRuleActionTypeFromReasonCode(reasonCode: string | null | undefined): string {
  const normalized = (reasonCode ?? "").trim();
  if (!normalized) {
    return "UNKNOWN_ACTION";
  }
  const segments = normalized.split(":");
  if (segments.length < 2) {
    return "UNKNOWN_ACTION";
  }
  const actionType = (segments[1] ?? "").trim();
  return actionType.length > 0 ? actionType : "UNKNOWN_ACTION";
}


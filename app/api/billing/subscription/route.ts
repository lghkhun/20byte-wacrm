import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { getActiveOrgIdFromRequest } from "@/lib/auth/activeOrg";
import { requireApiSession } from "@/lib/auth/middleware";
import { isBillingDisabled } from "@/lib/env";
import { isPrismaDatabaseUnavailableError } from "@/lib/db/prismaError";
import { getPrimaryOrganizationForUser } from "@/server/services/organizationService";
import { getOrgSubscriptionView } from "@/server/services/billingService";
import { triggerOrgBillingReminderBroadcast } from "@/server/services/billingReminderService";
import { ServiceError } from "@/server/services/serviceError";

type OrgSubscriptionView = Awaited<ReturnType<typeof getOrgSubscriptionView>>;

const CACHE_TTL_MS = 15_000;
const subscriptionCache = new Map<string, { expiresAt: number; data: OrgSubscriptionView }>();
const subscriptionInflight = new Map<string, Promise<OrgSubscriptionView>>();

async function getCachedOrgSubscriptionView(
  userId: string,
  orgId: string
): Promise<{ data: OrgSubscriptionView; fromCache: boolean }> {
  const cacheKey = `${userId}:${orgId}`;
  const now = Date.now();
  const cached = subscriptionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { data: cached.data, fromCache: true };
  }

  const inflight = subscriptionInflight.get(cacheKey);
  if (inflight) {
    return { data: await inflight, fromCache: true };
  }

  const request = (async () => {
    const data = await getOrgSubscriptionView(userId, orgId);
    subscriptionCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      data
    });
    return data;
  })();

  subscriptionInflight.set(cacheKey, request);
  try {
    return { data: await request, fromCache: false };
  } finally {
    subscriptionInflight.delete(cacheKey);
  }
}

export async function GET(request: NextRequest) {
  const auth = requireApiSession(request);
  if (auth.response) {
    return auth.response;
  }

  if (isBillingDisabled()) {
    return successResponse({
      subscription: { status: "ACTIVE", currentPeriodEndAt: "2099-01-01T00:00:00.000Z" },
      state: { isLocked: false, graceEndAt: null },
      pricing: { plans: [], defaultPlanMonths: 1, renewalDays: 28, currency: "IDR" },
      reminder: null
    }, 200);
  }

  const orgIdInput = request.nextUrl.searchParams.get("orgId")?.trim() ?? "";
  const activeOrgId = getActiveOrgIdFromRequest(request);

  try {
    const primary = await getPrimaryOrganizationForUser(auth.session.userId);
    const orgId = orgIdInput || activeOrgId || primary?.id || "";
    if (!orgId) {
      return errorResponse(404, "ORG_NOT_FOUND", "No business is available for this account.");
    }

    const { data: result, fromCache } = await getCachedOrgSubscriptionView(auth.session.userId, orgId);
    if (!fromCache) {
      void triggerOrgBillingReminderBroadcast({
        orgId,
        shouldBroadcastWhatsapp: Boolean(result.reminder?.shouldBroadcastWhatsapp),
        message: result.reminder?.message ?? ""
      });
    }
    return successResponse(result, 200);
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (isPrismaDatabaseUnavailableError(error)) {
      return errorResponse(503, "DB_UNAVAILABLE", "Database belum tersedia. Pastikan MySQL aktif di 127.0.0.1:3307.");
    }

    return errorResponse(500, "BILLING_SUBSCRIPTION_FAILED", "Failed to load subscription.");
  }
}

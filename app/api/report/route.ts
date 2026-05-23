import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { getActiveOrgIdFromRequest } from "@/lib/auth/activeOrg";
import { requireApiSession } from "@/lib/auth/middleware";
import { prisma } from "@/lib/db/prisma";
import { canAccessCustomerDirectory } from "@/lib/permissions/orgPermissions";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";
import { parseRuleActionTypeFromReasonCode } from "@/server/services/report/reportCampaignHelpers";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DateBucket = {
  date: string;
  label: string;
};

function parseDateParam(value: string | null, fallback: Date): Date {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function startOfDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(23, 59, 59, 999);
  return next;
}

function formatDateParam(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatCompactDate(value: Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short"
  }).format(value);
}

function buildDateBuckets(from: Date, to: Date): DateBucket[] {
  const days = Math.max(1, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY) + 1);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(from);
    date.setDate(from.getDate() + index);
    return {
      date: formatDateParam(date),
      label: formatCompactDate(date)
    };
  });
}

function normalizeGroupLabel(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

export async function GET(request: NextRequest) {
  const auth = requireApiSession(request);
  if (!auth.session) {
    return auth.response;
  }

  const candidateOrgId = getActiveOrgIdFromRequest(request);
  const orgId = await resolvePrimaryOrganizationIdForUser(auth.session.userId, candidateOrgId);

  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: auth.session.userId
      }
    },
    select: {
      role: true
    }
  });

  if (!membership || !canAccessCustomerDirectory(membership.role)) {
    return errorResponse(403, "FORBIDDEN_REPORT_ACCESS", "Your role cannot access report.");
  }

  const today = startOfDay(new Date());
  const defaultFrom = new Date(today.getTime() - 29 * MS_PER_DAY);
  let rangeFrom = startOfDay(parseDateParam(request.nextUrl.searchParams.get("from"), defaultFrom));
  const rangeTo = endOfDay(parseDateParam(request.nextUrl.searchParams.get("to"), today));

  if (rangeFrom.getTime() > rangeTo.getTime()) {
    rangeFrom = startOfDay(rangeTo);
  }

  const dateBuckets = buildDateBuckets(rangeFrom, rangeTo);

  const customerRangeWhere: Prisma.CustomerWhereInput = {
    orgId,
    createdAt: {
      gte: rangeFrom,
      lte: rangeTo
    }
  };

  const [
    totalCustomers,
    leadStatusRows,
    hotnessRows,
    sourceRows,
    campaignRows,
    businessCategoryRows,
    followUpRows,
    assignedRows,
    customerTrendRows,
    conversationStageRows,
    stageMeta,
    activityRows,
    messageDurationAggregate,
    messageConnectedCount,
    memberRows,
    customerDetails,
    projectValueAgg
  ] = await Promise.all([
    prisma.customer.count({ where: customerRangeWhere }),
    prisma.customer.groupBy({
      by: ["leadStatus"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { leadStatus: "desc" } }
    }),
    prisma.customer.groupBy({
      by: ["hotness"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { hotness: "desc" } }
    }),
    prisma.customer.groupBy({
      by: ["source"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { source: "desc" } }
    }),
    prisma.customer.groupBy({
      by: ["campaign"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { campaign: "desc" } }
    }),
    prisma.customer.groupBy({
      by: ["businessCategory"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { businessCategory: "desc" } }
    }),
    prisma.customer.groupBy({
      by: ["followUpStatus"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { followUpStatus: "desc" } }
    }),
    prisma.customer.groupBy({
      by: ["assignedToMemberId"],
      where: customerRangeWhere,
      _count: { _all: true },
      orderBy: { _count: { assignedToMemberId: "desc" } }
    }),
    prisma.$queryRaw<Array<{ day: Date; total: bigint | number }>>(Prisma.sql`
      SELECT DATE(createdAt) AS day, COUNT(*) AS total
      FROM Customer
      WHERE orgId = ${orgId}
        AND createdAt >= ${rangeFrom}
        AND createdAt <= ${rangeTo}
      GROUP BY DATE(createdAt)
      ORDER BY day ASC
    `),
    prisma.conversation.groupBy({
      by: ["crmStageId"],
      where: {
        orgId,
        customer: customerRangeWhere
      },
      _count: { _all: true }
    }),
    prisma.crmPipelineStage.findMany({
      where: { orgId },
      select: { id: true, name: true, position: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }]
    }),
    prisma.$queryRaw<Array<{ day: Date; activeCustomers: bigint | number }>>(Prisma.sql`
      SELECT DATE(m.createdAt) AS day, COUNT(DISTINCT c.customerId) AS activeCustomers
      FROM Message m
      INNER JOIN Conversation c ON c.id = m.conversationId
      WHERE m.orgId = ${orgId}
        AND m.createdAt >= ${rangeFrom}
        AND m.createdAt <= ${rangeTo}
      GROUP BY DATE(m.createdAt)
      ORDER BY day ASC
    `),
    prisma.message.aggregate({
      where: {
        orgId,
        durationSec: { not: null },
        createdAt: { gte: rangeFrom, lte: rangeTo }
      },
      _avg: { durationSec: true }
    }),
    prisma.message.count({
      where: {
        orgId,
        direction: "OUTBOUND",
        sendStatus: "SENT",
        createdAt: { gte: rangeFrom, lte: rangeTo }
      }
    }),
    prisma.orgMember.findMany({
      where: { orgId },
      select: {
        id: true,
        user: {
          select: {
            name: true,
            email: true
          }
        }
      }
    }),
    prisma.customer.findMany({
      where: customerRangeWhere,
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        displayName: true,
        phoneE164: true,
        leadStatus: true,
        followUpStatus: true,
        followUpAt: true,
        businessCategory: true,
        detail: true,
        source: true,
        projectValueCents: true,
        remarks: true,
        assignedToMemberId: true,
        conversations: {
          select: {
            crmStageId: true,
            crmStage: {
              select: {
                name: true
              }
            }
          },
          orderBy: {
            updatedAt: "desc"
          },
          take: 1
        }
      }
    }),
    prisma.customer.aggregate({
      where: customerRangeWhere,
      _sum: {
        projectValueCents: true
      }
    })
  ]);

  const stageCountMap = new Map(conversationStageRows.map((row) => [row.crmStageId ?? "__unassigned__", row._count._all]));
  const memberNameMap = new Map(
    memberRows.map((member) => [member.id, normalizeGroupLabel(member.user.name ?? member.user.email, "Unassigned")])
  );

  const [
    sequenceEnrolled,
    sequenceActiveEnrollments,
    sequenceCompletedEnrollments,
    sequenceStoppedEnrollments,
    sequenceFailedEnrollments,
    sequenceQueuedExecutions,
    sequenceSentExecutions,
    sequenceFailedExecutions,
    sequenceSkippedExecutions,
    sequenceByFlowRaw,
    broadcastsLaunched,
    broadcastsRunning,
    broadcastsCompleted,
    broadcastsCanceled,
    broadcastPendingRecipients,
    broadcastQueuedRecipients,
    broadcastSentRecipients,
    broadcastFailedRecipients,
    broadcastSkippedRecipients,
    broadcastStoppedRecipients,
    broadcastByNameRaw,
    ruleEvaluated,
    ruleSkipped,
    ruleActionExecuted,
    ruleActionFailed,
    ruleDidntReadScheduled,
    ruleDidntReadTriggered,
    ruleDidntReadCanceled,
    rulesByActionRows
  ] = await Promise.all([
    prisma.whatsAppEnrollment.count({
      where: { orgId, createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppEnrollment.count({
      where: { orgId, status: "ACTIVE", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppEnrollment.count({
      where: { orgId, status: "COMPLETED", finishedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppEnrollment.count({
      where: { orgId, status: "STOPPED", finishedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppEnrollment.count({
      where: { orgId, status: "FAILED", finishedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppExecution.count({
      where: { orgId, status: "QUEUED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppExecution.count({
      where: { orgId, status: "SENT", executedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppExecution.count({
      where: { orgId, status: "FAILED", executedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppExecution.count({
      where: { orgId, status: "SKIPPED", executedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppFlow.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        enrollments: {
          where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
          select: { status: true, finishedAt: true, createdAt: true }
        }
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.whatsAppBroadcast.count({
      where: { orgId, launchedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcast.count({
      where: { orgId, status: "RUNNING", launchedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcast.count({
      where: { orgId, status: "COMPLETED", completedAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcast.count({
      where: { orgId, status: "CANCELED", canceledAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcastRecipient.count({
      where: { orgId, status: "PENDING", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcastRecipient.count({
      where: { orgId, status: "QUEUED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcastRecipient.count({
      where: { orgId, status: "SENT", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcastRecipient.count({
      where: { orgId, status: "FAILED", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcastRecipient.count({
      where: { orgId, status: "SKIPPED", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcastRecipient.count({
      where: { orgId, status: "STOPPED", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppBroadcast.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        recipients: {
          where: {
            OR: [
              { status: "SENT", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } },
              { status: "FAILED", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } },
              { status: "SKIPPED", lastAttemptAt: { gte: rangeFrom, lte: rangeTo } }
            ]
          },
          select: { status: true }
        }
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_EVALUATED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_SKIPPED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_ACTION_EXECUTED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_ACTION_FAILED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_DIDNT_READ_SCHEDULED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_DIDNT_READ_TRIGGERED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.count({
      where: { orgId, eventType: "RULE_DIDNT_READ_CANCELED", createdAt: { gte: rangeFrom, lte: rangeTo } }
    }),
    prisma.whatsAppComplianceEvent.findMany({
      where: {
        orgId,
        eventType: { in: ["RULE_ACTION_EXECUTED", "RULE_ACTION_FAILED"] },
        createdAt: { gte: rangeFrom, lte: rangeTo }
      },
      select: {
        eventType: true,
        reasonCode: true
      }
    })
  ]);

  const dailyCreatedMap = new Map(
    customerTrendRows.map((item) => [new Date(item.day).toISOString().slice(0, 10), Number(item.total)])
  );
  const dailyActiveMap = new Map(
    activityRows.map((item) => [new Date(item.day).toISOString().slice(0, 10), Number(item.activeCustomers)])
  );

  const trend = dateBuckets.map((bucket) => ({
    date: bucket.date,
    label: bucket.label,
    customers: dailyCreatedMap.get(bucket.date) ?? 0,
    activeCustomers: dailyActiveMap.get(bucket.date) ?? 0
  }));

  const stageDistribution = [
    ...stageMeta.map((stage) => ({
      label: stage.name,
      value: stageCountMap.get(stage.id) ?? 0
    })),
    {
      label: "Unassigned",
      value: stageCountMap.get("__unassigned__") ?? 0
    }
  ].filter((item) => item.value > 0);

  const assignedDistribution = assignedRows.map((row) => ({
    label: row.assignedToMemberId ? memberNameMap.get(row.assignedToMemberId) ?? "Unassigned" : "Unassigned",
    value: row._count._all
  }));

  const sequenceByFlow = sequenceByFlowRaw
    .map((flow) => {
      const enrolled = flow.enrollments.length;
      const completed = flow.enrollments.filter((item) => item.status === "COMPLETED" && item.finishedAt).length;
      const failed = flow.enrollments.filter((item) => item.status === "FAILED" && item.finishedAt).length;
      return {
        flowId: flow.id,
        flowName: flow.name,
        enrolled,
        completed,
        failed
      };
    })
    .filter((item) => item.enrolled > 0 || item.completed > 0 || item.failed > 0)
    .sort((a, b) => b.enrolled - a.enrolled);

  const broadcastByName = broadcastByNameRaw
    .map((item) => {
      const sent = item.recipients.filter((recipient) => recipient.status === "SENT").length;
      const failed = item.recipients.filter((recipient) => recipient.status === "FAILED").length;
      const skipped = item.recipients.filter((recipient) => recipient.status === "SKIPPED").length;
      return {
        broadcastId: item.id,
        broadcastName: item.name,
        sent,
        failed,
        skipped
      };
    })
    .filter((item) => item.sent > 0 || item.failed > 0 || item.skipped > 0)
    .sort((a, b) => b.sent - a.sent);

  const rulesByActionMap = new Map<string, { actionType: string; executed: number; failed: number }>();
  for (const row of rulesByActionRows) {
    const actionType = parseRuleActionTypeFromReasonCode(row.reasonCode);
    const existing = rulesByActionMap.get(actionType) ?? { actionType, executed: 0, failed: 0 };
    if (row.eventType === "RULE_ACTION_EXECUTED") {
      existing.executed += 1;
    } else {
      existing.failed += 1;
    }
    rulesByActionMap.set(actionType, existing);
  }
  const rulesByActionType = Array.from(rulesByActionMap.values()).sort((a, b) => b.executed - a.executed);

  return successResponse({
    range: {
      from: formatDateParam(rangeFrom),
      to: formatDateParam(rangeTo)
    },
    leads: {
      total: totalCustomers,
      leadStatus: leadStatusRows.map((row) => ({
        label: normalizeGroupLabel(row.leadStatus, "Unknown"),
        value: row._count._all
      })),
      hotness: hotnessRows.map((row) => ({
        label: normalizeGroupLabel(row.hotness, "Unknown"),
        value: row._count._all
      })),
      stage: stageDistribution,
      source: sourceRows.map((row) => ({
        label: normalizeGroupLabel(row.source, "Empty"),
        value: row._count._all
      })),
      campaign: campaignRows.map((row) => ({
        label: normalizeGroupLabel(row.campaign, "Empty"),
        value: row._count._all
      })),
      businessCategory: businessCategoryRows.map((row) => ({
        label: normalizeGroupLabel(row.businessCategory, "Uncategorized"),
        value: row._count._all
      })),
      followUp: followUpRows.map((row) => ({
        label: normalizeGroupLabel(row.followUpStatus, "No Follow-up"),
        value: row._count._all
      })),
      assigned: assignedDistribution,
      trend
    },
    customers: {
      total: totalCustomers,
      stage: stageDistribution,
      status: leadStatusRows.map((row) => ({
        label: normalizeGroupLabel(row.leadStatus, "Unknown"),
        value: row._count._all
      })),
      followUp: followUpRows.map((row) => ({
        label: normalizeGroupLabel(row.followUpStatus, "No Follow-up"),
        value: row._count._all
      })),
      source: sourceRows.map((row) => ({
        label: normalizeGroupLabel(row.source, "Empty"),
        value: row._count._all
      })),
      campaign: campaignRows.map((row) => ({
        label: normalizeGroupLabel(row.campaign, "Empty"),
        value: row._count._all
      })),
      businessCategory: businessCategoryRows.map((row) => ({
        label: normalizeGroupLabel(row.businessCategory, "Uncategorized"),
        value: row._count._all
      })),
      assigned: assignedDistribution,
      retention: trend,
      avgMessageDurationSec: messageDurationAggregate._avg.durationSec ?? 0,
      connectedOutboundMessages: messageConnectedCount,
      totalProjectValueCents: projectValueAgg._sum.projectValueCents ?? 0,
      details: customerDetails.map((customer) => ({
        id: customer.id,
        name: customer.displayName,
        whatsapp: customer.phoneE164,
        statusLead: customer.leadStatus,
        followUp: customer.followUpStatus,
        followUpAt: customer.followUpAt?.toISOString() ?? null,
        businessCategory: customer.businessCategory,
        detail: customer.detail,
        source: customer.source,
        pipelineStage: customer.conversations[0]?.crmStage?.name ?? "Unassigned",
        projectValueCents: customer.projectValueCents ?? 0,
        assignee: customer.assignedToMemberId ? memberNameMap.get(customer.assignedToMemberId) ?? "Unassigned" : "Unassigned",
        notes: customer.remarks
      }))
    },
    campaign: {
      sequence: {
        enrolled: sequenceEnrolled,
        activeEnrollments: sequenceActiveEnrollments,
        completed: sequenceCompletedEnrollments,
        stopped: sequenceStoppedEnrollments,
        failed: sequenceFailedEnrollments,
        queuedExecutions: sequenceQueuedExecutions,
        sentExecutions: sequenceSentExecutions,
        failedExecutions: sequenceFailedExecutions,
        skippedExecutions: sequenceSkippedExecutions,
        executionOutcome: [
          { label: "Queued", value: sequenceQueuedExecutions },
          { label: "Sent", value: sequenceSentExecutions },
          { label: "Failed", value: sequenceFailedExecutions },
          { label: "Skipped", value: sequenceSkippedExecutions }
        ],
        sequenceByFlow
      },
      broadcast: {
        launched: broadcastsLaunched,
        running: broadcastsRunning,
        completed: broadcastsCompleted,
        canceled: broadcastsCanceled,
        pendingRecipients: broadcastPendingRecipients,
        queuedRecipients: broadcastQueuedRecipients,
        sentRecipients: broadcastSentRecipients,
        failedRecipients: broadcastFailedRecipients,
        skippedRecipients: broadcastSkippedRecipients,
        stoppedRecipients: broadcastStoppedRecipients,
        recipientOutcome: [
          { label: "Pending", value: broadcastPendingRecipients },
          { label: "Queued", value: broadcastQueuedRecipients },
          { label: "Sent", value: broadcastSentRecipients },
          { label: "Failed", value: broadcastFailedRecipients },
          { label: "Skipped", value: broadcastSkippedRecipients },
          { label: "Stopped", value: broadcastStoppedRecipients }
        ],
        broadcastByName
      },
      rules: {
        evaluated: ruleEvaluated,
        skipped: ruleSkipped,
        actionExecuted: ruleActionExecuted,
        actionFailed: ruleActionFailed,
        didntReadScheduled: ruleDidntReadScheduled,
        didntReadTriggered: ruleDidntReadTriggered,
        didntReadCanceled: ruleDidntReadCanceled,
        rulesByActionType
      }
    }
  });
}

import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";

import { errorResponse, successResponse } from "@/lib/api/http";
import { getActiveOrgIdFromRequest } from "@/lib/auth/activeOrg";
import { requireApiSession } from "@/lib/auth/middleware";
import { prisma } from "@/lib/db/prisma";
import { canAccessCustomerDirectory } from "@/lib/permissions/orgPermissions";
import { resolvePrimaryOrganizationIdForUser } from "@/server/services/organizationService";

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

  const stageNameMap = new Map(stageMeta.map((stage) => [stage.id, stage.name]));
  const stageCountMap = new Map(conversationStageRows.map((row) => [row.crmStageId ?? "__unassigned__", row._count._all]));
  const memberNameMap = new Map(
    memberRows.map((member) => [member.id, normalizeGroupLabel(member.user.name ?? member.user.email, "Unassigned")])
  );

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
    }
  });
}

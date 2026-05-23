import { prisma } from "@/lib/db/prisma";
import { canAccessCustomerDirectory } from "@/lib/permissions/orgPermissions";
import { publishCustomerUpdatedEvent } from "@/lib/ably/publisher";
import { processAiAutomationTrigger } from "@/server/services/aiAutomationService";
import { assertOrgBillingAccess } from "@/server/services/billingService";
import { ServiceError } from "@/server/services/serviceError";

type CustomerTagItem = {
  id: string;
  name: string;
  color: string;
  isAssigned: boolean;
};

type CustomerNoteItem = {
  id: string;
  content: string;
  authorUserId: string;
  createdAt: Date;
};

type CustomerNotesResult = {
  notes: CustomerNoteItem[];
  page: number;
  limit: number;
  total: number;
};

function normalize(value: string): string {
  return value.trim();
}

function normalizePage(value: number | undefined): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return 1;
  }

  return Math.floor(value);
}

function normalizeLimit(value: number | undefined): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return 20;
  }

  return Math.min(100, Math.floor(value));
}

async function requireCustomerAccess(actorUserId: string, orgId: string, customerId: string): Promise<void> {
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: actorUserId
      }
    },
    select: {
      role: true
    }
  });

  if (!membership) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }

  if (!canAccessCustomerDirectory(membership.role)) {
    throw new ServiceError(403, "FORBIDDEN_CUSTOMER_ACCESS", "Your role cannot access customer database.");
  }

  await assertOrgBillingAccess(orgId, "write");

  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      orgId
    },
    select: {
      id: true
    }
  });

  if (!customer) {
    throw new ServiceError(404, "CUSTOMER_NOT_FOUND", "Customer does not exist.");
  }
}

export async function createTag(actorUserId: string, orgIdInput: string, nameInput: string, colorInput?: string) {
  const orgId = normalize(orgIdInput);
  const name = normalize(nameInput);
  const color = normalize(colorInput ?? "emerald") || "emerald";
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!name) {
    throw new ServiceError(400, "INVALID_TAG_NAME", "Tag name is required.");
  }

  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId: actorUserId
      }
    },
    select: {
      role: true
    }
  });

  if (!membership) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }

  if (!canAccessCustomerDirectory(membership.role)) {
    throw new ServiceError(403, "FORBIDDEN_CUSTOMER_ACCESS", "Your role cannot access customer database.");
  }

  await assertOrgBillingAccess(orgId, "write");

  const existing = await prisma.tag.findFirst({
    where: {
      orgId,
      name
    },
    select: {
      id: true
    }
  });

  if (existing) {
    throw new ServiceError(400, "TAG_ALREADY_EXISTS", "Tag with this name already exists.");
  }

  return prisma.tag.create({
    data: {
      orgId,
      name,
      color
    },
    select: {
      id: true,
      name: true,
      color: true,
      createdAt: true
    }
  });
}

export async function listCustomerTags(actorUserId: string, orgIdInput: string, customerIdInput: string): Promise<CustomerTagItem[]> {
  const orgId = normalize(orgIdInput);
  const customerId = normalize(customerIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!customerId) {
    throw new ServiceError(400, "MISSING_CUSTOMER_ID", "customerId is required.");
  }

  await requireCustomerAccess(actorUserId, orgId, customerId);

  const [tags, assignedLinks] = await prisma.$transaction([
    prisma.tag.findMany({
      where: {
        orgId
      },
      orderBy: {
        name: "asc"
      },
      select: {
        id: true,
        name: true,
        color: true
      }
    }),
    prisma.customerTag.findMany({
      where: {
        orgId,
        customerId
      },
      select: {
        tagId: true
      }
    })
  ]);

  const assignedTagIdSet = new Set(assignedLinks.map((row) => row.tagId));
  return tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    isAssigned: assignedTagIdSet.has(tag.id)
  }));
}

export async function assignTagToCustomer(
  actorUserId: string,
  orgIdInput: string,
  customerIdInput: string,
  tagIdInput: string
) {
  const orgId = normalize(orgIdInput);
  const customerId = normalize(customerIdInput);
  const tagId = normalize(tagIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!customerId) {
    throw new ServiceError(400, "MISSING_CUSTOMER_ID", "customerId is required.");
  }

  if (!tagId) {
    throw new ServiceError(400, "MISSING_TAG_ID", "tagId is required.");
  }

  await requireCustomerAccess(actorUserId, orgId, customerId);

  const tag = await prisma.tag.findFirst({
    where: {
      id: tagId,
      orgId
    },
    select: {
      id: true,
      name: true,
      color: true
    }
  });

  if (!tag) {
    throw new ServiceError(404, "TAG_NOT_FOUND", "Tag does not exist.");
  }

  await prisma.customerTag.upsert({
    where: {
      customerId_tagId: {
        customerId,
        tagId
      }
    },
    update: {},
    create: {
      orgId,
      customerId,
      tagId
    }
  });

  void publishCustomerUpdatedEvent({
    orgId,
    customerId
  });
  void processAiAutomationTrigger({
    trigger: "TAG_ADDED",
    orgId,
    customerId,
    customerTags: [tag.name]
  }).catch(() => undefined);

  return tag;
}

export async function listCustomerNotes(
  actorUserId: string,
  orgIdInput: string,
  customerIdInput: string,
  pageInput?: number,
  limitInput?: number
): Promise<CustomerNotesResult> {
  const orgId = normalize(orgIdInput);
  const customerId = normalize(customerIdInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!customerId) {
    throw new ServiceError(400, "MISSING_CUSTOMER_ID", "customerId is required.");
  }

  await requireCustomerAccess(actorUserId, orgId, customerId);
  const page = normalizePage(pageInput);
  const limit = normalizeLimit(limitInput);

  const [total, rows] = await prisma.$transaction([
    prisma.customerNote.count({
      where: {
        orgId,
        customerId
      }
    }),
    prisma.customerNote.findMany({
      where: {
        orgId,
        customerId
      },
      orderBy: {
        createdAt: "desc"
      },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        content: true,
        authorUserId: true,
        createdAt: true
      }
    })
  ]);

  return {
    notes: rows,
    page,
    limit,
    total
  };
}

export async function createCustomerNote(
  actorUserId: string,
  orgIdInput: string,
  customerIdInput: string,
  contentInput: string
) {
  const orgId = normalize(orgIdInput);
  const customerId = normalize(customerIdInput);
  const content = normalize(contentInput);
  if (!orgId) {
    throw new ServiceError(400, "MISSING_ORG_ID", "orgId is required.");
  }

  if (!customerId) {
    throw new ServiceError(400, "MISSING_CUSTOMER_ID", "customerId is required.");
  }

  if (!content) {
    throw new ServiceError(400, "INVALID_NOTE_CONTENT", "Note content is required.");
  }

  await requireCustomerAccess(actorUserId, orgId, customerId);

  const note = await prisma.customerNote.create({
    data: {
      orgId,
      customerId,
      authorUserId: actorUserId,
      content
    },
    select: {
      id: true,
      content: true,
      authorUserId: true,
      createdAt: true
    }
  });

  void publishCustomerUpdatedEvent({
    orgId,
    customerId
  });

  return note;
}

export async function updateCustomerNote(
  actorUserId: string,
  orgIdInput: string,
  customerIdInput: string,
  noteIdInput: string,
  contentInput: string
) {
  const orgId = normalize(orgIdInput);
  const customerId = normalize(customerIdInput);
  const noteId = normalize(noteIdInput);
  const content = normalize(contentInput);
  if (!orgId || !customerId || !noteId) {
    throw new ServiceError(400, "INVALID_NOTE_UPDATE", "orgId, customerId, and noteId are required.");
  }

  if (!content) {
    throw new ServiceError(400, "INVALID_NOTE_CONTENT", "Note content is required.");
  }

  await requireCustomerAccess(actorUserId, orgId, customerId);

  const updateResult = await prisma.customerNote.updateMany({
    where: {
      id: noteId,
      orgId,
      customerId
    },
    data: {
      content
    }
  });

  if (updateResult.count !== 1) {
    throw new ServiceError(404, "CUSTOMER_NOTE_NOT_FOUND", "Customer note does not exist.");
  }

  const note = await prisma.customerNote.findFirst({
    where: {
      id: noteId,
      orgId,
      customerId
    },
    select: {
      id: true,
      content: true,
      authorUserId: true,
      createdAt: true
    }
  });

  if (!note) {
    throw new ServiceError(404, "CUSTOMER_NOTE_NOT_FOUND", "Customer note does not exist.");
  }

  void publishCustomerUpdatedEvent({
    orgId,
    customerId
  });

  return note;
}

export async function deleteCustomerNote(
  actorUserId: string,
  orgIdInput: string,
  customerIdInput: string,
  noteIdInput: string
) {
  const orgId = normalize(orgIdInput);
  const customerId = normalize(customerIdInput);
  const noteId = normalize(noteIdInput);
  if (!orgId || !customerId || !noteId) {
    throw new ServiceError(400, "INVALID_NOTE_DELETE", "orgId, customerId, and noteId are required.");
  }

  await requireCustomerAccess(actorUserId, orgId, customerId);

  const deleteResult = await prisma.customerNote.deleteMany({
    where: {
      id: noteId,
      orgId,
      customerId
    }
  });

  if (deleteResult.count !== 1) {
    throw new ServiceError(404, "CUSTOMER_NOTE_NOT_FOUND", "Customer note does not exist.");
  }

  void publishCustomerUpdatedEvent({
    orgId,
    customerId
  });
}

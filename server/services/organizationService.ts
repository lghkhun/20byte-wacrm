import { Role } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getProxyAssetUrl, getPublicObjectKeyFromUrl } from "@/lib/r2/client";
import { assertOrgBillingAccess } from "@/server/services/billingService";
import { createAccountSetupToken } from "@/server/services/accountSetupService";
import { sendTransactionalEmail } from "@/server/services/emailService";
import {
  canAssignOrganizationRole,
  canManageOrganizationMember,
  canViewOrganizationMembers
} from "@/lib/permissions/orgPermissions";
import { normalizeAndValidateEmail } from "@/lib/validation/formValidation";
import { ServiceError } from "@/server/services/serviceError";

const MIN_ORG_NAME_LENGTH = 2;
const MAX_ORG_NAME_LENGTH = 80;
const MAX_NON_OWNER_MEMBERS = 4;

type CreateOrganizationInput = {
  userId: string;
  name: string;
};

type AddOrganizationMemberInput = {
  actorUserId: string;
  orgId: string;
  email: string;
  role: Role;
};

type InviteOrganizationMemberInput = AddOrganizationMemberInput & {
  name?: string;
};

type OrganizationSummary = {
  id: string;
  name: string;
  role: Role;
  createdAt: Date;
};

export type OrganizationBusinessProfile = {
  id: string;
  name: string;
  legalName: string | null;
  responsibleName: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  businessNpwp: string | null;
  businessAddress: string | null;
  logoUrl: string | null;
  invoiceSignatureUrl: string | null;
};

type OrganizationMemberSummary = {
  orgId: string;
  userId: string;
  role: Role;
  email: string;
  name: string | null;
  createdAt: Date;
};

type OrganizationMemberInvitation = {
  setupLink: string | null;
  expiresAt: Date | null;
  mailtoUrl: string | null;
  requiresPasswordSetup: boolean;
  emailDelivery: boolean | null;
};

type OrganizationMemberInviteResult = {
  member: OrganizationMemberSummary;
  invitation: OrganizationMemberInvitation;
};

function normalizeAssetUrlForClient(value: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  const objectKey = getPublicObjectKeyFromUrl(normalized);
  if (!objectKey) {
    return normalized;
  }

  return getProxyAssetUrl(objectKey);
}

function mapBusinessProfileForClient(profile: OrganizationBusinessProfile): OrganizationBusinessProfile {
  return {
    ...profile,
    logoUrl: normalizeAssetUrlForClient(profile.logoUrl),
    invoiceSignatureUrl: normalizeAssetUrlForClient(profile.invoiceSignatureUrl)
  };
}

function normalizeOrgName(value: string): string {
  return value.trim();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function normalizeOptionalEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  return normalizeAndValidateEmail(normalized);
}

function normalizeOptionalName(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 120);
}

function formatInviteRoleLabel(role: Role): string {
  if (role === Role.ADVERTISER) {
    return "Advertiser";
  }

  return "Customer Service (CS)";
}

function buildInviteMailtoUrl(input: {
  email: string;
  orgName: string;
  role: Role;
  setupLink: string;
  expiresAt: Date;
}): string {
  const subject = `Undangan bergabung di ${input.orgName} via 20byte`;
  const expiresAtLabel = new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(input.expiresAt);
  const body = [
    "Halo,",
    "",
    `Anda diundang untuk bergabung ke bisnis "${input.orgName}" di 20byte sebagai ${formatInviteRoleLabel(input.role)}.`,
    "Silakan aktivasi akun melalui link berikut:",
    input.setupLink,
    "",
    `Link berlaku sampai ${expiresAtLabel}.`,
    "",
    "Terima kasih."
  ].join("\n");

  return `mailto:${encodeURIComponent(input.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildInviteEmailPayload(input: {
  orgName: string;
  role: Role;
  setupLink: string;
  expiresAt: Date;
  name: string | null;
}): { subject: string; text: string; html: string } {
  const subject = `Undangan bergabung di ${input.orgName} via 20byte`;
  const expiresAtLabel = new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(input.expiresAt);
  const greeting = input.name?.trim() || "Tim";
  const roleLabel = formatInviteRoleLabel(input.role);
  const text = [
    `Halo ${greeting},`,
    "",
    `Anda diundang untuk bergabung ke bisnis "${input.orgName}" di 20byte sebagai ${roleLabel}.`,
    "Silakan aktivasi akun melalui link berikut:",
    input.setupLink,
    "",
    `Link berlaku sampai ${expiresAtLabel}.`,
    "",
    "Terima kasih."
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6">
      <p>Halo ${greeting},</p>
      <p>Anda diundang untuk bergabung ke bisnis <strong>${input.orgName}</strong> di 20byte sebagai <strong>${roleLabel}</strong>.</p>
      <p>Silakan aktivasi akun Anda melalui tombol berikut:</p>
      <p>
        <a href="${input.setupLink}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">
          Aktivasi Akun
        </a>
      </p>
      <p>Atau buka link ini langsung:</p>
      <p><a href="${input.setupLink}">${input.setupLink}</a></p>
      <p style="color:#6b7280">Link berlaku sampai ${expiresAtLabel}.</p>
    </div>
  `.trim();

  return { subject, text, html };
}

function isMissingBusinessNpwpFieldError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return message.includes("businessNpwp");
}

function validateOrgName(name: string): string {
  const normalizedName = normalizeOrgName(name);

  if (normalizedName.length < MIN_ORG_NAME_LENGTH) {
    throw new ServiceError(400, "INVALID_ORG_NAME", "Organization name is too short.");
  }

  if (normalizedName.length > MAX_ORG_NAME_LENGTH) {
    throw new ServiceError(400, "INVALID_ORG_NAME", "Organization name is too long.");
  }

  return normalizedName;
}

export function assertNonOwnerMemberLimit(role: Role, nonOwnerCount: number): void {
  if (role === Role.OWNER) {
    return;
  }

  if (nonOwnerCount >= MAX_NON_OWNER_MEMBERS) {
    throw new ServiceError(
      400,
      "ORG_MEMBER_LIMIT_EXCEEDED",
      `MVP saat ini membatasi maksimal ${MAX_NON_OWNER_MEMBERS} anggota per business (di luar owner).`
    );
  }
}

async function requireMembership(userId: string, orgId: string) {
  const membership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId,
        userId
      }
    }
  });

  if (!membership) {
    throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this organization.");
  }

  await assertOrgBillingAccess(orgId, "write");

  return membership;
}

export async function createOrganizationForUser(input: CreateOrganizationInput): Promise<OrganizationSummary> {
  const name = validateOrgName(input.name);

  return prisma.$transaction(async (tx) => {
    const organization = await tx.org.create({
      data: {
        name
      },
      select: {
        id: true,
        name: true,
        createdAt: true
      }
    });

    const membership = await tx.orgMember.create({
      data: {
        orgId: organization.id,
        userId: input.userId,
        role: Role.OWNER
      },
      select: {
        role: true
      }
    });

    await tx.aiAgentConfig.create({
      data: {
        orgId: organization.id,
        enabled: false,
        role: "SALES_ASSISTANT",
        goal: "ANSWER_QUESTION",
        tone: "FRIENDLY",
        salesMode: "SOFT_SELLING",
        stopIfHumanReply: true,
        typingDelayMs: 1200,
        multiBubbleReply: false,
        confidenceThreshold: 70,
        activeModelTier: "FREE"
      }
    });
    await tx.aiTokenBalance.create({
      data: {
        orgId: organization.id,
        totalTokens: 0,
        usedTokens: 0,
        remainingTokens: 0
      }
    });

    return {
      id: organization.id,
      name: organization.name,
      role: membership.role,
      createdAt: organization.createdAt
    };
  });
}

export async function getActiveOrganizationForUser(
  userId: string,
  candidateOrgId = ""
): Promise<OrganizationSummary | null> {
  const normalizedCandidate = candidateOrgId.trim();
  if (normalizedCandidate) {
    const membership = await prisma.orgMember.findUnique({
      where: {
        orgId_userId: {
          orgId: normalizedCandidate,
          userId
        }
      },
      include: {
        org: {
          select: {
            id: true,
            name: true,
            createdAt: true
          }
        }
      }
    });

    if (membership) {
      return {
        id: membership.org.id,
        name: membership.org.name,
        role: membership.role,
        createdAt: membership.org.createdAt
      };
    }
  }

  return getPrimaryOrganizationForUser(userId);
}

export async function listOrganizationsForUser(userId: string): Promise<OrganizationSummary[]> {
  const memberships = await prisma.orgMember.findMany({
    where: {
      userId
    },
    include: {
      org: {
        select: {
          id: true,
          name: true,
          createdAt: true
        }
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  return memberships.map((membership) => ({
    id: membership.org.id,
    name: membership.org.name,
    role: membership.role,
    createdAt: membership.org.createdAt
  }));
}

export async function getPrimaryOrganizationForUser(userId: string): Promise<OrganizationSummary | null> {
  const membership = await prisma.orgMember.findFirst({
    where: {
      userId
    },
    include: {
      org: {
        select: {
          id: true,
          name: true,
          createdAt: true
        }
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  if (!membership) {
    return null;
  }

  return {
    id: membership.org.id,
    name: membership.org.name,
    role: membership.role,
    createdAt: membership.org.createdAt
  };
}

export async function resolvePrimaryOrganizationIdForUser(userId: string, candidateOrgId: string): Promise<string> {
  const normalizedCandidate = candidateOrgId.trim();
  if (normalizedCandidate) {
    const membership = await prisma.orgMember.findUnique({
      where: {
        orgId_userId: {
          orgId: normalizedCandidate,
          userId
        }
      },
      select: {
        orgId: true
      }
    });

    if (!membership) {
      throw new ServiceError(403, "ORG_ACCESS_DENIED", "You do not have access to this business.");
    }

    return membership.orgId;
  }

  const organization = await getPrimaryOrganizationForUser(userId);
  if (!organization) {
    throw new ServiceError(404, "ORG_NOT_FOUND", "No business is available for this account.");
  }

  return organization.id;
}

export async function getOrganizationBusinessProfile(
  actorUserId: string,
  candidateOrgId = ""
): Promise<OrganizationBusinessProfile> {
  const orgId = await resolvePrimaryOrganizationIdForUser(actorUserId, candidateOrgId);
  const membership = await requireMembership(actorUserId, orgId);
  if (membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can access business settings.");
  }

  const selectWithNpwp = {
    id: true,
    name: true,
    legalName: true,
    responsibleName: true,
    businessPhone: true,
    businessEmail: true,
    businessNpwp: true,
    businessAddress: true,
    logoUrl: true,
    invoiceSignatureUrl: true
  };
  const selectWithoutNpwp = {
    id: true,
    name: true,
    legalName: true,
    responsibleName: true,
    businessPhone: true,
    businessEmail: true,
    businessAddress: true,
    logoUrl: true,
    invoiceSignatureUrl: true
  };

  let organization: OrganizationBusinessProfile | null = null;
  try {
    organization = await prisma.org.findUnique({
      where: {
        id: orgId
      },
      select: selectWithNpwp
    });
  } catch (error) {
    if (!isMissingBusinessNpwpFieldError(error)) {
      throw error;
    }

    const fallback = await prisma.org.findUnique({
      where: {
        id: orgId
      },
      select: selectWithoutNpwp
    });
    organization = fallback
      ? {
          ...fallback,
          businessNpwp: null
        }
      : null;
  }

  if (!organization) {
    throw new ServiceError(404, "ORG_NOT_FOUND", "No business is available for this account.");
  }

  return mapBusinessProfileForClient(organization);
}

export async function updateOrganizationBusinessProfile(input: {
  actorUserId: string;
  orgId?: string;
  name: string;
  legalName?: string | null;
  responsibleName?: string | null;
  businessPhone?: string | null;
  businessEmail?: string | null;
  businessNpwp?: string | null;
  businessAddress?: string | null;
  logoUrl?: string | null;
  invoiceSignatureUrl?: string | null;
}): Promise<OrganizationBusinessProfile> {
  const orgId = await resolvePrimaryOrganizationIdForUser(input.actorUserId, input.orgId?.trim() ?? "");
  const membership = await requireMembership(input.actorUserId, orgId);
  if (membership.role !== Role.OWNER) {
    throw new ServiceError(403, "FORBIDDEN_OWNER_ONLY", "Only owner can update business settings.");
  }

  const dataWithNpwp = {
    name: validateOrgName(input.name),
    legalName: normalizeOptionalText(input.legalName),
    responsibleName: normalizeOptionalText(input.responsibleName),
    businessPhone: normalizeOptionalText(input.businessPhone),
    businessEmail: normalizeOptionalEmail(input.businessEmail),
    businessNpwp: normalizeOptionalText(input.businessNpwp),
    businessAddress: normalizeOptionalText(input.businessAddress),
    logoUrl: normalizeOptionalText(input.logoUrl),
    invoiceSignatureUrl: normalizeOptionalText(input.invoiceSignatureUrl)
  };
  const dataWithoutNpwp = {
    name: validateOrgName(input.name),
    legalName: normalizeOptionalText(input.legalName),
    responsibleName: normalizeOptionalText(input.responsibleName),
    businessPhone: normalizeOptionalText(input.businessPhone),
    businessEmail: normalizeOptionalEmail(input.businessEmail),
    businessAddress: normalizeOptionalText(input.businessAddress),
    logoUrl: normalizeOptionalText(input.logoUrl),
    invoiceSignatureUrl: normalizeOptionalText(input.invoiceSignatureUrl)
  };
  const selectWithNpwp = {
    id: true,
    name: true,
    legalName: true,
    responsibleName: true,
    businessPhone: true,
    businessEmail: true,
    businessNpwp: true,
    businessAddress: true,
    logoUrl: true,
    invoiceSignatureUrl: true
  };
  const selectWithoutNpwp = {
    id: true,
    name: true,
    legalName: true,
    responsibleName: true,
    businessPhone: true,
    businessEmail: true,
    businessAddress: true,
    logoUrl: true,
    invoiceSignatureUrl: true
  };

  let updated: OrganizationBusinessProfile;
  try {
    updated = await prisma.org.update({
      where: {
        id: orgId
      },
      data: dataWithNpwp,
      select: selectWithNpwp
    });
  } catch (error) {
    if (!isMissingBusinessNpwpFieldError(error)) {
      throw error;
    }

    const fallback = await prisma.org.update({
      where: {
        id: orgId
      },
      data: dataWithoutNpwp,
      select: selectWithoutNpwp
    });
    updated = {
      ...fallback,
      businessNpwp: null
    };
  }

  return mapBusinessProfileForClient(updated);
}

export async function listOrganizationMembers(
  actorUserId: string,
  orgId: string
): Promise<OrganizationMemberSummary[]> {
  const actorMembership = await requireMembership(actorUserId, orgId);
  if (!canViewOrganizationMembers(actorMembership.role)) {
    throw new ServiceError(403, "FORBIDDEN_MEMBER_LIST", "Your role cannot list organization members.");
  }

  const memberships = await prisma.orgMember.findMany({
    where: {
      orgId
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true
        }
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  return memberships.map((membership) => ({
    orgId: membership.orgId,
    userId: membership.user.id,
    role: membership.role,
    email: membership.user.email,
    name: membership.user.name,
    createdAt: membership.createdAt
  }));
}

export async function inviteOrganizationMemberByEmail(
  input: InviteOrganizationMemberInput
): Promise<OrganizationMemberInviteResult> {
  const actorMembership = await requireMembership(input.actorUserId, input.orgId);
  if (!canAssignOrganizationRole(actorMembership.role, input.role)) {
    throw new ServiceError(403, "FORBIDDEN_ROLE_ASSIGNMENT", "Your role cannot assign this member role.");
  }

  const normalizedEmail = normalizeAndValidateEmail(input.email);
  const normalizedName = normalizeOptionalName(input.name);

  const organization = await prisma.org.findUnique({
    where: {
      id: input.orgId
    },
    select: {
      name: true
    }
  });

  if (!organization) {
    throw new ServiceError(404, "ORG_NOT_FOUND", "Organization not found.");
  }

  const existingUser = await prisma.user.findUnique({
    where: {
      email: normalizedEmail
    },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true
    }
  });

  const user =
    existingUser ??
    (await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: normalizedName,
        passwordHash: null
      },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true
      }
    }));

  const existingMembership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId: input.orgId,
        userId: user.id
      }
    },
    select: {
      role: true
    }
  });

  if (existingMembership && !canManageOrganizationMember(actorMembership.role, existingMembership.role)) {
    throw new ServiceError(403, "FORBIDDEN_MEMBER_MODIFICATION", "Your role cannot modify this member.");
  }

  if (existingMembership?.role === Role.OWNER && input.role !== Role.OWNER) {
    const ownerCount = await prisma.orgMember.count({
      where: {
        orgId: input.orgId,
        role: Role.OWNER
      }
    });

    if (ownerCount <= 1) {
      throw new ServiceError(
        400,
        "LAST_OWNER_ROLE_CHANGE_FORBIDDEN",
        "Organization must have at least one owner."
      );
    }
  }

  if (!existingMembership && input.role !== Role.OWNER) {
    const nonOwnerCount = await prisma.orgMember.count({
      where: {
        orgId: input.orgId,
        role: {
          not: Role.OWNER
        }
      }
    });

    assertNonOwnerMemberLimit(input.role, nonOwnerCount);
  }

  const membership = await prisma.orgMember.upsert({
    where: {
      orgId_userId: {
        orgId: input.orgId,
        userId: user.id
      }
    },
    update: {
      role: input.role
    },
    create: {
      orgId: input.orgId,
      userId: user.id,
      role: input.role
    }
  });

  let invitation: OrganizationMemberInvitation = {
    setupLink: null,
    expiresAt: null,
    mailtoUrl: null,
    requiresPasswordSetup: false,
    emailDelivery: null
  };

  if (!user.passwordHash) {
    const tokenInfo = await createAccountSetupToken({
      userId: user.id,
      orgId: input.orgId,
      createdByUserId: input.actorUserId
    });

    let emailDelivery = false;
    const emailPayload = buildInviteEmailPayload({
      orgName: organization.name,
      role: membership.role,
      setupLink: tokenInfo.setupLink,
      expiresAt: tokenInfo.expiresAt,
      name: user.name
    });

    try {
      await sendTransactionalEmail({
        to: user.email,
        subject: emailPayload.subject,
        text: emailPayload.text,
        html: emailPayload.html
      });
      emailDelivery = true;
    } catch {
      emailDelivery = false;
    }

    invitation = {
      setupLink: tokenInfo.setupLink,
      expiresAt: tokenInfo.expiresAt,
      mailtoUrl: buildInviteMailtoUrl({
        email: user.email,
        orgName: organization.name,
        role: membership.role,
        setupLink: tokenInfo.setupLink,
        expiresAt: tokenInfo.expiresAt
      }),
      requiresPasswordSetup: true,
      emailDelivery
    };
  }

  return {
    member: {
      orgId: membership.orgId,
      userId: user.id,
      role: membership.role,
      email: user.email,
      name: user.name,
      createdAt: membership.createdAt
    },
    invitation
  };
}

export async function addOrganizationMemberByEmail(
  input: AddOrganizationMemberInput
): Promise<OrganizationMemberSummary> {
  const result = await inviteOrganizationMemberByEmail({
    ...input
  });
  return result.member;
}

export async function updateOrganizationMemberRole(input: {
  actorUserId: string;
  orgId: string;
  userId: string;
  role: Role;
}): Promise<OrganizationMemberSummary> {
  const actorMembership = await requireMembership(input.actorUserId, input.orgId);
  if (!canAssignOrganizationRole(actorMembership.role, input.role)) {
    throw new ServiceError(403, "FORBIDDEN_ROLE_ASSIGNMENT", "Your role cannot assign this member role.");
  }

  const existingMembership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId: input.orgId,
        userId: input.userId
      }
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true
        }
      }
    }
  });

  if (!existingMembership) {
    throw new ServiceError(404, "ORG_MEMBER_NOT_FOUND", "Organization member not found.");
  }

  if (existingMembership.role === Role.OWNER) {
    throw new ServiceError(400, "OWNER_ROLE_LOCKED", "Owner role cannot be changed from Team Settings.");
  }

  if (!canManageOrganizationMember(actorMembership.role, existingMembership.role)) {
    throw new ServiceError(403, "FORBIDDEN_MEMBER_MODIFICATION", "Your role cannot modify this member.");
  }

  const updated = await prisma.orgMember.update({
    where: {
      orgId_userId: {
        orgId: input.orgId,
        userId: input.userId
      }
    },
    data: {
      role: input.role
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true
        }
      }
    }
  });

  return {
    orgId: updated.orgId,
    userId: updated.user.id,
    role: updated.role,
    email: updated.user.email,
    name: updated.user.name,
    createdAt: updated.createdAt
  };
}

export async function removeOrganizationMember(input: {
  actorUserId: string;
  orgId: string;
  userId: string;
}): Promise<{ deleted: boolean }> {
  const actorMembership = await requireMembership(input.actorUserId, input.orgId);

  if (input.userId === input.actorUserId) {
    throw new ServiceError(400, "SELF_MEMBER_DELETE_FORBIDDEN", "You cannot remove your own membership.");
  }

  const targetMembership = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId: input.orgId,
        userId: input.userId
      }
    },
    select: {
      role: true
    }
  });

  if (!targetMembership) {
    throw new ServiceError(404, "ORG_MEMBER_NOT_FOUND", "Organization member not found.");
  }

  if (targetMembership.role === Role.OWNER) {
    throw new ServiceError(400, "OWNER_DELETE_FORBIDDEN", "Owner cannot be removed from Team Settings.");
  }

  if (!canManageOrganizationMember(actorMembership.role, targetMembership.role)) {
    throw new ServiceError(403, "FORBIDDEN_MEMBER_MODIFICATION", "Your role cannot modify this member.");
  }

  await prisma.orgMember.delete({
    where: {
      orgId_userId: {
        orgId: input.orgId,
        userId: input.userId
      }
    }
  });

  return { deleted: true };
}

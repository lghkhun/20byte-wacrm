import { Role } from "@prisma/client";

const MEMBER_VIEW_ROLES = new Set<Role>([Role.OWNER, Role.ADMIN]);
const OWNER_ASSIGNABLE_ROLES = new Set<Role>([Role.CS, Role.ADVERTISER]);
const ADMIN_ASSIGNABLE_ROLES = new Set<Role>([Role.CS, Role.ADVERTISER]);
const OWNER_MANAGEABLE_ROLES = new Set<Role>([Role.OWNER, Role.ADMIN, Role.CS, Role.ADVERTISER]);
const ADMIN_MANAGEABLE_ROLES = new Set<Role>([Role.CS, Role.ADVERTISER]);
const SETTINGS_ACCESS_ROLES = new Set<Role>([Role.OWNER, Role.ADMIN]);
const AI_AUTOMATION_MANAGE_ROLES = new Set<Role>([Role.OWNER, Role.ADMIN]);
const INBOX_ACCESS_ROLES = new Set<Role>([Role.OWNER, Role.ADMIN, Role.CS]);
const CUSTOMER_DIRECTORY_ACCESS_ROLES = new Set<Role>([Role.OWNER, Role.ADMIN, Role.CS, Role.ADVERTISER]);

export function canViewOrganizationMembers(role: Role): boolean {
  return MEMBER_VIEW_ROLES.has(role);
}

export function canAssignOrganizationRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === Role.OWNER) {
    return OWNER_ASSIGNABLE_ROLES.has(targetRole);
  }

  if (actorRole === Role.ADMIN) {
    return ADMIN_ASSIGNABLE_ROLES.has(targetRole);
  }

  return false;
}

export function canManageOrganizationMember(actorRole: Role, targetCurrentRole: Role): boolean {
  if (actorRole === Role.OWNER) {
    return OWNER_MANAGEABLE_ROLES.has(targetCurrentRole);
  }

  if (actorRole === Role.ADMIN) {
    return ADMIN_MANAGEABLE_ROLES.has(targetCurrentRole);
  }

  return false;
}

export function canAccessOrganizationSettings(role: Role): boolean {
  return SETTINGS_ACCESS_ROLES.has(role);
}

export function canAccessInbox(role: Role): boolean {
  return INBOX_ACCESS_ROLES.has(role);
}

export function canAccessCustomerDirectory(role: Role): boolean {
  return CUSTOMER_DIRECTORY_ACCESS_ROLES.has(role);
}

export function canManageAiAutomation(role: Role): boolean {
  return AI_AUTOMATION_MANAGE_ROLES.has(role);
}

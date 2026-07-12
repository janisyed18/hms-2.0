import type { StaffRole } from "../domain/types";

export const ALL_ROLES: StaffRole[] = [
  "SUPER_ADMIN",
  "HMS_ADMIN",
  "INSPECTOR",
  "ASSEMBLY",
  "REVIEWER",
  "CUSTOMER_USER"
];

const HMS_ADMIN_MANAGES: StaffRole[] = [
  "HMS_ADMIN",
  "INSPECTOR",
  "ASSEMBLY",
  "REVIEWER",
  "CUSTOMER_USER"
];

export const ROLE_LABELS: Record<StaffRole, string> = {
  SUPER_ADMIN: "Super Admin",
  HMS_ADMIN: "HMS Admin",
  INSPECTOR: "Inspector",
  ASSEMBLY: "Assembly",
  REVIEWER: "Reviewer",
  CUSTOMER_USER: "Customer User"
};

/**
 * Roles the acting user may create or manage. Mirrors the backend privilege
 * matrix so the UI never *offers* a control the API would reject: Super Admin
 * manages everything (incl. Super Admin); HMS Admin manages all but Super Admin;
 * everyone else manages nobody. Presentation only — the backend is authoritative.
 */
export function manageableRoles(actorRoles: StaffRole[]): StaffRole[] {
  if (actorRoles.includes("SUPER_ADMIN")) {
    return ALL_ROLES;
  }
  if (actorRoles.includes("HMS_ADMIN")) {
    return HMS_ADMIN_MANAGES;
  }
  return [];
}

export function canManageRole(actorRoles: StaffRole[], target: StaffRole): boolean {
  return manageableRoles(actorRoles).includes(target);
}

export function requiresCustomer(role: StaffRole): boolean {
  return role === "CUSTOMER_USER";
}

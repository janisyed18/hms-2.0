/** Which app a URL belongs to: the staff workspace at `/` or the customer portal at `/portal/`. */
export type RouteSurface = "staff" | "portal";

export const STAFF_VIEWS = [
  "dashboard",
  "analytics",
  "customers",
  "assets",
  "products",
  "reference",
  "scheduling",
  "inspections",
  "certificates",
  "retest",
  "sync",
  "audit",
  "users",
  "devices"
] as const;

export const PORTAL_VIEWS = [
  "dashboard",
  "assets",
  "locations",
  "bookings",
  "inspections",
  "certificates",
  "retest",
  "notifications"
] as const;

export const USER_SORTS = ["name", "email", "role", "-last_login_at"] as const;
export const USER_STATUSES = ["ACTIVE", "LOCKED", "DISABLED"] as const;
export const USER_MFA = ["enabled", "setup_required"] as const;
export const USER_ROLES = ["SUPER_ADMIN", "HMS_ADMIN", "REVIEWER", "INSPECTOR", "ASSEMBLY", "CUSTOMER_USER"] as const;
export const PAGE_SIZES = [5, 10, 25, 50] as const;

export type UserSort = (typeof USER_SORTS)[number];

/** Everything the Users & Roles directory can be asked, as it appears in the URL. */
export interface UsersRouteQuery {
  q: string;
  role: string;
  status: "" | (typeof USER_STATUSES)[number];
  mfa: "" | (typeof USER_MFA)[number];
  customer: string;
  sort: UserSort;
  page: number;
  pageSize: number;
}

export const DEFAULT_USERS_QUERY: UsersRouteQuery = {
  q: "",
  role: "",
  status: "",
  mfa: "",
  customer: "",
  sort: "name",
  page: 1,
  pageSize: 10
};

/** The customer detail tabs that can be linked to, by the name used in the URL. */
export const CUSTOMER_TABS = { locations: "Locations" } as const;

export interface HmsRoute {
  view: string;
  /** Staff and portal asset detail. */
  asset: string | null;
  inspection: string | null;
  /** Staff customer detail, or the portal's selected organisation. */
  customer: string | null;
  /** The staff customer detail tab, by display name; null is the default. */
  tab: string | null;
  users: UsersRouteQuery;
}

export function emptyRoute(view: string): HmsRoute {
  return { view, asset: null, inspection: null, customer: null, tab: null, users: DEFAULT_USERS_QUERY };
}

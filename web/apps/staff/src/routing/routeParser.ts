import {
  CUSTOMER_TABS,
  DEFAULT_USERS_QUERY,
  PAGE_SIZES,
  PORTAL_VIEWS,
  STAFF_VIEWS,
  USER_MFA,
  USER_ROLES,
  USER_SORTS,
  USER_STATUSES,
  emptyRoute,
  type HmsRoute,
  type RouteSurface,
  type UsersRouteQuery
} from "./routeTypes";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SEARCH = 100;
const MAX_PAGE = 100_000;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function id(value: string | null): string | null {
  return value !== null && ID.test(value) ? value : null;
}

function positiveInt(value: string | null, max: number): number | null {
  if (value === null || !/^[0-9]{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : null;
}

export function viewsFor(surface: RouteSurface): readonly string[] {
  return surface === "portal" ? PORTAL_VIEWS : STAFF_VIEWS;
}

function parseUsers(params: URLSearchParams): UsersRouteQuery {
  const pageSize = positiveInt(params.get("page_size"), 1000);
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_SEARCH),
    role: oneOf(params.get("role"), USER_ROLES) ?? "",
    status: oneOf(params.get("status"), USER_STATUSES) ?? "",
    mfa: oneOf(params.get("mfa"), USER_MFA) ?? "",
    customer: id(params.get("customer")) ?? "",
    sort: oneOf(params.get("sort"), USER_SORTS) ?? DEFAULT_USERS_QUERY.sort,
    page: positiveInt(params.get("page"), MAX_PAGE) ?? DEFAULT_USERS_QUERY.page,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize ?? -1) ? (pageSize as number) : DEFAULT_USERS_QUERY.pageSize
  };
}

/**
 * Reads a query string into a route. Anything that is not a known, well-formed value is dropped, and
 * a parameter only counts on the view it belongs to, so the result is always safe to render from.
 * Whether the signed-in person may open the view is decided later, by the caller.
 */
export function parseRoute(search: string, surface: RouteSurface): HmsRoute {
  const params = new URLSearchParams(search);
  const views = viewsFor(surface);
  const view = oneOf(params.get("view"), views as readonly string[]) ?? "dashboard";
  const route = emptyRoute(view);

  if (view === "assets") route.asset = id(params.get("asset"));
  if (view === "inspections" && surface === "staff") route.inspection = id(params.get("inspection"));
  if (surface === "portal") route.customer = id(params.get("customer"));
  if (surface === "staff" && view === "customers") {
    route.customer = id(params.get("customer"));
    const tab = oneOf(params.get("tab"), Object.keys(CUSTOMER_TABS) as Array<keyof typeof CUSTOMER_TABS>);
    route.tab = route.customer && tab ? CUSTOMER_TABS[tab] : null;
  }
  if (surface === "staff" && view === "users") route.users = parseUsers(params);
  return route;
}

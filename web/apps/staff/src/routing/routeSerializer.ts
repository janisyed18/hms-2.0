import { CUSTOMER_TABS, DEFAULT_USERS_QUERY, type HmsRoute, type RouteSurface } from "./routeTypes";

/**
 * The one canonical query string for a route: parameters in a fixed order, only those that belong to
 * the view, and defaults left out. Parsing then serialising any URL gives its canonical form.
 */
export function serializeRoute(route: HmsRoute, surface: RouteSurface): string {
  const params = new URLSearchParams();
  if (route.view !== "dashboard") params.set("view", route.view);

  // The portal's organisation comes straight after the view: /portal/?view=assets&customer=...&asset=...
  if (surface === "portal" && route.customer) params.set("customer", route.customer);
  if (route.view === "assets" && route.asset) params.set("asset", route.asset);
  if (route.view === "inspections" && surface === "staff" && route.inspection) params.set("inspection", route.inspection);
  if (surface === "staff" && route.view === "customers" && route.customer) {
    params.set("customer", route.customer);
    const tab = Object.entries(CUSTOMER_TABS).find(([, label]) => label === route.tab)?.[0];
    if (tab && route.tab !== CUSTOMER_TABS.locations) params.set("tab", tab);
  }
  if (surface === "staff" && route.view === "users") {
    const users = route.users;
    const defaults = DEFAULT_USERS_QUERY;
    if (users.q.trim()) params.set("q", users.q.trim());
    if (users.role) params.set("role", users.role);
    if (users.status) params.set("status", users.status);
    if (users.mfa) params.set("mfa", users.mfa);
    if (users.customer) params.set("customer", users.customer);
    if (users.sort !== defaults.sort) params.set("sort", users.sort);
    if (users.page !== defaults.page) params.set("page", String(users.page));
    if (users.pageSize !== defaults.pageSize) params.set("page_size", String(users.pageSize));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

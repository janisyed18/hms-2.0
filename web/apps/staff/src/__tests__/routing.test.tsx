import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";

import { parseRoute } from "../routing/routeParser";
import { serializeRoute } from "../routing/routeSerializer";
import { DEFAULT_USERS_QUERY, emptyRoute } from "../routing/routeTypes";
import { useHmsRoute } from "../routing/useHmsRoute";

const staff = (search: string) => parseRoute(search, "staff");
const canonical = (search: string, surface: "staff" | "portal" = "staff") => serializeRoute(parseRoute(search, surface), surface);

describe("parsing", () => {
  it("opens the dashboard for no query, an unknown view, or junk", () => {
    expect(staff("").view).toBe("dashboard");
    expect(staff("?view=nope").view).toBe("dashboard");
    expect(staff("?view[]=users").view).toBe("dashboard");
    expect(staff("?unrelated=1&also=2").view).toBe("dashboard");
  });

  it("reads every Users & Roles parameter", () => {
    const route = staff("?view=users&q=syed+jani&role=INSPECTOR&status=ACTIVE&mfa=enabled&customer=cust-1&sort=-last_login_at&page=2&page_size=25");
    expect(route.users).toEqual({ q: "syed jani", role: "INSPECTOR", status: "ACTIVE", mfa: "enabled", customer: "cust-1", sort: "-last_login_at", page: 2, pageSize: 25 });
  });

  it("discards invalid values instead of failing", () => {
    const route = staff("?view=users&role=WIZARD&status=BOGUS&mfa=maybe&sort=password&page=-4&page_size=7&customer=../etc");
    expect(route.users).toEqual(DEFAULT_USERS_QUERY);
    for (const page of ["0", "1.5", "abc", "", "99999999", " 3"]) {
      expect(staff(`?view=users&page=${page}`).users.page).toBe(1);
    }
    expect(staff("?view=users&q=" + "x".repeat(500)).users.q).toHaveLength(100);
  });

  it("only counts a parameter on the view it belongs to", () => {
    expect(staff("?view=inspections&asset=a1&customer=c1&role=INSPECTOR&page=3")).toEqual(emptyRoute("inspections"));
    expect(staff("?view=assets&asset=a1&inspection=i1").inspection).toBeNull();
    expect(staff("?view=assets&asset=a1").asset).toBe("a1");
    expect(staff("?view=inspections&inspection=i1").inspection).toBe("i1");
    expect(staff("?view=customers&customer=c1").customer).toBe("c1");
    expect(staff("?view=assets&users=1&q=x").users).toEqual(DEFAULT_USERS_QUERY);
  });

  it("refuses ids that are not plain identifiers", () => {
    for (const bad of ["../x", "a b", "<script>", "x".repeat(65), "-lead", ""]) {
      expect(staff(`?view=assets&asset=${encodeURIComponent(bad)}`).asset).toBeNull();
    }
    expect(staff("?view=assets&asset=0193c7a8-1234-7abc-8def-0123456789ab").asset).toBe("0193c7a8-1234-7abc-8def-0123456789ab");
  });

  it("knows which views belong to the portal and which to the staff app", () => {
    expect(parseRoute("?view=users", "portal").view).toBe("dashboard");
    expect(parseRoute("?view=bookings", "staff").view).toBe("dashboard");
    expect(parseRoute("?view=bookings&customer=c1", "portal")).toMatchObject({ view: "bookings", customer: "c1" });
    expect(parseRoute("?view=assets&customer=c1&asset=a1", "portal")).toMatchObject({ view: "assets", customer: "c1", asset: "a1" });
    // The portal has no inspection detail and no users directory.
    expect(parseRoute("?view=inspections&inspection=i1", "portal").inspection).toBeNull();
    expect(parseRoute("?view=users&q=x", "portal").users).toEqual(DEFAULT_USERS_QUERY);
  });
});

describe("hostile and repeated values", () => {
  it("takes the first of a repeated parameter, the same way every time", () => {
    expect(staff("?view=users&view=assets").view).toBe("users");
    expect(staff("?view=users&page=2&page=3").users.page).toBe(2);
    expect(staff("?view=users&role=INSPECTOR&role=WIZARD").users.role).toBe("INSPECTOR");
    expect(staff("?view=users&role=WIZARD&role=INSPECTOR").users.role).toBe("");
    expect(canonical("?view=users&page=2&page=3&view=assets")).toBe("?view=users&page=2");
  });

  it("survives encoded junk, huge numbers and NaN", () => {
    for (const search of ["?view=%00", "?view=%E0%A4%A", "?%=%&=&", "?view=users&q=%3Cscript%3E", "?view=users&page=NaN&page_size=Infinity", "?view=users&page=1e3", "?view=users&page_size=999999999999999999"]) {
      expect(() => canonical(search)).not.toThrow();
    }
    expect(staff("?view=users&page=1e3").users.page).toBe(1);
    expect(staff("?view=users&page_size=999999999999999999").users.pageSize).toBe(10);
    expect(staff("?view=users&page=NaN").users.page).toBe(1);
    expect(staff("?view=users&q=%3Cscript%3E").users.q).toBe("<script>");
    expect(canonical("?view=users&page=0")).toBe("?view=users");
  });

  it("keeps a valid customer tab out of the canonical form and drops an invalid one", () => {
    expect(staff("?view=customers&customer=c1&tab=locations").tab).toBe("Locations");
    expect(canonical("?view=customers&customer=c1&tab=locations")).toBe("?view=customers&customer=c1");
    expect(canonical("?view=customers&customer=c1&tab=bogus")).toBe("?view=customers&customer=c1");
    expect(staff("?view=customers&tab=locations").tab).toBeNull(); // a tab without a customer means nothing
  });
});

describe("serialising", () => {
  it("leaves the dashboard and every default out", () => {
    expect(canonical("")).toBe("");
    expect(canonical("?view=dashboard")).toBe("");
    expect(canonical("?view=users")).toBe("?view=users");
    expect(canonical("?view=users&sort=name&page=1&page_size=10")).toBe("?view=users");
  });

  it("writes parameters in one fixed order, whatever order they arrived in", () => {
    expect(canonical("?page=2&sort=email&view=users&q=jani&status=ACTIVE&role=INSPECTOR&mfa=enabled&page_size=25&customer=c1"))
      .toBe("?view=users&q=jani&role=INSPECTOR&status=ACTIVE&mfa=enabled&customer=c1&sort=email&page=2&page_size=25");
  });

  it("encodes a search the way the address bar shows it", () => {
    expect(canonical("?view=users&q=syed%20jani")).toBe("?view=users&q=syed+jani");
    expect(canonical("?view=users&q=a%26b%3Dc")).toBe("?view=users&q=a%26b%3Dc");
  });

  it("is idempotent: the canonical form of a canonical form is itself", () => {
    const urls = [
      "?view=users&q=syed+jani&role=INSPECTOR&status=ACTIVE&mfa=enabled&customer=c1&sort=-last_login_at&page=2&page_size=25",
      "?view=assets&asset=a1",
      "?view=inspections&inspection=i1",
      "?view=customers&customer=c1&tab=locations",
      "?view=bogus&x=1&asset=a1",
      "?view=users&page=-4&status=BOGUS"
    ];
    for (const url of urls) {
      const once = canonical(url);
      expect(canonical(once)).toBe(once);
    }
    const portal = canonical("?view=assets&customer=c1&asset=a1&junk=1", "portal");
    expect(portal).toBe("?view=assets&customer=c1&asset=a1");
    expect(canonical(portal, "portal")).toBe(portal);
  });
});

describe("the route hook", () => {
  const all = ["dashboard", "assets", "users", "inspections", "customers"];
  const open = (url: string) => window.history.replaceState(null, "", url);

  it("rewrites a URL that is not canonical, without adding a history entry", () => {
    open("/?view=users&status=BOGUS&page=-4&junk=1");
    const before = window.history.length;
    const { result } = renderHook(() => useHmsRoute("staff", all, "dashboard"));
    expect(window.location.search).toBe("?view=users");
    expect(result.current.route.view).toBe("users");
    expect(window.history.length).toBe(before);
  });

  it("never lets a view the person may not open through, and says so in the address bar", () => {
    open("/?view=users&role=INSPECTOR");
    const { result } = renderHook(() => useHmsRoute("staff", ["dashboard", "assets"], "dashboard"));
    expect(result.current.route.view).toBe("dashboard");
    expect(window.location.search).toBe("");
  });

  it("keeps staff-only views out of the portal and puts the portal at /portal/", () => {
    open("/portal/?view=users&q=x");
    const { result } = renderHook(() => useHmsRoute("portal", ["dashboard", "assets", "bookings"], "dashboard"));
    expect(result.current.route.view).toBe("dashboard");
    expect(window.location.pathname).toBe("/portal/");
    expect(window.location.search).toBe("");
  });

  it("pushes on navigate, replaces on request, and ignores a navigation to where it already is", () => {
    open("/");
    const { result } = renderHook(() => useHmsRoute("staff", all, "dashboard"));
    const start = window.history.length;
    act(() => result.current.navigate({ view: "assets", asset: "a1" }));
    expect(window.location.search).toBe("?view=assets&asset=a1");
    expect(window.history.length).toBe(start + 1);
    act(() => result.current.navigate({ view: "assets", asset: "a1" }));
    expect(window.history.length).toBe(start + 1);
    act(() => result.current.navigate({ asset: "a2" }, { replace: true }));
    expect(window.location.search).toBe("?view=assets&asset=a2");
    expect(window.history.length).toBe(start + 1);
  });

  it("follows Back and Forward", async () => {
    open("/");
    const { result } = renderHook(() => useHmsRoute("staff", all, "dashboard"));
    act(() => result.current.navigate({ view: "users" }));
    act(() => result.current.navigate((current) => ({ ...current, users: { ...current.users, role: "INSPECTOR", page: 2 } })));
    expect(window.location.search).toBe("?view=users&role=INSPECTOR&page=2");
    act(() => window.history.back());
    await waitFor(() => expect(result.current.route.users).toMatchObject({ role: "", page: 1 }));
    expect(window.location.search).toBe("?view=users");
    act(() => window.history.back());
    await waitFor(() => expect(result.current.route.view).toBe("dashboard"));
    act(() => window.history.forward());
    await waitFor(() => expect(result.current.route.view).toBe("users"));
  });

  it("drops what belongs to the view it just left", () => {
    open("/?view=assets&asset=a1");
    const { result } = renderHook(() => useHmsRoute("staff", all, "dashboard"));
    act(() => result.current.navigate({ view: "inspections" }));
    expect(window.location.search).toBe("?view=inspections");
    expect(result.current.route.asset).toBeNull();
  });

  it("does not rewrite a newer URL with the correction worked out for an older render", () => {
    // A navigation that lands between a render and that render's effects (a click straight after
    // mount, on a loaded machine) must win: the effect is about the URL it rendered, not this one.
    open("/");
    function Probe() {
      useHmsRoute("staff", all, "dashboard");
      useLayoutEffect(() => {
        // Runs after the render, before its passive effects.
        window.history.pushState(null, "", "/?view=users");
      }, []);
      return null;
    }
    render(<Probe />);
    expect(window.location.search).toBe("?view=users");
  });
});

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { parseRoute } from "./routeParser";
import { serializeRoute } from "./routeSerializer";
import type { HmsRoute, RouteSurface } from "./routeTypes";

// The URL is the single source of truth. This tiny store only tells React when it has changed:
// the browser says so for Back/Forward (popstate), and we say so after our own pushState/replaceState,
// which the browser does not announce.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function snapshot(): string {
  return `${window.location.pathname}${window.location.search}`;
}

// Each app lives at one path; the route is carried in the query string, which the hosting already serves.
const basePath = (surface: RouteSurface) => (surface === "portal" ? "/portal/" : "/");

function write(url: string, replace: boolean) {
  if (replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(null, "", url);
  listeners.forEach((listener) => listener());
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one (typing, redirects, canonicalising). */
  replace?: boolean;
}

export type RoutePatch = Partial<HmsRoute> | ((current: HmsRoute) => HmsRoute);

/**
 * The current route, validated against what this person may open, and a way to change it.
 * `allowedViews` is the session's list: a URL naming any other view is replaced by `fallbackView`
 * before anything is rendered from it.
 */
export function useHmsRoute(surface: RouteSurface, allowedViews: readonly string[], fallbackView: string) {
  const location = useSyncExternalStore(subscribe, snapshot, snapshot);
  const search = location.includes("?") ? location.slice(location.indexOf("?")) : "";
  const allowedKey = allowedViews.join(",");

  const route = useMemo(() => {
    const parsed = parseRoute(search, surface);
    return allowedViews.includes(parsed.view) ? parsed : parseRoute(`?view=${fallbackView}`, surface);
    // allowedKey stands in for allowedViews, which callers rebuild on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, surface, allowedKey, fallbackView]);

  // A URL that is not canonical (a bad value, a parameter from another view, an unavailable view) is
  // rewritten in place so the address bar always says what is on screen.
  useEffect(() => {
    // This correction was worked out for the URL this render saw. If a navigation has landed since
    // (a click straight after mount), that URL is stale: leave it, and the render it triggers
    // corrects the new one if it needs it. Otherwise this would undo the person's navigation.
    if (snapshot() !== location) return;
    const canonical = `${basePath(surface)}${serializeRoute(route, surface)}`;
    if (canonical !== location) write(canonical, true);
  }, [route, surface, location]);

  const navigate = useCallback(
    (patch: RoutePatch, options: NavigateOptions = {}) => {
      const current = parseRoute(window.location.search, surface);
      const base = allowedViews.includes(current.view) ? current : parseRoute(`?view=${fallbackView}`, surface);
      const next = typeof patch === "function" ? patch(base) : { ...base, ...patch };
      const target = next.view && allowedViews.includes(next.view) ? next : { ...next, view: fallbackView };
      const url = `${basePath(surface)}${serializeRoute(target, surface)}`;
      if (url === snapshot()) return;
      write(url, options.replace ?? false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surface, allowedKey, fallbackView]
  );

  return { route, navigate };
}

import { vi } from "vitest";

import { mockBootstrapResponse } from "../data/mockSync";

type FetchImpl = (url: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A paged bootstrap reads the change feed after its pages, so a test fetch that only knows the
 * bootstrap needs the feed answered too. Anything else goes to the test's own handler.
 */
export function withChangeFeed(impl: FetchImpl): FetchImpl {
  return (url, init) =>
    String(url).includes("/sync/changes")
      ? json({ cursor: mockBootstrapResponse.cursor, has_more: false, changes: [] })
      : impl(url, init);
}

/** A fetch whose n-th bootstrap returns the n-th body (the last one repeats). */
export function bootstrapSequence(...bodies: unknown[]) {
  let call = 0;
  return vi.fn(
    withChangeFeed((url) => {
      if (String(url).includes("/sync/bootstrap")) {
        const body = bodies[Math.min(call, bodies.length - 1)];
        call += 1;
        return json(body);
      }
      return new Response("Not found", { status: 404 });
    })
  );
}

export const bootstrapOnly = (body: unknown = mockBootstrapResponse) => bootstrapSequence(body);

export const bootstrapCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/sync/bootstrap")).length;

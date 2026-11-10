import { describe, expect, it } from "vitest";

import { parseRoute } from "../routing/routeParser";
import { serializeRoute } from "../routing/routeSerializer";

describe("the staff asset register can be linked to one customer", () => {
  it("round-trips ?view=assets&customer=<id>", () => {
    const route = parseRoute("?view=assets&customer=c-1", "staff");
    expect(route.view).toBe("assets");
    expect(route.customer).toBe("c-1");
    expect(serializeRoute(route, "staff")).toBe("?view=assets&customer=c-1");
  });

  it("an open asset wins over the customer filter, and other views ignore it", () => {
    expect(parseRoute("?view=assets&asset=a-1&customer=c-1", "staff").customer).toBeNull();
    expect(parseRoute("?view=products&customer=c-1", "staff").customer).toBeNull();
  });

  it("the portal keeps its own organisation parameter untouched", () => {
    expect(serializeRoute(parseRoute("?view=assets&customer=c-1", "portal"), "portal")).toBe("?view=assets&customer=c-1");
  });
});

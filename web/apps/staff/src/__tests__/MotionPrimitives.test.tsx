import { render, screen, waitFor } from "@testing-library/react";
import { useReducedMotion } from "motion/react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MotionProvider } from "../motion/MotionProvider";
import {
  PageMotion,
  PresencePanel,
  Pressable,
  StaggerGroup,
  StaggerItem
} from "../motion/MotionPrimitives";

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    useReducedMotion: vi.fn(() => false)
  };
});

const mockedUseReducedMotion = vi.mocked(useReducedMotion);

function MotionTestRoot({ children }: { children: ReactNode }) {
  return <MotionProvider>{children}</MotionProvider>;
}

beforeEach(() => {
  mockedUseReducedMotion.mockReturnValue(true);
});

describe("Command Centre motion primitives", () => {
  it("keeps page content visible", async () => {
    render(<PageMotion><h1>Assets</h1></PageMotion>, { wrapper: MotionTestRoot });

    expect(await screen.findByRole("heading", { name: "Assets" })).toBeVisible();
  });

  it("keeps the outgoing keyed page mounted until its exit completes", async () => {
    const view = render(
      <PageMotion motionKey="assets"><h1>Assets</h1></PageMotion>,
      { wrapper: MotionTestRoot }
    );
    await screen.findByRole("heading", { name: "Assets" });

    view.rerender(
      <PageMotion motionKey="inspections"><h1>Inspections</h1></PageMotion>
    );

    expect(screen.getByRole("heading", { name: "Assets" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inspections" })).not.toBeInTheDocument();
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Inspections" })).toBeVisible(),
      { timeout: 2000 }
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Assets" })).not.toBeInTheDocument()
    );
  });

  it("preserves staggered items and their semantic content", async () => {
    render(
      <StaggerGroup className="group">
        <StaggerItem className="item"><span>One</span></StaggerItem>
        <StaggerItem><span>Two</span></StaggerItem>
      </StaggerGroup>,
      { wrapper: MotionTestRoot }
    );

    await waitFor(() => {
      expect(screen.getByText("One")).toBeVisible();
      expect(screen.getByText("Two")).toBeVisible();
    });
    expect(screen.getByText("One").closest(".item")).toBeInTheDocument();
  });

  it("transitions keyed presence panels through their exit lifecycle", async () => {
    const view = render(
      <PresencePanel presenceKey="summary"><p>Summary</p></PresencePanel>,
      { wrapper: MotionTestRoot }
    );
    await screen.findByText("Summary");

    view.rerender(
      <PresencePanel presenceKey="activity"><p>Activity</p></PresencePanel>
    );

    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Activity")).toBeVisible(), {
      timeout: 2000
    });
    await waitFor(() => expect(screen.queryByText("Summary")).not.toBeInTheDocument());
  });

  it("uses opacity-only states when reduced motion is requested", async () => {
    mockedUseReducedMotion.mockReturnValue(true);

    render(
      <PageMotion>
        <StaggerGroup>
          <StaggerItem><span>Reduced</span></StaggerItem>
        </StaggerGroup>
      </PageMotion>,
      { wrapper: MotionTestRoot }
    );

    const content = await screen.findByText("Reduced");
    const page = content.closest("section");
    const item = content.parentElement;
    await waitFor(() => expect(content).toBeVisible());
    expect(page?.style.transform).toBe("");
    expect(item?.style.transform).toBe("");
  });

  it("renders an explicitly decorative forwardRef icon inside one native button", () => {
    const SaveIcon = forwardRef<SVGSVGElement, ComponentPropsWithoutRef<"svg">>(
      function SaveIcon(props, ref) {
        return (
          <svg {...props} ref={ref} data-testid="save-icon">
            <path d="M3 3h10v10H3z" />
          </svg>
        );
      }
    );

    render(
      <Pressable aria-label="Save changes"><SaveIcon aria-hidden="true" /></Pressable>,
      { wrapper: MotionTestRoot }
    );

    expect(screen.getAllByRole("button", { name: "Save changes" })).toHaveLength(1);
    expect(screen.getByTestId("save-icon")).toBeInTheDocument();
  });

  it("rejects an unmarked custom component before it can render a nested button", () => {
    function CustomButton() {
      return <button type="button">Custom action</button>;
    }

    const container = document.createElement("div");

    expect(() =>
      render(<Pressable><CustomButton /></Pressable>, {
        container,
        wrapper: MotionTestRoot
      })
    ).toThrow(/custom content must be decorative/i);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("rejects an actual native interactive descendant", () => {
    const container = document.createElement("div");

    expect(() =>
      render(<Pressable><span><button type="button">Save</button></span></Pressable>, {
        container,
        wrapper: MotionTestRoot
      })
    ).toThrow(/only accepts non-interactive/i);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

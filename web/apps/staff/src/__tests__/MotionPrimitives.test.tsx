import { render, screen } from "@testing-library/react";
import { useReducedMotion } from "motion/react";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PageMotion,
  Pressable,
  StaggerGroup
} from "../motion/MotionPrimitives";

vi.mock("motion/react", () => {
  const createMotionElement = (tag: ElementType) =>
    forwardRef<HTMLElement, ComponentPropsWithoutRef<"div"> & {
      animate?: unknown;
      children?: ReactNode;
      exit?: unknown;
      initial?: unknown;
      transition?: unknown;
      variants?: unknown;
      whileTap?: unknown;
    }>(function MotionElement(
      {
        animate,
        children,
        exit,
        initial,
        transition,
        variants,
        whileTap,
        ...props
      },
      ref
    ) {
      const Component = tag;
      return (
        <Component
          {...props}
          ref={ref}
          data-animate={JSON.stringify(animate)}
          data-exit={JSON.stringify(exit)}
          data-initial={JSON.stringify(initial)}
          data-transition={JSON.stringify(transition)}
          data-variants={JSON.stringify(variants)}
          data-while-tap={JSON.stringify(whileTap)}
        >
          {children}
        </Component>
      );
    });

  const elements = new Map<ElementType, ReturnType<typeof createMotionElement>>();
  const getElement = (tag: ElementType) => {
    if (!elements.has(tag)) elements.set(tag, createMotionElement(tag));
    return elements.get(tag);
  };

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    m: new Proxy(
      { create: (tag: ElementType) => getElement(tag) },
      { get: (target, property) => property === "create" ? target.create : getElement(property as ElementType) }
    ),
    useReducedMotion: vi.fn(() => false)
  };
});

const mockedUseReducedMotion = vi.mocked(useReducedMotion);

beforeEach(() => {
  mockedUseReducedMotion.mockReturnValue(false);
});

describe("Command Centre motion primitives", () => {
  it("never hides page content from assistive technology", () => {
    render(<PageMotion><h1>Assets</h1></PageMotion>);

    expect(screen.getByRole("heading", { name: "Assets" })).toBeVisible();
  });

  it("preserves all staggered children", () => {
    render(<StaggerGroup><span>One</span><span>Two</span></StaggerGroup>);

    expect(screen.getByText("One")).toBeVisible();
    expect(screen.getByText("Two")).toBeVisible();
  });

  it("removes translation and stagger timing when reduced motion is requested", () => {
    mockedUseReducedMotion.mockReturnValue(true);

    render(
      <PageMotion>
        <StaggerGroup><span>Reduced</span></StaggerGroup>
      </PageMotion>
    );

    const page = screen.getByText("Reduced").closest("section");
    const group = screen.getByText("Reduced").parentElement;
    expect(page).toHaveAttribute("data-initial", JSON.stringify({ opacity: 0 }));
    expect(page).toHaveAttribute("data-animate", JSON.stringify({ opacity: 1 }));
    expect(JSON.parse(page?.getAttribute("data-initial") ?? "{}")).not.toHaveProperty("y");
    expect(group).toHaveAttribute(
      "data-variants",
      JSON.stringify({ hidden: {}, visible: { transition: { staggerChildren: 0 } } })
    );
  });

  it("rejects button content before producing nested interactive output", () => {
    const container = document.createElement("div");

    expect(() =>
      render(<Pressable><button type="button">Save</button></Pressable>, { container })
    ).toThrow(/only accepts non-interactive native content/i);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("rejects link content before producing nested interactive output", () => {
    const container = document.createElement("div");

    expect(() =>
      render(<Pressable><a href="/assets">Open assets</a></Pressable>, { container })
    ).toThrow(/only accepts non-interactive native content/i);
    expect(container.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("rejects a custom component before it can produce a nested button", () => {
    function CustomButton() {
      return <button type="button">Custom action</button>;
    }

    const container = document.createElement("div");

    expect(() =>
      render(<Pressable><CustomButton /></Pressable>, { container })
    ).toThrow(/only accepts non-interactive native content/i);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";

describe("Inspector app", () => {
  it("opens to the queue-first work dashboard", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "BAT Inspector" })
    ).toBeInTheDocument();
    expect(screen.getByText("Assigned")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });
});

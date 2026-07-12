import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AccountSecurity } from "../components/AccountSecurity";
import type { StaffSession } from "../domain/types";

const session: StaffSession = {
  userId: "u-1",
  displayName: "Alex Reviewer",
  roles: ["REVIEWER"],
  permissions: ["asset:read", "certificate:approve"],
  customerIds: [],
  authMode: "bearer"
};

describe("AccountSecurity", () => {
  it("shows identity and security state without any secret material", () => {
    render(<AccountSecurity session={session} />);
    expect(screen.getByText("Alex Reviewer")).toBeInTheDocument();
    expect(screen.getByText("REVIEWER")).toBeInTheDocument();
    expect(screen.getByText("All customers")).toBeInTheDocument();
    expect(
      screen.getByText(/Multi-factor authentication/i)
    ).toBeInTheDocument();
    // No secret fields ever rendered.
    expect(screen.queryByText(/secret/i)).toBeNull();
    expect(screen.queryByText(/password_hash/i)).toBeNull();
  });

  it("invokes the sign-out callback", () => {
    const onSignOut = vi.fn();
    render(<AccountSecurity session={session} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalled();
  });
});

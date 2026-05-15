/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarNav } from "@/components/sidebar-nav";

const usePathnameMock = vi.fn(() => "/chat");

vi.mock("next/navigation", () => ({
  usePathname: () => usePathnameMock(),
}));

describe("SidebarNav", () => {
  beforeEach(() => {
    usePathnameMock.mockReturnValue("/chat");
  });

  it("renders brand and primary navigation", () => {
    render(
      <SidebarNav
        mobileOpen={false}
        conversations={[]}
        onCloseMobile={() => undefined}
      />,
    );

    expect(screen.getByText("ReasonKB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new chat/i })).toHaveAttribute("href", "/chat");
    expect(screen.getByRole("link", { name: /^projects$/i })).toHaveAttribute("href", "/projects");
  });

  it("highlights the active route and does not render a theme toggle", () => {
    usePathnameMock.mockReturnValue("/projects");

    render(
      <SidebarNav
        mobileOpen={false}
        conversations={[]}
        onCloseMobile={() => undefined}
      />,
    );

    expect(screen.getByRole("link", { name: /^chat$/i })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /^projects$/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^settings$/i })).toHaveAttribute("href", "/settings");
    expect(screen.queryByText(/light mode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
  });
});

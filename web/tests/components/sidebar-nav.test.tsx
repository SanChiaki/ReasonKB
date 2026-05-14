/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarNav } from "@/components/sidebar-nav";

describe("SidebarNav", () => {
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
    expect(screen.getByRole("link", { name: /projects/i })).toHaveAttribute("href", "/projects");
  });

  it("renders settings navigation and theme control", () => {
    render(
      <SidebarNav
        mobileOpen={false}
        conversations={[]}
        onCloseMobile={() => undefined}
      />,
    );

    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute(
      "href",
      "/settings",
    );

    const controls = screen.getByRole("contentinfo", {
      name: /sidebar controls/i,
    });

    expect(
      within(controls).getByRole("button", { name: /theme/i }),
    ).toBeInTheDocument();
  });
});

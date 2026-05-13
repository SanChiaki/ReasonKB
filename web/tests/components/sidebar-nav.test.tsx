/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarNav } from "@/components/sidebar-nav";

describe("SidebarNav", () => {
  it("renders a visible collapse toggle", () => {
    render(
      <SidebarNav
        collapsed={false}
        conversations={[]}
        onToggleCollapse={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: /collapse sidebar/i }),
    ).toBeInTheDocument();
  });

  it("renders settings navigation and theme control", () => {
    render(
      <SidebarNav
        collapsed={false}
        conversations={[]}
        onToggleCollapse={() => undefined}
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

/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";

describe("AppShell", () => {
  it("renders content with a mobile navigation trigger", () => {
    render(
      <AppShell conversations={[]}>
        <div>Projects content</div>
      </AppShell>,
    );

    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("Projects content");

    fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));

    expect(screen.getAllByRole("button", { name: /close navigation/i }).length).toBeGreaterThan(
      0,
    );
  });
});

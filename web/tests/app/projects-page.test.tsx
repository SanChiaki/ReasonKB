/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/repos/conversation-store");
  vi.unmock("@/lib/repos/project-store");
  vi.unmock("@/components/app-shell");
  routerMocks.refresh.mockClear();
  routerMocks.push.mockClear();
});

describe("ProjectsPage", () => {
  it("renders Projects as a read-only source view", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: { dbPath: "/tmp/test.db" },
    }));
    vi.doMock("@/lib/repos/conversation-store", () => ({
      listConversations: () => [],
    }));
    vi.doMock("@/lib/repos/project-store", () => ({
      listProjects: () => [],
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }));

    const module = await import("@/app/projects/page");
    render(await module.default({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("searchbox", { name: /search projects/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create project/i })).not.toBeInTheDocument();
  });

  it("renders a search no-match state instead of the empty-project copy", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: { dbPath: "/tmp/test.db" },
    }));
    vi.doMock("@/lib/repos/conversation-store", () => ({
      listConversations: () => [],
    }));
    vi.doMock("@/lib/repos/project-store", () => ({
      listProjects: () => [
        {
          id: "proj_alpha",
          name: "Alpha",
          documentCount: 1,
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
      ],
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }));

    const module = await import("@/app/projects/page");
    render(await module.default({ searchParams: Promise.resolve({ q: "omega" }) }));

    expect(screen.getByText(/no matching projects/i)).toBeInTheDocument();
    expect(screen.getByText(/omega/i)).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
  });
});

/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/repos/conversation-store");
  vi.unmock("@/lib/repos/system-settings-store");
  vi.unmock("@/components/app-shell");
  routerMocks.refresh.mockClear();
});

describe("SettingsPage", () => {
  it("renders the index worker concurrency setting", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/test.db",
        envFilePath: "/Users/oam/.reasonkb/.env",
        composeCommand:
          "docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans",
        hostBrowseRootHostPath: "/Users/oam",
        hostBrowseRootContainerPath: "/host-browse",
      },
    }));
    vi.doMock("@/lib/repos/conversation-store", () => ({
      listConversations: () => [],
    }));
    vi.doMock("@/lib/repos/system-settings-store", () => ({
      getSystemSettings: () => ({
        indexWorkerConcurrency: 3,
        retrievalDocumentLimit: 12,
        llmApiKeyConfigured: true,
        llmBaseUrl: "https://llm.example.test/v1",
        llmModel: "openai/deepseek-v4-flash",
        llmRetrievalModel: "openai/deepseek-v4-flash",
        llmConfigured: true,
        llmMissingFields: [],
        currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
        pendingProjectsRootHostPath: "",
        projectsRootSwitchStatus: "idle",
        projectsRootSwitchUpdatedAt: null,
      }),
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }));

    const module = await import("@/app/settings/page");
    render(await module.default());

    expect(screen.getByRole("heading", { name: /system settings/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/concurrent jobs/i)).toHaveValue(3);
    expect(screen.getByLabelText(/retrieval documents/i)).toHaveValue(12);
    expect(screen.getByLabelText(/base url/i)).toHaveValue(
      "https://llm.example.test/v1",
    );
    expect(screen.getByText(/model service is ready/i)).toBeInTheDocument();
    expect(screen.getAllByText("/Users/oam/.reasonkb/projects").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /choose folder/i })).toBeEnabled();
  });
});

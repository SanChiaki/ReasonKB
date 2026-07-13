// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminSourceManager,
  type AdminSource,
} from "@/components/admin-source-manager";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdminSourceManager", () => {
  it("shows the affected source next retry time", () => {
    const source: AdminSource = {
      id: "src_1",
      kind: "seeyon",
      displayName: "Seeyon",
      state: "active",
      scope: { endpoint: "https://oa.example.test/seeyon" },
      config: { loginName: "reader" },
      configRevision: 1,
      selectionPolicy: "none",
      schedule: {
        mode: "scheduled",
        intervalSeconds: 600,
        maxDocumentSizeBytes: 104857600,
      },
      health: {
        state: "degraded",
        consecutiveFailureCount: 1,
        lastSuccessAt: null,
        nextSyncAt: "2026-07-13T06:30:00Z",
        errorSummary: "ConnectionError: unavailable",
      },
      validatedAt: null,
      purgeAfter: null,
      createdAt: "2026-07-13T06:00:00Z",
      updatedAt: "2026-07-13T06:00:00Z",
    };

    render(<AdminSourceManager initialSources={[source]} />);

    expect(screen.getByText("下次重试")).toBeInTheDocument();
    expect(screen.getByText("连续失败")).toBeInTheDocument();
    expect(screen.getByText("ConnectionError: unavailable")).toBeInTheDocument();
  });

  it("automatically refreshes health after asynchronous connection validation", async () => {
    const source: AdminSource = {
      id: "src_1",
      kind: "seeyon",
      displayName: "Seeyon",
      state: "active",
      scope: { endpoint: "https://oa.example.test/seeyon" },
      config: { loginName: "reader" },
      configRevision: 1,
      selectionPolicy: "none",
      schedule: {
        mode: "scheduled",
        intervalSeconds: 600,
        maxDocumentSizeBytes: 104857600,
      },
      health: {
        state: "normal",
        consecutiveFailureCount: 0,
        lastSuccessAt: null,
        nextSyncAt: null,
        errorSummary: null,
      },
      validatedAt: "2026-07-13T06:00:00Z",
      purgeAfter: null,
      createdAt: "2026-07-13T06:00:00Z",
      updatedAt: "2026-07-13T06:00:00Z",
    };
    let sourceReads = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      sourceReads += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sources: [
            {
              ...source,
              health: {
                ...source.health,
                state: sourceReads === 1 ? "unknown" : "normal",
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSourceManager initialSources={[source]} />);
    fireEvent.click(screen.getByRole("button", { name: "验证连接" }));

    await waitFor(() => expect(screen.getByText("unknown")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("normal")).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(sourceReads).toBeGreaterThanOrEqual(2);
  });
});

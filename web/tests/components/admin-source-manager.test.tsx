// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminSourceManager,
  type AdminSource,
} from "@/components/admin-source-manager";

function sourceFixture(): AdminSource {
  return {
    id: "src_1",
    kind: "seeyon",
    displayName: "Seeyon",
    state: "active",
    scope: { endpoint: "https://oa.example.test/seeyon" },
    config: { loginName: "reader" },
    configRevision: 1,
    selectionPolicy: "all",
    schedule: {
      mode: "scheduled",
      intervalSeconds: 600,
      maxDocumentSizeBytes: 104857600,
    },
    health: {
      state: "normal",
      consecutiveFailureCount: 0,
      lastSuccessAt: "2026-07-13T06:00:00Z",
      nextSyncAt: "2026-07-13T06:10:00Z",
      errorSummary: null,
    },
    validatedAt: "2026-07-13T06:00:00Z",
    purgeAfter: null,
    createdAt: "2026-07-13T06:00:00Z",
    updatedAt: "2026-07-13T06:00:00Z",
  };
}

function runtimeStatus() {
  return {
    status: {
      coverage: {
        totalDocuments: 0,
        retrievableDocuments: 0,
        queuedDocuments: 0,
        indexingDocuments: 0,
        failedDocuments: 0,
        unsupportedDocuments: 0,
        missingFileIdDocuments: 0,
        oversizedDocuments: 0,
        missingDocuments: 0,
        accessRevokedDocuments: 0,
        excludedDocuments: 0,
        percent: 100,
      },
      itemStates: {},
      syncRuns: [],
    },
  };
}

function okJson(payload: unknown, status = 200) {
  return { ok: true, status, json: async () => payload };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdminSourceManager", () => {
  it("warns before staging a Seeyon URL migration", async () => {
    const source = sourceFixture();
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("/migration") && init?.method === "POST") {
        return okJson({ migration: { id: "migration_1", status: "requested" } }, 202);
      }
      if (url === "/api/admin/sources") return okJson({ sources: [source] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AdminSourceManager initialSources={[source]} />);
    fireEvent.click(screen.getByRole("button", { name: "迁移 URL" }));
    fireEvent.change(screen.getByLabelText("新 Seeyon URL"), {
      target: { value: "https://oa-public.example.test/seeyon" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始迁移" }));

    await waitFor(() => {
      expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("这不是普通配置修改"));
      expect(
        fetchMock.mock.calls.some(
          ([request, init]) => String(request).endsWith("/migration") && init?.method === "POST",
        ),
      ).toBe(true);
    });
  });

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

  it("warns when Seeyon items were skipped because file_id is missing", async () => {
    const source: AdminSource = {
      id: "src_1",
      kind: "seeyon",
      displayName: "Seeyon",
      state: "active",
      scope: { endpoint: "https://oa.example.test/seeyon" },
      config: { loginName: "reader" },
      configRevision: 1,
      selectionPolicy: "all",
      schedule: {
        mode: "scheduled",
        intervalSeconds: 600,
        maxDocumentSizeBytes: 104857600,
      },
      health: {
        state: "normal",
        consecutiveFailureCount: 0,
        lastSuccessAt: "2026-07-13T06:00:00Z",
        nextSyncAt: "2026-07-13T06:10:00Z",
        errorSummary: null,
      },
      validatedAt: "2026-07-13T06:00:00Z",
      purgeAfter: null,
      createdAt: "2026-07-13T06:00:00Z",
      updatedAt: "2026-07-13T06:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: string | URL | Request) => {
        const url = String(request);
        if (url.endsWith("/status")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: {
                coverage: {
                  totalDocuments: 2,
                  retrievableDocuments: 1,
                  queuedDocuments: 0,
                  indexingDocuments: 0,
                  failedDocuments: 0,
                  unsupportedDocuments: 1,
                  missingFileIdDocuments: 1,
                  oversizedDocuments: 0,
                  missingDocuments: 0,
                  accessRevokedDocuments: 0,
                  percent: 50,
                },
                itemStates: { active: 1, unsupported: 1 },
                syncRuns: [],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ collections: [] }),
        };
      }),
    );

    render(<AdminSourceManager initialSources={[source]} />);
    fireEvent.click(screen.getByRole("button", { name: /Seeyon/ }));

    expect(
      await screen.findByText(/已跳过 1 个缺少 file_id 的致远条目/),
    ).toBeInTheDocument();
  });

  it("excludes and restores a Collection through the server-derived rule API", async () => {
    const source = sourceFixture();
    let excluded = false;
    const collection = {
      id: "collection_1",
      displayName: "Operations",
      externalId: "lib_1",
      rootExternalId: "root_1",
      origin: "registered",
      validationState: "valid",
      lifecycleState: "active",
      selected: true,
      validationError: null,
      projectId: "project_1",
    };
    const rule = {
      id: "rule_collection",
      collectionId: collection.id,
      targetType: "collection",
      targetExternalId: collection.externalId,
      displayPath: collection.displayName,
      createdAt: "2026-07-13T06:00:00Z",
    };
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("/status")) return okJson(runtimeStatus());
      if (url.includes("/items?")) return okJson({ items: [], nextCursor: null });
      if (url.endsWith("/collections")) {
        return okJson({
          selectionPolicy: "all",
          collections: [
            {
              ...collection,
              lifecycleState: excluded ? "excluded" : "active",
              exclusionRuleId: excluded ? rule.id : null,
            },
          ],
        });
      }
      if (url.endsWith("/exclusions") && init?.method === "POST") {
        excluded = true;
        return okJson({ exclusion: rule, sync: { queued: 1, coalesced: 0 } }, 201);
      }
      if (url.endsWith(`/exclusions/${rule.id}`) && init?.method === "DELETE") {
        excluded = false;
        return okJson({ exclusion: rule, restorationPending: true });
      }
      if (url.endsWith("/exclusions")) {
        return okJson({ exclusions: excluded ? [rule] : [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AdminSourceManager initialSources={[source]} />);
    fireEvent.click(screen.getByRole("button", { name: /Seeyon/ }));
    fireEvent.click(await screen.findByRole("button", { name: "排除 Operations" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([request, init]) => String(request).endsWith("/exclusions") && init?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        targetType: "collection",
        collectionId: collection.id,
      });
    });
    const restoreButtons = await screen.findAllByRole("button", { name: "恢复 Operations" });
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([request, init]) =>
            String(request).endsWith(`/exclusions/${rule.id}`) && init?.method === "DELETE",
        ),
      ).toBe(true);
    });
    expect(await screen.findByRole("button", { name: "排除 Operations" })).toBeInTheDocument();
  });

  it("loads paged source items and prevents restoring an inherited exclusion", async () => {
    const source = sourceFixture();
    const collection = {
      id: "collection_1",
      displayName: "Operations",
      externalId: "lib_1",
      rootExternalId: "root_1",
      origin: "registered",
      validationState: "valid",
      lifecycleState: "active",
      selected: true,
      validationError: null,
      projectId: "project_1",
      exclusionRuleId: null,
    };
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/status")) return okJson(runtimeStatus());
      if (url.endsWith("/collections")) {
        return okJson({ selectionPolicy: "all", collections: [collection] });
      }
      if (url.endsWith("/exclusions")) return okJson({ exclusions: [] });
      if (url.includes("/items?") && url.includes("cursor=next-page")) {
        return okJson({
          items: [
            {
              id: "item_2",
              itemType: "document",
              name: "inherited.pdf",
              relativePath: "Archive/inherited.pdf",
              sizeBytes: 128,
              lifecycleState: "excluded",
              documentStatus: "ready",
              statusReason: null,
              hasChildren: false,
              exclusionRuleId: null,
              excludedByRuleId: "rule_archive",
              excludedByPath: "Archive",
            },
          ],
          nextCursor: null,
        });
      }
      if (url.includes("/items?")) {
        return okJson({
          items: [
            {
              id: "item_1",
              itemType: "document",
              name: "first.pdf",
              relativePath: "first.pdf",
              sizeBytes: 64,
              lifecycleState: "active",
              documentStatus: "ready",
              statusReason: null,
              hasChildren: false,
              exclusionRuleId: null,
              excludedByRuleId: null,
              excludedByPath: null,
            },
          ],
          nextCursor: "next-page",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSourceManager initialSources={[source]} />);
    fireEvent.click(screen.getByRole("button", { name: /Seeyon/ }));

    expect(await screen.findByText("first.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("inherited.pdf")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "inherited.pdf 已由上级排除" }),
    ).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([request]) => String(request).includes("cursor=next-page")),
    ).toBe(true);
  });
});

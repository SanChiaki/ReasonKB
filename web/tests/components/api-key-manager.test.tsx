/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiKeyManager,
  type ApiKeyListItem,
} from "@/components/api-key-manager";
import { I18nProvider } from "@/lib/i18n";

vi.mock("@/components/admin-shell", () => ({
  readAdminCsrfToken: () => "csrf-token",
}));

const activeKey: ApiKeyListItem = {
  id: "key_123",
  ownerUserId: "deployment-admin",
  name: "Codex",
  prefix: "abc123",
  scopes: ["read:projects", "query"],
  projectIds: [],
  createdAt: "2026-07-21T08:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

function renderManager(initialApiKeys: ApiKeyListItem[] = []) {
  return render(
    <I18nProvider>
      <ApiKeyManager
        initialApiKeys={initialApiKeys}
        projects={[{ id: "proj_1", name: "Alpha" }]}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ApiKeyManager", () => {
  it("creates a scoped key and displays its secret once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: {
            ...activeKey,
            apiKey: "rkb_live_abc123_secret",
          },
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Codex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 API 密钥" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/api-keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reasonkb-csrf": "csrf-token",
      },
      body: JSON.stringify({
        name: "Codex",
        scopes: ["read:projects", "read:documents", "query", "evidence"],
        projectIds: [],
      }),
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "rkb_live_abc123_secret",
    );
    expect(screen.getByText("rkb_live_abc123_...")).toBeInTheDocument();
  });

  it("revokes an active key and refreshes the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const revoked = { ...activeKey, revokedAt: "2026-07-21T09:00:00.000Z" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: true })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKeys: [revoked] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderManager([activeKey]);

    fireEvent.click(
      screen.getByRole("button", { name: "撤销 API 密钥: Codex" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/api-keys/key_123",
      {
        method: "DELETE",
        headers: { "x-reasonkb-csrf": "csrf-token" },
      },
    );
    expect(await screen.findByText("已撤销")).toBeInTheDocument();
  });
});

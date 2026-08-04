/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceHealthPanel } from "@/components/service-health-panel";
import { I18nProvider } from "@/lib/i18n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ServiceHealthPanel", () => {
  it("shows every service state and supports a manual refresh", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          checkedAt: "2026-08-03T05:00:00.000Z",
          services: [
            { id: "web", status: "healthy", latencyMs: 0 },
            { id: "retrieval-api", status: "healthy", latencyMs: 18 },
            { id: "mcp-server", status: "healthy", latencyMs: 11 },
            { id: "index-worker", status: "healthy", lastHeartbeatAt: "2026-08-03T04:59:55.000Z" },
            { id: "source-worker", status: "unhealthy", detail: "heartbeat_stale" },
            { id: "gotenberg", status: "unhealthy", detail: "http_503" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    render(
      <I18nProvider>
        <ServiceHealthPanel />
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "服务健康" })).toBeInTheDocument();
    expect(await screen.findByText("4 / 6 正常")).toBeInTheDocument();
    expect(screen.getByText("索引 Worker")).toBeInTheDocument();
    expect(screen.getByText("源同步 Worker")).toBeInTheDocument();
    expect(screen.getAllByText("不可用")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "刷新服务状态" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProviderHealthPanel } from "@/components/model-provider-health-panel";
import { I18nProvider } from "@/lib/i18n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ModelProviderHealthPanel", () => {
  it("shows provider failures without exposing raw exception content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          checkedAt: "2026-08-04T12:00:00.000Z",
          providers: [
            {
              key: "retrieval:model-a:api.deepseek.com",
              operation: "retrieval",
              model: "model-a",
              providerHost: "api.deepseek.com",
              status: "degraded",
              recentFailureCount: 1,
              consecutiveFailures: 1,
              lastSuccessAt: null,
              lastFailureAt: "2026-08-04T11:59:00.000Z",
              lastFailureClass: "provider_unavailable",
              lastFailureStatusCode: 503,
              lastFailureStage: "page_selection",
              lastFailureElapsedMs: 30000,
            },
          ],
          recentFailures: [
            {
              id: "failure-1",
              occurredAt: "2026-08-04T11:59:00.000Z",
              requestId: "request-1",
              operation: "retrieval",
              stage: "page_selection",
              model: "model-a",
              providerHost: "api.deepseek.com",
              errorClass: "provider_unavailable",
              statusCode: 503,
              exceptionType: "ServiceUnavailableError",
              elapsedMs: 30000,
              attempt: 1,
              retryable: true,
              providerRequestId: "provider-1",
              retryAfter: null,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    render(
      <I18nProvider>
        <ModelProviderHealthPanel />
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "模型供应商健康" })).toBeInTheDocument();
    expect(screen.getByText("model-a")).toBeInTheDocument();
    expect(screen.getByText("降级")).toBeInTheDocument();
    expect(screen.getAllByText(/HTTP 503/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/ServiceUnavailableError/)).not.toBeInTheDocument();
  });
});

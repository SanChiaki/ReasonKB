/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemSettingsForm } from "@/components/system-settings-form";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

afterEach(() => {
  vi.restoreAllMocks();
  routerMocks.refresh.mockClear();
});

describe("SystemSettingsForm", () => {
  it("saves runtime settings", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            settings: {
              indexWorkerConcurrency: 4,
              retrievalDocumentLimit: 12,
              llmApiKeyConfigured: true,
              llmBaseUrl: "https://llm.example.test/v1",
              llmModel: "openai/deepseek-v4-flash",
              llmRetrievalModel: "openai/deepseek-v4-flash",
              llmConfigured: true,
              llmMissingFields: [],
            },
          }),
        ),
      );

    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
      />,
    );
    fireEvent.change(screen.getByLabelText(/concurrent jobs/i), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText(/retrieval documents/i), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-test" },
    });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://llm.example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^model$/i), {
      target: { value: "openai/deepseek-v4-flash" },
    });
    fireEvent.change(screen.getByLabelText(/retrieval model/i), {
      target: { value: "openai/deepseek-v4-flash" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          indexWorkerConcurrency: 4,
          retrievalDocumentLimit: 12,
          llmApiKey: "sk-test",
          llmBaseUrl: "https://llm.example.test/v1",
          llmModel: "openai/deepseek-v4-flash",
          llmRetrievalModel: "openai/deepseek-v4-flash",
        }),
      }),
    );
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/settings saved/i)).toBeInTheDocument();
  });

  it("shows missing model configuration with a visible API key status", () => {
    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
      />,
    );

    expect(screen.getByText(/model service is not configured/i)).toBeInTheDocument();
    expect(screen.getByText(/api key is not saved/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/api key/i)).toHaveAttribute(
      "placeholder",
      "Paste a new API key",
    );
  });
});

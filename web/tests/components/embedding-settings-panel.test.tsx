/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingSettingsPanel } from "@/components/embedding-settings-panel";

const routerMocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

afterEach(() => {
  vi.restoreAllMocks();
  routerMocks.refresh.mockClear();
});

const readyIndex = {
  status: "ready" as const,
  configuredModel: "text-embedding-3-small",
  activeModel: "text-embedding-3-small",
  indexedDocumentCount: 15,
  totalDocumentCount: 15,
  coverage: 1,
  error: null,
};

describe("EmbeddingSettingsPanel", () => {
  it("saves a model while inheriting the existing LLM credentials", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ settings: {} })));
    render(
      <EmbeddingSettingsPanel
        initialApiKeyConfigured={true}
        initialApiKeyInherited={true}
        initialBaseUrl="https://llm.example.test/v1"
        initialBaseUrlInherited={true}
        initialModel="text-embedding-3-small"
        semanticIndex={readyIndex}
      />,
    );

    expect(screen.getByLabelText(/enable semantic routing/i)).toBeChecked();
    expect(screen.getByLabelText(/use the model service api key/i)).toBeChecked();
    expect(screen.getByLabelText(/embedding api key/i)).toBeDisabled();
    expect(screen.getByLabelText(/embedding base url/i)).toBeDisabled();
    expect(screen.getByText("15 / 15")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /save embedding settings/i }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          embeddingApiKey: null,
          embeddingBaseUrl: "",
          embeddingModel: "text-embedding-3-small",
        }),
      }),
    );
    expect(screen.getByText(/embedding settings saved/i)).toBeInTheDocument();
  });

  it("tests independent provider settings before saving them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          model: "text-embedding-v4",
          dimension: 1024,
          promptTokens: 6,
          elapsedMs: 38,
          errorType: null,
          message: "Embedding model test succeeded.",
          details: "",
        }),
      ),
    );
    render(
      <EmbeddingSettingsPanel
        initialApiKeyConfigured={false}
        initialApiKeyInherited={true}
        initialBaseUrl=""
        initialBaseUrlInherited={true}
        initialModel=""
        semanticIndex={{
          status: "unconfigured",
          configuredModel: "",
          activeModel: null,
          indexedDocumentCount: 0,
          totalDocumentCount: 15,
          coverage: 0,
          error: null,
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText(/enable semantic routing/i));
    fireEvent.click(screen.getByLabelText(/use the model service api key/i));
    fireEvent.click(screen.getByLabelText(/use the model service base url/i));
    fireEvent.change(screen.getByLabelText(/embedding api key/i), {
      target: { value: "embed-key" },
    });
    fireEvent.change(screen.getByLabelText(/embedding base url/i), {
      target: { value: "https://embedding.example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText(/embedding model/i), {
      target: { value: "text-embedding-v4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings/embedding-test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          apiKey: "embed-key",
          baseUrl: "https://embedding.example.test/v1",
          model: "text-embedding-v4",
        }),
      }),
    );
    expect(screen.getByText(/1024 dimensions/i)).toBeInTheDocument();
    expect(screen.getByText(/38 ms/i)).toBeInTheDocument();
  });
});

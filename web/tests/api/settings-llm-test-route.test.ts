import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/security/admin-route-auth");
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-settings-llm-test-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  vi.doMock("@/lib/config", () => ({
    appConfig: {
      dbPath,
      retrievalBaseUrl: "http://retrieval.example.test",
    },
  }));
  vi.doMock("@/lib/security/admin-route-auth", () => ({
    authorizeAdminRequest: () => ({ id: "test-admin" }),
    unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
  }));
}

describe("settings LLM test route", () => {
  it("forwards a temporary model test to the retrieval API", async () => {
    makeTempConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          model: "openai/current-model",
          elapsedMs: 42,
          output: "OK",
          errorType: null,
          message: "Model test succeeded.",
          details: "",
        }),
      ),
    );

    const { POST } = await import("@/app/api/admin/settings/llm-test/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/llm-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: "",
          baseUrl: "https://llm.example.test/v1",
          model: "openai/current-model",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://retrieval.example.test/internal/llm/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          apiKey: undefined,
          baseUrl: "https://llm.example.test/v1",
          model: "openai/current-model",
        }),
      }),
    );
  });

  it("builds the LiteLLM model string from the selected interface format", async () => {
    makeTempConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          model: "anthropic/claude-3-5-sonnet-latest",
          elapsedMs: 42,
          output: "OK",
          errorType: null,
          message: "Model test succeeded.",
          details: "",
        }),
      ),
    );

    const { POST } = await import("@/app/api/admin/settings/llm-test/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/llm-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interfaceFormat: "anthropic-messages",
          modelName: "claude-3-5-sonnet-latest",
          baseUrl: "https://api.anthropic.com",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://retrieval.example.test/internal/llm/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          apiKey: undefined,
          baseUrl: "https://api.anthropic.com",
          model: "anthropic/claude-3-5-sonnet-latest",
        }),
      }),
    );
  });

  it("returns the retrieval API failure payload", async () => {
    makeTempConfig();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          model: "openai/current-model",
          elapsedMs: 17,
          output: "",
          errorType: "authentication",
          message: "Authentication failed. Check the API key.",
          details: "invalid api key",
        }),
      ),
    );

    const { POST } = await import("@/app/api/admin/settings/llm-test/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/llm-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: "https://llm.example.test/v1",
          model: "openai/current-model",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.errorType).toBe("authentication");
    expect(json.message).toMatch(/authentication failed/i);
  });
});

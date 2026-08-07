import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/security/admin-route-auth");
});

function mockRuntime() {
  vi.doMock("@/lib/config", () => ({
    appConfig: {
      dbPath: "/tmp/test.db",
      retrievalBaseUrl: "http://retrieval.example.test",
    },
  }));
  vi.doMock("@/lib/security/admin-route-auth", () => ({
    authorizeAdminRequest: () => ({ id: "test-admin" }),
    unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
  }));
}

describe("embedding settings test route", () => {
  it("proxies the candidate embedding settings to the retrieval API", async () => {
    mockRuntime();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          model: "text-embedding-3-small",
          dimension: 1536,
          promptTokens: 5,
          elapsedMs: 42,
          errorType: null,
          message: "Embedding model test succeeded.",
          details: "",
        }),
      ),
    );
    const { POST } = await import("@/app/api/admin/settings/embedding-test/route");

    const response = await POST(
      new Request("http://localhost/api/admin/settings/embedding-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: "https://embedding.example.test/v1",
          model: "text-embedding-3-small",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).dimension).toBe(1536);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://retrieval.example.test/internal/embedding/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseUrl: "https://embedding.example.test/v1",
          model: "text-embedding-3-small",
        }),
      }),
    );
  });

  it("rejects a missing model before calling the retrieval API", async () => {
    mockRuntime();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { POST } = await import("@/app/api/admin/settings/embedding-test/route");

    const response = await POST(
      new Request("http://localhost/api/admin/settings/embedding-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

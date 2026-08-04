import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorized: true,
  getLlmProviderHealth: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: { dbPath: "/tmp/reasonkb-test.db" },
}));

vi.mock("@/lib/security/admin-route-auth", () => ({
  authorizeAdminRequest: () => (mocks.authorized ? { id: "admin" } : null),
  unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
}));

vi.mock("@/lib/repos/llm-observability-store", () => ({
  getLlmProviderHealth: mocks.getLlmProviderHealth,
}));

afterEach(() => {
  mocks.authorized = true;
  mocks.getLlmProviderHealth.mockReset();
});

describe("LLM health route", () => {
  it("returns provider events only to an administrator", async () => {
    mocks.getLlmProviderHealth.mockReturnValue({
      checkedAt: "2026-08-04T12:00:00.000Z",
      providers: [],
      recentFailures: [],
    });
    const { GET } = await import("@/app/api/admin/llm-health/route");

    const response = await GET(new Request("http://localhost/api/admin/llm-health"));

    expect(response.status).toBe(200);
    expect(mocks.getLlmProviderHealth).toHaveBeenCalledWith("/tmp/reasonkb-test.db");
  });

  it("rejects unauthenticated requests", async () => {
    mocks.authorized = false;
    const { GET } = await import("@/app/api/admin/llm-health/route");

    const response = await GET(new Request("http://localhost/api/admin/llm-health"));

    expect(response.status).toBe(401);
    expect(mocks.getLlmProviderHealth).not.toHaveBeenCalled();
  });
});

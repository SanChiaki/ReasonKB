import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorized: true,
  collectServiceHealth: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: {
    dbPath: "/tmp/reasonkb-test.db",
    serviceHealth: { requestTimeoutMs: 100 },
  },
}));

vi.mock("@/lib/security/admin-route-auth", () => ({
  authorizeAdminRequest: () => (mocks.authorized ? { id: "admin" } : null),
  unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
}));

vi.mock("@/lib/service-health", () => ({
  collectServiceHealth: mocks.collectServiceHealth,
}));

afterEach(() => {
  mocks.authorized = true;
  mocks.collectServiceHealth.mockReset();
});

describe("service health route", () => {
  it("returns the aggregated service state to an administrator", async () => {
    mocks.collectServiceHealth.mockResolvedValue({
      checkedAt: "2026-08-03T05:00:00.000Z",
      services: [{ id: "web", status: "healthy" }],
    });
    const { GET } = await import("@/app/api/admin/service-health/route");

    const response = await GET(new Request("http://localhost/api/admin/service-health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkedAt: "2026-08-03T05:00:00.000Z",
      services: [{ id: "web", status: "healthy" }],
    });
    expect(mocks.collectServiceHealth).toHaveBeenCalledWith(
      expect.objectContaining({ requestTimeoutMs: 100 }),
    );
  });

  it("rejects unauthenticated requests", async () => {
    mocks.authorized = false;
    const { GET } = await import("@/app/api/admin/service-health/route");

    const response = await GET(new Request("http://localhost/api/admin/service-health"));

    expect(response.status).toBe(401);
    expect(mocks.collectServiceHealth).not.toHaveBeenCalled();
  });
});

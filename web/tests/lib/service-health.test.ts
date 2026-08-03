import { describe, expect, it, vi } from "vitest";
import { collectServiceHealth } from "@/lib/service-health";

describe("collectServiceHealth", () => {
  it("combines HTTP probes and worker heartbeat freshness without exposing internal errors", async () => {
    const now = new Date("2026-08-03T05:00:00.000Z");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("retrieval")) {
        return new Response(null, { status: 200 });
      }
      if (url.includes("mcp")) {
        throw new Error("connect ECONNREFUSED 10.0.0.9:3002");
      }
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    const statImpl = vi.fn(async (path: string) => ({
      mtimeMs: path.includes("index-worker")
        ? now.getTime() - 10_000
        : now.getTime() - 180_000,
    }));

    const result = await collectServiceHealth(
      {
        retrievalHealthUrl: "http://retrieval/health",
        mcpHealthUrl: "http://mcp/health",
        gotenbergHealthUrl: "http://gotenberg/health",
        indexWorkerHeartbeatPath: "/health/index-worker.heartbeat",
        sourceWorkerHeartbeatPath: "/health/source-worker.heartbeat",
        requestTimeoutMs: 100,
        workerHeartbeatMaxAgeMs: 120_000,
      },
      { fetchImpl, statImpl, now: () => now },
    );

    expect(result.checkedAt).toBe(now.toISOString());
    expect(result.services.map(({ id, status }) => [id, status])).toEqual([
      ["web", "healthy"],
      ["retrieval-api", "healthy"],
      ["mcp-server", "unhealthy"],
      ["index-worker", "healthy"],
      ["source-worker", "unhealthy"],
      ["gotenberg", "unhealthy"],
    ]);
    expect(result.services.find((service) => service.id === "mcp-server")?.detail).toBe(
      "request_failed",
    );
    expect(JSON.stringify(result)).not.toContain("10.0.0.9");
  });

  it("reports a missing worker heartbeat as unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    const statImpl = vi.fn(async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    const result = await collectServiceHealth(
      {
        retrievalHealthUrl: "http://retrieval/health",
        mcpHealthUrl: "http://mcp/health",
        gotenbergHealthUrl: "http://gotenberg/health",
        indexWorkerHeartbeatPath: "/health/index-worker.heartbeat",
        sourceWorkerHeartbeatPath: "/health/source-worker.heartbeat",
        requestTimeoutMs: 100,
        workerHeartbeatMaxAgeMs: 120_000,
      },
      { fetchImpl, statImpl },
    );

    expect(
      result.services.filter((service) => service.id.endsWith("worker")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "unhealthy", detail: "heartbeat_missing" }),
      ]),
    );
  });
});

import { stat } from "node:fs/promises";

export type ServiceHealthId =
  | "web"
  | "retrieval-api"
  | "mcp-server"
  | "index-worker"
  | "source-worker"
  | "gotenberg";

export type ServiceHealthStatus = "healthy" | "unhealthy" | "unknown";

export type ServiceHealthItem = {
  id: ServiceHealthId;
  status: ServiceHealthStatus;
  detail?: string;
  latencyMs?: number;
  lastHeartbeatAt?: string;
};

export type ServiceHealthResult = {
  checkedAt: string;
  services: ServiceHealthItem[];
};

export type ServiceHealthConfig = {
  retrievalHealthUrl: string;
  mcpHealthUrl: string;
  gotenbergHealthUrl: string;
  indexWorkerHeartbeatPath: string;
  sourceWorkerHeartbeatPath: string;
  requestTimeoutMs: number;
  workerHeartbeatMaxAgeMs: number;
};

type HealthDependencies = {
  fetchImpl?: typeof fetch;
  statImpl?: (path: string) => Promise<{ mtimeMs: number }>;
  now?: () => Date;
};

async function probeHttpService(
  id: ServiceHealthId,
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ServiceHealthItem> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!response.ok) {
      return {
        id,
        status: "unhealthy",
        detail: `http_${response.status}`,
        latencyMs,
      };
    }
    return { id, status: "healthy", latencyMs };
  } catch {
    return { id, status: "unhealthy", detail: "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeWorkerHeartbeat(
  id: ServiceHealthId,
  path: string,
  maximumAgeMs: number,
  now: Date,
  statImpl: (path: string) => Promise<{ mtimeMs: number }>,
): Promise<ServiceHealthItem> {
  try {
    const heartbeat = await statImpl(path);
    const lastHeartbeatAt = new Date(heartbeat.mtimeMs).toISOString();
    if (now.getTime() - heartbeat.mtimeMs > maximumAgeMs) {
      return {
        id,
        status: "unhealthy",
        detail: "heartbeat_stale",
        lastHeartbeatAt,
      };
    }
    return { id, status: "healthy", lastHeartbeatAt };
  } catch (error) {
    const detail =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "heartbeat_missing"
        : "heartbeat_unreadable";
    return { id, status: "unhealthy", detail };
  }
}

export async function collectServiceHealth(
  config: ServiceHealthConfig,
  dependencies: HealthDependencies = {},
): Promise<ServiceHealthResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const statImpl = dependencies.statImpl ?? stat;
  const now = dependencies.now?.() ?? new Date();

  const [retrieval, mcp, indexWorker, sourceWorker, gotenberg] = await Promise.all([
    probeHttpService(
      "retrieval-api",
      config.retrievalHealthUrl,
      config.requestTimeoutMs,
      fetchImpl,
    ),
    probeHttpService(
      "mcp-server",
      config.mcpHealthUrl,
      config.requestTimeoutMs,
      fetchImpl,
    ),
    probeWorkerHeartbeat(
      "index-worker",
      config.indexWorkerHeartbeatPath,
      config.workerHeartbeatMaxAgeMs,
      now,
      statImpl,
    ),
    probeWorkerHeartbeat(
      "source-worker",
      config.sourceWorkerHeartbeatPath,
      config.workerHeartbeatMaxAgeMs,
      now,
      statImpl,
    ),
    probeHttpService(
      "gotenberg",
      config.gotenbergHealthUrl,
      config.requestTimeoutMs,
      fetchImpl,
    ),
  ]);

  return {
    checkedAt: now.toISOString(),
    services: [
      { id: "web", status: "healthy", latencyMs: 0 },
      retrieval,
      mcp,
      indexWorker,
      sourceWorker,
      gotenberg,
    ],
  };
}

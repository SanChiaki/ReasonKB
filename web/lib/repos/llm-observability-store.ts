import Database from "better-sqlite3";

export type LlmProviderStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export type LlmProviderHealth = {
  key: string;
  operation: "index" | "retrieval" | "answer" | "health_test";
  model: string;
  providerHost: string | null;
  status: LlmProviderStatus;
  recentFailureCount: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureClass: string | null;
  lastFailureStatusCode: number | null;
  lastFailureStage: string | null;
  lastFailureElapsedMs: number | null;
};

export type LlmProviderFailure = {
  id: string;
  occurredAt: string;
  requestId: string | null;
  operation: "index" | "retrieval" | "answer" | "health_test";
  stage: string;
  model: string;
  providerHost: string | null;
  errorClass: string | null;
  statusCode: number | null;
  exceptionType: string | null;
  elapsedMs: number;
  attempt: number;
  retryable: boolean;
  providerRequestId: string | null;
  retryAfter: string | null;
};

export type LlmProviderHealthResult = {
  checkedAt: string;
  providers: LlmProviderHealth[];
  recentFailures: LlmProviderFailure[];
};

type EventRow = {
  id: string;
  occurred_at: string;
  request_id: string | null;
  operation: "index" | "retrieval" | "answer" | "health_test";
  stage: string;
  model: string | null;
  provider_host: string | null;
  outcome: "success" | "failure";
  error_class: string | null;
  status_code: number | null;
  exception_type: string | null;
  elapsed_ms: number;
  attempt: number;
  retryable: number;
  provider_request_id: string | null;
  retry_after: string | null;
};

export function getLlmProviderHealth(
  dbPath: string,
  now = new Date(),
): LlmProviderHealthResult {
  const checkedAt = now.toISOString();
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma("busy_timeout = 5000");
  try {
    let rows: EventRow[];
    try {
      rows = db
        .prepare(
          `SELECT id, occurred_at, request_id, operation, stage, model,
                  provider_host, outcome, error_class, status_code,
                  exception_type, elapsed_ms, attempt, retryable,
                  provider_request_id, retry_after
             FROM llm_provider_events
            WHERE operation IN ('index', 'retrieval', 'answer', 'health_test')
            ORDER BY occurred_at DESC
            LIMIT 1000`,
        )
        .all() as EventRow[];
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table")) {
        return { checkedAt, providers: [], recentFailures: [] };
      }
      throw error;
    }

    const nowMs = now.getTime();
    const windowStartMs = nowMs - 5 * 60 * 1000;
    const groups = new Map<string, LlmProviderHealth>();
    const consecutiveCounts = new Map<string, number>();
    const failureStreakClosed = new Set<string>();
    const latestEventTimes = new Map<string, number>();
    const recentFailures: LlmProviderFailure[] = [];

    for (const row of rows) {
      const model = row.model || "unknown";
      const key = `${row.operation}:${model}:${row.provider_host || "unknown"}`;
      const occurredMs = Date.parse(row.occurred_at);
      if (!latestEventTimes.has(key)) latestEventTimes.set(key, occurredMs);
      let health = groups.get(key);
      if (!health) {
        health = {
          key,
          operation: row.operation,
          model,
          providerHost: row.provider_host,
          status: "unknown",
          recentFailureCount: 0,
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastFailureClass: null,
          lastFailureStatusCode: null,
          lastFailureStage: null,
          lastFailureElapsedMs: null,
        };
        groups.set(key, health);
      }
      if (!health) continue;

      if (row.outcome === "failure") {
        if (!failureStreakClosed.has(key)) {
          consecutiveCounts.set(key, (consecutiveCounts.get(key) || 0) + 1);
        }
        if (occurredMs >= windowStartMs) health.recentFailureCount += 1;
        if (!health.lastFailureAt) {
          health.lastFailureAt = row.occurred_at;
          health.lastFailureClass = row.error_class;
          health.lastFailureStatusCode = row.status_code;
          health.lastFailureStage = row.stage;
          health.lastFailureElapsedMs = row.elapsed_ms;
        }
        if (recentFailures.length < 20) {
          recentFailures.push(toFailure(row));
        }
      } else {
        failureStreakClosed.add(key);
        if (!health.lastSuccessAt) health.lastSuccessAt = row.occurred_at;
      }
    }

    for (const health of groups.values()) {
      health.consecutiveFailures = consecutiveCounts.get(health.key) || 0;
      const latestEventMs = latestEventTimes.get(health.key) ?? 0;
      health.status = nowMs - latestEventMs > 15 * 60 * 1000
        ? "unknown"
        : health.consecutiveFailures >= 3
          ? "unavailable"
          : health.consecutiveFailures > 0
            ? "degraded"
            : "healthy";
    }

    return {
      checkedAt,
      providers: [...groups.values()],
      recentFailures,
    };
  } finally {
    db.close();
  }
}

function toFailure(row: EventRow): LlmProviderFailure {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    requestId: row.request_id,
    operation: row.operation,
    stage: row.stage,
    model: row.model || "unknown",
    providerHost: row.provider_host,
    errorClass: row.error_class,
    statusCode: row.status_code,
    exceptionType: row.exception_type,
    elapsedMs: row.elapsed_ms,
    attempt: row.attempt,
    retryable: row.retryable === 1,
    providerRequestId: row.provider_request_id,
    retryAfter: row.retry_after,
  };
}

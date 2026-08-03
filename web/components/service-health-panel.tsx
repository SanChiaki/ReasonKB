"use client";

import {
  Cable,
  CircleCheck,
  CircleHelp,
  CircleX,
  FileOutput,
  FileSearch,
  MonitorCog,
  RefreshCcw,
  RefreshCw,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DISPLAY_TIME_ZONE } from "@/lib/date-time";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type {
  ServiceHealthId,
  ServiceHealthItem,
  ServiceHealthResult,
} from "@/lib/service-health";

const refreshIntervalMs = 15_000;

const serviceDefinitions: Array<{
  id: ServiceHealthId;
  label: TranslationKey;
  icon: LucideIcon;
}> = [
  { id: "web", label: "settings.serviceWeb", icon: MonitorCog },
  { id: "retrieval-api", label: "settings.serviceRetrieval", icon: Search },
  { id: "mcp-server", label: "settings.serviceMcp", icon: Cable },
  { id: "index-worker", label: "settings.serviceIndexWorker", icon: FileSearch },
  { id: "source-worker", label: "settings.serviceSourceWorker", icon: RefreshCcw },
  { id: "gotenberg", label: "settings.serviceGotenberg", icon: FileOutput },
];

function healthLabelKey(status: ServiceHealthItem["status"]): TranslationKey {
  if (status === "healthy") return "settings.serviceHealthy";
  if (status === "unhealthy") return "settings.serviceUnavailable";
  return "settings.serviceUnknown";
}

function detailLabelKey(detail?: string): TranslationKey | null {
  if (detail === "heartbeat_missing") return "settings.serviceHeartbeatMissing";
  if (detail === "heartbeat_stale") return "settings.serviceHeartbeatStale";
  if (detail === "heartbeat_unreadable") return "settings.serviceHeartbeatUnreadable";
  if (detail === "request_failed") return "settings.serviceConnectionFailed";
  return null;
}

export function ServiceHealthPanel() {
  const { locale, t } = useI18n();
  const [result, setResult] = useState<ServiceHealthResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  const loadHealth = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/service-health", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("health request failed");
      setResult((await response.json()) as ServiceHealthResult);
      setLoadError(false);
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(true);
    } finally {
      if (activeRequest.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    const interval = window.setInterval(() => void loadHealth(), refreshIntervalMs);
    return () => {
      window.clearInterval(interval);
      activeRequest.current?.abort();
    };
  }, [loadHealth]);

  const servicesById = new Map(result?.services.map((service) => [service.id, service]));
  const healthyCount = result?.services.filter((service) => service.status === "healthy").length ?? 0;
  const formatter = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });

  function serviceMetadata(service: ServiceHealthItem | undefined) {
    if (!service) return t("settings.serviceChecking");
    const detailKey = detailLabelKey(service.detail);
    if (detailKey) return t(detailKey);
    if (service.detail?.startsWith("http_")) {
      return `HTTP ${service.detail.slice(5)}`;
    }
    if (service.lastHeartbeatAt) {
      return t("settings.serviceHeartbeatAt", {
        time: formatter.format(new Date(service.lastHeartbeatAt)),
      });
    }
    if (service.latencyMs !== undefined) {
      return t("settings.serviceLatency", { latency: service.latencyMs });
    }
    return t("settings.serviceUnknown");
  }

  return (
    <section
      aria-labelledby="service-health-title"
      className="rounded-lg border border-[var(--pi-border)] bg-white p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
            {t("settings.serviceHealthEyebrow")}
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="service-health-title" className="text-xl font-semibold text-[var(--pi-ink)]">
              {t("settings.serviceHealth")}
            </h2>
            {result ? (
              <p className="text-sm font-medium text-[var(--pi-muted)]" aria-live="polite">
                {t("settings.serviceHealthySummary", {
                  healthy: healthyCount,
                  total: result.services.length,
                })}
              </p>
            ) : null}
          </div>
          {result ? (
            <p className="mt-1 text-xs text-[var(--pi-muted)]">
              {t("settings.serviceCheckedAt", {
                time: formatter.format(new Date(result.checkedAt)),
              })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void loadHealth()}
          disabled={loading}
          aria-label={t("settings.serviceRefresh")}
          title={t("settings.serviceRefresh")}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pi-border)] text-[var(--pi-muted)] transition enabled:hover:border-[var(--pi-brand)] enabled:hover:text-[var(--pi-brand)] disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loadError && !result ? (
        <p className="mt-5 border-t border-[var(--pi-border)] pt-4 text-sm text-[var(--pi-danger)]">
          {t("settings.serviceLoadError")}
        </p>
      ) : (
        <div className="mt-5 grid border-t border-l border-[var(--pi-border)] sm:grid-cols-2 xl:grid-cols-3">
          {serviceDefinitions.map(({ id, label, icon: ServiceIcon }) => {
            const service = servicesById.get(id);
            const status = service?.status ?? "unknown";
            const StatusIcon =
              status === "healthy"
                ? CircleCheck
                : status === "unhealthy"
                  ? CircleX
                  : CircleHelp;
            const statusColor =
              status === "healthy"
                ? "text-[var(--pi-success)]"
                : status === "unhealthy"
                  ? "text-[var(--pi-danger)]"
                  : "text-[var(--pi-muted)]";

            return (
              <div
                key={id}
                className="min-w-0 border-r border-b border-[var(--pi-border)] px-4 py-3.5"
              >
                <div className="flex items-start gap-3">
                  <ServiceIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--pi-brand)]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--pi-ink)]">{t(label)}</p>
                    <p className="mt-1 truncate text-xs text-[var(--pi-muted)]">
                      {serviceMetadata(service)}
                    </p>
                  </div>
                  <div className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${statusColor}`}>
                    <StatusIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    <span>{service ? t(healthLabelKey(service.status)) : t("settings.serviceChecking")}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

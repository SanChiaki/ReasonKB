"use client";

import {
  CircleCheck,
  CircleHelp,
  CircleX,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DISPLAY_TIME_ZONE } from "@/lib/date-time";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type {
  LlmProviderFailure,
  LlmProviderHealth,
  LlmProviderHealthResult,
} from "@/lib/repos/llm-observability-store";

const refreshIntervalMs = 15_000;

function statusInfo(status: LlmProviderHealth["status"]): {
  label: TranslationKey;
  color: string;
  icon: LucideIcon;
} {
  if (status === "healthy") {
    return { label: "settings.modelProviderHealthy", color: "text-[var(--pi-success)]", icon: CircleCheck };
  }
  if (status === "degraded") {
    return { label: "settings.modelProviderDegraded", color: "text-amber-700", icon: TriangleAlert };
  }
  if (status === "unavailable") {
    return { label: "settings.modelProviderUnavailable", color: "text-[var(--pi-danger)]", icon: CircleX };
  }
  return { label: "settings.modelProviderUnknown", color: "text-[var(--pi-muted)]", icon: CircleHelp };
}

function errorLabel(errorClass: string | null): TranslationKey {
  switch (errorClass) {
    case "authentication_failed":
      return "settings.modelErrorAuthentication";
    case "connection_error":
      return "settings.modelErrorConnection";
    case "timeout":
    case "deadline_exceeded":
      return "settings.modelErrorTimeout";
    case "rate_limited":
      return "settings.modelErrorRateLimited";
    case "provider_unavailable":
      return "settings.modelErrorProviderUnavailable";
    case "model_not_found":
      return "settings.modelErrorModelNotFound";
    case "invalid_request":
      return "settings.modelErrorInvalidRequest";
    default:
      return "settings.modelErrorProvider";
  }
}

function operationLabel(operation: LlmProviderFailure["operation"]): TranslationKey | null {
  if (operation === "index") return "settings.modelOperationIndex";
  if (operation === "retrieval") return "settings.modelOperationRetrieval";
  if (operation === "answer") return "settings.modelOperationAnswer";
  if (operation === "health_test") return "settings.modelOperationHealthTest";
  return null;
}

export function ModelProviderHealthPanel() {
  const { locale, t } = useI18n();
  const [result, setResult] = useState<LlmProviderHealthResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  const loadHealth = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/llm-health", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("model health request failed");
      setResult((await response.json()) as LlmProviderHealthResult);
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

  const formatter = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });

  return (
    <section
      aria-labelledby="model-provider-health-title"
      className="rounded-lg border border-[var(--pi-border)] bg-white p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
            {t("settings.modelProviderHealthEyebrow")}
          </p>
          <h2 id="model-provider-health-title" className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
            {t("settings.modelProviderHealth")}
          </h2>
          {result ? (
            <p className="mt-1 text-xs text-[var(--pi-muted)]">
              {t("settings.modelProviderCheckedAt", {
                time: formatter.format(new Date(result.checkedAt)),
              })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void loadHealth()}
          disabled={loading}
          aria-label={t("settings.modelProviderRefresh")}
          title={t("settings.modelProviderRefresh")}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pi-border)] text-[var(--pi-muted)] transition enabled:hover:border-[var(--pi-brand)] enabled:hover:text-[var(--pi-brand)] disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loadError && !result ? (
        <p className="mt-5 border-t border-[var(--pi-border)] pt-4 text-sm text-[var(--pi-danger)]">
          {t("settings.modelProviderLoadError")}
        </p>
      ) : result?.providers.length ? (
        <div className="mt-5 space-y-5 border-t border-[var(--pi-border)] pt-5">
          <div className="grid border-l border-t border-[var(--pi-border)] lg:grid-cols-2">
            {result.providers.map((provider) => {
              const info = statusInfo(provider.status);
              const StatusIcon = info.icon;
              return (
                <div
                  key={provider.key}
                  className="min-w-0 border-r border-b border-[var(--pi-border)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--pi-ink)]">{provider.model}</p>
                      <p className="mt-1 truncate text-xs text-[var(--pi-muted)]">
                        {t(operationLabel(provider.operation) ?? "settings.modelOperationUnknown")}
                        {provider.providerHost ? ` · ${provider.providerHost}` : ""}
                      </p>
                    </div>
                    <span className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${info.color}`}>
                      <StatusIcon aria-hidden="true" className="h-3.5 w-3.5" />
                      {t(info.label)}
                    </span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div><dt className="text-[var(--pi-muted)]">{t("settings.modelProviderRecentFailures")}</dt><dd className="mt-0.5 font-medium text-[var(--pi-ink)]">{provider.recentFailureCount}</dd></div>
                    <div><dt className="text-[var(--pi-muted)]">{t("settings.modelProviderConsecutiveFailures")}</dt><dd className="mt-0.5 font-medium text-[var(--pi-ink)]">{provider.consecutiveFailures}</dd></div>
                    <div><dt className="text-[var(--pi-muted)]">{t("settings.modelProviderLastSuccess")}</dt><dd className="mt-0.5 font-medium text-[var(--pi-ink)]">{provider.lastSuccessAt ? formatter.format(new Date(provider.lastSuccessAt)) : "-"}</dd></div>
                    <div><dt className="text-[var(--pi-muted)]">{t("settings.modelProviderLastFailure")}</dt><dd className="mt-0.5 font-medium text-[var(--pi-ink)]">{provider.lastFailureAt ? formatter.format(new Date(provider.lastFailureAt)) : "-"}</dd></div>
                  </dl>
                  {provider.lastFailureClass ? (
                    <p className="mt-3 text-xs text-[var(--pi-danger)]">
                      {t(errorLabel(provider.lastFailureClass))}
                      {provider.lastFailureStatusCode ? ` · HTTP ${provider.lastFailureStatusCode}` : ""}
                      {provider.lastFailureStage ? ` · ${provider.lastFailureStage}` : ""}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          {result.recentFailures.length ? (
            <div>
              <h3 className="text-sm font-semibold text-[var(--pi-ink)]">{t("settings.modelProviderRecentErrors")}</h3>
              <div className="mt-2 divide-y divide-[var(--pi-border)] border border-[var(--pi-border)]">
                {result.recentFailures.map((failure) => (
                  <div key={failure.id} className="grid gap-1 px-3 py-2.5 text-xs sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-3">
                    <span className="text-[var(--pi-muted)]">{formatter.format(new Date(failure.occurredAt))}</span>
                    <span className="min-w-0 truncate text-[var(--pi-ink)]">
                      {t(errorLabel(failure.errorClass))} · {failure.stage} · {failure.model}
                    </span>
                    <span className="text-[var(--pi-muted)]">
                      {failure.statusCode ? `HTTP ${failure.statusCode}` : `${failure.elapsedMs} ms`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-5 border-t border-[var(--pi-border)] pt-4 text-sm text-[var(--pi-muted)]">
          {t("settings.modelProviderNoData")}
        </p>
      )}
    </section>
  );
}

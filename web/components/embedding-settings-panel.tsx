"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, RefreshCw } from "lucide-react";
import { readAdminCsrfToken } from "@/components/admin-shell";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type { SemanticIndexState } from "@/lib/repos/system-settings-store";

type EmbeddingTestResponse = {
  success: boolean;
  model: string;
  dimension: number;
  promptTokens: number;
  elapsedMs: number;
  errorType?: string | null;
  message: string;
  details?: string;
};

const semanticStatusKeys: Record<SemanticIndexState["status"], TranslationKey> = {
  unconfigured: "settings.semanticStatus.unconfigured",
  validating: "settings.semanticStatus.validating",
  backfilling: "settings.semanticStatus.backfilling",
  ready: "settings.semanticStatus.ready",
  degraded: "settings.semanticStatus.degraded",
};

function validHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function EmbeddingSettingsPanel({
  initialApiKeyConfigured,
  initialApiKeyInherited,
  initialBaseUrl,
  initialBaseUrlInherited,
  initialModel,
  semanticIndex,
}: {
  initialApiKeyConfigured: boolean;
  initialApiKeyInherited: boolean;
  initialBaseUrl: string;
  initialBaseUrlInherited: boolean;
  initialModel: string;
  semanticIndex: SemanticIndexState;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInherited, setApiKeyInherited] = useState(initialApiKeyInherited);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [baseUrlInherited, setBaseUrlInherited] = useState(
    initialBaseUrlInherited,
  );
  const [enabled, setEnabled] = useState(Boolean(initialModel));
  const [model, setModel] = useState(initialModel);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [testResult, setTestResult] = useState<EmbeddingTestResponse | null>(null);

  useEffect(() => {
    if (!["validating", "backfilling"].includes(semanticIndex.status)) {
      return;
    }
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [router, semanticIndex.status]);

  useEffect(() => {
    if (baseUrlInherited) {
      setBaseUrl(initialBaseUrl);
    }
  }, [baseUrlInherited, initialBaseUrl]);

  const hasExplicitSavedApiKey =
    initialApiKeyConfigured && !initialApiKeyInherited;
  const apiKeyValid = apiKeyInherited || Boolean(apiKey.trim()) || hasExplicitSavedApiKey;
  const baseUrlValid = baseUrlInherited || validHttpUrl(baseUrl.trim());
  const modelValid = Boolean(model.trim());
  const canSubmit =
    (!enabled || (apiKeyValid && baseUrlValid && modelValid)) && !submitting;
  const canTest =
    enabled && apiKeyValid && baseUrlValid && modelValid && !testing;
  const coveragePercent = Math.round(semanticIndex.coverage * 100);
  const statusLabel = t(semanticStatusKeys[semanticIndex.status]);

  function resetMessages() {
    setStatusMessage("");
    setErrorMessage("");
    setTestResult(null);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    resetMessages();
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-reasonkb-csrf": readAdminCsrfToken(),
        },
        body: JSON.stringify({
          embeddingApiKey: apiKeyInherited
            ? null
            : apiKey.trim() || undefined,
          embeddingBaseUrl: baseUrlInherited ? "" : baseUrl.trim(),
          embeddingModel: enabled ? model.trim() : "",
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setErrorMessage(payload?.error ?? t("settings.embeddingSaveError"));
        return;
      }
      setApiKey("");
      setStatusMessage(t("settings.embeddingSaved"));
      router.refresh();
    } catch {
      setErrorMessage(t("settings.embeddingSaveError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function testConnection() {
    if (!canTest) {
      return;
    }
    setTesting(true);
    resetMessages();
    try {
      const response = await fetch("/api/admin/settings/embedding-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-reasonkb-csrf": readAdminCsrfToken(),
        },
        body: JSON.stringify({
          ...(!apiKeyInherited && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(!baseUrlInherited ? { baseUrl: baseUrl.trim() } : {}),
          model: model.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | EmbeddingTestResponse
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("success" in payload)) {
        setErrorMessage(
          payload && "error" in payload && payload.error
            ? payload.error
            : t("settings.embeddingTestError"),
        );
        return;
      }
      setTestResult(payload);
    } catch {
      setErrorMessage(t("settings.embeddingTestError"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className="rounded-lg border border-[var(--pi-border)] bg-white p-5"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 lg:max-w-md">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
            {t("settings.embeddingEyebrow")}
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
            {t("settings.embeddingTitle")}
          </h2>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`rounded-md border px-2.5 py-1 ${
                semanticIndex.status === "ready"
                  ? "border-[var(--pi-brand-soft)] bg-[var(--pi-brand-soft)] text-[var(--pi-brand)]"
                  : semanticIndex.status === "degraded"
                    ? "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                    : "border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-muted)]"
              }`}
            >
              {statusLabel}
            </span>
            <button
              type="button"
              onClick={() => router.refresh()}
              title={t("settings.refreshSemanticStatus")}
              aria-label={t("settings.refreshSemanticStatus")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-muted)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)]"
            >
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
          <dl className="mt-4 grid gap-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--pi-muted)]">
                {t("settings.semanticCoverage")}
              </dt>
              <dd className="mt-1 font-medium text-[var(--pi-ink)]">
                {semanticIndex.indexedDocumentCount} / {semanticIndex.totalDocumentCount}
                <span className="ml-2 text-xs font-normal text-[var(--pi-muted)]">
                  {coveragePercent}%
                </span>
              </dd>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--pi-bg)]">
                <div
                  className="h-full bg-[var(--pi-brand)] transition-[width]"
                  style={{ width: `${coveragePercent}%` }}
                />
              </div>
            </div>
            {semanticIndex.activeModel ? (
              <div>
                <dt className="text-xs text-[var(--pi-muted)]">
                  {t("settings.semanticActiveModel")}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs text-[var(--pi-ink)]">
                  {semanticIndex.activeModel}
                </dd>
              </div>
            ) : null}
          </dl>
          {semanticIndex.error ? (
            <p className="mt-4 break-words rounded-md border border-[var(--pi-danger)] bg-[rgba(190,18,60,0.06)] p-3 text-xs text-[var(--pi-danger)]">
              {semanticIndex.error}
            </p>
          ) : null}
        </div>

        <div className="grid w-full gap-4 lg:w-[28rem]">
          <label className="flex items-start gap-3 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
                resetMessages();
              }}
              className="mt-1 h-4 w-4 rounded border-[var(--pi-border)] text-[var(--pi-brand)] focus:ring-[var(--pi-brand)]"
            />
            <span className="text-sm font-medium text-[var(--pi-ink)]">
              {t("settings.embeddingEnabled")}
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3">
            <input
              type="checkbox"
              checked={apiKeyInherited}
              disabled={!enabled}
              onChange={(event) => {
                setApiKeyInherited(event.target.checked);
                resetMessages();
              }}
              className="mt-1 h-4 w-4 rounded border-[var(--pi-border)] text-[var(--pi-brand)] focus:ring-[var(--pi-brand)]"
            />
            <span className="text-sm font-medium text-[var(--pi-ink)]">
              {t("settings.embeddingInheritApiKey")}
            </span>
          </label>
          <div>
            <label
              htmlFor="embedding-api-key"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.embeddingApiKey")}
            </label>
            <input
              id="embedding-api-key"
              type="password"
              value={apiKey}
              disabled={!enabled || apiKeyInherited}
              placeholder={
                apiKeyInherited
                  ? t("settings.embeddingInherited")
                  : hasExplicitSavedApiKey
                    ? t("settings.keepApiKey")
                    : t("settings.pasteApiKey")
              }
              autoComplete="off"
              onChange={(event) => {
                setApiKey(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)] disabled:bg-[var(--pi-bg)]"
            />
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3">
            <input
              type="checkbox"
              checked={baseUrlInherited}
              disabled={!enabled}
              onChange={(event) => {
                setBaseUrlInherited(event.target.checked);
                resetMessages();
              }}
              className="mt-1 h-4 w-4 rounded border-[var(--pi-border)] text-[var(--pi-brand)] focus:ring-[var(--pi-brand)]"
            />
            <span className="text-sm font-medium text-[var(--pi-ink)]">
              {t("settings.embeddingInheritBaseUrl")}
            </span>
          </label>
          <div>
            <label
              htmlFor="embedding-base-url"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.embeddingBaseUrl")}
            </label>
            <input
              id="embedding-base-url"
              type="url"
              value={baseUrl}
              disabled={!enabled || baseUrlInherited}
              placeholder="https://api.example.com/v1"
              onChange={(event) => {
                setBaseUrl(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)] disabled:bg-[var(--pi-bg)]"
            />
          </div>
          <div>
            <label
              htmlFor="embedding-model"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.embeddingModel")}
            </label>
            <input
              id="embedding-model"
              value={model}
              disabled={!enabled}
              placeholder="text-embedding-3-small"
              onChange={(event) => {
                setModel(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={!canTest}
              onClick={testConnection}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--pi-border)] bg-white px-4 py-2.5 text-sm font-medium text-[var(--pi-ink)] transition enabled:hover:border-[var(--pi-brand)] enabled:hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <FlaskConical aria-hidden="true" className="h-4 w-4" />
              {testing
                ? t("settings.embeddingTesting")
                : t("settings.embeddingTest")}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-[var(--pi-brand-strong)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {submitting
                ? t("settings.embeddingSaving")
                : t("settings.embeddingSave")}
            </button>
          </div>
          {testResult ? (
            <div
              role="status"
              className={`rounded-md border p-3 text-sm ${
                testResult.success
                  ? "border-[var(--pi-brand-soft)] bg-[var(--pi-bg)]"
                  : "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.06)]"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={
                    testResult.success
                      ? "font-medium text-[var(--pi-brand)]"
                      : "font-medium text-[var(--pi-danger)]"
                  }
                >
                  {testResult.message}
                </span>
                <span className="text-xs text-[var(--pi-muted)]">
                  {testResult.elapsedMs} ms
                </span>
              </div>
              {testResult.success ? (
                <p className="mt-2 text-xs text-[var(--pi-muted)]">
                  {testResult.dimension} {t("settings.embeddingDimensions")} ·{" "}
                  {testResult.promptTokens} {t("settings.embeddingTokens")}
                </p>
              ) : testResult.details ? (
                <p className="mt-2 break-words text-xs text-[var(--pi-muted)]">
                  {testResult.details}
                </p>
              ) : null}
            </div>
          ) : null}
          {statusMessage ? (
            <p role="status" className="text-sm text-[var(--pi-brand)]">
              {statusMessage}
            </p>
          ) : null}
          {errorMessage ? (
            <p role="alert" className="text-sm text-[var(--pi-danger)]">
              {errorMessage}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SAVE_ERROR_MESSAGE = "Unable to save system settings. Please try again.";

export function SystemSettingsForm({
  initialIndexWorkerConcurrency,
  initialRetrievalDocumentLimit,
  initialLlmApiKeyConfigured,
  initialLlmBaseUrl,
  initialLlmModel,
  initialLlmRetrievalModel,
  initialLlmConfigured,
  initialLlmMissingFields,
}: {
  initialIndexWorkerConcurrency: number;
  initialRetrievalDocumentLimit: number;
  initialLlmApiKeyConfigured: boolean;
  initialLlmBaseUrl: string;
  initialLlmModel: string;
  initialLlmRetrievalModel: string;
  initialLlmConfigured: boolean;
  initialLlmMissingFields: string[];
}) {
  const router = useRouter();
  const [indexWorkerConcurrency, setIndexWorkerConcurrency] = useState(
    String(initialIndexWorkerConcurrency),
  );
  const [retrievalDocumentLimit, setRetrievalDocumentLimit] = useState(
    String(initialRetrievalDocumentLimit),
  );
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState(initialLlmBaseUrl);
  const [llmModel, setLlmModel] = useState(initialLlmModel);
  const [llmRetrievalModel, setLlmRetrievalModel] = useState(initialLlmRetrievalModel);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const parsedConcurrency = Number.parseInt(indexWorkerConcurrency, 10);
  const parsedRetrievalDocumentLimit = Number.parseInt(retrievalDocumentLimit, 10);
  const isValidConcurrency =
    Number.isInteger(parsedConcurrency) &&
    parsedConcurrency >= 1 &&
    parsedConcurrency <= 16;
  const isValidRetrievalDocumentLimit =
    Number.isInteger(parsedRetrievalDocumentLimit) &&
    parsedRetrievalDocumentLimit >= 1 &&
    parsedRetrievalDocumentLimit <= 50;
  const isValidBaseUrl = (() => {
    const value = llmBaseUrl.trim();
    if (!value) {
      return true;
    }
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  })();
  const isValidModel = llmModel.trim().length > 0;
  const isValidRetrievalModel = llmRetrievalModel.trim().length > 0;
  const canSubmit =
    isValidConcurrency &&
    isValidRetrievalDocumentLimit &&
    isValidBaseUrl &&
    isValidModel &&
    isValidRetrievalModel &&
    !submitting;

  function resetMessages() {
    setStatusMessage("");
    setErrorMessage("");
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setSubmitting(true);
    setStatusMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          indexWorkerConcurrency: parsedConcurrency,
          retrievalDocumentLimit: parsedRetrievalDocumentLimit,
          llmApiKey: llmApiKey.trim() ? llmApiKey.trim() : undefined,
          llmBaseUrl: llmBaseUrl.trim(),
          llmModel: llmModel.trim(),
          llmRetrievalModel: llmRetrievalModel.trim(),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setErrorMessage(payload?.error ?? SAVE_ERROR_MESSAGE);
        return;
      }

      setStatusMessage("Settings saved.");
      router.refresh();
    } catch {
      setErrorMessage(SAVE_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Model service
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {initialLlmConfigured
                ? "Model service is ready"
                : "Model service is not configured"}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Configure the OpenAI-compatible endpoint used by document indexing and retrieval answers.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span
                className={`rounded-md border px-2.5 py-1 ${
                  initialLlmApiKeyConfigured
                    ? "border-[var(--pi-brand-soft)] bg-[var(--pi-brand-soft)] text-[var(--pi-brand)]"
                    : "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                }`}
              >
                {initialLlmApiKeyConfigured ? "API key is saved" : "API key is not saved"}
              </span>
              <span
                className={`rounded-md border px-2.5 py-1 ${
                  initialLlmMissingFields.includes("Base URL")
                    ? "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                    : "border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-muted)]"
                }`}
              >
                {initialLlmMissingFields.includes("Base URL")
                  ? "Base URL is missing"
                  : "Base URL is set"}
              </span>
            </div>
          </div>
          <div className="grid w-full gap-4 lg:w-[28rem]">
            <div>
              <label htmlFor="llm-api-key" className="text-sm font-medium text-[var(--pi-ink)]">
                API key
              </label>
              <input
                id="llm-api-key"
                type="password"
                value={llmApiKey}
                placeholder={
                  initialLlmApiKeyConfigured ? "Leave blank to keep saved key" : "Paste a new API key"
                }
                autoComplete="off"
                onChange={(event) => {
                  setLlmApiKey(event.target.value);
                  resetMessages();
                }}
                className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
              />
            </div>
            <div>
              <label htmlFor="llm-base-url" className="text-sm font-medium text-[var(--pi-ink)]">
                Base URL
              </label>
              <input
                id="llm-base-url"
                type="url"
                value={llmBaseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => {
                  setLlmBaseUrl(event.target.value);
                  resetMessages();
                }}
                className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
              />
              {!isValidBaseUrl ? (
                <p className="mt-2 text-xs text-[var(--pi-danger)]">
                  Base URL must start with http:// or https://.
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="llm-model" className="text-sm font-medium text-[var(--pi-ink)]">
                  Model
                </label>
                <input
                  id="llm-model"
                  value={llmModel}
                  onChange={(event) => {
                    setLlmModel(event.target.value);
                    resetMessages();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                />
              </div>
              <div>
                <label
                  htmlFor="llm-retrieval-model"
                  className="text-sm font-medium text-[var(--pi-ink)]"
                >
                  Retrieval model
                </label>
                <input
                  id="llm-retrieval-model"
                  value={llmRetrievalModel}
                  onChange={(event) => {
                    setLlmRetrievalModel(event.target.value);
                    resetMessages();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Indexing
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              Worker concurrency
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Controls how many document index jobs the single index-worker container may run at the same time. Lower values stop new dispatches; active jobs finish naturally.
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <label
              htmlFor="index-worker-concurrency"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              Concurrent jobs
            </label>
            <input
              id="index-worker-concurrency"
              type="number"
              min={1}
              max={16}
              step={1}
              value={indexWorkerConcurrency}
              onChange={(event) => {
                setIndexWorkerConcurrency(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
            <p className="mt-2 text-xs text-[var(--pi-muted)]">Allowed range: 1-16</p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Retrieval
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              Candidate document limit
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Controls how many ready documents may be selected for a single retrieval query before evidence is loaded and the final answer is generated.
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <label
              htmlFor="retrieval-document-limit"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              Retrieval documents
            </label>
            <input
              id="retrieval-document-limit"
              type="number"
              min={1}
              max={50}
              step={1}
              value={retrievalDocumentLimit}
              onChange={(event) => {
                setRetrievalDocumentLimit(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
            <p className="mt-2 text-xs text-[var(--pi-muted)]">Allowed range: 1-50</p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? "Saving..." : "Save settings"}
        </button>
        {statusMessage ? (
          <p className="text-sm text-[var(--pi-brand)]">{statusMessage}</p>
        ) : null}
        {errorMessage ? (
          <p className="text-sm text-[var(--pi-danger)]">{errorMessage}</p>
        ) : null}
      </div>
    </form>
  );
}

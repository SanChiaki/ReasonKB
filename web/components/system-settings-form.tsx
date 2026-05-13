"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SAVE_ERROR_MESSAGE = "Unable to save system settings. Please try again.";

export function SystemSettingsForm({
  initialIndexWorkerConcurrency,
}: {
  initialIndexWorkerConcurrency: number;
}) {
  const router = useRouter();
  const [indexWorkerConcurrency, setIndexWorkerConcurrency] = useState(
    String(initialIndexWorkerConcurrency),
  );
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const parsedConcurrency = Number.parseInt(indexWorkerConcurrency, 10);
  const isValidConcurrency =
    Number.isInteger(parsedConcurrency) &&
    parsedConcurrency >= 1 &&
    parsedConcurrency <= 16;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValidConcurrency || submitting) {
      return;
    }

    setSubmitting(true);
    setStatusMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indexWorkerConcurrency: parsedConcurrency }),
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
      <section className="rounded-[1.5rem] border border-[var(--pi-border)] bg-white/80 p-5 shadow-[0_18px_50px_rgba(65,88,130,0.1)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--pi-brand)]">
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
                setStatusMessage("");
                setErrorMessage("");
              }}
              className="mt-2 w-full rounded-2xl border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-border-strong)] focus:ring-4 focus:ring-[var(--pi-brand-soft)]"
            />
            <p className="mt-2 text-xs text-[var(--pi-muted)]">Allowed range: 1-16</p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!isValidConcurrency || submitting}
          className="rounded-2xl border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(37,99,235,0.22)] transition enabled:hover:-translate-y-0.5 enabled:hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
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

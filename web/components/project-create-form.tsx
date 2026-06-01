"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

export function ProjectCreateForm() {
  const router = useRouter();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const trimmedName = name.trim();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedName || submitting) {
      return;
    }

    setSubmitting(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setErrorMessage(payload?.error ?? t("projects.createError"));
        return;
      }

      setName("");
      router.refresh();
    } catch {
      setErrorMessage(t("projects.createError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (errorMessage) {
              setErrorMessage("");
            }
          }}
          placeholder={t("projects.createPlaceholder")}
          maxLength={120}
          className="w-full min-w-[15rem] rounded-lg border border-[var(--pi-border)] bg-white px-4 py-2.5 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
        />
        <button
          type="submit"
          disabled={!trimmedName || submitting}
          className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? t("projects.creating") : t("projects.create")}
        </button>
      </div>
      {errorMessage ? (
        <p className="text-sm text-[var(--pi-danger,#fca5a5)]">{errorMessage}</p>
      ) : null}
    </form>
  );
}

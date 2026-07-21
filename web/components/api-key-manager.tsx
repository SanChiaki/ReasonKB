"use client";

import { Ban, Check, Copy, KeyRound, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { readAdminCsrfToken } from "@/components/admin-shell";
import { useI18n } from "@/lib/i18n";

const scopeOptions = [
  "read:projects",
  "read:documents",
  "query",
  "evidence",
] as const;

type AgentScope = (typeof scopeOptions)[number];

export type ApiKeyListItem = {
  id: string;
  ownerUserId: string;
  name: string;
  prefix: string;
  scopes: AgentScope[];
  projectIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type ApiKeyProjectOption = {
  id: string;
  name: string;
};

type CreateApiKeyPayload = {
  apiKey?: ApiKeyListItem & { apiKey: string };
  error?: string;
};

function formatDate(value: string | null, locale: "zh" | "en", never: string) {
  if (!value) return never;
  return new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    hour12: false,
  });
}

export function ApiKeyManager({
  initialApiKeys,
  projects,
}: {
  initialApiKeys: ApiKeyListItem[];
  projects: ApiKeyProjectOption[];
}) {
  const { locale, t } = useI18n();
  const [apiKeys, setApiKeys] = useState(initialApiKeys);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AgentScope[]>([...scopeOptions]);
  const [projectMode, setProjectMode] = useState<"all" | "selected">("all");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [createdSecret, setCreatedSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [error, setError] = useState("");

  const canCreate =
    name.trim().length > 0 &&
    scopes.length > 0 &&
    (projectMode === "all" || projectIds.length > 0) &&
    !submitting;

  function toggleScope(scope: AgentScope) {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }

  function toggleProject(projectId: string) {
    setProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((item) => item !== projectId)
        : [...current, projectId],
    );
  }

  async function refreshKeys() {
    const response = await fetch("/api/admin/api-keys");
    const payload = (await response.json().catch(() => null)) as
      | { apiKeys?: ApiKeyListItem[]; error?: string }
      | null;
    if (!response.ok || !payload?.apiKeys) {
      throw new Error(payload?.error || t("apiKeys.loadError"));
    }
    setApiKeys(payload.apiKeys);
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-reasonkb-csrf": readAdminCsrfToken(),
        },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          projectIds: projectMode === "all" ? [] : projectIds,
        }),
      });
      const payload = (await response.json().catch(() => null)) as CreateApiKeyPayload | null;
      if (!response.ok || !payload?.apiKey) {
        setError(payload?.error || t("apiKeys.createError"));
        return;
      }
      const { apiKey, ...record } = payload.apiKey;
      setApiKeys((current) => [record, ...current]);
      setCreatedSecret(apiKey);
      setCopied(false);
      setName("");
      setScopes([...scopeOptions]);
      setProjectMode("all");
      setProjectIds([]);
    } catch {
      setError(t("apiKeys.createError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeKey(key: ApiKeyListItem) {
    if (!window.confirm(t("apiKeys.revokeConfirm", { name: key.name }))) return;
    setRevokingId(key.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/api-keys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
        headers: { "x-reasonkb-csrf": readAdminCsrfToken() },
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        setError(payload?.error || t("apiKeys.revokeError"));
        return;
      }
      await refreshKeys();
    } catch {
      setError(t("apiKeys.revokeError"));
    } finally {
      setRevokingId("");
    }
  }

  async function copySecret() {
    await navigator.clipboard.writeText(createdSecret);
    setCopied(true);
  }

  return (
    <section className="border-y border-[var(--pi-border)] bg-white py-5">
      <div className="px-5">
        <p className="text-[11px] font-semibold uppercase text-[var(--pi-brand)]">
          {t("apiKeys.eyebrow")}
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-[var(--pi-ink)]">
              {t("apiKeys.title")}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--pi-muted)]">
              {t("apiKeys.description")}
            </p>
          </div>
          <KeyRound aria-hidden="true" className="h-5 w-5 text-[var(--pi-brand)]" />
        </div>
      </div>

      <form onSubmit={createKey} className="mt-5 grid gap-5 border-t border-[var(--pi-border)] px-5 pt-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <div className="space-y-4">
          <div>
            <label htmlFor="api-key-name" className="text-sm font-medium text-[var(--pi-ink)]">
              {t("apiKeys.name")}
            </label>
            <input
              id="api-key-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("apiKeys.namePlaceholder")}
              className="mt-2 w-full rounded-md border border-[var(--pi-border)] px-3 py-2.5 text-sm outline-none focus:border-[var(--pi-brand)]"
            />
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-[var(--pi-ink)]">
              {t("apiKeys.scopes")}
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {scopeOptions.map((scope) => (
                <label key={scope} className="flex items-center gap-2 border-b border-[var(--pi-border)] py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-[var(--pi-ink)]">
            {t("apiKeys.projects")}
          </legend>
          <div className="mt-2 inline-flex rounded-md border border-[var(--pi-border)] p-1">
            {(["all", "selected"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={projectMode === mode}
                onClick={() => setProjectMode(mode)}
                className={`px-3 py-1.5 text-sm ${
                  projectMode === mode
                    ? "rounded bg-[var(--pi-brand)] text-white"
                    : "text-[var(--pi-muted)]"
                }`}
              >
                {t(mode === "all" ? "apiKeys.allProjects" : "apiKeys.selectedProjects")}
              </button>
            ))}
          </div>
          {projectMode === "selected" ? (
            <div className="rk-scrollbar mt-3 max-h-44 overflow-y-auto border-y border-[var(--pi-border)]">
              {projects.length > 0 ? (
                projects.map((project) => (
                  <label key={project.id} className="flex items-center gap-2 border-b border-[var(--pi-border)] px-1 py-2 text-sm last:border-b-0">
                    <input
                      type="checkbox"
                      checked={projectIds.includes(project.id)}
                      onChange={() => toggleProject(project.id)}
                    />
                    <span className="min-w-0 truncate">{project.name}</span>
                  </label>
                ))
              ) : (
                <p className="py-4 text-sm text-[var(--pi-muted)]">{t("apiKeys.noProjects")}</p>
              )}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={!canCreate}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus aria-hidden="true" size={16} />
            {submitting ? t("apiKeys.creating") : t("apiKeys.create")}
          </button>
        </fieldset>
      </form>

      {error ? <p role="alert" className="mx-5 mt-4 text-sm text-[var(--pi-danger)]">{error}</p> : null}

      <div className="mt-6 overflow-x-auto border-t border-[var(--pi-border)]">
        <table className="w-full min-w-[880px] text-left text-xs">
          <thead className="border-b border-[var(--pi-border)] text-[var(--pi-muted)]">
            <tr>
              <th className="px-5 py-3 font-medium">{t("apiKeys.name")}</th>
              <th className="px-3 py-3 font-medium">{t("apiKeys.scopes")}</th>
              <th className="px-3 py-3 font-medium">{t("apiKeys.projects")}</th>
              <th className="px-3 py-3 font-medium">{t("apiKeys.created")}</th>
              <th className="px-3 py-3 font-medium">{t("apiKeys.lastUsed")}</th>
              <th className="px-3 py-3 font-medium">{t("apiKeys.status")}</th>
              <th className="px-5 py-3 text-right font-medium">{t("apiKeys.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--pi-border)]">
            {apiKeys.length > 0 ? (
              apiKeys.map((key) => (
                <tr key={key.id}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-[var(--pi-ink)]">{key.name}</div>
                    <div className="mt-1 font-mono text-[11px] text-[var(--pi-muted)]">
                      rkb_live_{key.prefix}_...
                    </div>
                  </td>
                  <td className="max-w-[220px] px-3 py-3 font-mono text-[11px]">
                    {key.scopes.join(", ")}
                  </td>
                  <td className="max-w-[180px] px-3 py-3">
                    {key.projectIds.length === 0
                      ? t("apiKeys.allProjects")
                      : t("apiKeys.projectCount", { count: key.projectIds.length })}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    {formatDate(key.createdAt, locale, t("apiKeys.never"))}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    {formatDate(key.lastUsedAt, locale, t("apiKeys.never"))}
                  </td>
                  <td className="px-3 py-3 font-medium">
                    {key.revokedAt ? t("apiKeys.revoked") : t("apiKeys.active")}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      title={t("apiKeys.revoke")}
                      aria-label={`${t("apiKeys.revoke")}: ${key.name}`}
                      disabled={Boolean(key.revokedAt) || revokingId === key.id}
                      onClick={() => revokeKey(key)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--pi-danger)] hover:bg-[var(--pi-bg)] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <Ban aria-hidden="true" size={16} />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-sm text-[var(--pi-muted)]">
                  {t("apiKeys.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {createdSecret ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="created-api-key-title">
          <div className="w-full max-w-2xl rounded-lg border border-[var(--pi-border)] bg-white p-5 shadow-xl">
            <h3 id="created-api-key-title" className="text-lg font-semibold">
              {t("apiKeys.secretTitle")}
            </h3>
            <p className="mt-2 text-sm text-[var(--pi-muted)]">{t("apiKeys.secretOnce")}</p>
            <code className="mt-4 block break-all border-y border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-3 text-xs">
              {createdSecret}
            </code>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={copySecret}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--pi-border)] px-3 py-2 text-sm"
              >
                {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
                {copied ? t("apiKeys.copied") : t("apiKeys.copy")}
              </button>
              <button
                type="button"
                onClick={() => setCreatedSecret("")}
                className="rounded-md bg-[var(--pi-brand)] px-3 py-2 text-sm font-medium text-white"
              >
                {t("apiKeys.close")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

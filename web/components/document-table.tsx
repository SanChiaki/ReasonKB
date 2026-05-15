"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DocumentTableRow = {
  id: string;
  fileName: string;
  pageCount: number;
  status: string;
  errorMessage?: string | null;
  importError?: string | null;
  createdAt: string;
  sourceRelativePath?: string | null;
  projectRelativePath?: string | null;
  lastIndexDurationMs?: number | null;
  lastIndexTotalTokens?: number | null;
  lastIndexLlmCallCount?: number | null;
  lastIndexedAt?: string | null;
};

function formatUploadedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return "Unknown";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatDuration(value?: number | null) {
  if (typeof value !== "number") return "Pending";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatTokens(value?: number | null) {
  if (typeof value !== "number") return "0 tokens";
  if (value < 1000) return `${value} tokens`;
  return `${(value / 1000).toFixed(1)}K tokens`;
}

function formatCalls(value?: number | null) {
  if (typeof value !== "number") return "0 calls";
  return `${value} ${value === 1 ? "call" : "calls"}`;
}

export function DocumentTable({
  documents,
  searchQuery,
  onReindexQueued,
}: {
  documents: DocumentTableRow[];
  searchQuery?: string;
  onReindexQueued?: () => void;
}) {
  const router = useRouter();
  const trimmedSearchQuery = searchQuery?.trim() ?? "";
  const [pendingReindexId, setPendingReindexId] = useState<string | null>(null);
  const [reindexError, setReindexError] = useState<string | null>(null);

  async function handleReindex(document: DocumentTableRow) {
    setPendingReindexId(document.id);
    setReindexError(null);
    try {
      const response = await fetch(`/api/documents/${document.id}/reindex`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Failed to queue document reindex.");
      }
      onReindexQueued?.();
      router.refresh();
    } catch (error) {
      setReindexError(error instanceof Error ? error.message : "Failed to queue document reindex.");
    } finally {
      setPendingReindexId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--pi-border)] bg-[var(--pi-panel-strong)]">
      {reindexError ? (
        <div className="border-b border-[var(--pi-border)] bg-red-50 px-5 py-3 text-sm text-[var(--pi-danger)]">
          {reindexError}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-muted)]">
              <th className="px-5 py-4 font-medium">File Name</th>
              <th className="px-5 py-4 font-medium">Source Path</th>
              <th className="px-5 py-4 font-medium">Page Count</th>
              <th className="px-5 py-4 font-medium">Indexing Status</th>
              <th className="px-5 py-4 font-medium">Parse Metrics</th>
              <th className="px-5 py-4 font-medium">Upload Time</th>
              <th className="px-5 py-4 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-10 text-center text-sm text-[var(--pi-muted)]"
                >
                  {trimmedSearchQuery
                    ? `No matching documents for "${trimmedSearchQuery}" in this project.`
                    : "No documents found in this project."}
                </td>
              </tr>
            ) : (
              documents.map((document) => (
                <tr key={document.id} className="border-b border-[var(--pi-border)]/70 last:border-0">
                  <td className="px-5 py-4 font-medium text-[var(--pi-ink)]">
                    <div className="flex max-w-[24rem] flex-col gap-1">
                      <span>{document.fileName}</span>
                      {document.errorMessage || document.importError ? (
                        <span className="line-clamp-2 text-xs font-normal text-[var(--pi-danger,#b91c1c)]">
                          {document.errorMessage ?? document.importError}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="max-w-[22rem] px-5 py-4 text-xs text-[var(--pi-muted)]">
                    <span className="block truncate" title={document.sourceRelativePath ?? document.projectRelativePath ?? ""}>
                      {document.projectRelativePath ?? document.sourceRelativePath ?? "-"}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[var(--pi-ink)]/90">{document.pageCount}</td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center rounded-md border border-[var(--pi-border)] bg-white px-3 py-1 text-xs font-medium uppercase tracking-[0.08em] text-[var(--pi-ink)]">
                      {formatStatus(document.status)}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-xs text-[var(--pi-muted)]">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-[var(--pi-ink)]/90">
                        {formatDuration(document.lastIndexDurationMs)}
                      </span>
                      <span>
                        {formatTokens(document.lastIndexTotalTokens)}
                      </span>
                      <span>
                        {formatCalls(document.lastIndexLlmCallCount)}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-[var(--pi-muted)]">
                    {formatUploadedAt(document.createdAt)}
                  </td>
                  <td className="px-5 py-4">
                    <button
                      type="button"
                      onClick={() => void handleReindex(document)}
                      disabled={pendingReindexId === document.id}
                      aria-label={`Reindex ${document.fileName}`}
                      className="inline-flex min-w-24 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white px-3 py-2 text-xs font-medium text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pendingReindexId === document.id ? "Queueing" : "Reindex"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

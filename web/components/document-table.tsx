"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FolderTree, RefreshCcw, X } from "lucide-react";

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
  hasIndexTree?: boolean;
  indexNodeCount?: number;
};

type DocumentIndexTreeNode = {
  id: string;
  title: string;
  summary: string | null;
  pageRange: string | null;
  depth: number;
  children: DocumentIndexTreeNode[];
};

type DocumentIndexTree = {
  documentId: string;
  indexedAt: string;
  stats: {
    nodeCount: number;
    leafCount: number;
    maxDepth: number;
  };
  roots: DocumentIndexTreeNode[];
};

type TreeState =
  | { status: "idle" }
  | { status: "loading"; document: DocumentTableRow }
  | { status: "loaded"; document: DocumentTableRow; tree: DocumentIndexTree }
  | { status: "error"; document: DocumentTableRow; message: string };

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

function pluralize(value: number, singular: string) {
  if (singular === "leaf") {
    return `${value} ${value === 1 ? "leaf" : "leaves"}`;
  }
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
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
  const [treeState, setTreeState] = useState<TreeState>({ status: "idle" });

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

  async function handleOpenIndexTree(document: DocumentTableRow) {
    if (!document.hasIndexTree) return;
    setTreeState({ status: "loading", document });
    try {
      const response = await fetch(`/api/documents/${document.id}/structure`);
      if (!response.ok) {
        throw new Error("Failed to load document index tree.");
      }
      const tree = (await response.json()) as DocumentIndexTree;
      setTreeState({ status: "loaded", document, tree });
    } catch (error) {
      setTreeState({
        status: "error",
        document,
        message: error instanceof Error ? error.message : "Failed to load document index tree.",
      });
    }
  }

  function closeTree() {
    setTreeState({ status: "idle" });
  }

  return (
    <>
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
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOpenIndexTree(document)}
                          disabled={!document.hasIndexTree}
                          aria-label={
                            document.hasIndexTree
                              ? `View index tree for ${document.fileName}`
                              : `Index tree unavailable for ${document.fileName}`
                          }
                          title={
                            document.hasIndexTree
                              ? typeof document.indexNodeCount === "number"
                                ? `View ${document.indexNodeCount} PageIndex nodes`
                                : "View PageIndex tree"
                              : "Index tree is available after indexing completes"
                          }
                          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <FolderTree className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReindex(document)}
                          disabled={pendingReindexId === document.id}
                          aria-label={`Reindex ${document.fileName}`}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <RefreshCcw className={`h-4 w-4 ${pendingReindexId === document.id ? "animate-spin" : ""}`} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <IndexTreeDialog state={treeState} onClose={closeTree} />
    </>
  );
}

function IndexTreeDialog({
  state,
  onClose,
}: {
  state: TreeState;
  onClose: () => void;
}) {
  if (state.status === "idle") return null;

  const title = `PageIndex tree for ${state.document.fileName}`;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(24,31,44,0.42)] p-3 sm:items-center sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--pi-border)] bg-[var(--pi-panel)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--pi-border)] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
              PageIndex Tree
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-[var(--pi-ink)]">
              {state.document.fileName}
            </h2>
            {state.status === "loaded" ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--pi-muted)]">
                <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2.5 py-1">
                  {pluralize(state.tree.stats.nodeCount, "node")}
                </span>
                <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2.5 py-1">
                  {pluralize(state.tree.stats.leafCount, "leaf")}
                </span>
                <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2.5 py-1">
                  Depth {state.tree.stats.maxDepth}
                </span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close PageIndex tree"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="rk-scrollbar min-h-0 flex-1 overflow-auto px-5 py-4">
          {state.status === "loading" ? (
            <div className="py-12 text-center text-sm text-[var(--pi-muted)]">
              Loading PageIndex tree...
            </div>
          ) : null}
          {state.status === "error" ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-[var(--pi-danger)]">
              {state.message}
            </div>
          ) : null}
          {state.status === "loaded" ? (
            state.tree.roots.length > 0 ? (
              <div className="space-y-2">
                {state.tree.roots.map((node) => (
                  <TreeNode key={node.id} node={node} />
                ))}
              </div>
            ) : (
              <div className="py-12 text-center text-sm text-[var(--pi-muted)]">
                This document index has no tree nodes.
              </div>
            )
          ) : null}
        </div>
      </section>
    </div>
  );
}

function TreeNode({ node }: { node: DocumentIndexTreeNode }) {
  const hasChildren = node.children.length > 0;
  return (
    <details className="group rounded-md border border-[var(--pi-border)] bg-white" open={node.depth < 2}>
      <summary className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 marker:content-none">
        <span
          className="mt-0.5 flex h-5 w-5 items-center justify-center rounded border border-[var(--pi-border)] text-[var(--pi-muted)]"
          aria-hidden="true"
        >
          {hasChildren ? (
            <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--pi-muted)]" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium text-[var(--pi-ink)]">
            {node.title}
          </span>
          {node.summary ? (
            <span className="mt-1 line-clamp-2 block break-words text-xs leading-5 text-[var(--pi-muted)]">
              {node.summary}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--pi-muted)]">
          {node.pageRange ? (
            <span className="rounded-md bg-[var(--pi-bg)] px-2 py-1">p. {node.pageRange}</span>
          ) : null}
          <span className="rounded-md bg-[var(--pi-bg)] px-2 py-1">L{node.depth}</span>
        </span>
      </summary>
      {hasChildren ? (
        <div className="space-y-2 border-t border-[var(--pi-border)] bg-[var(--pi-bg-soft)] px-3 py-3 pl-6">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

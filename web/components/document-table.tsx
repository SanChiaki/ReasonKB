"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileText, FolderTree, RefreshCcw, X } from "lucide-react";
import { DISPLAY_TIME_ZONE } from "@/lib/date-time";
import { useI18n, type Locale, type TranslationKey } from "@/lib/i18n";
import { readAdminCsrfToken } from "@/components/admin-shell";

export type DocumentTableRow = {
  id: string;
  fileName: string;
  pageCount: number;
  status: string;
  lifecycleState?: string;
  retrievalEligible?: boolean;
  statusReason?: string | null;
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

function formatUploadedAt(value: string, locale: Locale, unknownLabel: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return unknownLabel;
  }
  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

function formatStatus(status: string, unknownLabel: string) {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return unknownLabel;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatDuration(value: number | null | undefined, pendingLabel: string) {
  if (typeof value !== "number") return pendingLabel;
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatTokens(
  value: number | null | undefined,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
) {
  if (typeof value !== "number") return t("documents.tokens", { count: 0 });
  if (value < 1000) return t("documents.tokens", { count: value });
  return t("documents.tokenK", { count: (value / 1000).toFixed(1) });
}

function formatCalls(
  value: number | null | undefined,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
) {
  if (typeof value !== "number") {
    return t("documents.calls", { count: 0, unit: t("documents.callPlural") });
  }
  return t("documents.calls", {
    count: value,
    unit: value === 1 ? t("documents.callSingular") : t("documents.callPlural"),
  });
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
  const { locale, t } = useI18n();
  const trimmedSearchQuery = searchQuery?.trim() ?? "";
  const [pendingReindexId, setPendingReindexId] = useState<string | null>(null);
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [reindexNotice, setReindexNotice] = useState<string | null>(null);
  const [treeState, setTreeState] = useState<TreeState>({ status: "idle" });

  async function handleReindex(document: DocumentTableRow) {
    setPendingReindexId(document.id);
    setReindexError(null);
    setReindexNotice(null);
    try {
      const response = await fetch(`/api/documents/${document.id}/reindex`, {
        method: "POST",
        headers: { "x-reasonkb-csrf": readAdminCsrfToken() },
      });
      if (!response.ok) {
        throw new Error(t("documents.failedReindex"));
      }
      setReindexNotice(t("documents.reindexQueued", { name: document.fileName }));
      onReindexQueued?.();
      router.refresh();
    } catch (error) {
      setReindexError(error instanceof Error ? error.message : t("documents.failedReindex"));
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
        throw new Error(t("documents.failedTree"));
      }
      const tree = (await response.json()) as DocumentIndexTree;
      setTreeState({ status: "loaded", document, tree });
    } catch (error) {
      setTreeState({
        status: "error",
        document,
        message: error instanceof Error ? error.message : t("documents.failedTree"),
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
        {reindexNotice ? (
          <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm text-emerald-800" role="status">
            {reindexNotice}
          </div>
        ) : null}
        {documents.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--pi-muted)]">
            {trimmedSearchQuery
              ? t("documents.noMatches", { query: trimmedSearchQuery })
              : t("documents.empty")}
          </div>
        ) : (
          <div className="divide-y divide-[var(--pi-border)]">
            <div className="hidden grid-cols-[minmax(0,2fr)_5rem_7rem_8rem] gap-4 bg-[var(--pi-bg)] px-5 py-3 text-xs font-medium text-[var(--pi-muted)] md:grid">
              <span>{t("documents.fileName")}</span>
              <span>{t("documents.pageCount")}</span>
              <span>{t("documents.indexingStatus")}</span>
              <span>{t("documents.actions")}</span>
            </div>
            {documents.map((document) => {
              const excluded = document.lifecycleState === "excluded";
              const reason = document.statusReason ?? document.errorMessage ?? document.importError;
              const treeLabel = !excluded && document.hasIndexTree
                ? t("documents.viewTreeFor", { name: document.fileName })
                : t("documents.treeUnavailableFor", { name: document.fileName });
              return (
                <div key={document.id} className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,2fr)_5rem_7rem_8rem] md:items-center md:gap-4 md:px-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-brand)]">
                      <FileText aria-hidden="true" size={15} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--pi-ink)]">{document.fileName}</p>
                      <p className="mt-1 truncate text-xs text-[var(--pi-muted)]" title={document.sourceRelativePath ?? document.projectRelativePath ?? ""}>
                        {document.projectRelativePath ?? document.sourceRelativePath ?? "-"}
                      </p>
                      {reason ? <p className={`mt-1 line-clamp-2 text-xs ${excluded ? "text-[var(--pi-muted)]" : "text-[var(--pi-danger)]"}`}>{reason}</p> : null}
                      <p className="mt-1 text-xs text-[var(--pi-muted)] md:hidden">
                        {formatUploadedAt(document.createdAt, locale, t("common.unknown"))}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-[var(--pi-muted)]"><span className="md:hidden">{t("documents.pageCount")}: </span>{document.pageCount}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex w-fit items-center rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2 py-1 text-[11px] font-medium text-[var(--pi-ink)]">
                      {excluded ? t("documents.excluded") : formatStatus(document.status, t("documents.statusUnknown"))}
                    </span>
                    <span className="text-xs text-[var(--pi-muted)] md:hidden">
                      <span>{formatDuration(document.lastIndexDurationMs, t("documents.pending"))}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{formatTokens(document.lastIndexTotalTokens, t)}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{formatCalls(document.lastIndexLlmCallCount, t)}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    <button
                      type="button"
                      onClick={() => void handleOpenIndexTree(document)}
                      disabled={excluded || !document.hasIndexTree}
                      aria-label={treeLabel}
                      title={excluded ? t("documents.excludedAction") : document.hasIndexTree ? (typeof document.indexNodeCount === "number" ? t("documents.viewNodeCount", { count: document.indexNodeCount }) : t("documents.viewTree")) : t("documents.treeAfterIndex")}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <FolderTree className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleReindex(document)}
                      disabled={excluded || pendingReindexId === document.id}
                      aria-label={t("documents.reindex", { name: document.fileName })}
                      title={excluded ? t("documents.excludedAction") : undefined}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <RefreshCcw className={`h-4 w-4 ${pendingReindexId === document.id ? "animate-spin" : ""}`} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
  const { t } = useI18n();

  if (state.status === "idle") return null;

  const title = t("documents.pageIndexTreeFor", { name: state.document.fileName });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(24,31,44,0.42)] p-3 md:justify-end md:p-0">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--pi-border)] bg-[var(--pi-panel)] shadow-2xl md:h-full md:max-h-none md:max-w-[min(42rem,calc(100vw-var(--pi-sidebar-width)))] md:rounded-none md:rounded-l-lg"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--pi-border)] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
              {t("documents.pageIndexTree")}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-[var(--pi-ink)]">
              {state.document.fileName}
            </h2>
            {state.status === "loaded" ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--pi-muted)]">
                <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2.5 py-1">
                  {t("documents.nodeCount", {
                    count: state.tree.stats.nodeCount,
                    plural: state.tree.stats.nodeCount === 1 ? "" : "s",
                  })}
                </span>
                <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2.5 py-1">
                  {t("documents.leafCount", {
                    count: state.tree.stats.leafCount,
                    leaf: state.tree.stats.leafCount === 1 ? "leaf" : "leaves",
                  })}
                </span>
                <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-2.5 py-1">
                  {t("documents.depth", { depth: state.tree.stats.maxDepth })}
                </span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t("documents.closePageIndexTree")}
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)] transition hover:border-[var(--pi-brand)] hover:text-[var(--pi-brand)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="rk-scrollbar min-h-0 flex-1 overflow-auto px-5 py-4">
          {state.status === "loading" ? (
            <div className="py-12 text-center text-sm text-[var(--pi-muted)]">
              {t("documents.loadingTree")}
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
                {t("documents.noTreeNodes")}
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

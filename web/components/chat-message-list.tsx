"use client";

import React from "react";
import { CitationList, type CitationItem } from "@/components/citation-list";
import { useI18n } from "@/lib/i18n";
import type { RetrievalEvidence } from "@/lib/retrieval-client";

export type RetrievalProgressDocument = {
  documentId?: string;
  documentName?: string;
  projectName?: string;
  sourceRelativePath?: string | null;
};

export type ChatProgressLine = {
  id: string;
  label?: string;
  stage?: string;
  data?: Record<string, unknown>;
};

export type ChatProgressState = {
  lines: ChatProgressLine[];
  documents: RetrievalProgressDocument[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: CitationItem[];
  evidence?: RetrievalEvidence[];
  progress?: ChatProgressState;
  progressExpanded?: boolean;
};

function EvidenceList({ evidence }: { evidence: RetrievalEvidence[] }) {
  const { t } = useI18n();

  if (evidence.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-3">
      {evidence.map((item, index) => {
        const path =
          item.projectRelativePath ?? item.sourceRelativePath ?? item.documentName ?? t("chat.evidence");
        return (
          <section
            key={`${item.documentName}-${item.pages}-${index}`}
            className="rounded-lg border border-[var(--pi-border)] bg-white p-4"
          >
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--pi-muted)]">
                  {t("chat.evidence")} · {item.evidenceKind}
                </p>
                <h3 className="mt-1 text-sm font-semibold text-[var(--pi-ink)]">{path}</h3>
                <p className="mt-1 text-xs text-[var(--pi-muted)]">
                  {item.projectName} / {item.documentName} / {t("chat.pages")} {item.pages}
                </p>
              </div>
              {item.sourceRelativePath ? (
                <span className="rounded-md bg-[var(--pi-bg)] px-3 py-1 text-[11px] font-medium text-[var(--pi-muted)]">
                  {item.sourceRelativePath}
                </span>
              ) : null}
            </div>
            {item.excerpt ? (
              <p className="mt-3 rounded-md bg-[var(--pi-brand-soft)] px-3 py-2 text-sm leading-6 text-[var(--pi-ink)]">
                {item.excerpt}
              </p>
            ) : null}
            <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-[var(--pi-ink)]">
              {item.content}
            </p>
          </section>
        );
      })}
    </div>
  );
}

function documentLabel(
  document: RetrievalProgressDocument | undefined,
  fallback: string,
) {
  if (!document) {
    return fallback;
  }
  return document.sourceRelativePath ?? document.documentName ?? fallback;
}

function progressLineLabel(
  line: ChatProgressLine,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (!line.stage) {
    return line.label ?? "";
  }

  const data = line.data ?? {};
  const document = data.document as RetrievalProgressDocument | undefined;
  switch (line.stage) {
    case "retrieval_started":
      return t("chat.progressRetrievalStarted");
    case "documents_loaded":
      return t("chat.progressDocumentsLoaded", {
        count: Number(data.documentCount ?? 0),
      });
    case "document_selection_started":
      return t("chat.progressSelectionStarted");
    case "documents_selected": {
      const count = Number(data.documentCount ?? 0);
      return t("chat.progressDocumentsSelected", {
        count,
        plural: count === 1 ? "" : "s",
      });
    }
    case "evidence_started":
      return t("chat.progressEvidenceStarted");
    case "document_evidence_started":
      return t("chat.progressDocumentEvidenceStarted", {
        document: documentLabel(document, t("common.unknown")),
      });
    case "document_pages_selected":
      return t("chat.progressDocumentPagesSelected", {
        document: documentLabel(document, t("common.unknown")),
        pages: String(data.pages ?? ""),
      });
    case "document_evidence_loaded":
      return t("chat.progressDocumentEvidenceLoaded", {
        document: documentLabel(document, t("common.unknown")),
      });
    case "document_evidence_skipped":
      return t("chat.progressDocumentEvidenceSkipped", {
        document: documentLabel(document, t("common.unknown")),
      });
    case "answer_generation_started":
      return t("chat.progressAnswerStarted");
    case "answer_generation_completed":
      return t("chat.progressAnswerCompleted");
    case "retrieval_completed":
      return t("chat.progressCompleted");
    case "retrieval_failed":
      return t("chat.progressFailed");
    default:
      return line.label ?? line.stage;
  }
}

function RetrievalProgressMessage({
  progress,
  defaultOpen,
}: {
  progress: ChatProgressState;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();

  if (progress.lines.length === 0 && progress.documents.length === 0) {
    return null;
  }

  return (
    <details
      data-testid="chat-message-progress"
      open={defaultOpen}
      className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-2 text-sm"
    >
      <summary className="cursor-pointer select-none text-xs font-medium text-[var(--pi-muted)]">
        {t("chat.progressTitle")}
      </summary>
      <ol className="mt-2 space-y-1.5">
        {progress.lines.map((line, index) => (
          <li
            key={line.id}
            className={
              index === progress.lines.length - 1
                ? "text-sm font-medium text-[var(--pi-ink)]"
                : "text-xs text-[var(--pi-muted)]"
            }
          >
            {progressLineLabel(line, t)}
          </li>
        ))}
      </ol>
      {progress.documents.length > 0 ? (
        <div className="border-t border-[var(--pi-border)] pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase text-[var(--pi-muted)]">
            {t("chat.progressSelectedDocuments")}
          </p>
          <div className="flex flex-wrap gap-2">
            {progress.documents.map((document, index) => (
              <span
                key={`${document.documentId ?? document.documentName ?? "document"}-${index}`}
                className="rounded-md bg-[var(--pi-bg)] px-2.5 py-1 text-xs text-[var(--pi-ink)]"
              >
                {documentLabel(document, t("common.unknown"))}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </details>
  );
}

export function ChatMessageList({
  messages,
}: {
  messages: ChatMessage[];
}) {
  const { t } = useI18n();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-1 pb-6 md:px-4">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <article
              key={message.id}
              data-testid={`chat-message-${message.id}`}
              className="flex w-full justify-end text-[var(--pi-ink)]"
            >
              <div
                data-testid={`chat-message-bubble-${message.id}`}
                className="max-w-[min(42rem,85%)] rounded-lg bg-[var(--pi-brand)] px-4 py-3 text-white"
              >
                <p className="whitespace-pre-wrap text-sm leading-7 md:text-[15px]">
                  {message.content}
                </p>
              </div>
            </article>
          );
        }

        return (
          <article
            key={message.id}
            data-testid={`chat-message-${message.id}`}
            className="flex w-full justify-start text-[var(--pi-ink)]"
          >
            <div
              data-testid={`chat-message-bubble-${message.id}`}
              className="max-w-3xl space-y-4 rounded-lg border border-[var(--pi-border)] bg-white px-5 py-4"
            >
              {message.progress ? (
                <RetrievalProgressMessage
                  progress={message.progress}
                  defaultOpen={message.progressExpanded}
                />
              ) : null}
              <CitationList citations={message.citations} />
              <EvidenceList evidence={message.evidence ?? []} />
              {message.content ? (
                <p
                  data-testid={`chat-message-answer-${message.id}`}
                  className="whitespace-pre-wrap text-sm leading-7 md:text-[15px]"
                >
                  {message.content}
                </p>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

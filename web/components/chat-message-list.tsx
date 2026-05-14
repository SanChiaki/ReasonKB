import React from "react";
import { CitationList, type CitationItem } from "@/components/citation-list";
import type { RetrievalEvidence } from "@/lib/retrieval-client";

function EvidenceList({ evidence }: { evidence: RetrievalEvidence[] }) {
  if (evidence.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-3">
      {evidence.map((item, index) => {
        const path =
          item.projectRelativePath ?? item.sourceRelativePath ?? item.documentName ?? "Evidence";
        return (
          <section
            key={`${item.documentName}-${item.pages}-${index}`}
            className="rounded-lg border border-[var(--pi-border)] bg-white p-4"
          >
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--pi-muted)]">
                  Evidence · {item.evidenceKind}
                </p>
                <h3 className="mt-1 text-sm font-semibold text-[var(--pi-ink)]">{path}</h3>
                <p className="mt-1 text-xs text-[var(--pi-muted)]">
                  {item.projectName} / {item.documentName} / pages {item.pages}
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

export function ChatMessageList({
  messages,
}: {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    citations: CitationItem[];
    evidence?: RetrievalEvidence[];
  }>;
}) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-1 pb-6 md:px-4">
      {messages.map((message) => (
        <article
          key={message.id}
          className={
            message.role === "user"
              ? "ml-auto w-full max-w-3xl text-[var(--pi-ink)]"
              : "w-full max-w-3xl text-[var(--pi-ink)]"
          }
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--pi-muted)]">
            {message.role === "user" ? "You" : "Assistant"}
          </p>
          <div
            className={
              message.role === "assistant"
                ? "rounded-lg border border-[var(--pi-border)] bg-white px-5 py-4"
                : ""
            }
          >
            <p className="whitespace-pre-wrap text-sm leading-7 md:text-[15px]">
            {message.content}
            </p>
            {message.role === "assistant" ? (
              <>
                <CitationList citations={message.citations} />
                <EvidenceList evidence={message.evidence ?? []} />
              </>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

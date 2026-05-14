import React from "react";

export type CitationItem = {
  projectId?: string;
  projectName: string;
  documentId?: string;
  documentName: string;
  pages: string;
  focusPage?: number;
  excerpt?: string;
};

export function CitationList({ citations }: { citations: CitationItem[] }) {
  if (citations.length === 0) {
    return null;
  }

  return (
    <ul className="mt-4 space-y-2 text-xs text-[var(--pi-muted)]">
      {citations.map((citation, index) => (
        <li
          key={`${citation.projectName}-${citation.documentName}-${citation.pages}-${index}`}
          className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-2"
        >
          <p className="text-xs text-[var(--pi-muted)]">
            [{citation.projectName}] {citation.documentName} - pages {citation.pages}
            {citation.focusPage ? ` · focus page ${citation.focusPage}` : ""}
          </p>
          {citation.excerpt ? (
            <p className="mt-1 text-sm leading-6 text-[var(--pi-ink)]">{citation.excerpt}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

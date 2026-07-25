"use client";

import React from "react";
import { ExternalLink } from "lucide-react";
import { normalizeDocumentUrl } from "@/lib/document-url";
import { useI18n } from "@/lib/i18n";

export type CitationItem = {
  projectId?: string;
  projectName: string;
  documentId?: string;
  documentName: string;
  documentUrl?: string | null;
  sourceDisplayName?: string | null;
  sourceKind?: string | null;
  pages: string;
  focusPage?: number;
  excerpt?: string;
};

export function CitationList({ citations }: { citations: CitationItem[] }) {
  const { t } = useI18n();

  if (citations.length === 0) {
    return null;
  }

  return (
    <ul className="mt-4 space-y-2 text-xs text-[var(--pi-muted)]">
      {citations.map((citation, index) => {
        const documentUrl = normalizeDocumentUrl(citation.documentUrl);
        return (
          <li
            key={`${citation.projectName}-${citation.documentName}-${citation.pages}-${index}`}
            className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-2"
          >
            <p className="text-xs text-[var(--pi-muted)]">
              [{citation.sourceDisplayName ? `${citation.sourceDisplayName} / ` : ""}{citation.projectName}] {" "}
              {documentUrl ? (
                <a
                  href={documentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[var(--pi-brand)] hover:underline"
                  title={citation.documentName}
                >
                  {citation.documentName}
                  <ExternalLink className="ml-1 inline-block h-3 w-3" aria-hidden="true" />
                </a>
              ) : (
                citation.documentName
              )}{" "}- {t("chat.pages")}{" "}
              {citation.pages}
              {citation.focusPage
                ? ` · ${t("chat.focusPage")} ${citation.focusPage}`
                : ""}
            </p>
            {citation.excerpt ? (
              <p className="mt-1 text-sm leading-6 text-[var(--pi-ink)]">{citation.excerpt}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

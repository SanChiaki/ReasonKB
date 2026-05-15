import React from "react";
import { AppShell } from "@/components/app-shell";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageList } from "@/components/chat-message-list";
import type { CitationItem } from "@/components/citation-list";
import { appConfig } from "@/lib/config";
import { getConversationDetail, listConversations } from "@/lib/repos/conversation-store";
import { listProjects } from "@/lib/repos/project-store";
import type { RetrievalEvidence } from "@/lib/retrieval-client";

const demoUserId = "user_demo";

function toCitation(value: unknown): CitationItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.evidenceKind === "string") {
    return null;
  }
  if (
    typeof candidate.projectName !== "string" ||
    typeof candidate.documentName !== "string" ||
    typeof candidate.pages !== "string"
  ) {
    return null;
  }

  return {
    projectId: typeof candidate.projectId === "string" ? candidate.projectId : undefined,
    projectName: candidate.projectName,
    documentId: typeof candidate.documentId === "string" ? candidate.documentId : undefined,
    documentName: candidate.documentName,
    pages: candidate.pages,
    focusPage:
      typeof candidate.focusPage === "number" && Number.isInteger(candidate.focusPage)
        ? candidate.focusPage
        : undefined,
    excerpt: typeof candidate.excerpt === "string" ? candidate.excerpt : undefined,
  };
}

function isCitationItem(citation: CitationItem | null): citation is CitationItem {
  return citation !== null;
}

function toEvidence(value: unknown): RetrievalEvidence | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.projectName !== "string" ||
    typeof candidate.documentName !== "string" ||
    typeof candidate.pages !== "string" ||
    typeof candidate.evidenceKind !== "string" ||
    typeof candidate.content !== "string"
  ) {
    return null;
  }

  return {
    projectId: typeof candidate.projectId === "string" ? candidate.projectId : undefined,
    projectName: candidate.projectName,
    documentId: typeof candidate.documentId === "string" ? candidate.documentId : undefined,
    documentName: candidate.documentName,
    sourceRelativePath:
      typeof candidate.sourceRelativePath === "string" ? candidate.sourceRelativePath : null,
    projectRelativePath:
      typeof candidate.projectRelativePath === "string" ? candidate.projectRelativePath : null,
    pages: candidate.pages,
    evidenceKind: candidate.evidenceKind,
    excerpt: typeof candidate.excerpt === "string" ? candidate.excerpt : null,
    content: candidate.content,
    visualAssets: Array.isArray(candidate.visualAssets)
      ? (candidate.visualAssets as Array<Record<string, unknown>>)
      : [],
  };
}

function isEvidenceItem(evidence: RetrievalEvidence | null): evidence is RetrievalEvidence {
  return evidence !== null;
}

function getScopeSummary(
  selectedProjectIds: string[],
  availableProjects: Array<{ id: string; name: string }>,
) {
  if (selectedProjectIds.length === 0) {
    return "All projects";
  }

  const projectNames = selectedProjectIds
    .map((projectId) => availableProjects.find((project) => project.id === projectId)?.name)
    .filter((name): name is string => Boolean(name));

  if (projectNames.length <= 1) {
    return projectNames[0] ?? "All projects";
  }

  return "Multiple projects";
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ conversationId?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawConversationId = Array.isArray(params.conversationId)
    ? params.conversationId[0]
    : params.conversationId;
  const conversationId = rawConversationId?.trim() ? rawConversationId.trim() : undefined;

  const conversations = listConversations(appConfig.dbPath, demoUserId);
  const availableProjects = listProjects(appConfig.dbPath, demoUserId).map((project) => ({
    id: project.id,
    name: project.name,
  }));
  const conversation = conversationId
    ? getConversationDetail(appConfig.dbPath, conversationId, demoUserId)
    : null;

  const availableProjectIdSet = new Set(availableProjects.map((project) => project.id));
  const selectedProjectIds = (conversation?.projectIds ?? []).filter((projectId) =>
    availableProjectIdSet.has(projectId),
  );
  const scopeSummary = getScopeSummary(selectedProjectIds, availableProjects);
  const messages = (conversation?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    citations: Array.isArray(message.citations)
      ? message.citations.map(toCitation).filter(isCitationItem)
      : [],
    evidence: Array.isArray(message.citations)
      ? message.citations.map(toEvidence).filter(isEvidenceItem)
      : [],
  }));

  return (
    <AppShell conversations={conversations}>
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--pi-bg)]">
        <header className="shrink-0 border-b border-[var(--pi-border)] bg-[var(--pi-panel)] px-5 py-4 md:px-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
            ReasonKB Chat
          </p>
          <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h1 className="text-2xl font-semibold text-[var(--pi-ink)]">
              {conversation?.title ?? "New Chat"}
            </h1>
            <div className="inline-flex items-center gap-2 self-start rounded-md border border-[var(--pi-border)] bg-white px-3 py-1.5 text-xs text-[var(--pi-muted)]">
              <span className="font-semibold uppercase tracking-[0.06em]">Scope</span>
              <span className="text-[var(--pi-ink)]">{scopeSummary}</span>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="rk-scrollbar relative min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-8 md:py-8">
            {messages.length > 0 ? (
              <div className="pb-4">
                <ChatMessageList messages={messages} />
              </div>
            ) : (
              <div className="flex h-full min-h-[240px] items-center justify-center px-4 md:min-h-[420px]">
                <div className="w-full max-w-2xl text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--pi-border)] bg-white text-xl text-[var(--pi-muted)] md:h-14 md:w-14 md:text-2xl">
                    ◌
                  </div>
                  <h2 className="text-2xl font-semibold text-[var(--pi-ink)] md:text-3xl">
                    Ask across projects
                  </h2>
                  <p className="mx-auto mt-3 max-w-xl text-[15px] leading-6 text-[var(--pi-muted)]">
                    Ask across every indexed project, optionally select project scopes, or switch to Evidence mode to inspect retrieved source blocks.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-[var(--pi-border)] bg-[var(--pi-panel)] px-5 py-5 md:px-8">
            <div className="mx-auto w-full max-w-4xl">
              <ChatComposer
                availableProjects={availableProjects}
                selectedProjectIds={selectedProjectIds}
                conversationId={conversation?.id}
              />
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

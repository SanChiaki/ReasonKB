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
      <section className="flex min-h-[calc(100vh-4.25rem)] flex-col overflow-hidden rounded-[2.25rem] border border-[var(--pi-border)] bg-[rgba(255,255,255,0.58)] shadow-[0_28px_80px_rgba(65,88,130,0.14)] ring-1 ring-white/70 backdrop-blur-xl">
        <header className="border-b border-[var(--pi-border)] bg-[rgba(255,255,255,0.78)] px-6 py-5 backdrop-blur-xl md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--pi-brand)]">
            ReasonKB Chat
          </p>
          <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h1 className="text-3xl font-semibold text-[var(--pi-ink)] md:text-4xl">
              {conversation?.title ?? "New Chat"}
            </h1>
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-[var(--pi-border)] bg-white/80 px-3 py-1.5 text-xs text-[var(--pi-muted)] shadow-[0_8px_24px_rgba(65,88,130,0.08)]">
              <span className="uppercase tracking-[0.14em]">Scope</span>
              <span className="text-[var(--pi-ink)]">{scopeSummary}</span>
            </div>
          </div>
        </header>

        <div className="relative mt-6 flex-1">
          {messages.length > 0 ? (
            <div className="pb-52 pt-2">
              <ChatMessageList messages={messages} />
            </div>
          ) : (
            <div className="flex h-full min-h-[44vh] items-center justify-center px-4 pb-52">
              <div className="w-full max-w-2xl text-center">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[1.35rem] border border-[var(--pi-border)] bg-white text-2xl shadow-[0_16px_38px_rgba(37,99,235,0.14)]">
                  ◌
                </div>
                <h2 className="text-3xl font-semibold text-[var(--pi-ink)] md:text-5xl">
                  Ask across projects
                </h2>
                <p className="mt-4 text-sm text-[var(--pi-muted)] md:text-base">
                  Ask across every indexed project, optionally select project scopes, or switch to Evidence mode to inspect retrieved source blocks.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-20 mt-auto bg-[linear-gradient(180deg,rgba(244,248,255,0),rgba(244,248,255,0.86)_24%,rgba(244,248,255,0.98)_100%)] px-4 pb-4 pt-8 backdrop-blur-md">
          <div className="mx-auto w-full max-w-4xl">
            <ChatComposer
              availableProjects={availableProjects}
              selectedProjectIds={selectedProjectIds}
              conversationId={conversation?.id}
            />
          </div>
        </div>
      </section>
    </AppShell>
  );
}

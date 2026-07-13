import React from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ChatConversation } from "@/components/chat-conversation";
import type {
  ChatProgressLine,
  ChatProgressState,
} from "@/components/chat-message-list";
import type { CitationItem } from "@/components/citation-list";
import { appConfig } from "@/lib/config";
import {
  LocalizedConversationTitle,
  LocalizedModelMissingDescription,
  LocalizedScopeLabel,
  LocalizedText,
} from "@/lib/i18n";
import { getConversationDetail, listConversations } from "@/lib/repos/conversation-store";
import { listProjects } from "@/lib/repos/project-store";
import { getSystemSettings } from "@/lib/repos/system-settings-store";
import {
  isPersistedRetrievalProgress,
  type RetrievalEvidence,
} from "@/lib/retrieval-client";

const demoUserId = "user_demo";
const settingsDefaults = {
  indexWorkerConcurrency: Number.parseInt(
    process.env.INDEX_WORKER_CONCURRENCY ?? "1",
    10,
  ),
  retrievalDocumentLimit: 5,
  llmApiKey: process.env.PAGEINDEX_LLM_API_KEY ?? "",
  llmBaseUrl: process.env.PAGEINDEX_LLM_BASE_URL ?? "",
  llmModel: process.env.PAGEINDEX_LLM_MODEL ?? "openai/deepseek-v4-flash",
  llmRetrievalModel:
    process.env.PAGEINDEX_LLM_RETRIEVAL_MODEL ??
    process.env.PAGEINDEX_LLM_MODEL ??
    "openai/deepseek-v4-flash",
};

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
    sourceDisplayName:
      typeof candidate.sourceDisplayName === "string" ? candidate.sourceDisplayName : null,
    sourceKind: typeof candidate.sourceKind === "string" ? candidate.sourceKind : null,
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
    sourceDisplayName:
      typeof candidate.sourceDisplayName === "string" ? candidate.sourceDisplayName : null,
    sourceKind: typeof candidate.sourceKind === "string" ? candidate.sourceKind : null,
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

function toProgressState(values: unknown[]): ChatProgressState | undefined {
  const progress = values.find(isPersistedRetrievalProgress);
  if (!progress) {
    return undefined;
  }

  const lines: ChatProgressLine[] = progress.lines.map((line, index) => ({
    id: `${line.stage}-${index}`,
    stage: line.stage,
    data: line.data,
  }));
  return {
    lines,
    documents: progress.documents,
  };
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
  const availableProjects = listProjects(appConfig.dbPath).map((project) => ({
    id: project.id,
    name: project.name,
    sourceDisplayName: project.source?.displayName,
    sourceKind: project.source?.kind,
  }));
  const settings = getSystemSettings(appConfig.dbPath, settingsDefaults);
  const conversation = conversationId
    ? getConversationDetail(appConfig.dbPath, conversationId, demoUserId)
    : null;

  const availableProjectIdSet = new Set(availableProjects.map((project) => project.id));
  const selectedProjectIds = (conversation?.projectIds ?? []).filter((projectId) =>
    availableProjectIdSet.has(projectId),
  );
  const scopeSummary = getScopeSummary(selectedProjectIds, availableProjects);
  const messages = (conversation?.messages ?? []).map((message) => {
    const attachments = Array.isArray(message.citations) ? message.citations : [];
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      citations: attachments.map(toCitation).filter(isCitationItem),
      evidence: attachments.map(toEvidence).filter(isEvidenceItem),
      progress: toProgressState(attachments),
      progressExpanded: false,
    };
  });

  return (
    <AppShell conversations={conversations}>
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--pi-bg)]">
        <header className="shrink-0 border-b border-[var(--pi-border)] bg-[var(--pi-panel)] px-5 py-4 md:px-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
            <LocalizedText id="chat.eyebrow" />
          </p>
          <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h1 className="text-2xl font-semibold text-[var(--pi-ink)]">
              <LocalizedConversationTitle title={conversation?.title ?? "New Chat"} />
            </h1>
            <div className="inline-flex items-center gap-2 self-start rounded-md border border-[var(--pi-border)] bg-white px-3 py-1.5 text-xs text-[var(--pi-muted)]">
              <span className="font-semibold uppercase tracking-[0.06em]">
                <LocalizedText id="chat.scope" />
              </span>
              <span className="text-[var(--pi-ink)]">
                <LocalizedScopeLabel value={scopeSummary} />
              </span>
            </div>
          </div>
        </header>

        <ChatConversation
          messages={messages}
          availableProjects={availableProjects}
          selectedProjectIds={selectedProjectIds}
          conversationId={conversation?.id}
          modelWarning={
            !settings.llmConfigured ? (
              <div className="mx-auto mb-5 flex w-full max-w-4xl flex-col gap-3 rounded-lg border border-[rgba(180,35,24,0.28)] bg-[rgba(255,247,237,0.82)] px-4 py-3 text-sm text-[var(--pi-ink)] md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-semibold text-[var(--pi-danger)]">
                    <LocalizedText id="chat.modelMissingTitle" />
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--pi-muted)]">
                    <LocalizedModelMissingDescription fields={settings.llmMissingFields} />
                  </p>
                </div>
                <Link
                  href="/settings"
                  className="inline-flex w-fit items-center justify-center rounded-md border border-[var(--pi-danger)] bg-white px-3 py-2 text-xs font-semibold text-[var(--pi-danger)] transition hover:bg-[rgba(180,35,24,0.08)]"
                >
                  <LocalizedText id="chat.configureModel" />
                </Link>
              </div>
            ) : null
          }
          emptyState={
            <div className="flex h-full min-h-[240px] items-center justify-center px-4 md:min-h-[420px]">
                <div className="w-full max-w-2xl text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--pi-border)] bg-white text-xl text-[var(--pi-muted)] md:h-14 md:w-14 md:text-2xl">
                    ◌
                  </div>
                  <h2 className="text-2xl font-semibold text-[var(--pi-ink)] md:text-3xl">
                    <LocalizedText id="chat.emptyTitle" />
                  </h2>
                  <p className="mx-auto mt-3 max-w-xl text-[15px] leading-6 text-[var(--pi-muted)]">
                    <LocalizedText id="chat.emptyDescription" />
                  </p>
                </div>
              </div>
          }
        />
      </section>
    </AppShell>
  );
}

"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectScopePicker } from "@/components/project-scope-picker";
import { useI18n } from "@/lib/i18n";
import type { RetrievalMode } from "@/lib/retrieval-client";

type ConversationCreateResponse = { id: string };

export function ChatComposer({
  availableProjects,
  selectedProjectIds,
  conversationId,
}: {
  availableProjects: Array<{ id: string; name: string }>;
  selectedProjectIds: string[];
  conversationId?: string;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  const [activeProjectIds, setActiveProjectIds] = useState(selectedProjectIds);
  const [retrievalMode, setRetrievalMode] = useState<RetrievalMode>("answer");
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const sendInFlightRef = useRef(false);

  useEffect(() => {
    setActiveProjectIds(selectedProjectIds);
  }, [selectedProjectIds]);

  function toggleProject(projectId: string) {
    setActiveProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((value) => value !== projectId)
        : [...current, projectId],
    );
  }

  const canSend = message.trim().length > 0 && !sending;
  const placeholder =
    activeProjectIds.length === 0
      ? t("chat.placeholderAll")
      : t("chat.placeholderSelected");

  async function handleSend() {
    if (sendInFlightRef.current || !canSend) {
      return;
    }

    sendInFlightRef.current = true;
    setSending(true);
    setErrorMessage("");
    try {
      let currentConversationId = conversationId;

      if (!currentConversationId) {
        const createResponse = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectIds: activeProjectIds }),
        });
        if (!createResponse.ok) {
          setErrorMessage(t("chat.sendError"));
          return;
        }
        const created = (await createResponse.json()) as
          | ConversationCreateResponse
          | undefined;
        if (!created?.id) {
          setErrorMessage(t("chat.sendError"));
          return;
        }
        currentConversationId = created.id;
      }

      const sendResponse = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentConversationId,
          projectIds: activeProjectIds,
          message: message.trim(),
          mode: retrievalMode,
        }),
      });
      if (!sendResponse.ok) {
        setErrorMessage(t("chat.sendError"));
        return;
      }

      setMessage("");
      router.push(`/chat?conversationId=${currentConversationId}`);
      router.refresh();
    } catch {
      setErrorMessage(t("chat.sendError"));
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  return (
    <form
      className="bg-[var(--pi-panel)]"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSend();
      }}
    >
      <label htmlFor="chat-message" className="sr-only">
        {t("chat.messageLabel")}
      </label>
      <div className="mb-2 text-xs font-semibold text-[var(--pi-muted)]">
        {t("chat.messageLabel")}
      </div>

      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <ProjectScopePicker
          projects={availableProjects}
          selectedProjectIds={activeProjectIds}
          onToggle={toggleProject}
        />
        <div
          className="inline-flex w-fit rounded-lg bg-[var(--pi-bg)] p-1 text-xs font-medium text-[var(--pi-muted)]"
          aria-label={t("chat.retrievalMode")}
        >
          {(["answer", "evidence"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-label={mode === "answer" ? t("chat.answerModeAria") : t("chat.evidenceModeAria")}
              aria-pressed={retrievalMode === mode}
              onClick={() => setRetrievalMode(mode)}
              className={`rounded-md px-4 py-2 transition ${
                retrievalMode === mode
                  ? "bg-white text-[var(--pi-brand)] shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
                  : "hover:text-[var(--pi-ink)]"
              }`}
            >
              {mode === "answer" ? t("chat.answerMode") : t("chat.evidenceMode")}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          id="chat-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={placeholder}
          rows={1}
          className="min-h-12 flex-1 resize-none rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-[15px] leading-6 text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
        />
        <button
          type="submit"
          aria-label={t("chat.send")}
          disabled={!canSend}
          className="inline-flex h-12 shrink-0 items-center justify-center rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-6 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:self-end"
        >
          {sending ? t("chat.sending") : t("chat.send")}
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--pi-muted)]">
          {retrievalMode === "evidence"
            ? t("chat.evidenceHelp")
            : activeProjectIds.length === 0
              ? t("chat.answerAllHelp")
              : t("chat.answerSelectedHelp")}
        </p>
      </div>
      {errorMessage ? (
        <p className="mt-3 text-sm text-[var(--pi-danger,#fca5a5)]">{errorMessage}</p>
      ) : null}
    </form>
  );
}

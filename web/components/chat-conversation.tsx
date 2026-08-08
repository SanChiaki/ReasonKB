"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChatComposer } from "@/components/chat-composer";
import {
  ChatMessageList,
  type ChatMessage,
  type ChatProgressLine,
  type RetrievalProgressDocument,
} from "@/components/chat-message-list";
import type { RetrievalStreamEvent } from "@/lib/retrieval-client";

export function ChatConversation({
  messages,
  availableProjects,
  selectedProjectIds,
  conversationId,
  emptyState,
  modelWarning,
}: {
  messages: ChatMessage[];
  availableProjects: Array<{ id: string; name: string }>;
  selectedProjectIds: string[];
  conversationId?: string;
  emptyState?: React.ReactNode;
  modelWarning?: React.ReactNode;
}) {
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const [pendingAssistantMessage, setPendingAssistantMessage] =
    useState<ChatMessage | null>(null);
  const [pendingBaselineMessageCount, setPendingBaselineMessageCount] =
    useState<number | null>(null);
  const progressLineIdRef = useRef(0);
  const progressLinesRef = useRef<ChatProgressLine[]>([]);
  const progressDocumentsRef = useRef<RetrievalProgressDocument[]>([]);

  function clearPendingMessages() {
    setPendingUserMessage(null);
    setPendingAssistantMessage(null);
    setPendingBaselineMessageCount(null);
    progressLinesRef.current = [];
    progressDocumentsRef.current = [];
    progressLineIdRef.current = 0;
  }

  useEffect(() => {
    if (pendingBaselineMessageCount !== null && messages.length > pendingBaselineMessageCount) {
      clearPendingMessages();
    }
  }, [messages.length, pendingBaselineMessageCount]);

  function handleSendStarted(input: { message: string }) {
    setPendingBaselineMessageCount(messages.length);
    setPendingUserMessage({
      id: "pending-user-message",
      role: "user",
      content: input.message,
      citations: [],
    });
    progressLinesRef.current = [];
    progressDocumentsRef.current = [];
    setPendingAssistantMessage({
      id: "pending-assistant-message",
      role: "assistant",
      content: "",
      citations: [],
      progressExpanded: true,
      progress: {
        lines: [],
        documents: [],
      },
    });
    progressLineIdRef.current = 0;
  }

  function handleStreamEvent(event: RetrievalStreamEvent) {
    if (event.type === "result") {
      setPendingAssistantMessage((current) => ({
        id: current?.id ?? "pending-assistant-message",
        role: "assistant",
        content: event.data.answer,
        citations: event.data.citations,
        evidence: event.data.evidence,
        progressExpanded: false,
        progress: {
          lines: progressLinesRef.current,
          documents: progressDocumentsRef.current,
        },
      }));
      return;
    }

    if (event.type !== "progress") {
      return;
    }
    if (event.stage) {
      progressLineIdRef.current += 1;
      const nextLines = [
        ...progressLinesRef.current.slice(-5),
        {
          id: `${event.stage}-${progressLineIdRef.current}`,
          stage: event.stage,
          data: event.data,
        },
      ];
      progressLinesRef.current = nextLines;
      setPendingAssistantMessage((assistant) =>
        assistant
          ? {
              ...assistant,
              progress: {
                lines: nextLines,
                documents: progressDocumentsRef.current,
              },
            }
          : assistant,
      );
    }
    if (event.stage === "documents_selected") {
      const documents = event.data.documents;
      const nextDocuments = Array.isArray(documents)
        ? documents as RetrievalProgressDocument[]
        : [];
      progressDocumentsRef.current = nextDocuments;
      setPendingAssistantMessage((assistant) =>
        assistant
          ? {
              ...assistant,
              progress: {
                lines: progressLinesRef.current,
                documents: nextDocuments,
              },
            }
          : assistant,
      );
    }
  }

  const showPendingMessages =
    pendingBaselineMessageCount === null || messages.length <= pendingBaselineMessageCount;
  const visibleMessages = [
    ...messages,
    ...(showPendingMessages && pendingUserMessage ? [pendingUserMessage] : []),
    ...(showPendingMessages && pendingAssistantMessage ? [pendingAssistantMessage] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="rk-scrollbar relative min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7">
        {modelWarning}
        {visibleMessages.length > 0 ? (
          <div className="pb-4">
            <ChatMessageList messages={visibleMessages} />
          </div>
        ) : (
          emptyState
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--pi-border)] bg-[var(--pi-panel)] px-4 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:px-8 md:py-4">
        <div className="mx-auto w-full max-w-4xl">
          <ChatComposer
            availableProjects={availableProjects}
            selectedProjectIds={selectedProjectIds}
            conversationId={conversationId}
            onSendStarted={handleSendStarted}
            onStreamEvent={handleStreamEvent}
          />
        </div>
      </div>
    </div>
  );
}

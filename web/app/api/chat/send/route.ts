import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  sendRetrievalQuery,
  sendRetrievalQueryStream,
  type PersistedRetrievalProgress,
  type RetrievalProgressDocument,
  type RetrievalResult,
  type RetrievalStreamEvent,
} from "@/lib/retrieval-client";
import {
  appendConversationMessage,
  getConversationById,
  replaceConversationProjects,
  updateConversationTitle,
} from "@/lib/repos/conversation-store";
import { getProjectById } from "@/lib/repos/project-store";

const demoUserId = "user_demo";

const schema = z.object({
  conversationId: z.string().min(1),
  projectIds: z.array(z.string().min(1)).default([]),
  message: z.string().trim().min(1),
  mode: z.enum(["answer", "evidence"]).default("answer"),
  stream: z.boolean().default(false),
});

function formatEvidenceAnswer(evidenceCount: number) {
  return `Evidence mode returned ${evidenceCount} evidence ${
    evidenceCount === 1 ? "item" : "items"
  }.`;
}

function fallbackRetrievalResult(): RetrievalResult {
  return {
    answer: "I ran into a retrieval error. Please try again.",
    citations: [],
    selectedDocuments: [],
    evidence: [],
  };
}

function retrievalErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Retrieval failed.";
}

function persistAssistantResponse(input: {
  conversationId: string;
  mode: "answer" | "evidence";
  result: RetrievalResult;
  progress?: PersistedRetrievalProgress;
}) {
  const assistantContent =
    input.mode === "evidence"
      ? formatEvidenceAnswer(input.result.evidence.length)
      : input.result.answer;
  const baseAttachments =
    input.mode === "evidence" ? input.result.evidence : input.result.citations;
  const assistantAttachments = input.progress
    ? [input.progress, ...baseAttachments]
    : baseAttachments;

  appendConversationMessage(appConfig.dbPath, {
    conversationId: input.conversationId,
    role: "assistant",
    content: assistantContent,
    citations: assistantAttachments,
  });
}

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const conversation = getConversationById(
    appConfig.dbPath,
    parsed.data.conversationId,
    demoUserId,
  );
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const missingProjectIds = [...new Set(parsed.data.projectIds)].filter(
    (projectId) => !getProjectById(appConfig.dbPath, projectId, demoUserId),
  );
  if (missingProjectIds.length > 0) {
    return NextResponse.json(
      { error: "One or more projects were not found.", missingProjectIds },
      { status: 404 },
    );
  }

  replaceConversationProjects(
    appConfig.dbPath,
    parsed.data.conversationId,
    parsed.data.projectIds,
  );
  appendConversationMessage(appConfig.dbPath, {
    conversationId: parsed.data.conversationId,
    role: "user",
    content: parsed.data.message,
    citations: [],
  });
  if (conversation.title === "New Chat") {
    updateConversationTitle(
      appConfig.dbPath,
      parsed.data.conversationId,
      parsed.data.message.slice(0, 48),
    );
  }

  if (parsed.data.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const progressLines: PersistedRetrievalProgress["lines"] = [];
        let progressDocuments: RetrievalProgressDocument[] = [];
        const sendEvent = (event: RetrievalStreamEvent) => {
          if (event.type === "progress") {
            progressLines.push({
              stage: event.stage,
              data: event.data,
            });
            if (event.stage === "documents_selected") {
              const documents = event.data.documents;
              progressDocuments = Array.isArray(documents)
                ? documents as RetrievalProgressDocument[]
                : [];
            }
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        let result: RetrievalResult;
        try {
          result = await sendRetrievalQueryStream(
            {
              query: parsed.data.message,
              projectIds: parsed.data.projectIds,
              mode: parsed.data.mode,
            },
            sendEvent,
          );
        } catch (error) {
          const message = retrievalErrorMessage(error);
          console.error("chat retrieval stream failed", error);
          sendEvent({
            type: "progress",
            stage: "retrieval_failed",
            data: { message },
          });
          result = fallbackRetrievalResult();
          sendEvent({ type: "result", data: result });
        }

        persistAssistantResponse({
          conversationId: parsed.data.conversationId,
          mode: parsed.data.mode,
          result,
          progress: progressLines.length > 0 || progressDocuments.length > 0
            ? {
                kind: "retrieval_progress",
                lines: progressLines,
                documents: progressDocuments,
              }
            : undefined,
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  let result: Awaited<ReturnType<typeof sendRetrievalQuery>>;
  try {
    result = await sendRetrievalQuery({
      query: parsed.data.message,
      projectIds: parsed.data.projectIds,
      mode: parsed.data.mode,
    });
  } catch (error) {
    console.error("chat retrieval failed", error);
    result = fallbackRetrievalResult();
  }

  persistAssistantResponse({
    conversationId: parsed.data.conversationId,
    mode: parsed.data.mode,
    result,
  });

  return NextResponse.json(result);
}

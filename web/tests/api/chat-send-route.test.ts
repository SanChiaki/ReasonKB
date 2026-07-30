import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createConversation, getConversationDetail } from "@/lib/repos/conversation-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-send-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return { dir, dbPath };
}

function mockConfig(dbPath: string) {
  vi.doMock("@/lib/config", () => ({
    appConfig: {
      dbPath,
      retrievalBaseUrl: "http://127.0.0.1:8001",
    },
  }));
}

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/retrieval-client");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("chat send route validation", () => {
  it("returns 404 when conversation does not exist", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const sendRetrievalQuery = vi.fn();
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: "conv_missing",
          projectIds: [project.id],
          message: "hello",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toContain("Conversation");
    expect(sendRetrievalQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when any submitted project is missing", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const sendRetrievalQuery = vi.fn();
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id, "proj_missing"],
          message: "hello",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toContain("project");
    expect(sendRetrievalQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation belongs to a different owner", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_other");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const sendRetrievalQuery = vi.fn();
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "hello",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toContain("Conversation");
    expect(sendRetrievalQuery).not.toHaveBeenCalled();
  });

  it("returns stable assistant failure payload and persists it when retrieval fails", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const sendRetrievalQuery = vi.fn().mockRejectedValue(new Error("retrieval down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "Summarize alpha revenue",
        }),
      }),
    );
    const json = await response.json();
    const detail = getConversationDetail(dbPath, conversation.id);
    if (!detail) {
      throw new Error("Expected conversation detail to exist.");
    }

    expect(response.status).toBe(200);
    expect(json).toEqual({
      answer: "I ran into a retrieval error. Please try again.",
      citations: [],
      selectedDocuments: [],
      evidence: [],
      retrievalStatus: "degraded",
      degradedReason: "retrieval_request_failed",
    });
    expect(detail.title).toBe("Summarize alpha revenue");
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0].role).toBe("user");
    expect(detail.messages[0].content).toBe("Summarize alpha revenue");
    expect(detail.messages[1].role).toBe("assistant");
    expect(detail.messages[1].content).toBe(json.answer);
    expect(detail.messages[1].citations).toEqual([]);
    expect(sendRetrievalQuery).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "chat retrieval failed",
      expect.any(Error),
    );
  });

  it("passes evidence mode through and persists returned evidence", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const evidence = [
      {
        projectId: project.id,
        projectName: "Alpha",
        documentId: "doc_1",
        documentName: "handover.md",
        sourceRelativePath: "Alpha/delivery/handover.md",
        projectRelativePath: "delivery/handover.md",
        pages: "1",
        evidenceKind: "markdown_text",
        excerpt: "Acceptance evidence",
        content: "Acceptance evidence and handover notes.",
        visualAssets: [],
      },
    ];
    const sendRetrievalQuery = vi.fn().mockResolvedValue({
      answer: "",
      citations: [],
      selectedDocuments: [{ documentId: "doc_1", sourceRelativePath: "Alpha/delivery/handover.md" }],
      evidence,
    });
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "Show evidence",
          mode: "evidence",
        }),
      }),
    );
    const json = await response.json();
    const detail = getConversationDetail(dbPath, conversation.id);
    if (!detail) {
      throw new Error("Expected conversation detail to exist.");
    }

    expect(response.status).toBe(200);
    expect(json.evidence).toEqual(evidence);
    expect(sendRetrievalQuery).toHaveBeenCalledWith({
      query: "Show evidence",
      projectIds: [project.id],
      mode: "evidence",
    });
    expect(detail.messages[1].content).toBe("Evidence mode returned 1 evidence item.");
    expect(detail.messages[1].citations).toEqual(evidence);
  });

  it("allows sending without projectIds and treats it as global retrieval", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");

    const sendRetrievalQuery = vi.fn().mockResolvedValue({
      answer: "global answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    });
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: "Find final acceptance handover reports",
        }),
      }),
    );
    const detail = getConversationDetail(dbPath, conversation.id);
    if (!detail) {
      throw new Error("Expected conversation detail to exist.");
    }

    expect(response.status).toBe(200);
    expect(sendRetrievalQuery).toHaveBeenCalledWith({
      query: "Find final acceptance handover reports",
      projectIds: [],
      mode: "answer",
    });
    expect(detail.projectIds).toEqual([]);
    expect(detail.messages[1].content).toBe("global answer");
  });

  it("streams retrieval progress and persists the final assistant response with progress metadata", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const sendRetrievalQueryStream = vi.fn(async (_input, onEvent) => {
      onEvent({
        type: "progress",
        stage: "documents_loaded",
        data: { documentCount: 2 },
      });
      onEvent({
        type: "progress",
        stage: "documents_selected",
        data: {
          documentCount: 1,
          documents: [
            {
              documentId: "doc_1",
              documentName: "acceptance.pdf",
              projectName: "Alpha",
              sourceRelativePath: "Alpha/acceptance.pdf",
            },
          ],
        },
      });
      onEvent({
        type: "result",
        data: {
          answer: "streamed answer",
          citations: [],
          selectedDocuments: [],
          evidence: [],
        },
      });
      return {
        answer: "streamed answer",
        citations: [],
        selectedDocuments: [],
        evidence: [],
      };
    });
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQueryStream,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "Stream this",
          mode: "answer",
          stream: true,
        }),
      }),
    );
    const text = await response.text();
    const detail = getConversationDetail(dbPath, conversation.id);
    if (!detail) {
      throw new Error("Expected conversation detail to exist.");
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"type":"progress"');
    expect(text).toContain('"stage":"documents_loaded"');
    expect(text).toContain('"type":"result"');
    expect(sendRetrievalQueryStream).toHaveBeenCalledWith(
      {
        query: "Stream this",
        projectIds: [project.id],
        mode: "answer",
      },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0].content).toBe("Stream this");
    expect(detail.messages[1].content).toBe("streamed answer");
    expect(detail.messages[1].citations).toContainEqual({
      kind: "retrieval_progress",
      lines: [
        { stage: "documents_loaded", data: { documentCount: 2 } },
        {
          stage: "documents_selected",
          data: {
            documentCount: 1,
            documents: [
              {
                documentId: "doc_1",
                documentName: "acceptance.pdf",
                projectName: "Alpha",
                sourceRelativePath: "Alpha/acceptance.pdf",
              },
            ],
          },
        },
      ],
      documents: [
        {
          documentId: "doc_1",
          documentName: "acceptance.pdf",
          projectName: "Alpha",
          sourceRelativePath: "Alpha/acceptance.pdf",
        },
      ],
    });
  });

  it("streams and persists a retrieval failure progress event when streaming retrieval fails", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const sendRetrievalQueryStream = vi
      .fn()
      .mockRejectedValue(new Error("connect timed out"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQueryStream,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "Stream failure",
          mode: "answer",
          stream: true,
        }),
      }),
    );
    const text = await response.text();
    const detail = getConversationDetail(dbPath, conversation.id);
    if (!detail) {
      throw new Error("Expected conversation detail to exist.");
    }

    expect(response.status).toBe(200);
    expect(text).toContain('"type":"progress"');
    expect(text).toContain('"stage":"retrieval_failed"');
    expect(text).toContain('"type":"result"');
    expect(text).toContain('"retrievalStatus":"degraded"');
    expect(text).toContain('"degradedReason":"retrieval_request_failed"');
    expect(detail.messages[1].content).toBe(
      "I ran into a retrieval error. Please try again.",
    );
    expect(detail.messages[1].citations).toContainEqual({
      kind: "retrieval_progress",
      lines: [
        {
          stage: "retrieval_failed",
          data: { message: "connect timed out" },
        },
      ],
      documents: [],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "chat retrieval stream failed",
      expect.any(Error),
    );
  });

  it("persists the final assistant response when the stream is cancelled after result before EOF", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const result = {
      answer: "visible before disconnect",
      citations: [],
      selectedDocuments: [],
      evidence: [],
      retrievalStatus: "matched" as const,
    };

    let resolveResultSent!: () => void;
    const resultSent = new Promise<void>((resolve) => {
      resolveResultSent = resolve;
    });
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const sendRetrievalQueryStream = vi.fn(
      async (_input, onEvent, signal?: AbortSignal) => {
        onEvent({ type: "result", data: result });
        resolveResultSent();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolveAborted();
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQueryStream,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "Disconnect after result",
          mode: "answer",
          stream: true,
        }),
      }),
    );
    await resultSent;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected streaming response body.");
    }
    const finalEvent = await reader.read();

    expect(new TextDecoder().decode(finalEvent.value)).toContain(
      '"type":"result"',
    );
    await reader.cancel("client disconnected after result");
    await aborted;

    await vi.waitFor(() => {
      expect(getConversationDetail(dbPath, conversation.id)?.messages).toHaveLength(2);
    });
    const detail = getConversationDetail(dbPath, conversation.id);
    expect(detail?.messages[1].role).toBe("assistant");
    expect(detail?.messages[1].content).toBe(result.answer);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("aborts retrieval and skips fallback persistence when the response stream is cancelled", async () => {
    const { dbPath } = makeTempDb();
    mockConfig(dbPath);
    const conversation = createConversation(dbPath, "user_demo");
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    let retrievalSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const sendRetrievalQueryStream = vi.fn(
      async (_input, onEvent, signal?: AbortSignal) => {
        retrievalSignal = signal;
        onEvent({
          type: "progress",
          stage: "documents_loaded",
          data: { documentCount: 2 },
        });
        resolveStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolveAborted();
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQueryStream,
    }));

    const { POST } = await import("@/app/api/chat/send/route");
    const response = await POST(
      new Request("http://localhost/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          projectIds: [project.id],
          message: "Cancel streaming",
          mode: "answer",
          stream: true,
        }),
      }),
    );
    await started;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected streaming response body.");
    }
    const firstEvent = await reader.read();

    expect(new TextDecoder().decode(firstEvent.value)).toContain(
      '"stage":"documents_loaded"',
    );
    const encodedEventCount = encode.mock.calls.length;
    await reader.cancel("client disconnected");
    await aborted;

    expect(retrievalSignal?.aborted).toBe(true);
    expect(encode).toHaveBeenCalledTimes(encodedEventCount);
    expect(consoleError).not.toHaveBeenCalled();
    const detail = getConversationDetail(dbPath, conversation.id);
    if (!detail) {
      throw new Error("Expected conversation detail to exist.");
    }
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].role).toBe("user");
    expect(detail.messages[0].content).toBe("Cancel streaming");
    encode.mockRestore();
  });
});

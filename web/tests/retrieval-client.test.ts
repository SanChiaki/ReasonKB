import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.unmock("@/lib/config");
});

describe("retrieval client", () => {
  it("forwards an abort signal to a retrieval request", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        answer: "answer",
        citations: [],
        selectedDocuments: [],
        evidence: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendRetrievalQuery } = await import("@/lib/retrieval-client");
    const abortController = new AbortController();
    await sendRetrievalQuery(
      { query: "Cancelable", projectIds: [], mode: "answer" },
      abortController.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://retrieval.test/internal/retrieve/query",
      expect.objectContaining({ signal: abortController.signal }),
    );
  });

  it("parses retrieval progress events and returns the final result", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "progress",
              stage: "documents_loaded",
              data: { documentCount: 2 },
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "result",
              data: {
                answer: "streamed answer",
                citations: [],
                selectedDocuments: [],
                evidence: [],
              },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendRetrievalQueryStream } = await import("@/lib/retrieval-client");
    const events: unknown[] = [];
    const result = await sendRetrievalQueryStream(
      { query: "What changed?", projectIds: ["proj_1"], mode: "answer" },
      (event) => events.push(event),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://retrieval.test/internal/retrieve/query/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "What changed?",
          projectIds: ["proj_1"],
          mode: "answer",
        }),
      }),
    );
    expect(events).toEqual([
      { type: "progress", stage: "documents_loaded", data: { documentCount: 2 } },
      {
        type: "result",
        data: {
          answer: "streamed answer",
          citations: [],
          selectedDocuments: [],
          evidence: [],
        },
      },
    ]);
    expect(result.answer).toBe("streamed answer");
  });

  it("treats the result event as terminal without waiting for upstream EOF", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const encoder = new TextEncoder();
    const cancelStream = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "result",
                data: {
                  answer: "terminal answer",
                  citations: [],
                  selectedDocuments: [],
                  evidence: [],
                },
              })}\n\n`,
            ),
          );
        },
        pull() {
          throw new Error("client read past the terminal result event");
        },
        cancel: cancelStream,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );

    const { sendRetrievalQueryStream } = await import("@/lib/retrieval-client");
    const result = await sendRetrievalQueryStream(
      { query: "Return promptly", projectIds: [], mode: "answer" },
      vi.fn(),
    );

    expect(result.answer).toBe("terminal answer");
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it("cancels the upstream stream when frame parsing fails", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const encoder = new TextEncoder();
    const cancelStream = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(encoder.encode("data: not-json\n\n"));
        },
        cancel: cancelStream,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );

    const { sendRetrievalQueryStream } = await import("@/lib/retrieval-client");
    await expect(
      sendRetrievalQueryStream(
        { query: "Reject malformed data", projectIds: [], mode: "answer" },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(SyntaxError);

    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it("forwards an abort signal to the streaming retrieval request", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendRetrievalQueryStream } = await import("@/lib/retrieval-client");
    const abortController = new AbortController();
    const retrieval = sendRetrievalQueryStream(
      { query: "Cancel this", projectIds: [], mode: "evidence" },
      vi.fn(),
      abortController.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://retrieval.test/internal/retrieve/query/stream",
      expect.objectContaining({ signal: abortController.signal }),
    );
    abortController.abort();

    await expect(retrieval).rejects.toMatchObject({ name: "AbortError" });
  });

  it("projects Agent progress without leaking internal document metadata", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const encoder = new TextEncoder();
    const result = {
      answer: "Grounded answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    };
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const events = [
          {
            type: "progress",
            stage: "documents_selected",
            data: {
              documentCount: 1,
              selectionStrategy: "model_only_full_budget",
              documents: [
                {
                  documentId: "secret-doc",
                  sourceRelativePath: "private/secret.pdf",
                  documentUrl: "https://internal.example/secret",
                },
              ],
            },
          },
          {
            type: "progress",
            stage: "document_evidence_loaded",
            data: {
              document: { documentId: "secret-doc" },
              excerpt: "private evidence excerpt",
              evidenceCount: 1,
            },
          },
          { type: "result", data: result },
        ];
        const payload = events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");
        const bytes = encoder.encode(payload);
        controller.enqueue(bytes.slice(0, 31));
        controller.enqueue(bytes.slice(31));
        controller.close();
      },
    });

    const { projectAgentRetrievalStream } = await import("@/lib/retrieval-client");
    const projected = await new Response(
      projectAgentRetrievalStream(upstream),
    ).text();
    const events = projected
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")));

    expect(events).toEqual([
      {
        type: "progress",
        stage: "documents_selected",
        data: {
          documentCount: 1,
          selectionStrategy: "model_only_full_budget",
        },
      },
      {
        type: "progress",
        stage: "document_evidence_loaded",
        data: { evidenceCount: 1 },
      },
      { type: "result", data: result },
    ]);
  });

  it("also projects Evidence progress without leaking internal document metadata", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const { projectAgentRetrievalEvent } = await import("@/lib/retrieval-client");

    expect(
      projectAgentRetrievalEvent(
        {
          type: "progress",
          stage: "document_evidence_loaded",
          data: {
            document: {
              documentId: "secret-doc",
              sourceRelativePath: "private/secret.pdf",
              documentUrl: "https://internal.example/secret",
            },
            excerpt: "private evidence excerpt",
            evidenceCount: 1,
          },
        },
        "evidence",
      ),
    ).toEqual({
      type: "progress",
      stage: "document_evidence_loaded",
      data: { evidenceCount: 1 },
    });
  });

  it("preserves safe progressive retrieval metrics for Agent callers", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/app.db",
        retrievalBaseUrl: "http://retrieval.test",
      },
    }));
    const { projectAgentRetrievalEvent } = await import("@/lib/retrieval-client");

    expect(
      projectAgentRetrievalEvent({
        type: "progress",
        stage: "evidence_coverage_completed",
        data: {
          wave: 2,
          coverage: "incomplete",
          confidence: "high",
          unresolved: ["sign-off owner"],
          evidenceDocumentCount: 3,
          remainingDocumentCount: 2,
          documents: [{ documentId: "secret-doc" }],
        },
      }),
    ).toEqual({
      type: "progress",
      stage: "evidence_coverage_completed",
      data: {
        wave: 2,
        coverage: "incomplete",
        confidence: "high",
        evidenceDocumentCount: 3,
        remainingDocumentCount: 2,
      },
    });
  });
});

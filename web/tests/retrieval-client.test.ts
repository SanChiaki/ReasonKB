import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.unmock("@/lib/config");
});

describe("retrieval client streaming", () => {
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
});

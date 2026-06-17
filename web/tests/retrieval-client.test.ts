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
});

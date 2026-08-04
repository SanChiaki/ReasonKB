import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReasonkbMcpHttpApp,
  createReasonkbMcpServer,
} from "../mcp-server.mjs";

const listeners = [];
const clients = [];

afterEach(async () => {
  while (clients.length > 0) {
    await clients.pop().close();
  }
  while (listeners.length > 0) {
    const listener = listeners.pop();
    await new Promise((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function startAppInstance(fetchImpl, options = {}) {
  const app = createReasonkbMcpHttpApp({
    reasonkbUrl: "http://reasonkb.test",
    fetchImpl,
    host: "127.0.0.1",
    ...options,
  });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
  listeners.push(listener);
  const address = listener.address();
  return { app, baseUrl: "http://127.0.0.1:" + address.port };
}

async function startApp(fetchImpl, options = {}) {
  return (await startAppInstance(fetchImpl, options)).baseUrl;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function initializeSession(baseUrl, apiKey = "test-api-key") {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });
  await response.text();
  if (!response.ok || !response.headers.get("mcp-session-id")) {
    throw new Error("Failed to initialize MCP test session.");
  }
  return response.headers.get("mcp-session-id");
}

function postToSession(baseUrl, sessionId, apiKey, body) {
  return fetch(baseUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify(body),
  });
}

describe("Streamable HTTP MCP server", () => {
  it("publishes health without an API key", async () => {
    const baseUrl = await startApp(vi.fn());
    const response = await fetch(baseUrl + "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects request timeout values beyond the Node timer limit", () => {
    expect(() =>
      createReasonkbMcpHttpApp({
        reasonkbUrl: "http://reasonkb.test",
        fetchImpl: vi.fn(),
        requestTimeoutMs: 2_147_483_648,
      }),
    ).toThrow(/MCP request timeout must be at most 2147483647/);

    const original = process.env.REASONKB_MCP_REQUEST_TIMEOUT_SECONDS;
    process.env.REASONKB_MCP_REQUEST_TIMEOUT_SECONDS = "2147484";
    try {
      expect(() =>
        createReasonkbMcpHttpApp({
          reasonkbUrl: "http://reasonkb.test",
          fetchImpl: vi.fn(),
        }),
      ).toThrow(/REASONKB_MCP_REQUEST_TIMEOUT_SECONDS must be at most 2147483/);
    } finally {
      if (original === undefined) {
        delete process.env.REASONKB_MCP_REQUEST_TIMEOUT_SECONDS;
      } else {
        process.env.REASONKB_MCP_REQUEST_TIMEOUT_SECONDS = original;
      }
    }
  });

  it.each([0, ""])(
    "propagates SDK cancellation for falsy request id %j",
    async (requestId) => {
      let requestSignal;
      let resolveUpstreamStarted;
      const upstreamStarted = new Promise((resolve) => {
        resolveUpstreamStarted = resolve;
      });
      const fetchImpl = vi.fn(async (_url, init = {}) => {
        requestSignal = init.signal;
        resolveUpstreamStarted();
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () => reject(requestSignal.reason),
            { once: true },
          );
        });
      });
      const transport = {
        async start() {},
        async send() {},
        async close() {
          this.onclose?.();
        },
        receive(message) {
          this.onmessage?.(message);
        },
      };
      const server = createReasonkbMcpServer({
        apiKey: "test-api-key",
        baseUrl: "http://reasonkb.test",
        fetchImpl,
      });

      try {
        await server.connect(transport);
        transport.receive({
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name: "reasonkb_list_projects", arguments: {} },
        });
        await upstreamStarted;
        transport.receive({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId, reason: "test cancellation" },
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(requestSignal.aborted).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

  it("releases SDK request correlations when a transport closes", async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    transport._webStandardTransport._requestToStreamMapping.set(0, "stream-id");

    await transport.close();

    expect(transport._webStandardTransport._requestToStreamMapping.size).toBe(
      0,
    );
  });

  it("rejects missing and invalid Bearer API keys", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const baseUrl = await startApp(fetchImpl);
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    };

    const missing = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initialize),
    });
    const invalid = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify(initialize),
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed", "{", 400, "Malformed JSON request body."],
    [
      "oversized",
      JSON.stringify({ payload: "x".repeat(110 * 1024) }),
      413,
      "Request body is too large.",
    ],
  ])(
    "returns a sanitized JSON-RPC error for %s JSON",
    async (_name, body, expectedStatus, expectedMessage) => {
      const fetchImpl = vi.fn();
      const baseUrl = await startApp(fetchImpl);

      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body,
      });
      const text = await response.text();

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(JSON.parse(text)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: expectedMessage },
        id: null,
      });
      expect(text).not.toContain("SyntaxError");
      expect(text).not.toContain("PayloadTooLargeError");
      expect(text).not.toContain("/Users/");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects untrusted Origins before API key verification", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const baseUrl = await startApp(fetchImpl);
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    };

    const rejected = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify(initialize),
    });
    const rejectedBeforeParsing = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{",
    });
    const accepted = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify(initialize),
    });

    expect(rejected.status).toBe(403);
    expect(rejectedBeforeParsing.status).toBe(403);
    expect(await rejectedBeforeParsing.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Origin header." },
      id: null,
    });
    expect(accepted.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [["read:projects"], ["reasonkb_list_projects"]],
    [
      ["read:documents"],
      [
        "reasonkb_list_documents",
        "reasonkb_get_pages",
        "reasonkb_get_structure",
      ],
    ],
    [["query"], ["reasonkb_query"]],
    [["evidence"], ["reasonkb_evidence"]],
  ])("lists only the tools authorized by scopes %j", async (scopes, names) => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return jsonResponse({ scopes });
      }
      return jsonResponse({ error: "Unexpected upstream request." }, 500);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: {
        headers: { Authorization: "Bearer scoped-api-key" },
      },
    });

    await client.connect(transport);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(names);
  });

  it("rejects direct calls to tools hidden by the API key scopes", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return jsonResponse({ scopes: ["evidence"] });
      }
      return jsonResponse({ error: "Unexpected upstream request." }, 500);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: {
        headers: { Authorization: "Bearer evidence-only-key" },
      },
    });

    await client.connect(transport);

    const result = await client.callTool({
      name: "reasonkb_query",
      arguments: { query: "This must not run", projectIds: [] },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringMatching(/tool reasonkb_query not found/i),
        },
      ],
    });
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).endsWith("/api/agent/query"),
      ),
    ).toBe(false);
  });

  it("lists and calls tools through the official MCP client", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        return jsonResponse({
          projects: [{ id: "proj_alpha", name: "Alpha" }],
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: {
        headers: { Authorization: "Bearer test-api-key" },
      },
    });

    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({
      name: "reasonkb_list_projects",
      arguments: {},
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "reasonkb_list_projects",
      "reasonkb_list_documents",
      "reasonkb_query",
      "reasonkb_evidence",
      "reasonkb_get_pages",
      "reasonkb_get_structure",
    ]);
    expect(result.structuredContent).toEqual({
      projects: [{ id: "proj_alpha", name: "Alpha" }],
    });
    expect(
      requests.every(
        ({ init }) =>
          new Headers(init.headers).get("authorization") ===
          "Bearer test-api-key",
      ),
    ).toBe(true);
  });

  it.each([
    ["reasonkb_query", "query"],
    ["reasonkb_evidence", "evidence"],
  ])(
    "streams %s retrieval progress before returning the final result",
    async (toolName, route) => {
      const encoder = new TextEncoder();
      const progressEvents = [
        {
          type: "progress",
          stage: "documents_loaded",
          data: { documentCount: 2 },
        },
        {
          type: "progress",
          stage: "documents_selected",
          data: { selectedCount: 1 },
        },
      ];
      const finalResult = {
        answer: route === "query" ? "Grounded answer" : "",
        citations: [],
        selectedDocuments: [],
        evidence: [{ documentId: "doc-1", text: "Relevant evidence" }],
      };
      let upstreamRequest;
      let resolveUpstreamCancelled;
      const upstreamCancelled = new Promise((resolve) => {
        resolveUpstreamCancelled = resolve;
      });
      const fetchImpl = vi.fn(async (url, init = {}) => {
        if (String(url).endsWith("/api/agent/auth/verify")) {
          return new Response(null, { status: 204 });
        }
        if (String(url).endsWith("/api/agent/" + route)) {
          upstreamRequest = init;
          return new Response(
            new ReadableStream({
              start(controller) {
                const progressBytes = encoder.encode(
                  progressEvents
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join(""),
                );
                const splitAt = 17;
                controller.enqueue(progressBytes.slice(0, splitAt));
                controller.enqueue(progressBytes.slice(splitAt));
                setTimeout(() => {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: "result",
                        data: finalResult,
                      })}\n\n`,
                    ),
                  );
                }, 25);
              },
              cancel() {
                resolveUpstreamCancelled();
              },
            }),
            { headers: { "content-type": "text/event-stream; charset=utf-8" } },
          );
        }
        return jsonResponse({ error: "Not found." }, 404);
      });
      const baseUrl = await startApp(fetchImpl);
      const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(baseUrl), {
          requestInit: {
            headers: { Authorization: "Bearer test-api-key" },
          },
        }),
      );
      const progress = [];
      let callSettled = false;

      const call = client
        .callTool(
          {
            name: toolName,
            arguments: { query: "Find the evidence", projectIds: [] },
          },
          undefined,
          {
            onprogress(update) {
              progress.push({ ...update, callSettled });
            },
          },
        )
        .finally(() => {
          callSettled = true;
        });
      const result = await call;

      expect(new Headers(upstreamRequest.headers).get("accept")).toBe(
        "text/event-stream",
      );
      expect(progress).toEqual([
        {
          progress: 1,
          message: JSON.stringify(progressEvents[0]),
          callSettled: false,
        },
        {
          progress: 2,
          message: JSON.stringify(progressEvents[1]),
          callSettled: false,
        },
      ]);
      expect(result.structuredContent).toEqual(finalResult);
      await expect(
        Promise.race([
          upstreamCancelled,
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("upstream stream was not cancelled")),
              250,
            ),
          ),
        ]),
      ).resolves.toBeUndefined();
    },
  );

  it("returns a streamed result without notifications when progress was not requested", async () => {
    const encoder = new TextEncoder();
    const finalResult = {
      answer: "Grounded answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    };
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/query")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const event of [
                {
                  type: "progress",
                  stage: "documents_selected",
                  data: { documentCount: 1 },
                },
                { type: "result", data: finalResult },
              ]) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    const clientErrors = [];
    client.onerror = (error) => clientErrors.push(error);
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const result = await client.callTool({
      name: "reasonkb_query",
      arguments: { query: "Find the evidence", projectIds: [] },
    });

    expect(result.structuredContent).toEqual(finalResult);
    expect(clientErrors).toEqual([]);
  });

  it("preserves a zero progress token on the request-associated HTTP stream", async () => {
    const progressEvent = {
      type: "progress",
      stage: "retrieval_started",
      data: {},
    };
    const finalResult = {
      answer: "Grounded answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    };
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/query")) {
        return new Response(
          [
            `data: ${JSON.stringify(progressEvent)}\n\n`,
            `data: ${JSON.stringify({ type: "result", data: finalResult })}\n\n`,
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const sessionId = await initializeSession(baseUrl);

    const response = await postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: "zero-progress-token",
        method: "tools/call",
        params: {
          name: "reasonkb_query",
          arguments: { query: "Track this request", projectIds: [] },
          _meta: { progressToken: 0 },
        },
      },
    );
    const messages = (await response.text())
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));

    expect(response.status).toBe(200);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: 0,
        progress: 1,
        message: JSON.stringify(progressEvent),
      },
    });
    expect(messages[1]).toMatchObject({
      jsonrpc: "2.0",
      id: "zero-progress-token",
      result: { structuredContent: finalResult },
    });
  });

  it("keeps ordinary JSON Agent responses compatible with retrieval tools", async () => {
    const finalResult = {
      answer: "JSON answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    };
    let upstreamRequest;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/query")) {
        upstreamRequest = init;
        return jsonResponse(finalResult);
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const result = await client.callTool({
      name: "reasonkb_query",
      arguments: { query: "Use JSON fallback", projectIds: [] },
    });

    expect(new Headers(upstreamRequest.headers).get("accept")).toBe(
      "text/event-stream",
    );
    expect(result.structuredContent).toEqual(finalResult);
  });

  it("accepts a fragmented legitimate Evidence result larger than one MiB", async () => {
    const evidenceContent = "e".repeat(1_100_000);
    const finalResult = {
      answer: "",
      citations: [],
      selectedDocuments: [{ documentId: "doc-large" }],
      evidence: [
        {
          documentId: "doc-large",
          documentName: "large.pdf",
          pages: "1-16",
          content: evidenceContent,
        },
      ],
    };
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/evidence")) {
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "result", data: finalResult })}\r\n\r\n`,
        );
        let offset = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= bytes.length) {
                controller.close();
                return;
              }
              const nextOffset = Math.min(offset + 1024, bytes.length);
              controller.enqueue(bytes.slice(offset, nextOffset));
              offset = nextOffset;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const result = await client.callTool({
      name: "reasonkb_evidence",
      arguments: { query: "Return the full evidence", projectIds: [] },
    });

    expect(result.structuredContent.evidence[0].content).toHaveLength(1_100_000);
  });

  it("reports malformed Agent SSE without echoing its contents", async () => {
    const privatePayload = "PRIVATE evidence that must not appear in errors";
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/query")) {
        return new Response(`data: ${privatePayload}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const result = await client.callTool({
      name: "reasonkb_query",
      arguments: { query: "Malformed upstream", projectIds: [] },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "ReasonKB retrieval stream contained malformed JSON.",
    );
    expect(result.content[0].text).not.toContain(privatePayload);
  });

  it("binds each stateful session to the API key that initialized it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const baseUrl = await startApp(fetchImpl);
    const sessionId = await initializeSession(baseUrl, "key-a");
    const listTools = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    const missing = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(listTools),
    });
    const wrongKey = await postToSession(
      baseUrl,
      sessionId,
      "key-b",
      listTools,
    );
    const unknownSession = await postToSession(
      baseUrl,
      "unknown-session",
      "key-a",
      listTools,
    );
    const accepted = await postToSession(
      baseUrl,
      sessionId,
      "key-a",
      listTools,
    );
    const acceptedBody = await accepted.text();

    expect(missing.status).toBe(401);
    expect(wrongKey.status).toBe(404);
    expect(unknownSession.status).toBe(404);
    expect(accepted.status).toBe(200);
    expect(acceptedBody).toContain('"tools"');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("closes a session when its bound API key is revoked", async () => {
    let revoked = false;
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: revoked ? 401 : 204 }),
    );
    const baseUrl = await startApp(fetchImpl);
    const sessionId = await initializeSession(baseUrl);
    const listTools = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    revoked = true;
    const rejected = await postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      listTools,
    );
    revoked = false;
    const afterRevocation = await postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      listTools,
    );

    expect(rejected.status).toBe(401);
    expect(afterRevocation.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate request IDs that race through authentication", async () => {
    let holdAuthentication = false;
    const releaseAuthentication = [];
    const fetchImpl = vi.fn(async () => {
      if (!holdAuthentication) {
        return new Response(null, { status: 204 });
      }
      return new Promise((resolve) => {
        releaseAuthentication.push(() =>
          resolve(new Response(null, { status: 204 })),
        );
      });
    });
    const baseUrl = await startApp(fetchImpl);
    const sessionId = await initializeSession(baseUrl);
    holdAuthentication = true;
    const request = {
      jsonrpc: "2.0",
      id: "duplicate",
      method: "tools/list",
      params: {},
    };

    const firstResponsePromise = postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      request,
    );
    while (releaseAuthentication.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let duplicateResponse;
    try {
      duplicateResponse = await Promise.race([
        postToSession(baseUrl, sessionId, "test-api-key", request),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("duplicate request was not rejected")),
            250,
          ),
        ),
      ]);
    } finally {
      releaseAuthentication.splice(0).forEach((release) => release());
    }

    const responses = [await firstResponsePromise, duplicateResponse];
    await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status).sort()).toEqual([
      200,
      400,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("releases bounded session capacity after DELETE and idle expiry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const baseUrl = await startApp(fetchImpl, {
      maxSessions: 1,
      sessionIdleTimeoutMs: 25,
    });
    const firstSessionId = await initializeSession(baseUrl);

    const capacityResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(capacityResponse.status).toBe(503);

    const deleted = await fetch(baseUrl, {
      method: "DELETE",
      headers: {
        authorization: "Bearer test-api-key",
        "mcp-session-id": firstSessionId,
      },
    });
    expect(deleted.status).toBe(200);

    const secondSessionId = await initializeSession(baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const expired = await postToSession(
      baseUrl,
      secondSessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    );

    expect(expired.status).toBe(404);
    await expect(initializeSession(baseUrl)).resolves.toEqual(
      expect.any(String),
    );
  });

  it("rejects excessive project filters before calling the Agent API", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "Unexpected upstream request." }, 500);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const result = await client.callTool({
      name: "reasonkb_query",
      arguments: {
        query: "Bound this request",
        projectIds: Array.from({ length: 101 }, (_, index) => "proj_" + index),
      },
    });

    expect(result.isError).toBe(true);
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).endsWith("/api/agent/query"),
      ),
    ).toBe(false);
  });

  it("aborts an upstream Agent request when the client disconnects", async () => {
    let resolveUpstreamStarted;
    let resolveUpstreamAborted;
    const upstreamStarted = new Promise((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        resolveUpstreamStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              resolveUpstreamAborted();
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const sessionId = await initializeSession(baseUrl);
    const url = new URL(baseUrl);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      method: "POST",
      path: "/",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
    });
    request.on("error", () => {});
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "reasonkb_list_projects", arguments: {} },
      }),
    );

    await upstreamStarted;
    request.destroy();
    await upstreamAborted;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns a JSON-RPC timeout and aborts the upstream Agent request", async () => {
    let resolveUpstreamAborted;
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              resolveUpstreamAborted();
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, { requestTimeoutMs: 50 });
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const result = await client.callTool({
      name: "reasonkb_list_projects",
      arguments: {},
    });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("MCP request timed out."),
        },
      ],
    });
    await upstreamAborted;
  });

  it("cancels upstream work when an official MCP client times out", async () => {
    let resolveUpstreamStarted;
    let resolveUpstreamAborted;
    const upstreamStarted = new Promise((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/query")) {
        resolveUpstreamStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              resolveUpstreamAborted();
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, { requestTimeoutMs: 1_000 });
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    const clientErrors = [];
    client.onerror = (error) => clientErrors.push(error);
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );

    const call = client.callTool(
      {
        name: "reasonkb_query",
        arguments: { query: "Bound this request", projectIds: [] },
      },
      undefined,
      { timeout: 25 },
    );

    await upstreamStarted;
    await expect(call).rejects.toMatchObject({ code: -32001 });
    await expect(
      Promise.race([
        upstreamAborted,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("upstream request was not aborted")),
            250,
          ),
        ),
      ]),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(clientErrors).toEqual([]);
    await expect(client.listTools()).resolves.toHaveProperty("tools");
  });

  it("aborts an Agent event stream when an official MCP client times out", async () => {
    let resolveUpstreamAborted;
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = resolve;
    });
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/query")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "progress",
                    stage: "retrieval_started",
                    data: {},
                  })}\n\n`,
                ),
              );
              init.signal.addEventListener(
                "abort",
                () => {
                  resolveUpstreamAborted();
                  controller.error(init.signal.reason);
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, { requestTimeoutMs: 1_000 });
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    const clientErrors = [];
    client.onerror = (error) => clientErrors.push(error);
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );
    const progress = [];

    const call = client.callTool(
      {
        name: "reasonkb_query",
        arguments: { query: "Cancel the stream", projectIds: [] },
      },
      undefined,
      { timeout: 25, onprogress: (update) => progress.push(update) },
    );

    await expect(call).rejects.toMatchObject({ code: -32001 });
    await expect(
      Promise.race([
        upstreamAborted,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("upstream stream was not aborted")),
            250,
          ),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(progress).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(clientErrors).toEqual([]);
  });

  it.each([0, ""])(
    "cancels falsy request id %j and keeps the session reusable",
    async (requestId) => {
      let resolveUpstreamStarted;
      let resolveUpstreamAborted;
      const upstreamStarted = new Promise((resolve) => {
        resolveUpstreamStarted = resolve;
      });
      const upstreamAborted = new Promise((resolve) => {
        resolveUpstreamAborted = resolve;
      });
      let projectRequestCount = 0;
      const fetchImpl = vi.fn(async (url, init = {}) => {
        if (String(url).endsWith("/api/agent/auth/verify")) {
          return new Response(null, { status: 204 });
        }
        if (String(url).endsWith("/api/agent/projects")) {
          projectRequestCount += 1;
          if (projectRequestCount > 1) {
            return jsonResponse({ projects: [] });
          }
          resolveUpstreamStarted();
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => {
                resolveUpstreamAborted();
                reject(init.signal.reason);
              },
              { once: true },
            );
          });
        }
        return jsonResponse({ error: "Not found." }, 404);
      });
      const baseUrl = await startApp(fetchImpl, { requestTimeoutMs: 1_000 });
      const sessionId = await initializeSession(baseUrl);
      const toolResponse = await postToSession(
        baseUrl,
        sessionId,
        "test-api-key",
        {
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name: "reasonkb_list_projects", arguments: {} },
        },
      );

      try {
        await upstreamStarted;
        const wrongKeyCancellation = await postToSession(
          baseUrl,
          sessionId,
          "wrong-api-key",
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "wrong key" },
          },
        );
        expect(wrongKeyCancellation.status).toBe(404);
        await expect(
          Promise.race([
            upstreamAborted.then(() => "aborted"),
            new Promise((resolve) => setTimeout(() => resolve("active"), 25)),
          ]),
        ).resolves.toBe("active");

        const cancellation = await postToSession(
          baseUrl,
          sessionId,
          "test-api-key",
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "test cancellation" },
          },
        );

        expect(cancellation.status).toBe(202);
        expect(
          fetchImpl.mock.calls.filter(([url]) =>
            String(url).endsWith("/api/agent/auth/verify"),
          ),
        ).toHaveLength(2);
        await expect(
          Promise.race([
            upstreamAborted,
            new Promise((_resolve, reject) =>
              setTimeout(
                () => reject(new Error("upstream request was not aborted")),
                250,
              ),
            ),
          ]),
        ).resolves.toBeUndefined();
        await expect(
          Promise.race([
            toolResponse.text(),
            new Promise((_resolve, reject) =>
              setTimeout(
                () => reject(new Error("tool SSE did not close")),
                250,
              ),
            ),
          ]),
        ).resolves.toEqual(expect.any(String));
        const listTools = await postToSession(
          baseUrl,
          sessionId,
          "test-api-key",
          {
            jsonrpc: "2.0",
            id: "after-cancellation",
            method: "tools/list",
            params: {},
          },
        );
        expect(listTools.status).toBe(200);
        expect(await listTools.text()).toContain('"tools"');

        const reused = await postToSession(baseUrl, sessionId, "test-api-key", {
          jsonrpc: "2.0",
          id: 0,
          method: "tools/call",
          params: { name: "reasonkb_list_projects", arguments: {} },
        });
        expect(reused.status).toBe(200);
        expect(await reused.text()).toContain('"projects"');
      } finally {
        await fetch(baseUrl, {
          method: "DELETE",
          headers: {
            authorization: "Bearer test-api-key",
            "mcp-session-id": sessionId,
          },
        });
      }
    },
  );

  it("cancels a request while API key verification is still pending", async () => {
    let authenticationCount = 0;
    let projectRequestCount = 0;
    let releaseAuthentication;
    let resolveAuthenticationStarted;
    let resolveAuthenticationAborted;
    const authenticationStarted = new Promise((resolve) => {
      resolveAuthenticationStarted = resolve;
    });
    const authenticationAborted = new Promise((resolve) => {
      resolveAuthenticationAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        authenticationCount += 1;
        if (authenticationCount !== 2) {
          return new Response(null, { status: 204 });
        }
        resolveAuthenticationStarted();
        return new Promise((resolve, reject) => {
          releaseAuthentication = () => {
            resolve(new Response(null, { status: 204 }));
          };
          const abort = () => {
            resolveAuthenticationAborted();
            reject(init.signal.reason);
          };
          if (init.signal.aborted) {
            abort();
          } else {
            init.signal.addEventListener("abort", abort, { once: true });
          }
        });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        projectRequestCount += 1;
        return jsonResponse({ projects: [] });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, {
      preAuthTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    const sessionId = await initializeSession(baseUrl);
    const originalResponsePromise = postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: "during-authentication",
        method: "tools/call",
        params: { name: "reasonkb_list_projects", arguments: {} },
      },
    );

    try {
      await authenticationStarted;
      const cancellation = await postToSession(
        baseUrl,
        sessionId,
        "test-api-key",
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: "during-authentication",
            reason: "cancel during authentication",
          },
        },
      );
      const authenticationOutcome = await Promise.race([
        authenticationAborted.then(() => "aborted"),
        new Promise((resolve) =>
          setTimeout(() => resolve("still pending"), 100),
        ),
      ]);
      if (authenticationOutcome !== "aborted") {
        releaseAuthentication();
      }
      const originalResponse = await originalResponsePromise;
      await originalResponse.text();
      const reused = await postToSession(
        baseUrl,
        sessionId,
        "test-api-key",
        {
          jsonrpc: "2.0",
          id: "after-authentication-cancellation",
          method: "tools/list",
          params: {},
        },
      );

      expect(cancellation.status).toBe(202);
      expect(authenticationOutcome).toBe("aborted");
      expect(originalResponse.status).toBe(204);
      expect(projectRequestCount).toBe(0);
      expect(reused.status).toBe(200);
      expect(await reused.text()).toContain('"tools"');
    } finally {
      releaseAuthentication?.();
      await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-api-key",
          "mcp-session-id": sessionId,
        },
      });
    }
  });

  it("aborts authentication when its session is closed", async () => {
    let authenticationCount = 0;
    let projectRequestCount = 0;
    let releaseAuthentication;
    let resolveAuthenticationStarted;
    let resolveAuthenticationAborted;
    const authenticationStarted = new Promise((resolve) => {
      resolveAuthenticationStarted = resolve;
    });
    const authenticationAborted = new Promise((resolve) => {
      resolveAuthenticationAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        authenticationCount += 1;
        if (authenticationCount !== 2) {
          return new Response(null, { status: 204 });
        }
        resolveAuthenticationStarted();
        return new Promise((resolve, reject) => {
          releaseAuthentication = () => {
            resolve(new Response(null, { status: 204 }));
          };
          const abort = () => {
            resolveAuthenticationAborted();
            reject(init.signal.reason);
          };
          if (init.signal.aborted) {
            abort();
          } else {
            init.signal.addEventListener("abort", abort, { once: true });
          }
        });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        projectRequestCount += 1;
        return jsonResponse({ projects: [] });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, {
      preAuthTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    const sessionId = await initializeSession(baseUrl);
    const originalResponsePromise = postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: "closed-during-authentication",
        method: "tools/call",
        params: { name: "reasonkb_list_projects", arguments: {} },
      },
    );

    await authenticationStarted;
    const deleted = await fetch(baseUrl, {
      method: "DELETE",
      headers: {
        authorization: "Bearer test-api-key",
        "mcp-session-id": sessionId,
      },
    });
    const authenticationOutcome = await Promise.race([
      authenticationAborted.then(() => "aborted"),
      new Promise((resolve) =>
        setTimeout(() => resolve("still pending"), 100),
      ),
    ]);
    if (authenticationOutcome !== "aborted") {
      releaseAuthentication();
    }
    const originalResponse = await originalResponsePromise;
    const originalBody = await originalResponse.json();

    expect(deleted.status).toBe(200);
    expect(authenticationOutcome).toBe("aborted");
    expect(originalResponse.status).toBe(404);
    expect(originalBody).toMatchObject({
      error: { code: -32001, message: "MCP session not found." },
    });
    expect(projectRequestCount).toBe(0);
  });

  it("aborts pending authentication during application shutdown", async () => {
    let authenticationCount = 0;
    let resolveAuthenticationStarted;
    let resolveAuthenticationAborted;
    const authenticationStarted = new Promise((resolve) => {
      resolveAuthenticationStarted = resolve;
    });
    const authenticationAborted = new Promise((resolve) => {
      resolveAuthenticationAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (!String(url).endsWith("/api/agent/auth/verify")) {
        return jsonResponse({ error: "Unexpected upstream request." }, 500);
      }
      authenticationCount += 1;
      if (authenticationCount === 1) {
        return new Response(null, { status: 204 });
      }
      resolveAuthenticationStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => {
          resolveAuthenticationAborted();
          reject(init.signal.reason);
        };
        if (init.signal.aborted) {
          abort();
        } else {
          init.signal.addEventListener("abort", abort, { once: true });
        }
      });
    });
    const { app, baseUrl } = await startAppInstance(fetchImpl, {
      preAuthTimeoutMs: 1_000,
    });
    const sessionId = await initializeSession(baseUrl);
    const originalResponsePromise = postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: "pending-at-shutdown",
        method: "tools/list",
        params: {},
      },
    );

    await authenticationStarted;
    await app.locals.closeMcpSessions();
    await authenticationAborted;
    const originalResponse = await originalResponsePromise;

    expect(originalResponse.status).toBe(503);
    expect(originalResponse.headers.get("retry-after")).toBe("1");
    expect(await originalResponse.json()).toMatchObject({
      error: { message: "MCP server is shutting down." },
    });
  });

  it("rejects JSON-RPC batches without cancelling active work", async () => {
    let resolveUpstreamStarted;
    let resolveUpstreamAborted;
    const upstreamStarted = new Promise((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    let upstreamWasAborted = false;
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = () => {
        upstreamWasAborted = true;
        resolve();
      };
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        resolveUpstreamStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              resolveUpstreamAborted();
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, { requestTimeoutMs: 1_000 });
    const sessionId = await initializeSession(baseUrl);
    const toolResponse = await postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "reasonkb_list_projects", arguments: {} },
      },
    );

    try {
      await upstreamStarted;
      const cancellation = await postToSession(
        baseUrl,
        sessionId,
        "test-api-key",
        [
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 7, reason: "batch cancellation" },
          },
        ],
      );

      expect(cancellation.status).toBe(400);
      expect(await cancellation.json()).toMatchObject({
        error: { code: -32600, message: "JSON-RPC batches are not supported." },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(upstreamWasAborted).toBe(false);
    } finally {
      await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-api-key",
          "mcp-session-id": sessionId,
        },
      });
      await upstreamAborted;
      await toolResponse.text();
    }
  });

  it("ignores cancellation for an unknown request without synthesizing a response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const baseUrl = await startApp(fetchImpl);
    const sessionId = await initializeSession(baseUrl);
    const sendSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, "send");

    try {
      const cancellation = await postToSession(
        baseUrl,
        sessionId,
        "test-api-key",
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "unknown", reason: "already finished" },
        },
      );

      expect(cancellation.status).toBe(202);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      sendSpy.mockRestore();
      await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-api-key",
          "mcp-session-id": sessionId,
        },
      });
    }
  });

  it("bounds concurrent API key verification independently of tool work", async () => {
    let holdAuthentication = false;
    let activeAuthentication = 0;
    let maximumActiveAuthentication = 0;
    const releaseAuthentication = [];
    const fetchImpl = vi.fn(async (url) => {
      if (!String(url).endsWith("/api/agent/auth/verify")) {
        return jsonResponse({ error: "Unexpected upstream request." }, 500);
      }
      if (!holdAuthentication) {
        return new Response(null, { status: 204 });
      }
      activeAuthentication += 1;
      maximumActiveAuthentication = Math.max(
        maximumActiveAuthentication,
        activeAuthentication,
      );
      return new Promise((resolve) => {
        releaseAuthentication.push(() => {
          activeAuthentication -= 1;
          resolve(new Response(null, { status: 204 }));
        });
      });
    });
    const baseUrl = await startApp(fetchImpl, {
      maxConcurrentAuthRequests: 2,
    });
    const sessionId = await initializeSession(baseUrl);
    holdAuthentication = true;

    const requests = Array.from({ length: 6 }, (_, index) =>
      postToSession(baseUrl, sessionId, "test-api-key", {
        jsonrpc: "2.0",
        id: index + 10,
        method: "tools/list",
        params: {},
      }),
    );
    while (releaseAuthentication.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    let concurrencyError;
    try {
      expect(maximumActiveAuthentication).toBeLessThanOrEqual(2);
    } catch (error) {
      concurrencyError = error;
    } finally {
      releaseAuthentication.splice(0).forEach((release) => release());
    }
    const responses = await Promise.all(requests);
    await Promise.all(responses.map((response) => response.text()));
    if (concurrencyError) {
      throw concurrencyError;
    }
    expect(
      responses.filter((response) => response.status === 503),
    ).toHaveLength(4);
  });

  it("bounds authenticated control traffic independently of tool work", async () => {
    let holdAuthentication = false;
    let activeAuthentication = 0;
    let maximumActiveAuthentication = 0;
    const releaseAuthentication = [];
    const fetchImpl = vi.fn(async (url) => {
      if (!String(url).endsWith("/api/agent/auth/verify")) {
        return jsonResponse({ error: "Unexpected upstream request." }, 500);
      }
      if (!holdAuthentication) {
        return new Response(null, { status: 204 });
      }
      activeAuthentication += 1;
      maximumActiveAuthentication = Math.max(
        maximumActiveAuthentication,
        activeAuthentication,
      );
      return new Promise((resolve) => {
        releaseAuthentication.push(() => {
          activeAuthentication -= 1;
          resolve(new Response(null, { status: 204 }));
        });
      });
    });
    const baseUrl = await startApp(fetchImpl, {
      maxConcurrentAuthRequests: 6,
      maxConcurrentControlRequests: 2,
    });
    const sessionId = await initializeSession(baseUrl);
    holdAuthentication = true;

    const requests = Array.from({ length: 6 }, () =>
      postToSession(baseUrl, sessionId, "test-api-key", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    );
    while (releaseAuthentication.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseAuthentication.splice(0).forEach((release) => release());

    const responses = await Promise.all(requests);
    await Promise.all(responses.map((response) => response.text()));
    expect(maximumActiveAuthentication).toBe(2);
    expect(
      responses.filter((response) => response.status === 202),
    ).toHaveLength(2);
    expect(
      responses.filter((response) => response.status === 503),
    ).toHaveLength(4);
  });

  it("closes active tool streams before application shutdown completes", async () => {
    let resolveUpstreamStarted;
    let resolveUpstreamAborted;
    const upstreamStarted = new Promise((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        resolveUpstreamStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              resolveUpstreamAborted();
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const { app, baseUrl } = await startAppInstance(fetchImpl, {
      requestTimeoutMs: 1_000,
    });
    const sessionId = await initializeSession(baseUrl);
    const toolResponse = await postToSession(
      baseUrl,
      sessionId,
      "test-api-key",
      {
        jsonrpc: "2.0",
        id: 91,
        method: "tools/call",
        params: { name: "reasonkb_list_projects", arguments: {} },
      },
    );
    await upstreamStarted;

    await app.locals.closeMcpSessions();
    await upstreamAborted;
    await expect(toolResponse.text()).resolves.toEqual(expect.any(String));

    const rejected = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(rejected.status).toBe(503);
  });

  it("does not let an unauthenticated slow upload occupy a work slot", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const baseUrl = await startApp(fetchImpl, {
      maxConcurrentRequests: 1,
      requestTimeoutMs: 1_000,
    });
    const url = new URL(baseUrl);
    const slowRequest = http.request({
      hostname: url.hostname,
      port: url.port,
      method: "POST",
      path: "/",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer fake-api-key",
        "content-type": "application/json",
      },
    });
    slowRequest.on("error", () => {});
    slowRequest.write("{");
    await new Promise((resolve) => setTimeout(resolve, 25));

    let validResponse;
    try {
      validResponse = await fetch(baseUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });
    } finally {
      slowRequest.destroy();
    }

    expect(validResponse.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects work above the configured request concurrency", async () => {
    let resolveUpstreamStarted;
    let resolveUpstreamAborted;
    const upstreamStarted = new Promise((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    const upstreamAborted = new Promise((resolve) => {
      resolveUpstreamAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        resolveUpstreamStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              resolveUpstreamAborted();
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl, {
      maxConcurrentRequests: 1,
      requestTimeoutMs: 1_000,
    });
    const firstClient = new Client({
      name: "reasonkb-test-1",
      version: "1.0.0",
    });
    const secondClient = new Client({
      name: "reasonkb-test-2",
      version: "1.0.0",
    });
    clients.push(firstClient, secondClient);
    await firstClient.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );
    await secondClient.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      }),
    );
    const firstController = new AbortController();
    const firstRequest = firstClient.callTool(
      { name: "reasonkb_list_projects", arguments: {} },
      undefined,
      { signal: firstController.signal },
    );
    firstRequest.catch(() => {});
    await upstreamStarted;

    const busyResult = await secondClient.callTool({
      name: "reasonkb_list_projects",
      arguments: {},
    });
    expect(busyResult).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("MCP server is busy."),
        },
      ],
    });
    expect(
      fetchImpl.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/agent/projects"),
      ),
    ).toHaveLength(1);

    firstController.abort();
    await upstreamAborted;
  });
});

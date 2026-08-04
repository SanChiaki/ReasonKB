import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("stdio MCP server", () => {
  it("keeps the existing launcher compatible with official MCP clients", async () => {
    const upstream = http.createServer((request, response) => {
      if (request.url === "/api/agent/auth/verify") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            scopes: ["read:projects", "read:documents", "query", "evidence"],
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
      upstream.listen(0, "127.0.0.1", resolve);
      upstream.on("error", reject);
    });
    const address = upstream.address();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("..", "tools", "reasonkb-mcp.mjs")],
      cwd: path.resolve(".."),
      env: {
        ...process.env,
        REASONKB_API_KEY: "test-api-key",
        REASONKB_URL: `http://127.0.0.1:${address.port}`,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "reasonkb-stdio-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "reasonkb_list_projects",
        "reasonkb_list_documents",
        "reasonkb_query",
        "reasonkb_evidence",
        "reasonkb_get_pages",
        "reasonkb_get_structure",
      ]);
    } finally {
      await client.close();
      await new Promise((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("lists only tools allowed by the configured API key", async () => {
    const upstream = http.createServer((request, response) => {
      if (request.url === "/api/agent/auth/verify") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ scopes: ["evidence"] }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
      upstream.listen(0, "127.0.0.1", resolve);
      upstream.on("error", reject);
    });
    const address = upstream.address();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("..", "tools", "reasonkb-mcp.mjs")],
      cwd: path.resolve(".."),
      env: {
        ...process.env,
        REASONKB_API_KEY: "evidence-only-key",
        REASONKB_URL: `http://127.0.0.1:${address.port}`,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "reasonkb_evidence",
      ]);
    } finally {
      await client.close();
      await new Promise((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("streams retrieval progress before the final tool result", async () => {
    const progressEvent = {
      type: "progress",
      stage: "documents_selected",
      data: { documentCount: 1 },
    };
    const finalResult = {
      answer: "Grounded stdio answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    };
    let upstreamHeaders;
    const upstream = http.createServer((request, response) => {
      if (request.url === "/api/agent/auth/verify") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ scopes: ["query"] }));
        return;
      }
      upstreamHeaders = request.headers;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(progressEvent)}\n\n`);
      setTimeout(() => {
        response.end(
          `data: ${JSON.stringify({ type: "result", data: finalResult })}\n\n`,
        );
      }, 25);
    });
    await new Promise((resolve, reject) => {
      upstream.listen(0, "127.0.0.1", resolve);
      upstream.on("error", reject);
    });
    const address = upstream.address();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("..", "tools", "reasonkb-mcp.mjs")],
      cwd: path.resolve(".."),
      env: {
        ...process.env,
        REASONKB_API_KEY: "test-api-key",
        REASONKB_URL: `http://127.0.0.1:${address.port}`,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "reasonkb-stdio-test", version: "1.0.0" });
    const progress = [];
    let callSettled = false;

    try {
      await client.connect(transport);
      const call = client
        .callTool(
          {
            name: "reasonkb_query",
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

      expect(upstreamHeaders.accept).toBe("text/event-stream");
      expect(progress).toEqual([
        {
          progress: 1,
          message: JSON.stringify(progressEvent),
          callSettled: false,
        },
      ]);
      expect(result.structuredContent).toEqual(finalResult);
    } finally {
      await client.close();
      await new Promise((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cancels an Agent event stream when the stdio client times out", async () => {
    let resolveUpstreamClosed;
    const upstreamClosed = new Promise((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    const progressEvent = {
      type: "progress",
      stage: "retrieval_started",
      data: {},
    };
    const upstream = http.createServer((request, response) => {
      if (request.url === "/api/agent/auth/verify") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ scopes: ["query"] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(progressEvent)}\n\n`);
      response.on("close", resolveUpstreamClosed);
    });
    await new Promise((resolve, reject) => {
      upstream.listen(0, "127.0.0.1", resolve);
      upstream.on("error", reject);
    });
    const address = upstream.address();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("..", "tools", "reasonkb-mcp.mjs")],
      cwd: path.resolve(".."),
      env: {
        ...process.env,
        REASONKB_API_KEY: "test-api-key",
        REASONKB_URL: `http://127.0.0.1:${address.port}`,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "reasonkb-stdio-test", version: "1.0.0" });
    const progress = [];

    try {
      await client.connect(transport);
      const call = client.callTool(
        {
          name: "reasonkb_query",
          arguments: { query: "Cancel the stream", projectIds: [] },
        },
        undefined,
        { timeout: 100, onprogress: (update) => progress.push(update) },
      );

      await expect(call).rejects.toMatchObject({ code: -32001 });
      await expect(
        Promise.race([
          upstreamClosed,
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("upstream connection was not closed")),
              500,
            ),
          ),
        ]),
      ).resolves.toBeUndefined();
      expect(progress).toEqual([
        { progress: 1, message: JSON.stringify(progressEvent) },
      ]);
      await expect(client.listTools()).resolves.toHaveProperty("tools");
    } finally {
      await client.close();
      await new Promise((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

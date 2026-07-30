import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReasonkbMcpHttpApp } from "../mcp-server.mjs";

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

async function startApp(fetchImpl) {
  const app = createReasonkbMcpHttpApp({
    reasonkbUrl: "http://reasonkb.test",
    fetchImpl,
    host: "127.0.0.1",
  });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
  listeners.push(listener);
  const address = listener.address();
  return "http://127.0.0.1:" + address.port;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Streamable HTTP MCP server", () => {
  it("publishes health without an API key", async () => {
    const baseUrl = await startApp(vi.fn());
    const response = await fetch(baseUrl + "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects missing and invalid Bearer API keys", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
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

    const missing = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initialize),
    });
    const invalid = await fetch(baseUrl + "/mcp", {
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

  it("lists and calls tools through the official MCP client", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/api/agent/auth/verify")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/agent/projects")) {
        return jsonResponse({ projects: [{ id: "proj_alpha", name: "Alpha" }] });
      }
      return jsonResponse({ error: "Not found." }, 404);
    });
    const baseUrl = await startApp(fetchImpl);
    const client = new Client({ name: "reasonkb-test", version: "1.0.0" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(baseUrl + "/mcp"),
      {
        requestInit: {
          headers: { Authorization: "Bearer test-api-key" },
        },
      },
    );

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
      new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
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
});

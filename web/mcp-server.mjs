import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DEFAULT_BASE_URL = "http://localhost:43170";
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_INFO = { name: "reasonkb-mcp", version: "0.2.0" };
const MAX_PROJECT_IDS = 100;

function normalizedBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function configuredBaseUrl() {
  return normalizedBaseUrl(process.env.REASONKB_URL || DEFAULT_BASE_URL);
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function reasonkbRequest(pathname, init, context) {
  const { apiKey, baseUrl, fetchImpl } = context;
  const response = await fetchImpl(normalizedBaseUrl(baseUrl) + pathname, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || "ReasonKB returned " + response.status);
  }
  return payload;
}

export function createReasonkbMcpServer({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new Error("REASONKB_API_KEY is required.");
  }
  const server = new McpServer(SERVER_INFO);
  const request = (pathname, init = {}) =>
    reasonkbRequest(pathname, init, { apiKey, baseUrl, fetchImpl });

  server.registerTool(
    "reasonkb_list_projects",
    {
      description: "List ReasonKB projects visible to the configured API key.",
      inputSchema: z.object({}).strict(),
    },
    async () => toolResult(await request("/api/agent/projects")),
  );

  server.registerTool(
    "reasonkb_list_documents",
    {
      description: "List documents in a ReasonKB project.",
      inputSchema: z.object({ projectId: z.string().trim().min(1) }).strict(),
    },
    async ({ projectId }) =>
      toolResult(
        await request(
          "/api/agent/projects/" +
            encodeURIComponent(projectId) +
            "/documents",
        ),
      ),
  );

  for (const [name, route, description] of [
    [
      "reasonkb_query",
      "query",
      "Ask ReasonKB for an answer grounded in indexed documents.",
    ],
    [
      "reasonkb_evidence",
      "evidence",
      "Retrieve document evidence snippets without generating an answer.",
    ],
  ]) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z
          .object({
            query: z.string().trim().min(1),
            projectIds: z
              .array(z.string().trim().min(1))
              .max(MAX_PROJECT_IDS)
              .default([]),
          })
          .strict(),
      },
      async ({ query, projectIds }) =>
        toolResult(
          await request("/api/agent/" + route, {
            method: "POST",
            body: JSON.stringify({ query, projectIds }),
          }),
        ),
    );
  }

  server.registerTool(
    "reasonkb_get_pages",
    {
      description:
        "Read indexed page text for a document, optionally filtered by page range.",
      inputSchema: z
        .object({
          documentId: z.string().trim().min(1),
          pages: z.string().trim().min(1).optional(),
        })
        .strict(),
    },
    async ({ documentId, pages }) => {
      const suffix = pages ? "?pages=" + encodeURIComponent(pages) : "";
      return toolResult(
        await request(
          "/api/agent/documents/" +
            encodeURIComponent(documentId) +
            "/pages" +
            suffix,
        ),
      );
    },
  );

  server.registerTool(
    "reasonkb_get_structure",
    {
      description: "Read the PageIndex tree structure for a document.",
      inputSchema: z.object({ documentId: z.string().trim().min(1) }).strict(),
    },
    async ({ documentId }) =>
      toolResult(
        await request(
          "/api/agent/documents/" +
            encodeURIComponent(documentId) +
            "/structure",
        ),
      ),
  );

  return server;
}

export async function startReasonkbMcpStdioServer() {
  const server = createReasonkbMcpServer({
    apiKey: process.env.REASONKB_API_KEY || "",
    baseUrl: configuredBaseUrl(),
  });
  await server.connect(new StdioServerTransport());
  if (process.env.REASONKB_MCP_DEBUG === "1") {
    console.error("[reasonkb-mcp] stdio transport ready");
  }
  return server;
}

function bearerToken(request) {
  const authorization = request.headers.authorization || "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

function jsonRpcError(response, status, message) {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

async function verifyApiKey(apiKey, { reasonkbUrl, fetchImpl }) {
  return fetchImpl(reasonkbUrl + "/api/agent/auth/verify", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
  });
}

export function createReasonkbMcpHttpApp({
  reasonkbUrl = configuredBaseUrl(),
  fetchImpl = fetch,
  host = process.env.REASONKB_MCP_HOST || "127.0.0.1",
  allowedHosts = (process.env.REASONKB_MCP_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
} = {}) {
  const effectiveAllowedHosts =
    allowedHosts.length > 0 ? allowedHosts : DEFAULT_ALLOWED_HOSTS;
  const app = createMcpExpressApp({
    host,
    allowedHosts: effectiveAllowedHosts,
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/mcp", async (request, response) => {
    const apiKey = bearerToken(request);
    if (!apiKey) {
      response.set("WWW-Authenticate", "Bearer");
      jsonRpcError(response, 401, "Missing Bearer API key.");
      return;
    }

    let authResponse;
    try {
      authResponse = await verifyApiKey(apiKey, { reasonkbUrl, fetchImpl });
    } catch (error) {
      console.error(
        "[reasonkb-mcp-http] authentication service unavailable:",
        error instanceof Error ? error.message : error,
      );
      jsonRpcError(
        response,
        502,
        "ReasonKB authentication service is unavailable.",
      );
      return;
    }
    if (!authResponse.ok) {
      response.set("WWW-Authenticate", "Bearer");
      jsonRpcError(
        response,
        authResponse.status === 401 ? 401 : 502,
        authResponse.status === 401
          ? "Invalid or revoked API key."
          : "ReasonKB authentication service is unavailable.",
      );
      return;
    }

    try {
      const server = createReasonkbMcpServer({
        apiKey,
        baseUrl: reasonkbUrl,
        fetchImpl,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      response.on("close", () => {
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error(
        "[reasonkb-mcp-http] request failed:",
        error instanceof Error ? error.message : error,
      );
      if (!response.headersSent) {
        jsonRpcError(response, 500, "Internal MCP server error.");
      }
    }
  });

  for (const method of ["get", "delete"]) {
    app[method]("/mcp", (_request, response) => {
      response.set("Allow", "POST");
      jsonRpcError(response, 405, "Method not allowed.");
    });
  }

  return app;
}

export function startReasonkbMcpHttpServer() {
  const host = process.env.REASONKB_MCP_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.REASONKB_MCP_PORT || "43173", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("REASONKB_MCP_PORT must be a valid TCP port.");
  }
  const app = createReasonkbMcpHttpApp({ host });
  const listener = app.listen(port, host, () => {
    console.error(
      "[reasonkb-mcp-http] listening on http://" + host + ":" + port + "/mcp",
    );
  });
  listener.on("error", (error) => {
    console.error("[reasonkb-mcp-http] failed to start:", error);
    process.exitCode = 1;
  });
  return listener;
}

async function runEntrypoint() {
  const mode = process.argv[2] || "--stdio";
  if (mode === "--http") {
    startReasonkbMcpHttpServer();
    return;
  }
  if (mode === "--stdio") {
    await startReasonkbMcpStdioServer();
    return;
  }
  throw new Error("Unknown MCP transport option: " + mode);
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  runEntrypoint().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReasonkbMcpServer } from "./reasonkb-tools.mjs";

const DEFAULT_BASE_URL = "http://localhost:43170";
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function baseUrl() {
  return (process.env.REASONKB_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
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
  reasonkbUrl = baseUrl(),
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

const isEntrypoint =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  startReasonkbMcpHttpServer();
}

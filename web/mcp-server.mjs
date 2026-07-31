import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CancelledNotificationSchema,
  ErrorCode,
  InitializedNotificationSchema,
  isInitializeRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";

const DEFAULT_BASE_URL = "http://localhost:43170";
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_INFO = { name: "reasonkb-mcp", version: "0.2.0" };
const MAX_PROJECT_IDS = 100;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 600;
const DEFAULT_PRE_AUTH_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_MAX_CONCURRENT_AUTH_REQUESTS = 32;
const DEFAULT_MAX_CONCURRENT_CONTROL_REQUESTS = 32;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 900;
const MAX_REQUEST_BODY_SIZE = "100kb";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TIMER_DELAY_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000);
const REQUEST_SIGNAL_AUTH_INFO_KEY = "reasonkbRequestSignal";
const MAX_RETRIEVAL_SSE_FRAME_CHARS = 32 * 1024 * 1024;

function normalizedBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function configuredBaseUrl() {
  return normalizedBaseUrl(process.env.REASONKB_URL || DEFAULT_BASE_URL);
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(name + " must be a positive integer.");
  }
  if (parsed > maximum) {
    throw new Error(name + " must be at most " + maximum + ".");
  }
  return parsed;
}

function configuredSecondsAsMilliseconds(name, fallback) {
  const seconds = positiveInteger(
    process.env[name] || fallback,
    name,
    MAX_TIMER_DELAY_SECONDS,
  );
  return seconds * 1000;
}

function configuredRequestTimeoutMs() {
  return configuredSecondsAsMilliseconds(
    "REASONKB_MCP_REQUEST_TIMEOUT_SECONDS",
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
  );
}

function configuredPreAuthTimeoutMs() {
  return configuredSecondsAsMilliseconds(
    "REASONKB_MCP_PRE_AUTH_TIMEOUT_SECONDS",
    DEFAULT_PRE_AUTH_TIMEOUT_SECONDS,
  );
}

function configuredSessionIdleTimeoutMs() {
  return configuredSecondsAsMilliseconds(
    "REASONKB_MCP_SESSION_IDLE_TIMEOUT_SECONDS",
    DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS,
  );
}

function configuredMaxConcurrentRequests() {
  return positiveInteger(
    process.env.REASONKB_MCP_MAX_CONCURRENT_REQUESTS ||
      DEFAULT_MAX_CONCURRENT_REQUESTS,
    "REASONKB_MCP_MAX_CONCURRENT_REQUESTS",
  );
}

function configuredMaxConcurrentAuthRequests() {
  return positiveInteger(
    process.env.REASONKB_MCP_MAX_CONCURRENT_AUTH_REQUESTS ||
      DEFAULT_MAX_CONCURRENT_AUTH_REQUESTS,
    "REASONKB_MCP_MAX_CONCURRENT_AUTH_REQUESTS",
  );
}

function configuredMaxConcurrentControlRequests() {
  return positiveInteger(
    process.env.REASONKB_MCP_MAX_CONCURRENT_CONTROL_REQUESTS ||
      DEFAULT_MAX_CONCURRENT_CONTROL_REQUESTS,
    "REASONKB_MCP_MAX_CONCURRENT_CONTROL_REQUESTS",
  );
}

function configuredMaxSessions() {
  return positiveInteger(
    process.env.REASONKB_MCP_MAX_SESSIONS || DEFAULT_MAX_SESSIONS,
    "REASONKB_MCP_MAX_SESSIONS",
  );
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function combineAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  return AbortSignal.any(activeSignals);
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

function isEventStreamResponse(response) {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === "text/event-stream";
}

function takeCompleteSseFrames(state) {
  const frames = [];
  let scanFrom = Math.max(0, state.scanFrom);

  while (true) {
    let frameEnd = -1;
    let nextFrameStart = -1;
    for (let index = scanFrom; index < state.buffer.length; index += 1) {
      if (state.buffer.charCodeAt(index) !== 10) {
        continue;
      }
      let secondNewline = index + 1;
      if (state.buffer.charCodeAt(secondNewline) === 13) {
        secondNewline += 1;
      }
      if (state.buffer.charCodeAt(secondNewline) !== 10) {
        continue;
      }
      frameEnd =
        index > 0 && state.buffer.charCodeAt(index - 1) === 13 ? index - 1 : index;
      nextFrameStart = secondNewline + 1;
      break;
    }

    if (nextFrameStart < 0) {
      state.scanFrom = Math.max(0, state.buffer.length - 2);
      return frames;
    }

    frames.push(state.buffer.slice(0, frameEnd));
    state.buffer = state.buffer.slice(nextFrameStart);
    scanFrom = 0;
  }
}

function parseSseEvents(state) {
  const events = [];

  for (const part of takeCompleteSseFrames(state)) {
    if (part.length > MAX_RETRIEVAL_SSE_FRAME_CHARS) {
      throw new Error("ReasonKB retrieval event exceeded the maximum frame size.");
    }
    const data = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (data) {
      try {
        events.push(JSON.parse(data));
      } catch {
        throw new Error("ReasonKB retrieval stream contained malformed JSON.");
      }
    }
  }

  if (state.buffer.length > MAX_RETRIEVAL_SSE_FRAME_CHARS) {
    throw new Error("ReasonKB retrieval event exceeded the maximum frame size.");
  }

  return events;
}

async function readRetrievalEventStream(response, onProgress) {
  if (!response.body) {
    throw new Error("ReasonKB returned an empty event stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parserState = { buffer: "", scanFrom: 0 };
  let progress = 0;

  const handleEvents = async (events) => {
    for (const event of events) {
      if (event?.type === "progress") {
        progress += 1;
        await onProgress?.(event, progress);
      } else if (event?.type === "result") {
        if (
          !event.data ||
          typeof event.data !== "object" ||
          Array.isArray(event.data)
        ) {
          throw new Error("ReasonKB retrieval returned a malformed result event.");
        }
        return { found: true, result: event.data };
      }
    }
    return { found: false };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parserState.buffer += decoder.decode(value, { stream: true });
      const handled = await handleEvents(parseSseEvents(parserState));
      if (handled.found) {
        return handled.result;
      }
    }

    parserState.buffer += decoder.decode();
    if (parserState.buffer.trim()) {
      parserState.buffer += "\n\n";
      const handled = await handleEvents(parseSseEvents(parserState));
      if (handled.found) {
        return handled.result;
      }
    }

    throw new Error("ReasonKB event stream ended without a result event.");
  } finally {
    await reader.cancel("ReasonKB retrieval stream finished").catch(() => {});
    reader.releaseLock();
  }
}

async function reasonkbRetrievalRequest(pathname, init, context, onProgress) {
  const { apiKey, baseUrl, fetchImpl } = context;
  const response = await fetchImpl(normalizedBaseUrl(baseUrl) + pathname, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      Accept: "text/event-stream",
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || "ReasonKB returned " + response.status);
  }
  if (!isEventStreamResponse(response)) {
    return response.json().catch(() => null);
  }
  return readRetrievalEventStream(response, onProgress);
}

export function createReasonkbMcpServer({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  abortSignal,
  toolExecutor,
}) {
  if (!apiKey) {
    throw new Error("REASONKB_API_KEY is required.");
  }
  const server = new McpServer(SERVER_INFO);
  const runTool = (operation, extra) =>
    toolExecutor ? toolExecutor(operation, extra) : operation();
  const request = (pathname, init = {}, toolSignal, authInfo) =>
    reasonkbRequest(
      pathname,
      {
        ...init,
        signal: combineAbortSignals(
          abortSignal,
          toolSignal,
          authInfo?.extra?.[REQUEST_SIGNAL_AUTH_INFO_KEY],
        ),
      },
      { apiKey, baseUrl, fetchImpl },
    );
  const retrievalRequest = (
    pathname,
    init = {},
    toolSignal,
    authInfo,
    onProgress,
  ) =>
    reasonkbRetrievalRequest(
      pathname,
      {
        ...init,
        signal: combineAbortSignals(
          abortSignal,
          toolSignal,
          authInfo?.extra?.[REQUEST_SIGNAL_AUTH_INFO_KEY],
        ),
      },
      { apiKey, baseUrl, fetchImpl },
      onProgress,
    );

  server.registerTool(
    "reasonkb_list_projects",
    {
      description: "List ReasonKB projects visible to the configured API key.",
      inputSchema: z.object({}).strict(),
    },
    async (_arguments, extra) =>
      runTool(
        async (executionSignal) =>
          toolResult(
            await request(
              "/api/agent/projects",
              {},
              combineAbortSignals(extra.signal, executionSignal),
              extra.authInfo,
            ),
          ),
        extra,
      ),
  );

  server.registerTool(
    "reasonkb_list_documents",
    {
      description: "List documents in a ReasonKB project.",
      inputSchema: z.object({ projectId: z.string().trim().min(1) }).strict(),
    },
    async ({ projectId }, extra) =>
      runTool(
        async (executionSignal) =>
          toolResult(
            await request(
              "/api/agent/projects/" +
                encodeURIComponent(projectId) +
                "/documents",
              {},
              combineAbortSignals(extra.signal, executionSignal),
              extra.authInfo,
            ),
          ),
        extra,
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
      async ({ query, projectIds }, extra) =>
        runTool(async (executionSignal) => {
          const progressToken = extra._meta?.progressToken;
          const onProgress =
            progressToken === undefined
              ? undefined
              : (event, progress) =>
                  extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress,
                      message: JSON.stringify(event),
                    },
                  });
          return toolResult(
            await retrievalRequest(
              "/api/agent/" + route,
              {
                method: "POST",
                body: JSON.stringify({ query, projectIds }),
              },
              combineAbortSignals(extra.signal, executionSignal),
              extra.authInfo,
              onProgress,
            ),
          );
        }, extra),
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
    async ({ documentId, pages }, extra) =>
      runTool(async (executionSignal) => {
        const suffix = pages ? "?pages=" + encodeURIComponent(pages) : "";
        return toolResult(
          await request(
            "/api/agent/documents/" +
              encodeURIComponent(documentId) +
              "/pages" +
              suffix,
            {},
            combineAbortSignals(extra.signal, executionSignal),
            extra.authInfo,
          ),
        );
      }, extra),
  );

  server.registerTool(
    "reasonkb_get_structure",
    {
      description: "Read the PageIndex tree structure for a document.",
      inputSchema: z.object({ documentId: z.string().trim().min(1) }).strict(),
    },
    async ({ documentId }, extra) =>
      runTool(
        async (executionSignal) =>
          toolResult(
            await request(
              "/api/agent/documents/" +
                encodeURIComponent(documentId) +
                "/structure",
              {},
              combineAbortSignals(extra.signal, executionSignal),
              extra.authInfo,
            ),
          ),
        extra,
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

function jsonRpcError(response, status, message, code = -32000) {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestBodyError(error, request, response, _next) {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  if (error?.type === "request.aborted" || request.aborted) {
    response.end();
    return;
  }
  if (error?.type === "entity.too.large") {
    jsonRpcError(response, 413, "Request body is too large.");
    return;
  }
  if (error?.type === "entity.parse.failed") {
    jsonRpcError(response, 400, "Malformed JSON request body.");
    return;
  }
  console.error(
    "[reasonkb-mcp-http] request middleware failed:",
    error instanceof Error ? error.message : error,
  );
  jsonRpcError(response, 500, "Internal MCP server error.");
}

async function verifyApiKey(apiKey, { reasonkbUrl, fetchImpl, signal }) {
  return fetchImpl(reasonkbUrl + "/api/agent/auth/verify", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    signal,
  });
}

function normalizeAllowedOrigins(values) {
  return values.map((value) => {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol)) {
      throw new Error("MCP allowed origins must use HTTP or HTTPS.");
    }
    return origin.origin;
  });
}

function originIsAllowed(request, allowedOrigins) {
  const originHeader = request.headers.origin;
  if (!originHeader) {
    return true;
  }
  try {
    const origin = new URL(originHeader);
    return (
      ["http:", "https:"].includes(origin.protocol) &&
      (origin.host === request.headers.host ||
        allowedOrigins.includes(origin.origin))
    );
  } catch {
    return false;
  }
}

function apiKeyFingerprint(apiKey) {
  return createHash("sha256").update(apiKey).digest();
}

function sessionIdFromRequest(request) {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" ? value.trim() : "";
}

function parseControlNotification(message) {
  if (!isJSONRPCNotification(message)) {
    return undefined;
  }
  if (InitializedNotificationSchema.safeParse(message).success) {
    return { type: "initialized" };
  }
  const cancelled = CancelledNotificationSchema.safeParse(message);
  if (cancelled.success) {
    return {
      type: "cancelled",
      requestId: cancelled.data.params.requestId,
      reason: cancelled.data.params.reason,
    };
  }
  return undefined;
}

function analyzeControlMessages(body) {
  const messages = Array.isArray(body) ? body : [body];
  const controls = messages.map(parseControlNotification);
  const parsedControls = controls.filter(Boolean);
  return {
    allControl:
      messages.length > 0 && parsedControls.length === messages.length,
    cancellationOnly:
      messages.length > 0 &&
      parsedControls.length === messages.length &&
      parsedControls.every((control) => control.type === "cancelled"),
    cancellations: parsedControls.filter(
      (control) => control.type === "cancelled",
    ),
  };
}

export function createReasonkbMcpHttpApp({
  reasonkbUrl = configuredBaseUrl(),
  fetchImpl = fetch,
  host = process.env.REASONKB_MCP_HOST || "127.0.0.1",
  allowedHosts = (process.env.REASONKB_MCP_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  allowedOrigins = (process.env.REASONKB_MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  requestTimeoutMs = configuredRequestTimeoutMs(),
  preAuthTimeoutMs = configuredPreAuthTimeoutMs(),
  maxConcurrentRequests = configuredMaxConcurrentRequests(),
  maxConcurrentAuthRequests = configuredMaxConcurrentAuthRequests(),
  maxConcurrentControlRequests = configuredMaxConcurrentControlRequests(),
  maxSessions = configuredMaxSessions(),
  sessionIdleTimeoutMs = configuredSessionIdleTimeoutMs(),
} = {}) {
  const effectiveRequestTimeoutMs = positiveInteger(
    requestTimeoutMs,
    "MCP request timeout",
    MAX_TIMER_DELAY_MS,
  );
  const effectivePreAuthTimeoutMs = positiveInteger(
    preAuthTimeoutMs,
    "MCP pre-authentication timeout",
    MAX_TIMER_DELAY_MS,
  );
  const effectiveMaxConcurrentRequests = positiveInteger(
    maxConcurrentRequests,
    "MCP maximum concurrent requests",
  );
  const effectiveMaxConcurrentAuthRequests = positiveInteger(
    maxConcurrentAuthRequests,
    "MCP maximum concurrent authentication requests",
  );
  const effectiveMaxConcurrentControlRequests = positiveInteger(
    maxConcurrentControlRequests,
    "MCP maximum concurrent control requests",
  );
  const effectiveMaxSessions = positiveInteger(
    maxSessions,
    "MCP maximum sessions",
  );
  const effectiveSessionIdleTimeoutMs = positiveInteger(
    sessionIdleTimeoutMs,
    "MCP session idle timeout",
    MAX_TIMER_DELAY_MS,
  );
  const effectiveAllowedHosts =
    allowedHosts.length > 0 ? allowedHosts : DEFAULT_ALLOWED_HOSTS;
  const effectiveAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);
  const app = express();
  const requestContexts = new WeakMap();
  const sessions = new Map();
  const pendingSessions = new Set();
  let activeAuthRequests = 0;
  let activeControlRequests = 0;
  let activeToolRequests = 0;
  let shuttingDown = false;

  function abortPendingRequests(entry) {
    const reason = new Error("MCP session closed.");
    for (const pendingRequest of entry.pendingRequests?.values() ?? []) {
      pendingRequest.cancelled = true;
      pendingRequest.abortController.abort(reason);
      if (
        pendingRequest.dispatched ||
        pendingRequest.response.destroyed ||
        pendingRequest.response.writableEnded
      ) {
        continue;
      }
      if (!pendingRequest.response.headersSent) {
        if (shuttingDown) {
          pendingRequest.response.set("Retry-After", "1");
          jsonRpcError(
            pendingRequest.response,
            503,
            "MCP server is shutting down.",
          );
        } else {
          jsonRpcError(
            pendingRequest.response,
            404,
            "MCP session not found.",
            -32001,
          );
        }
      } else {
        pendingRequest.response.end();
      }
    }
    entry.pendingRequests?.clear();
  }

  function cleanupSession(entry) {
    if (entry.pending) {
      entry.pending = false;
      pendingSessions.delete(entry);
    }
    if (entry.sessionId && sessions.get(entry.sessionId) === entry) {
      sessions.delete(entry.sessionId);
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    abortPendingRequests(entry);
    entry.closed = true;
  }

  function closeSession(entry) {
    if (entry.closingPromise) {
      return entry.closingPromise;
    }
    cleanupSession(entry);
    for (const tool of entry.activeTools.values()) {
      tool.abortController.abort(new Error("MCP session closed."));
    }
    entry.closingPromise = Promise.resolve(entry.server?.close()).catch(
      (error) => {
        console.error(
          "[reasonkb-mcp-http] failed to close session:",
          error instanceof Error ? error.message : error,
        );
      },
    );
    return entry.closingPromise;
  }

  function armSessionIdleTimer(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    if (
      entry.closed ||
      entry.inFlight > 0 ||
      !entry.sessionId ||
      sessions.get(entry.sessionId) !== entry
    ) {
      return;
    }
    const remaining = entry.expiresAt - Date.now();
    if (remaining <= 0) {
      void closeSession(entry);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.inFlight === 0 && Date.now() >= entry.expiresAt) {
        void closeSession(entry);
      } else {
        armSessionIdleTimer(entry);
      }
    }, remaining);
    entry.idleTimer.unref?.();
  }

  function attachSession(context, entry, refreshOnFinish) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.inFlight += 1;
    context.session = entry;
    context.refreshSessionOnFinish = refreshOnFinish;
  }

  function detachSession(context) {
    const entry = context.session;
    if (!entry) {
      return;
    }
    context.session = undefined;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (context.refreshSessionOnFinish && !entry.closed) {
      entry.expiresAt = Date.now() + effectiveSessionIdleTimeoutMs;
    }
    if (!entry.closed && entry.inFlight === 0) {
      armSessionIdleTimer(entry);
    }
  }

  function clearRequestDeadline(context) {
    clearTimeout(context.timeout);
    context.timeout = undefined;
  }

  function finishRequestContext(context) {
    if (context.finished) {
      return;
    }
    context.finished = true;
    clearRequestDeadline(context);
    detachSession(context);
  }

  function startPreAuthDeadline(request, response, context) {
    context.timeout = setTimeout(() => {
      context.abortController.abort(new Error("MCP request timed out."));
      if (!response.headersSent) {
        response.set("Connection", "close");
        if (!request.complete) {
          response.once("finish", () => request.destroy());
        }
        jsonRpcError(response, 504, "MCP request timed out.");
      } else if (!response.writableEnded) {
        response.end();
      }
    }, effectivePreAuthTimeoutMs);
    context.timeout.unref?.();
  }

  async function authenticate(apiKey, response, context, session) {
    if (activeAuthRequests >= effectiveMaxConcurrentAuthRequests) {
      response.set("Retry-After", "1");
      jsonRpcError(response, 503, "MCP authentication service is busy.");
      return false;
    }
    activeAuthRequests += 1;
    let authResponse;
    try {
      authResponse = await verifyApiKey(apiKey, {
        reasonkbUrl,
        fetchImpl,
        signal: context.abortController.signal,
      });
    } catch (error) {
      if (context.abortController.signal.aborted) {
        return false;
      }
      console.error(
        "[reasonkb-mcp-http] authentication service unavailable:",
        error instanceof Error ? error.message : error,
      );
      jsonRpcError(
        response,
        502,
        "ReasonKB authentication service is unavailable.",
      );
      return false;
    } finally {
      activeAuthRequests -= 1;
    }
    if (authResponse.ok) {
      return true;
    }
    response.set("WWW-Authenticate", "Bearer");
    jsonRpcError(
      response,
      authResponse.status === 401 ? 401 : 502,
      authResponse.status === 401
        ? "Invalid or revoked API key."
        : "ReasonKB authentication service is unavailable.",
    );
    if (authResponse.status === 401 && session) {
      void closeSession(session);
    }
    return false;
  }

  async function executeTool(operation, extra) {
    if (activeToolRequests >= effectiveMaxConcurrentRequests) {
      throw new McpError(ErrorCode.ConnectionClosed, "MCP server is busy.");
    }
    const session = sessions.get(extra.sessionId);
    if (!session || session.closed) {
      throw new McpError(ErrorCode.ConnectionClosed, "MCP session is closed.");
    }
    if (session.activeTools.has(extra.requestId)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "An MCP request with this ID is already active.",
      );
    }

    activeToolRequests += 1;
    const abortController = new AbortController();
    const activeTool = { abortController };
    session.activeTools.set(extra.requestId, activeTool);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error("MCP request timed out."));
    }, effectiveRequestTimeoutMs);
    timeout.unref?.();
    try {
      if (extra.signal.aborted) {
        abortController.abort(extra.signal.reason);
      }
      return await operation(
        combineAbortSignals(abortController.signal, timeoutController.signal),
      );
    } catch (error) {
      if (timeoutController.signal.aborted && !extra.signal.aborted) {
        throw new McpError(ErrorCode.RequestTimeout, "MCP request timed out.");
      }
      if (abortController.signal.aborted && !extra.signal.aborted) {
        throw new McpError(
          ErrorCode.ConnectionClosed,
          "MCP request cancelled.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (session.activeTools.get(extra.requestId) === activeTool) {
        session.activeTools.delete(extra.requestId);
      }
      activeToolRequests -= 1;
    }
  }

  function matchPendingCancellations(session, cancellations) {
    return cancellations.flatMap((cancellation) => {
      const pendingRequest = session.pendingRequests.get(
        cancellation.requestId,
      );
      return pendingRequest ? [{ cancellation, pendingRequest }] : [];
    });
  }

  function cancelUndispatchedRequests(session, matches) {
    for (const { cancellation, pendingRequest } of matches) {
      if (pendingRequest.dispatched) {
        continue;
      }
      if (
        session.pendingRequests.get(cancellation.requestId) === pendingRequest
      ) {
        session.pendingRequests.delete(cancellation.requestId);
      }
      pendingRequest.cancelled = true;
      pendingRequest.abortController.abort(
        new Error(cancellation.reason || "MCP request cancelled."),
      );
      if (
        pendingRequest.response.destroyed ||
        pendingRequest.response.writableEnded
      ) {
        continue;
      }
      if (!pendingRequest.response.headersSent) {
        pendingRequest.response.status(204).end();
      } else if (!pendingRequest.response.writableEnded) {
        pendingRequest.response.end();
      }
    }
  }

  function abortCancelledTools(session, matches) {
    for (const { cancellation, pendingRequest } of matches) {
      if (!pendingRequest.dispatched) {
        continue;
      }
      pendingRequest.abortController.abort(
        new Error(cancellation.reason || "MCP request cancelled."),
      );
      const tool = session.activeTools.get(cancellation.requestId);
      tool?.abortController.abort(
        new Error(cancellation.reason || "MCP request cancelled."),
      );
    }
  }

  function isMissingRequestStreamError(error, requestId) {
    return (
      error instanceof Error &&
      error.message ===
        "No connection established for request ID: " + String(requestId)
    );
  }

  async function finishCancelledStreams(session, matches) {
    await Promise.resolve();
    abortCancelledTools(session, matches);
    for (const { cancellation, pendingRequest } of matches) {
      if (!pendingRequest.dispatched) {
        continue;
      }
      session.transport.closeSSEStream(cancellation.requestId);
      try {
        await session.transport.send({
          jsonrpc: "2.0",
          id: cancellation.requestId,
          error: {
            code: ErrorCode.ConnectionClosed,
            message: "MCP request cancelled.",
          },
        });
      } catch (error) {
        if (!isMissingRequestStreamError(error, cancellation.requestId)) {
          throw error;
        }
        // SDK 1.30.0 releases the request correlation before this error.
      }
    }
  }

  function setRequestAuthInfo(request, fingerprint, context) {
    request.auth = {
      token: fingerprint.toString("hex"),
      clientId: "reasonkb-api-key",
      scopes: [],
      extra: {
        [REQUEST_SIGNAL_AUTH_INFO_KEY]: context.abortController.signal,
      },
    };
  }

  function currentSession(sessionId, fingerprint) {
    const entry = sessions.get(sessionId);
    if (
      !entry ||
      entry.closed ||
      !timingSafeEqual(entry.apiKeyFingerprint, fingerprint)
    ) {
      return undefined;
    }
    return entry;
  }

  function closeExpiredSessions() {
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (entry.inFlight === 0 && entry.expiresAt <= now) {
        void closeSession(entry);
      }
    }
  }

  async function initializeSession(
    request,
    response,
    context,
    apiKey,
    fingerprint,
  ) {
    const entry = {
      apiKeyFingerprint: fingerprint,
      activeTools: new Map(),
      closed: false,
      closingPromise: undefined,
      expiresAt: Date.now() + effectiveSessionIdleTimeoutMs,
      idleTimer: undefined,
      inFlight: 0,
      pending: true,
      pendingRequests: new Map(),
      server: undefined,
      sessionId: undefined,
      transport: undefined,
    };
    pendingSessions.add(entry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        entry.sessionId = sessionId;
        entry.pending = false;
        pendingSessions.delete(entry);
        if (entry.closed || shuttingDown) {
          void closeSession(entry);
          return;
        }
        sessions.set(sessionId, entry);
        attachSession(context, entry, true);
      },
    });
    entry.transport = transport;
    transport.onclose = () => cleanupSession(entry);
    entry.server = createReasonkbMcpServer({
      apiKey,
      baseUrl: reasonkbUrl,
      fetchImpl,
      toolExecutor: executeTool,
    });

    try {
      await entry.server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      if (!entry.sessionId) {
        await closeSession(entry);
      }
    }
  }

  app.use(hostHeaderValidation(effectiveAllowedHosts));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.all("/", (request, response, next) => {
    if (!originIsAllowed(request, effectiveAllowedOrigins)) {
      jsonRpcError(response, 403, "Invalid Origin header.");
      return;
    }
    next();
  });

  app.get("/", (_request, response) => {
    response.set("Allow", "POST, DELETE");
    jsonRpcError(response, 405, "Method not allowed.");
  });

  app.all("/", (request, response, next) => {
    if (!bearerToken(request)) {
      response.set("WWW-Authenticate", "Bearer");
      jsonRpcError(response, 401, "Missing Bearer API key.");
      return;
    }
    const abortController = new AbortController();
    const context = {
      abortController,
      finished: false,
      refreshSessionOnFinish: false,
      session: undefined,
      timeout: undefined,
    };
    requestContexts.set(request, context);
    startPreAuthDeadline(request, response, context);

    request.once("aborted", () => abortController.abort());
    response.once("finish", () => finishRequestContext(context));
    response.once("close", () => {
      if (!response.writableEnded) {
        abortController.abort();
      }
      finishRequestContext(context);
    });
    next();
  });

  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));

  app.post("/", async (request, response) => {
    const apiKey = bearerToken(request);
    const context = requestContexts.get(request);
    const fingerprint = apiKeyFingerprint(apiKey);
    const sessionId = sessionIdFromRequest(request);
    let session;

    if (shuttingDown) {
      response.set("Retry-After", "1");
      jsonRpcError(response, 503, "MCP server is shutting down.");
      return;
    }

    if (Array.isArray(request.body)) {
      jsonRpcError(
        response,
        400,
        "JSON-RPC batches are not supported.",
        ErrorCode.InvalidRequest,
      );
      return;
    }

    if (sessionId) {
      session = currentSession(sessionId, fingerprint);
      if (!session) {
        jsonRpcError(response, 404, "MCP session not found.", -32001);
        return;
      }
    } else if (!isInitializeRequest(request.body)) {
      jsonRpcError(response, 400, "A valid MCP session is required.");
      return;
    }

    if (session) {
      const control = analyzeControlMessages(request.body);
      const rpcRequest = isJSONRPCRequest(request.body)
        ? request.body
        : undefined;
      let pendingRequest;
      if (rpcRequest && session.pendingRequests.has(rpcRequest.id)) {
        jsonRpcError(
          response,
          400,
          "An MCP request with this ID is already active.",
          ErrorCode.InvalidRequest,
        );
        return;
      }
      if (rpcRequest) {
        pendingRequest = {
          abortController: context.abortController,
          cancelled: false,
          dispatched: false,
          response,
        };
        session.pendingRequests.set(rpcRequest.id, pendingRequest);
      }
      let controlSlot = false;
      if (control.allControl) {
        if (activeControlRequests >= effectiveMaxConcurrentControlRequests) {
          response.set("Retry-After", "1");
          jsonRpcError(response, 503, "MCP control service is busy.");
          return;
        }
        activeControlRequests += 1;
        controlSlot = true;
      }
      try {
        if (
          !control.cancellationOnly &&
          !(await authenticate(apiKey, response, context, session))
        ) {
          return;
        }
        clearRequestDeadline(context);
        if (
          context.abortController.signal.aborted ||
          response.writableEnded ||
          (pendingRequest &&
            (pendingRequest.cancelled ||
              session.pendingRequests.get(rpcRequest.id) !== pendingRequest))
        ) {
          return;
        }
        if (session.closed || sessions.get(sessionId) !== session) {
          jsonRpcError(response, 404, "MCP session not found.", -32001);
          return;
        }
        attachSession(context, session, !control.allControl);
        setRequestAuthInfo(request, fingerprint, context);
        if (pendingRequest) {
          pendingRequest.dispatched = true;
        }
        const matchedCancellations = matchPendingCancellations(
          session,
          control.cancellations,
        );
        cancelUndispatchedRequests(session, matchedCancellations);
        await session.transport.handleRequest(request, response, request.body);
        await finishCancelledStreams(session, matchedCancellations);
      } catch (error) {
        if (context.abortController.signal.aborted) {
          return;
        }
        console.error(
          "[reasonkb-mcp-http] request failed:",
          error instanceof Error ? error.message : error,
        );
        if (!response.headersSent) {
          jsonRpcError(response, 500, "Internal MCP server error.");
        }
      } finally {
        if (
          pendingRequest &&
          session.pendingRequests.get(rpcRequest.id) === pendingRequest
        ) {
          session.pendingRequests.delete(rpcRequest.id);
        }
        if (controlSlot) {
          activeControlRequests -= 1;
        }
      }
      return;
    }

    if (!(await authenticate(apiKey, response, context))) {
      return;
    }
    clearRequestDeadline(context);

    closeExpiredSessions();
    if (sessions.size + pendingSessions.size >= effectiveMaxSessions) {
      response.set("Retry-After", "1");
      jsonRpcError(response, 503, "MCP session capacity reached.");
      return;
    }

    try {
      setRequestAuthInfo(request, fingerprint, context);
      await initializeSession(request, response, context, apiKey, fingerprint);
    } catch (error) {
      if (context.abortController.signal.aborted) {
        return;
      }
      console.error(
        "[reasonkb-mcp-http] request failed:",
        error instanceof Error ? error.message : error,
      );
      if (!response.headersSent) {
        jsonRpcError(response, 500, "Internal MCP server error.");
      }
    }
  });

  app.delete("/", async (request, response) => {
    const apiKey = bearerToken(request);
    const context = requestContexts.get(request);
    const fingerprint = apiKeyFingerprint(apiKey);
    const sessionId = sessionIdFromRequest(request);
    const session = currentSession(sessionId, fingerprint);
    if (shuttingDown) {
      response.set("Retry-After", "1");
      jsonRpcError(response, 503, "MCP server is shutting down.");
      return;
    }
    if (!session) {
      jsonRpcError(response, 404, "MCP session not found.", -32001);
      return;
    }
    if (!(await authenticate(apiKey, response, context, session))) {
      return;
    }
    clearRequestDeadline(context);
    if (session.closed || sessions.get(sessionId) !== session) {
      jsonRpcError(response, 404, "MCP session not found.", -32001);
      return;
    }
    attachSession(context, session, false);
    setRequestAuthInfo(request, fingerprint, context);
    try {
      await session.transport.handleRequest(request, response);
    } catch (error) {
      if (context.abortController.signal.aborted) {
        return;
      }
      console.error(
        "[reasonkb-mcp-http] session termination failed:",
        error instanceof Error ? error.message : error,
      );
      if (!response.headersSent) {
        jsonRpcError(response, 500, "Internal MCP server error.");
      }
    }
  });

  app.all("/", (_request, response) => {
    response.set("Allow", "GET, POST, DELETE");
    jsonRpcError(response, 405, "Method not allowed.");
  });

  app.use(requestBodyError);

  app.locals.closeMcpSessions = async () => {
    shuttingDown = true;
    const activeSessions = [
      ...new Set([...sessions.values(), ...pendingSessions.values()]),
    ];
    await Promise.allSettled(
      activeSessions.map((entry) => closeSession(entry)),
    );
  };

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
      "[reasonkb-mcp-http] listening on http://" + host + ":" + port,
    );
  });
  listener.on("error", (error) => {
    console.error("[reasonkb-mcp-http] failed to start:", error);
    process.exitCode = 1;
  });
  const closeListener = listener.close.bind(listener);
  let shutdownPromise;
  listener.close = (callback) => {
    shutdownPromise ??= app.locals.closeMcpSessions().then(
      () =>
        new Promise((resolve, reject) => {
          closeListener((error) => (error ? reject(error) : resolve()));
        }),
    );
    if (callback) {
      void shutdownPromise.then(() => callback(), callback);
    }
    return listener;
  };
  return listener;
}

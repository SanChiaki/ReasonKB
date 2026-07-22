#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://localhost:43170";

function baseUrl() {
  return (process.env.REASONKB_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKey() {
  return process.env.REASONKB_API_KEY || "";
}

async function reasonkbRequest(path, init = {}) {
  const key = apiKey();
  if (!key) {
    throw new Error("REASONKB_API_KEY is required.");
  }
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `ReasonKB returned ${response.status}`);
  }
  return payload;
}

const tools = [
  {
    name: "reasonkb_list_projects",
    description: "List ReasonKB projects visible to the configured API key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reasonkb_list_documents",
    description: "List documents in a ReasonKB project.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "reasonkb_query",
    description: "Ask ReasonKB for an answer grounded in indexed documents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectIds: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reasonkb_evidence",
    description: "Retrieve document evidence snippets without generating an answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectIds: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reasonkb_get_pages",
    description: "Read indexed page text for a document, optionally filtered by page range.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        pages: { type: "string" },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "reasonkb_get_structure",
    description: "Read the PageIndex tree structure for a document.",
    inputSchema: {
      type: "object",
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  if (name === "reasonkb_list_projects") {
    return reasonkbRequest("/api/agent/projects");
  }
  if (name === "reasonkb_list_documents") {
    return reasonkbRequest(
      `/api/agent/projects/${encodeURIComponent(args.projectId)}/documents`,
    );
  }
  if (name === "reasonkb_query" || name === "reasonkb_evidence") {
    const route = name === "reasonkb_query" ? "query" : "evidence";
    return reasonkbRequest(`/api/agent/${route}`, {
      method: "POST",
      body: JSON.stringify({
        query: args.query,
        projectIds: args.projectIds || [],
      }),
    });
  }
  if (name === "reasonkb_get_pages") {
    const suffix = args.pages ? `?pages=${encodeURIComponent(args.pages)}` : "";
    return reasonkbRequest(
      `/api/agent/documents/${encodeURIComponent(args.documentId)}/pages${suffix}`,
    );
  }
  if (name === "reasonkb_get_structure") {
    return reasonkbRequest(
      `/api/agent/documents/${encodeURIComponent(args.documentId)}/structure`,
    );
  }
  throw new Error(`Unknown tool: ${name}`);
}

function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function send(message) {
  process.stdout.write(encodeMessage(message));
}

function debug(message) {
  if (process.env.REASONKB_MCP_DEBUG === "1") {
    console.error(`[reasonkb-mcp] ${message}`);
  }
}

async function handleRequest(message) {
  if (!message || typeof message !== "object" || !message.method) {
    return;
  }
  const { id, method, params } = message;
  debug(`received ${method}${id === undefined ? "" : ` #${id}`}`);
  if (id === undefined) {
    return;
  }

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "reasonkb-mcp", version: "0.1.0" },
        },
      });
      return;
    }
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
      return;
    }
    if (method === "resources/list") {
      send({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    }
    if (method === "prompts/list") {
      send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    }
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments || {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Tool call failed.",
      },
    });
  }
}

let buffer = "";

function consumeMessages() {
  while (true) {
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd === -1) {
      return;
    }
    const raw = buffer.slice(0, lineEnd).replace(/\r$/, "");
    buffer = buffer.slice(lineEnd + 1);
    if (!raw.trim()) {
      continue;
    }
    Promise.resolve()
      .then(() => handleRequest(JSON.parse(raw)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
      });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  consumeMessages();
});

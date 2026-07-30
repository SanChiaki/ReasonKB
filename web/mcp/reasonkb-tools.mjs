import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_INFO = { name: "reasonkb-mcp", version: "0.2.0" };
const MAX_PROJECT_IDS = 100;

function normalizedBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function reasonkbRequest(path, init, context) {
  const { apiKey, baseUrl, fetchImpl } = context;
  const response = await fetchImpl(normalizedBaseUrl(baseUrl) + path, {
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
  const request = (path, init = {}) =>
    reasonkbRequest(path, init, { apiKey, baseUrl, fetchImpl });

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

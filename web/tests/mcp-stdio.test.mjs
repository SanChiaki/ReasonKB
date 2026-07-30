import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("stdio MCP server", () => {
  it("keeps the existing launcher compatible with official MCP clients", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("..", "tools", "reasonkb-mcp.mjs")],
      cwd: path.resolve(".."),
      env: {
        ...process.env,
        REASONKB_API_KEY: "test-api-key",
        REASONKB_URL: "http://reasonkb.test",
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
    }
  });
});

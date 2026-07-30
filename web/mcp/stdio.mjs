import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createReasonkbMcpServer } from "./reasonkb-tools.mjs";

const baseUrl = (process.env.REASONKB_URL || "http://localhost:43170").replace(
  /\/+$/,
  "",
);
const apiKey = process.env.REASONKB_API_KEY || "";

async function main() {
  const server = createReasonkbMcpServer({ apiKey, baseUrl });
  await server.connect(new StdioServerTransport());
  if (process.env.REASONKB_MCP_DEBUG === "1") {
    console.error("[reasonkb-mcp] stdio transport ready");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

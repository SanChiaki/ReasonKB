#!/usr/bin/env node

import {
  startReasonkbMcpHttpServer,
  startReasonkbMcpStdioServer,
} from "../web/mcp-server.mjs";

async function main() {
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

#!/usr/bin/env node

import {
  startReasonkbMcpHttpServer,
  startReasonkbMcpStdioServer,
} from "../web/mcp-server.mjs";

async function main() {
  const mode = process.argv[2] || "--stdio";
  if (mode === "--http") {
    const listener = startReasonkbMcpHttpServer();
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      listener.close((error) => {
        if (error) {
          console.error(error instanceof Error ? error.message : error);
          process.exitCode = 1;
        }
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
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

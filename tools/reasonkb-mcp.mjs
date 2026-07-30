#!/usr/bin/env node

import { startReasonkbMcpStdioServer } from "../web/mcp-server.mjs";

startReasonkbMcpStdioServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

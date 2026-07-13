import path from "node:path";
import { defineConfig } from "@playwright/test";

// We assume this is executed with CWD=web (via `pnpm -C web e2e`).
const repoRoot = path.resolve(process.cwd(), "..");
const e2eVarRoot = path.join(repoRoot, "var-e2e");
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

const config = defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  reporter: "list",
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: externalBaseUrl ? undefined : {
    // Keep the e2e run deterministic by starting with a clean, isolated var root.
    command:
      "node -e \"require('fs').rmSync(process.env.APP_VAR_ROOT,{recursive:true,force:true})\" && pnpm db:migrate && pnpm dev",
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      APP_VAR_ROOT: e2eVarRoot,
    },
  },
});

export default config;

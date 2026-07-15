#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://localhost:43170";

function usage() {
  console.log(`ReasonKB CLI

Environment:
  REASONKB_URL             ReasonKB web URL, default ${DEFAULT_BASE_URL}
  REASONKB_API_KEY         API key for /api/agent/* requests
  REASONKB_ADMIN_PASSWORD  Administrator password used only by create-key

Commands:
  create-key --name NAME [--scope SCOPE ...] [--project PROJECT_ID ...]
  projects
  documents PROJECT_ID
  query QUERY [--project PROJECT_ID ...]
  evidence QUERY [--project PROJECT_ID ...]
  pages DOCUMENT_ID [--pages PAGE_RANGE]
  structure DOCUMENT_ID
`);
}

function baseUrl() {
  return (process.env.REASONKB_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKey() {
  return process.env.REASONKB_API_KEY || "";
}

function parseOptions(args) {
  const values = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      values.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }
  return { values, options };
}

function optionList(options, key) {
  const value = options[key];
  if (value === undefined || value === true) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function request(path, init = {}, { requireKey = true } = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  if (requireKey) {
    const key = apiKey();
    if (!key) {
      throw new Error("REASONKB_API_KEY is required for this command.");
    }
    headers.Authorization = `Bearer ${key}`;
  }
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `ReasonKB returned ${response.status}`);
  }
  return payload;
}

async function adminSessionHeaders() {
  const password = process.env.REASONKB_ADMIN_PASSWORD || "";
  if (!password) {
    throw new Error("REASONKB_ADMIN_PASSWORD is required for create-key.");
  }
  const response = await fetch(`${baseUrl()}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `ReasonKB returned ${response.status}`);
  }
  const setCookies = response.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  if (!cookie || !payload?.csrfToken) {
    throw new Error("ReasonKB did not return an administrator session.");
  }
  return {
    Cookie: cookie,
    "x-reasonkb-csrf": payload.csrfToken,
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  const { values, options } = parseOptions(rest);
  if (command === "create-key") {
    const name = options.name;
    if (!name || name === true) {
      throw new Error("create-key requires --name NAME.");
    }
    const adminHeaders = await adminSessionHeaders();
    printJson(
      await request(
        "/api/admin/api-keys",
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({
            name,
            scopes: optionList(options, "scope"),
            projectIds: optionList(options, "project"),
          }),
        },
        { requireKey: false },
      ),
    );
    return;
  }

  if (command === "projects") {
    printJson(await request("/api/agent/projects"));
    return;
  }

  if (command === "documents") {
    const projectId = values[0];
    if (!projectId) {
      throw new Error("documents requires PROJECT_ID.");
    }
    printJson(await request(`/api/agent/projects/${encodeURIComponent(projectId)}/documents`));
    return;
  }

  if (command === "query" || command === "evidence") {
    const query = values.join(" ").trim();
    if (!query) {
      throw new Error(`${command} requires QUERY.`);
    }
    printJson(
      await request(`/api/agent/${command}`, {
        method: "POST",
        body: JSON.stringify({
          query,
          projectIds: optionList(options, "project"),
        }),
      }),
    );
    return;
  }

  if (command === "pages") {
    const documentId = values[0];
    if (!documentId) {
      throw new Error("pages requires DOCUMENT_ID.");
    }
    const pageRange = options.pages && options.pages !== true ? String(options.pages) : "";
    const suffix = pageRange ? `?pages=${encodeURIComponent(pageRange)}` : "";
    printJson(
      await request(`/api/agent/documents/${encodeURIComponent(documentId)}/pages${suffix}`),
    );
    return;
  }

  if (command === "structure") {
    const documentId = values[0];
    if (!documentId) {
      throw new Error("structure requires DOCUMENT_ID.");
    }
    printJson(
      await request(`/api/agent/documents/${encodeURIComponent(documentId)}/structure`),
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

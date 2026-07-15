# Agent Access

ReasonKB exposes a small API-key protected surface for local agents, CLI tools,
and MCP clients. The agent-facing routes live under `/api/agent/*` on the web
service. They do not write chat conversation history.

## Configuration

Set these environment variables for production-like Docker deployments:

```env
REASONKB_API_KEY_PEPPER=long-random-local-secret
```

`REASONKB_API_KEY_PEPPER` is mixed into stored API key hashes. Changing it
invalidates existing keys.

## Create an API Key

Run this against the web service:

```sh
REASONKB_ADMIN_PASSWORD=your-administrator-password
node tools/reasonkb-cli.mjs create-key --name codex
```

Key administration requires an authenticated deployment administrator. The CLI
uses `REASONKB_ADMIN_PASSWORD` only to create the administrator session needed
for this request; agent queries use `REASONKB_API_KEY` instead.

The response includes `apiKey` once. Store it in the agent environment:

```sh
REASONKB_URL=http://localhost:43170
REASONKB_API_KEY=rkb_live_...
```

Keys can be limited to scopes and projects:

```sh
node tools/reasonkb-cli.mjs create-key \
  --name project-agent \
  --scope read:projects \
  --scope read:documents \
  --scope query \
  --scope evidence \
  --project proj_123
```

Supported scopes are:

- `read:projects`
- `read:documents`
- `query`
- `evidence`

## CLI

```sh
node tools/reasonkb-cli.mjs projects
node tools/reasonkb-cli.mjs documents proj_123
node tools/reasonkb-cli.mjs query "What changed in the acceptance report?" --project proj_123
node tools/reasonkb-cli.mjs evidence "Find handover evidence" --project proj_123
node tools/reasonkb-cli.mjs pages doc_123 --pages 1-3
node tools/reasonkb-cli.mjs structure doc_123
```

## MCP Server

Use the stdio MCP server from an agent that can launch local commands:

```json
{
  "mcpServers": {
    "reasonkb": {
      "command": "node",
      "args": ["C:/path/to/ReasonKB/tools/reasonkb-mcp.mjs"],
      "env": {
        "REASONKB_URL": "http://localhost:43170",
        "REASONKB_API_KEY": "rkb_live_..."
      }
    }
  }
}
```

Exposed tools:

- `reasonkb_list_projects`
- `reasonkb_list_documents`
- `reasonkb_query`
- `reasonkb_evidence`
- `reasonkb_get_pages`
- `reasonkb_get_structure`

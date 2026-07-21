# Agent Access

ReasonKB exposes API-key protected routes under `/api/agent/*` for external
agents, CLI tools, and MCP clients. Agent requests do not write chat
conversation history.

## Manage API Keys

For Docker installations, sign in as the deployment administrator and open
`Settings` > `API keys`. The Web UI can create, list, scope, and revoke keys.
The complete key is shown once when it is created.

Keys can be limited to these scopes:

- `read:projects`
- `read:documents`
- `query`
- `evidence`

An empty project selection allows access to every active project. Selecting
projects restricts the key to those project IDs.

## Docker CLI

The one-command installer creates host launchers that execute the tools inside
the running Web container, so Node.js is not required on the host:

```sh
export REASONKB_API_KEY=rkb_live_...

~/.reasonkb/bin/reasonkb projects
~/.reasonkb/bin/reasonkb documents proj_123
~/.reasonkb/bin/reasonkb query "What changed?" --project proj_123
~/.reasonkb/bin/reasonkb evidence "Find handover evidence" --project proj_123
~/.reasonkb/bin/reasonkb pages doc_123 --pages 1-3
~/.reasonkb/bin/reasonkb structure doc_123
```

API Key administration is normally performed in the Web UI. For headless
administration, export the current administrator password and use:

```sh
export REASONKB_ADMIN_PASSWORD='your-current-administrator-password'

~/.reasonkb/bin/reasonkb create-key --name codex
~/.reasonkb/bin/reasonkb keys
~/.reasonkb/bin/reasonkb revoke-key key_123
```

Set `REASONKB_HOME` when the deployment is not under `~/.reasonkb`.

## Docker MCP

Configure a local Agent to launch the installed stdio wrapper:

```json
{
  "mcpServers": {
    "reasonkb": {
      "command": "/home/user/.reasonkb/bin/reasonkb-mcp",
      "env": {
        "REASONKB_API_KEY": "rkb_live_..."
      }
    }
  }
}
```

The wrapper uses `docker compose exec -T`; the disabled TTY keeps MCP JSON-RPC
stdin/stdout clean. This configuration is for an Agent running on the same host
as the ReasonKB Docker deployment.

## Source Development

When running ReasonKB from a source checkout, configure the Web process before
starting it:

```sh
export REASONKB_API_KEY_PEPPER='long-random-local-secret'
pnpm -C web dev
```

In another terminal, use the current administrator password to manage keys:

```sh
export REASONKB_URL='http://localhost:3000'
export REASONKB_ADMIN_PASSWORD='your-current-administrator-password'

node tools/reasonkb-cli.mjs create-key --name codex
node tools/reasonkb-cli.mjs keys
```

Use the created key for Agent commands:

```sh
export REASONKB_URL='http://localhost:3000'
export REASONKB_API_KEY='rkb_live_...'

node tools/reasonkb-cli.mjs projects
```

The source-checkout MCP configuration points directly to
`tools/reasonkb-mcp.mjs` and supplies the same URL and API Key.

## MCP Tools

- `reasonkb_list_projects`
- `reasonkb_list_documents`
- `reasonkb_query`
- `reasonkb_evidence`
- `reasonkb_get_pages`
- `reasonkb_get_structure`

The Docker installer stores the API Key hash pepper at
`~/.reasonkb/secrets/api_key_pepper`. Back it up with the SQLite database.
Changing or losing it invalidates every existing API Key.

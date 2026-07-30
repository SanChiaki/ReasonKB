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
projects restricts the key to those project IDs. An API Key or Agent query can
name at most 100 project IDs; use separate Keys when larger explicit scopes are
required.

## Retrieval Modes

`query` and `evidence` share the same document selection and bounded PageIndex
tree search. For each selected document, ReasonKB asks the retrieval model for
specific PageIndex nodes or physical pages, loads the stored page text, and
checks whether more evidence is needed. The search may continue for up to three
rounds, with at most eight new pages per round and sixteen pages per document.
Invalid model output or an older index without navigable PageIndex nodes falls
back to the original single-page-selection path.

- `query` returns a match only when the collected pages can answer every material
  part of the question accurately. It then generates an answer and returns page
  citations while preserving the source's category hierarchy.
- `evidence` favors recall across distinct relevant sections. It never generates
  the final answer; it returns page-scoped evidence content and source metadata
  so the caller can combine it with other information.

Every retrieval response includes `retrievalStatus`:

- `matched` means a `query` has sufficient evidence for a complete answer, or an
  `evidence` request returned directly relevant page evidence.
- `no_match` means retrieval completed normally but did not find enough direct
  support for that mode in ReasonKB.
- `degraded` means a provider, parsing, or validation failure prevented a
  reliable complete result. `degradedReason` identifies the failed stage so the
  caller can retry instead of treating the response as a confirmed no-match.

Candidate selection sends at most 50 ranked document summaries in each model
prompt. `answer` mode continues to the next batch when a batch is empty or its
output is recoverably malformed, then stops after finding candidates;
`evidence` mode evaluates every batch and re-ranks combined selections when
they exceed the configured document limit.
This keeps every ready document reachable by semantic model selection without
creating one unbounded prompt, at the cost of additional model calls for large
retrieval scopes. Provider failures stop the cascade.

Candidate-model failures use a bounded deterministic fallback only when file
metadata, descriptions, the PageIndex tree, and exact constraints found while
iterating page text provide a strong query-term match. Page text is scanned
lazily only after an explicit empty or technical model outcome; successful
model selection does not pay that full-text fallback cost.
An explicit empty model selection probes at most one strong candidate.
Every selected document, including normal model selections, fallback probes,
and the protected deterministic anchor, must pass a page-text support check
before its pages can appear in the final citations or evidence list. This final
check prevents a topically related document from being reported as a match when
its retrieved pages do not directly support the query.

Page selection, bounded tree continuation, page loading, final evidence
validation, and answer generation also propagate technical failures as
`degraded`. A response can therefore contain useful evidence and still be
degraded when an upstream failure means the search may be incomplete.

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

## Streamable HTTP MCP

Docker also starts a stateful MCP Streamable HTTP endpoint:

```text
http://localhost:43173
```

The endpoint uses the same API Keys, scopes, project restrictions, and document
availability checks as `/api/agent/*`. Send the Key as a Bearer token; never put
it in the URL. For example, Codex can read the token from an environment
variable:

```toml
[mcp_servers.reasonkb]
url = "http://localhost:43173"
bearer_token_env_var = "REASONKB_API_KEY"
```

The Docker port binds to `127.0.0.1` by default. To accept connections on
another interface, set `MCP_BIND_ADDRESS` and list every accepted hostname or
IP in `REASONKB_MCP_ALLOWED_HOSTS`:

```env
MCP_BIND_ADDRESS=0.0.0.0
MCP_PORT=43173
REASONKB_MCP_ALLOWED_HOSTS=kb.example.com,192.0.2.10
REASONKB_MCP_ALLOWED_ORIGINS=https://agent.example.com
REASONKB_MCP_PRE_AUTH_TIMEOUT_SECONDS=30
REASONKB_MCP_REQUEST_TIMEOUT_SECONDS=600
REASONKB_MCP_MAX_CONCURRENT_REQUESTS=8
REASONKB_MCP_MAX_CONCURRENT_AUTH_REQUESTS=32
REASONKB_MCP_MAX_CONCURRENT_CONTROL_REQUESTS=32
REASONKB_MCP_MAX_SESSIONS=128
REASONKB_MCP_SESSION_IDLE_TIMEOUT_SECONDS=900
```

Requests without an `Origin` header and requests whose Origin matches the MCP
Host are accepted. Browser-based clients on another Origin must be listed in
`REASONKB_MCP_ALLOWED_ORIGINS`; other Origins are rejected before API Key
verification.

The MCP service limits active tool calls, read-only API Key verifications, and
protocol control messages independently. Excess authentication or control
requests receive `503`, without making cancellation wait behind long-running
tool calls.
Tool calls that exceed the hard deadline are aborted. Body parsing and API Key
verification use the shorter pre-authentication deadline, and request bodies are
limited to 100 KiB.

HTTP clients use stateful MCP sessions so protocol cancellation can stop the
original tool call. A session remains bound to the API Key that initialized it.
Every ordinary request revalidates that Key. Cancellation-only notifications
may skip the remote verification call so cancellation remains available during
authentication saturation, but they are accepted only when the supplied Bearer
Key fingerprint matches the Key bound to that session. They do not invoke tools,
extend session lifetime, or consume tool execution capacity. New sessions
receive `503` when the session cap is full; idle sessions are closed after the
configured timeout.
Sessions are in memory, so a service restart invalidates them. Multi-replica
deployments require sticky routing to the instance that created each session.
Each POST accepts one JSON-RPC message. JSON-RPC batches receive `400`; this
keeps request cancellation isolated because the upstream SDK otherwise shares
one response stream across every request in a batch.

Do not expose the plain HTTP port directly to the public Internet. Put it
behind an HTTPS reverse proxy, retain Bearer authentication, and configure
firewall and request limits. A same-host reverse proxy can leave
`MCP_BIND_ADDRESS=127.0.0.1`.

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

To run the HTTP transport from a source checkout:

```sh
export REASONKB_URL='http://localhost:3000'
pnpm -C web mcp:http
```

It listens on `http://127.0.0.1:43173` by default.

## MCP Tools

- `reasonkb_list_projects`
- `reasonkb_list_documents`
- `reasonkb_query`
- `reasonkb_evidence`
- `reasonkb_get_pages`
- `reasonkb_get_structure`

Query citations and evidence items may include an optional `documentUrl`. It
is present only when an original-document link is available. For Seeyon
sources, it points to the original document viewer and is built from the
source endpoint and the document's stable `fr_id`. Local and SMB sources do
not expose `file://` or server-only paths as browser links. The Seeyon viewer
URL intentionally omits the `v` parameter because that value is
session-dependent and is not returned by the document-list API; the viewer
still applies its normal Seeyon login and permission checks.

The Docker installer stores the API Key hash pepper at
`~/.reasonkb/secrets/api_key_pepper`. Back it up with the SQLite database.
Changing or losing it invalidates every existing API Key.

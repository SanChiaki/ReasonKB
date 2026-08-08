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
prompt. The shared retrieval path evaluates every candidate-summary batch and
performs a bounded re-rank when the combined selections exceed the configured
document limit. This preserves the reachability of documents in later batches
without creating one unbounded prompt. Provider failures stop the candidate
cascade.

After ranking, Answer and Evidence build the same validated EvidenceSet. Both
start with at most two selected documents, inspect them with the same PageIndex
tree search and evidence validation rules, and expand in bounded waves when a
conservative coverage check finds a missing or uncertain part of the request.
Expansion stops only on high-confidence complete coverage or after the selected
document budget is exhausted. Evidence returns the validated page text directly.
Answer uses that same EvidenceSet for a final answer-generation call. Output mode
does not change candidate selection, page selection, evidence retention,
coverage decisions, or document concurrency.

This is path equivalence, not cross-request caching. Separate Answer and Evidence
HTTP requests each execute retrieval and can differ when the model provider is
non-deterministic. A product contract requiring byte-identical EvidenceSets across
separate calls would need an explicit retrieval-result or session identifier.

Cross-document routing is a ReasonKB orchestration policy, not an official
PageIndex retrieval guarantee. PageIndex supplies the per-document tree and page
navigation primitives; ReasonKB owns corpus scoping, document ranking,
cross-document budgets, validation, and response assembly.

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

## Retrieval Runtime Controls

ReasonKB snapshots the Answer Model, Retrieval Model, credentials, and request
deadline once at the start of each query. `PAGEINDEX_LLM_MODEL` is used for
indexing and final Answer synthesis; `PAGEINDEX_LLM_RETRIEVAL_MODEL` is used for
candidate routing, PageIndex node/page selection, tree sufficiency checks, and
evidence validation. Administrator settings stored in SQLite take precedence
over these environment defaults.

PageIndex indexing and structured retrieval stages request hidden thinking to
be disabled when the provider supports explicit reasoning control. Indexing
does not inherit the final Answer reasoning mode. The bounded third tree
assessment may request `low` reasoning for complex comparison, cross-document,
or multi-hop questions after earlier non-thinking rounds remain insufficient.
The request is honored only when the provider exposes an enforceable low-effort
budget. DeepSeek-compatible endpoints have no portable independent
reasoning-token cap, so `low` falls back to explicitly disabled thinking there.
Answer synthesis uses `ANSWER_REASONING_MODE=auto` by default:
ordinary synthesis explicitly disables hidden thinking, while clearly
multi-step questions or broad cross-document evidence use the same
provider-aware `low` policy. Set `disabled`, `low`, or `default` to override it.
PageIndex's term "reasoning-based retrieval" describes LLM navigation over the
document tree; it does not require hidden thinking for every provider request.

The retrieval service also accepts these deployment controls:

```env
# Whole-query deadline in seconds. Default and maximum 600.
RETRIEVAL_REQUEST_TIMEOUT_SECONDS=600

# Per-call timeouts. Retrieval and final Answer both default to 300.
RETRIEVAL_LLM_REQUEST_TIMEOUT_SECONDS=300
ANSWER_LLM_REQUEST_TIMEOUT_SECONDS=300

# Retrieval attempts per call, including the first attempt. Default/max 2.
RETRIEVAL_LLM_MAX_ATTEMPTS=2

# PageIndex runtime wrapper attempts (indexing/fallback paths). Default/max 2.
PAGEINDEX_LLM_MAX_ATTEMPTS=2

# Answer attempts per call, including the first attempt. Default 1; allowed 1-2.
ANSWER_LLM_MAX_ATTEMPTS=1

# Answer reasoning: auto (default), disabled, low, or provider default.
ANSWER_REASONING_MODE=auto

# Maximum visible Answer output. Default 4096; allowed 256-8192.
ANSWER_LLM_MAX_OUTPUT_TOKENS=4096

# Retrieval-model calls admitted across the process. Default 2; allowed 1-5.
RETRIEVAL_LLM_CONCURRENCY=2

# Documents searched concurrently by one request. Default 2; allowed 1-5.
RETRIEVAL_DOCUMENT_CONCURRENCY=2
```

The LLM provider SDK does not add retries on top of this budget. Retries are
limited to transient failures and remain bounded by the whole-query deadline.
The document concurrency setting is per request. Retrieval-model admission is
process-wide, so simultaneous Agent/MCP requests cannot each consume the full
document-search budget. The retrieval service also retains a five-worker ceiling
for non-model document work. Cancellation stops queued work and prevents later
model rounds or retries. An already-running synchronous provider request cannot
be interrupted by LiteLLM, so it retains its global admission slot until the
provider returns or the 30-second retrieval-call timeout expires; any late
response is discarded.

## Agent Streaming

`POST /api/agent/query` and `POST /api/agent/evidence` return the existing JSON
response by default. Clients that send `Accept: text/event-stream` receive an
SSE stream instead. Progress frames contain the stage and non-sensitive counts;
candidate document summaries, source paths, document URLs, and page excerpts are
not exposed in Agent progress frames. The final `result` frame has the same
scope-checked payload as the corresponding JSON response.

The retrieval service sends SSE keep-alive comments while a model call is in
flight and disables common reverse-proxy buffering. Clients must still enforce
a request deadline and propagate cancellation; a keep-alive does not extend the
configured 240-second retrieval budget or an upstream 300-second transport cap.

MCP `reasonkb_query` and `reasonkb_evidence` use this stream automatically. When
the caller supplies an MCP `progressToken`, the server sends ordered
`notifications/progress` messages before the final tool result. The token is
returned unchanged, including numeric token `0`; without a token, no progress
notifications are sent.

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
may skip the remote verification call so cancellation remains available while
the original request is waiting for or performing API Key verification, but
they are accepted only when the supplied Bearer Key fingerprint matches the Key
bound to that session. They do not invoke tools, extend session lifetime, or
consume tool execution capacity. New sessions receive `503` when the session
cap is full; idle sessions are closed after the configured timeout.
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

MCP tool discovery reflects the scopes of the API Key that initialized the
stdio process or HTTP session:

- `read:projects` exposes `reasonkb_list_projects`.
- `read:documents` exposes `reasonkb_list_documents`, `reasonkb_get_pages`, and
  `reasonkb_get_structure`.
- `query` exposes `reasonkb_query`.
- `evidence` exposes `reasonkb_evidence`.

Tools without a matching scope are omitted from `tools/list`. The corresponding
Agent routes still enforce scopes independently, so tool discovery is not an
authorization boundary.

`reasonkb_query` and `reasonkb_evidence` publish an `outputSchema` and return
the complete Agent result in `structuredContent`. Their text `content` is a
model-readable projection rather than a serialized copy of that object. Query
text contains the answer, retrieval status, and citation anchors. Evidence text
contains each document/page anchor and the complete evidence body, including
HTML table projections, but omits machine-only `pageBlocks`, bounding boxes,
layout diagnostics, and visual metadata. Programmatic clients that need the
complete response must read `structuredContent` instead of parsing
`content[0].text` as JSON.

Retrieval results also include an EvidenceSet `coverage` object. Coverage
`complete` means every material part of the original query is grounded;
`partial` means at least one part is grounded and at least one remains
unresolved; `none` means a reliable search found no grounded evidence; and
`unknown` means a technical failure prevented a reliable coverage judgment.
Partial coverage is a normal matched result, not a degraded retrieval. Each
Evidence item has a stable, index-version-bound `evidenceId`, and model-grounded
items can reference EvidenceSet-scoped coverage aspects through `supports`.
Query citations carry the same `evidenceId`, so coverage links remain resolvable
even though Query does not repeat raw Evidence content. The current contract
reports `canContinue: false`; resumable EvidenceSet expansion will be added as a
separate stateful tool rather than exposing internal candidate state.

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

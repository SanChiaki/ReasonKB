# ReasonKB

ReasonKB is a deployment-shared knowledge retrieval service built on the upstream PageIndex core. It ingests read-only external content, indexes it, and exposes isolated Project scopes for chat and evidence retrieval.

The formal product supports any number of Local directory, SMB share, and Seeyon V8.1SP2 sources at the same time. Manual Project creation and file upload are intentionally not supported.

## Source Model

- A Corpus Source is one connection and immutable content scope through the ordinary edit API.
- A Source Collection becomes one deployment-shared Project when selected.
- New sources default to `None`, with zero selected collections.
- `All` continuously includes collections discovered or registered later.
- Source configuration, credentials, collection selection, and manual sync take effect without restarting containers.
- Seeyon sources have an explicit URL migration flow for moving an OA endpoint from an intranet address to a public address. The target is validated and fully scanned before the existing source identity and reusable indexes are switched over.
- Connectors only list and read source content. ReasonKB never writes, moves, deletes, or changes permissions in a source system.

Local and SMB collections are discovered from the root and its top-level directories. Seeyon libraries are registered explicitly with a document library ID and root archive ID.

## Repository Layout

```text
vendor/pageindex/       Vendored VectifyAI/PageIndex source
services/retrieval_api Retrieval and evidence API
services/source_worker Runtime source discovery and synchronization
services/index_worker/ Revision-safe fetch, conversion, and indexing
web/                    Next.js user and administrator UI
docker/                 Compose files, entrypoints, and installer
docs/                   Architecture decisions and deployment guidance
```

Keep ReasonKB behavior outside `vendor/pageindex/pageindex`. Runtime integration belongs under `services/` and `web/`.

## Local Development

Install uv 0.12.1, synchronize the locked dependencies, and migrate SQLite:

```bash
uv sync --frozen
pnpm -C web install
pnpm -C web db:migrate
```

The checked-in `.python-version` selects Python 3.12 for local development.
ReasonKB supports Python 3.11 through 3.13; uv itself is pinned by
`pyproject.toml` so local and Docker dependency resolution use the same version.

Run the services in separate terminals:

```bash
pnpm -C web dev
uv run uvicorn services.retrieval_api.app:app --reload --port 8001
uv run python -m services.source_worker.worker
uv run python -m services.index_worker.worker
```

The source worker reads source changes from SQLite continuously, so API and UI changes can be developed natively without rebuilding a worker image. Run Gotenberg in Docker when Office conversion is required.

## Docker

Start the full development stack:

```bash
REASONKB_PROJECTS_ROOT=/absolute/read-only/source-boundary \
docker compose -f docker/compose.yml up --build
```

Default ports:

- Web: `http://localhost:43170`
- Retrieval API: `http://localhost:43171`
- Gotenberg: `http://localhost:43172`

`REASONKB_PROJECTS_ROOT` is mounted read-only at `/data/projects`. Every runtime Local source path must be `/data/projects` or a descendant. Changing this deployment access boundary changes a Docker bind mount and requires container recreation; adding or editing sources inside the boundary does not.

The retrieval API receives only the SQLite/runtime volume. It receives neither source mounts nor source credential keys.

## Administrator Bootstrap

The installer creates one deployment administrator and three host-side secret files:

```text
~/.reasonkb/secrets/master.key
~/.reasonkb/secrets/admin_password
~/.reasonkb/secrets/api_key_pepper
```

The files stay on the host with mode `0600`; the directory uses mode `0700`. Docker mounts them read-only into the privileged services as:

```text
/run/secrets/reasonkb_master_key
/run/secrets/reasonkb_admin_password
/run/secrets/reasonkb_api_key_pepper
```

The master key and API Key pepper are not stored only inside a disposable container. Back them up with the ReasonKB SQLite database. Losing the master key makes encrypted SMB and Seeyon credentials unrecoverable; losing the pepper invalidates existing Agent API Keys. `admin_password` is a bootstrap and recovery secret, not a readable copy of the current password after it has been changed in the Web UI.

Open `http://localhost:43170/admin/login`, sign in with the initial administrator password, then use `Data sources`.

An authenticated administrator can change the password from `Settings` > `Security`. The change takes effect immediately and revokes every existing administrator session.

If the password is forgotten, reset it from the Docker host without restarting the running services:

```bash
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh \
  | sh -s -- --reset-admin-password
```

The reset command prompts twice for a new password of 12 to 1024 characters, pulls the current reset tool image, updates SQLite, and revokes all administrator sessions. Set `REASONKB_HOME` on the `sh` command when the deployment is not under `~/.reasonkb`.

## Configuring Sources

### Local

Enter a display name and a container path under `/data/projects`. The source worker discovers a Root Collection for direct files and collections for top-level directories.

### SMB

Enter host, port, share, base path, authentication protocol, domain, username, and password. Credentials are encrypted with AES-256-GCM in SQLite and bound to the source ID. The index worker downloads only the revision currently being indexed and removes the temporary copy afterward.

### Seeyon V8.1SP2

Enter the Seeyon endpoint, `loginName`, REST username, and REST password. After validation, register each desired library with:

- display name
- document library ID (`docLibId`)
- root archive ID (`rootArchiveId`)

ReasonKB uses `fr_id` as stable document identity and `file_id + fr_size` as the revision fingerprint. It downloads the current `file_id` only when the revision changes.

For every source, validate the connection, choose `None`, `Explicit`, or `All`, and run an optional manual sync. Changes are persisted in SQLite and picked up without restarting the stack.

## Lifecycle and Safety

- Failed or partial scans never infer missing content.
- A complete authoritative scan is required before an absent item becomes Missing.
- Source principal changes fence retrieval until validation and reconciliation finish.
- Transient index failures use five persisted retries at approximately 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours.
- Source deletion has a seven-day recoverable Pending Purge period unless immediate purge is explicitly confirmed.
- Missing indexes are retained for 30 days; administrator audit events are retained for 180 days.

Legacy Local and SMB deployments are migrated in place. Existing Project/document IDs, indexes, jobs, and conversation links are preserved. Legacy SMB secret files are imported into encrypted source credentials. Demo upload records and managed upload files are deliberately removed.

## One-command Release Install

```bash
curl -fsSL https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/install.sh | sh
```

The installer stores Compose, `.env`, runtime data, secrets, and the Local source access root under `~/.reasonkb` by default. It configures only the deployment access boundary and optional LLM defaults; business sources are added after startup in the administrator UI.

Release images are published to Alibaba Cloud ACR with:

```bash
docker login crpi-95tja6y49h58rco0.cn-shenzhen.personal.cr.aliyuncs.com
./docker/publish-acr.sh
```

## Configuration

Administrator cookies follow the actual access protocol by default. Direct HTTP access omits
the `Secure` attribute, while HTTPS requests and reverse proxies that set
`X-Forwarded-Proto: https` enable it. This can be overridden in `.env` when the public protocol
is known:

```env
REASONKB_ADMIN_COOKIE_SECURE=auto  # auto | true | false
```

LLM defaults can be supplied through `.env` and later changed by the administrator. The answer
model is used for indexing and final Answer synthesis. The retrieval model is used for candidate
document routing, PageIndex node/page selection, evidence sufficiency checks, and evidence
validation:

```env
PAGEINDEX_LLM_API_KEY=your_key
PAGEINDEX_LLM_BASE_URL=https://provider.example/v1
PAGEINDEX_LLM_MODEL=openai/answer-model
PAGEINDEX_LLM_RETRIEVAL_MODEL=openai/retrieval-model
REASONKB_EMBEDDING_MODEL=text-embedding-3-small
# Optional overrides; otherwise the embedding adapter inherits the LLM credentials.
# REASONKB_EMBEDDING_API_KEY=your_embedding_key
# REASONKB_EMBEDDING_BASE_URL=https://embedding-provider.example/v1
RETRIEVAL_LLM_REQUEST_TIMEOUT_SECONDS=300
ANSWER_LLM_REQUEST_TIMEOUT_SECONDS=300
RETRIEVAL_REQUEST_TIMEOUT_SECONDS=600
RETRIEVAL_LLM_MAX_ATTEMPTS=2
ANSWER_LLM_MAX_ATTEMPTS=1
PAGEINDEX_LLM_MAX_ATTEMPTS=2
ANSWER_REASONING_MODE=auto
ANSWER_LLM_MAX_OUTPUT_TOKENS=4096
RETRIEVAL_LLM_CONCURRENCY=2
RETRIEVAL_DOCUMENT_CONCURRENCY=2
```

The embedding model is optional for upgrades. Without it, ReasonKB keeps the compatible FTS + LLM
candidate path. Once configured, the index worker builds document and PageIndex-node profiles in the
background from existing `doc_description` and `structure_json`; source documents do not need to be
re-indexed. A changed model is built as a shadow generation and becomes active only after backfill
completes. Progress, coverage, active model, and provider errors are available in the administrator
settings page.

`RETRIEVAL_REQUEST_TIMEOUT_SECONDS` is the deadline for the complete retrieval request and
defaults to its 600-second maximum. Retrieval and final Answer model calls each default to a
300-second per-call timeout while remaining bounded by the shared request deadline. Retrieval
calls accept `1` or `2` attempts through
`RETRIEVAL_LLM_MAX_ATTEMPTS`; Answer calls default to one attempt and can be set to `1` or `2`
through `ANSWER_LLM_MAX_ATTEMPTS`. Provider SDK retries are disabled so these attempts remain
inside the request deadline. The legacy PageIndex sync/async runtime wrappers used by indexing
and no-context fallbacks use a separate `PAGEINDEX_LLM_MAX_ATTEMPTS` budget (default and maximum
`2`). `ANSWER_LLM_MAX_OUTPUT_TOKENS` bounds visible Answer output to
256-8192 tokens (default 4096). `RETRIEVAL_DOCUMENT_CONCURRENCY` accepts `1-5` and controls
how many selected documents one request searches concurrently. The process-wide
`RETRIEVAL_LLM_CONCURRENCY` limit also accepts `1-5` and defaults to `2`, covering candidate
routing, tree search, sufficiency checks, and evidence validation across concurrent requests.
These defaults are intended for small single-node deployments; increase them only after
measuring provider rate limits, memory, and tail latency.

Answer and Evidence use the same retrieval path. All candidate-summary batches remain reachable,
then selected documents are inspected in shared bounded waves using the same PageIndex tree
traversal, evidence validation, and conservative coverage check. The first wave contains at most
two documents and later waves expand up to `RETRIEVAL_DOCUMENT_CONCURRENCY` until coverage is
high-confidence complete or the configured document limit is exhausted. Evidence returns the
validated page text directly; Answer performs one additional synthesis call over that same
EvidenceSet. Separate Answer and Evidence requests rerun retrieval independently, so provider
non-determinism can still produce different byte-level results unless a caller reuses one result.

PageIndex indexing and structured retrieval calls explicitly disable hidden thinking when the
provider supports reasoning control. Indexing remains deterministic non-thinking structural
extraction; it does not inherit the final Answer reasoning mode. A bounded third tree-assessment
round may request `low` reasoning for complex comparison, cross-document, or multi-hop questions
when earlier non-thinking rounds still need more evidence. The escalation is honored only when the
provider offers an enforceable low-effort budget. DeepSeek-compatible endpoints expose a
thinking switch but no portable independent reasoning-token cap, so `low` falls back to
explicitly disabled thinking on those endpoints. Answer synthesis uses the answer model with
`ANSWER_REASONING_MODE=auto` by default: ordinary synthesis explicitly
disables hidden thinking, while clearly multi-step questions or broad cross-document evidence use
the same provider-aware `low` policy. Set `disabled`, `low`, or `default` to override this policy.
This is separate from PageIndex's reasoning-based tree navigation: selecting nodes from a document
tree does not require hidden thinking on every provider request.

Image evidence extraction is disabled by default:

```env
VISION_EXTRACTION_ENABLED=true
VISION_MODEL=gpt-4.1
```

Digital PDF and converted Office pages use layout-aware table extraction by default. Tables with
a complete, non-overlapping grid are projected as compact structural HTML while their cells,
spans, and bounding boxes are stored separately for Evidence. Ambiguous pages keep the legacy
text instead of publishing uncertain structure. Use `REASONKB_PDF_TABLE_MODE=detect` to store
diagnostics without changing page text, or `off` for full rollback. Existing indexes require
re-indexing before they gain table structure.

Office files are converted through Gotenberg. Runtime settings are stored in SQLite and take precedence over startup defaults.

## Agent / CLI / MCP Access

ReasonKB includes API-key protected agent routes under `/api/agent/*`, a Node
CLI, a stdio MCP server, and a Streamable HTTP MCP endpoint. Use these when an
external coding agent needs to query indexed documents without writing chat
history.

Docker users create and revoke API Keys from `Settings` > `API keys`. The
installer also creates host launchers that run the bundled tools inside the Web
container, without requiring Node.js on the host:

```bash
export REASONKB_API_KEY=rkb_live_...
~/.reasonkb/bin/reasonkb projects
```

For a same-host MCP client, configure the command as:

```json
{
  "command": "/home/user/.reasonkb/bin/reasonkb-mcp",
  "env": {
    "REASONKB_API_KEY": "rkb_live_..."
  }
}
```

URL-based MCP clients can instead connect to:

```text
http://localhost:43173
```

and send the ReasonKB API Key as a Bearer token. The endpoint binds to localhost
by default; use an HTTPS reverse proxy before exposing it outside the host.

The installer keeps the stable API Key hash pepper in
`~/.reasonkb/secrets/api_key_pepper`; back it up with the SQLite database.
See [`docs/agent-access.md`](docs/agent-access.md) for the full CLI and MCP
configuration, headless Key administration, and source-development commands.

## Verification

```bash
uv run pytest -q services/tests
pnpm -C web test
pnpm -C web exec tsc --noEmit
docker compose -f docker/compose.yml config --quiet
docker compose -f docker/compose.release.yml config --quiet
```

Before release, rebuild the full Compose stack and validate administrator login, Local/SMB/Seeyon source changes, synchronization, indexing, retrieval, and desktop/mobile layouts.

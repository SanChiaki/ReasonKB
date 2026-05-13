# ReasonKB

ReasonKB is a local project-centric knowledge chat service built around the latest upstream PageIndex core.

The upstream PageIndex source is vendored under `vendor/pageindex` so it can be updated as a separate boundary. ReasonKB behavior lives outside the vendored tree.

## Repository Layout

```text
vendor/pageindex/       Latest VectifyAI/PageIndex source snapshot
services/               FastAPI retrieval API, index worker, directory watcher
web/                    Next.js project/document/chat UI
docker/                 Container entrypoints
patches/pageindex/      Audit notes for required upstream patches
```

Do not edit `vendor/pageindex/pageindex` for ReasonKB behavior. Put runtime integration in `services/common/pageindex_runtime.py`, env mapping in `services/common/llm_environment.py`, import-path setup in `services/common/pageindex_vendor.py`, and ReasonKB defaults in `services/common/pageindex_config.yaml`.

## Local Development

Install Python dependencies:

```bash
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r services/requirements.txt
```

Install web dependencies and migrate the SQLite schema:

```bash
pnpm -C web install
pnpm -C web db:migrate
```

Run these services in separate terminals:

```bash
pnpm -C web dev
./.venv/bin/uvicorn services.retrieval_api.app:app --reload --port 8001
./.venv/bin/python -m services.index_worker.worker
```

Open `http://localhost:3000/projects`, create a project, upload PDF/Markdown/text/Office files, then use `http://localhost:3000/chat`.

## Docker

Run the full stack with a mounted project corpus:

```bash
PROJECTS_ROOT=/absolute/path/to/projects docker compose -f docker/compose.yml up --build
```

Default host ports:

- Web: `http://localhost:43170`
- Retrieval API: `http://localhost:43171`
- Gotenberg Office conversion: `http://localhost:43172`

The mounted corpus should use first-level directories as projects:

```text
/absolute/path/to/projects/
  ProjectA/
    delivery/report.md
    office/scope.docx
  ProjectB/
    handover/report.pdf
```

## Configuration

ReasonKB exposes deployment-facing LLM variables without requiring external `OPENAI_*` names:

```bash
PAGEINDEX_LLM_API_KEY=your_key
PAGEINDEX_LLM_BASE_URL=https://provider.example/v1
```

Image evidence extraction is disabled by default. Enable it with:

```bash
VISION_EXTRACTION_ENABLED=true
VISION_MODEL=gpt-4.1
```

Office files are converted to evidence PDFs through Gotenberg before indexing. Runtime state is stored in ignored `./.reasonkb/var` unless overridden with `APP_VAR_ROOT`, `APP_DB_PATH`, `APP_UPLOAD_ROOT`, or `APP_CONVERTED_ROOT`.

System settings can be changed at `http://localhost:43170/settings`. Runtime settings are stored in SQLite and take precedence over `.env` defaults. `INDEX_WORKER_CONCURRENCY` remains the startup default for document indexing concurrency when no runtime value has been saved yet. Retrieval document limit is also managed there and is read by the retrieval API on each query.

## Tests

```bash
./.venv/bin/python -m pytest services/tests -q
pnpm -C web test
pnpm -C web e2e
```

## Updating Upstream PageIndex

The clean update path is to refresh only the vendor snapshot and keep ReasonKB code outside it:

```bash
git fetch upstream main
rm -rf vendor/pageindex
mkdir -p vendor/pageindex
git archive upstream/main | tar -x -C vendor/pageindex
```

Then check `patches/pageindex/`, run the Python and web tests, and commit only the vendor refresh plus any required ReasonKB integration changes.

# Multi-Source Corpus Verification

Verified on 2026-07-13 from worktree `multi-source-corpus-design`.

| Phase | Verified outcome | Authoritative evidence |
| --- | --- | --- |
| Persistence and migration | Ordered migrations preserve source-backed identities and conversations, remove demo uploads, resume after an interrupted migration, reject ambiguity, and rerun idempotently. | `web/tests/db/multi-source-migrate.test.ts` |
| Security and administration | Administrator session/CSRF enforcement, AES-GCM source credentials, immutable scope, sanitized audit/API output, private master-key startup validation, and runtime CRUD are covered. | `web/tests/security`, `web/tests/api`, `services/tests/test_worker_safety.py` |
| Connector and source lifecycle | Local, SMB, and Seeyon connectors run together; new sources default to None; Explicit and continuous All work; manual mode performs one-time discovery; incomplete scans do not mark items Missing. | Connector tests, `test_source_worker_engine.py`, Docker E2E |
| Revision-safe indexing | Expected source/config revisions fence claims and publication; replacement uploads keep identity, retire old indexes, and queue the new revision; transient failures retry and stale work cannot publish. | `test_index_document.py`, `test_source_worker_engine.py` |
| Seeyon V8.1SP2 | IDs are strings, `fr_id` is identity, `file_id + fr_size` is revision, fetch uses current `file_id`, 401 retries once, 403 is scope-aware, and token authentication is single-flight across threads/processes. | `test_seeyon_connector.py`, live Seeyon synchronization |
| UI and retrieval | Manual Project creation/upload/rename are absent. Admin UI covers source creation, validation error recovery, discovery, All selection, partial indexing, health/coverage, disable/enable, pending purge/restore, and confirmed immediate purge. Source identity appears in retrieval evidence. | Playwright `admin-sources.spec.ts` and `project-chat.spec.ts`; three live evidence queries |
| Deployment and recovery | Credential/source mounts are limited by service, workers expose heartbeats, source/index crash recovery releases abandoned work, due purge checks run every 5 seconds, and runtime changes need no restart. | Compose packaging tests, both Compose configs, healthy Docker stack |
| Capacity and failure safety | 100 sources, 1,000 Projects, and 100,000 documents pass. Tests inject partial traversal, fetch/conversion/disk failures, publication rollback, deactivation races, worker crashes, purge interruption, token stampedes, and SQLite writer contention. | Capacity command and failure-injection tests |

## Final Commands

```text
uv run pytest -q services/tests
186 passed

pnpm -C web test -- --run
132 passed

pnpm -C web exec tsc --noEmit
passed

PLAYWRIGHT_BASE_URL=http://localhost:43270 \
REASONKB_E2E_ADMIN_PASSWORD_FILE=/tmp/reasonkb-multisource-e2e/secrets/admin_password \
REASONKB_E2E_PROJECTS_ROOT=/tmp/reasonkb-multisource-e2e/projects \
pnpm -C web exec playwright test --reporter=list
2 passed

uv run python -m services.tests.source_capacity_check
100 sources; 1,000 Projects; 100,000 documents; 23.584 seconds;
0.3 MiB peak traced memory; 0.882 seconds maximum SQLite lock wait;
238.8 MiB database

docker compose -f docker/compose.yml config --quiet
docker compose -f docker/compose.release.yml config --quiet
git diff --check
passed
```

## Live Docker Evidence

- Web: `http://localhost:43270`
- Retrieval health: `http://localhost:43271/health`
- Gotenberg: `http://localhost:43272`
- Local, SMB, and Seeyon sources: `active`, `normal`, zero consecutive failures
- Projects: 5
- Retrievable documents: 6
- Latest live Seeyon run: completed, 3 seen, 0 changed, 0 missing
- Local, SMB, and Seeyon evidence queries each returned the expected document and source identity
- Retrieval API mount: `/app/var` only; no master key or source corpus mount
- Secret scan: 4 real secret probes across SQLite, container logs, environments, and process metadata; 0 matches
- Active test administrator sessions after cleanup: 0

# Multi-Source Corpus Implementation Plan

This plan sequences implementation so migrations and lifecycle safety land before new connectors. Each phase should be independently testable and keep remote I/O outside SQLite transactions.

## Phase 1: Persistence And Migration Framework

- Replace ad hoc column-only migration with ordered, transactional schema migrations and a schema-version table.
- Add source, encrypted credential, collection, source item, discovery run, collection Sync Run, audit, administrator session, and purge state persistence.
- Extend Projects, documents, indexes, and jobs with immutable source/collection identity, expected Source Revision, Source Configuration Revision, lifecycle, priority, retry, and fencing fields.
- Add uniqueness and claim indexes scoped by immutable IDs, never display names.
- Implement the idempotent legacy local/SMB backfill and destructive removal of demo upload data.
- Add migration fixtures for fresh, legacy local, legacy SMB, mixed upload/source-backed, interrupted, and ambiguous databases.

Exit criteria: migration preserves every supported source-backed ID and conversation link, deletes demo upload data, is rerunnable, and refuses ambiguous input without starting workers.

## Phase 2: Security And Administration Foundation

- Bootstrap one administrator password, store only an adaptive strong hash, and implement secure session creation, rotation, expiry, CSRF protection, and logout.
- Implement master-key loading, authenticated encryption with per-record nonces and associated source identity, credential redaction, and key/permission startup checks.
- Add source CRUD, validation, enable/disable, selection policy, manual sync, retry, deregistration, restore, and purge APIs.
- Enforce immutable Source Scope and increment Source Configuration Revision on every saved configuration or credential change.
- Write sanitized append-only audit events for every administration action.

Exit criteria: all mutating administration routes reject unauthenticated callers, secrets never appear in API responses/logs/audit, and CRUD changes are observable without service restart.

## Phase 3: Connector Contract And Local Connector

- Define typed connector request/result models for validate, discover, scan page/stream, and fetch revision.
- Move local traversal behind the connector boundary with root confinement, path normalization, stable relative-path identity, no-link policy, Root Collection support, format classification, and size classification.
- Implement bounded streaming into persistent Source Discovery Runs and collection Sync Runs.
- Build selection transitions, Pending Project creation, complete-run Missing reconciliation, incomplete-run preservation, and Retrieval Coverage.
- Replace the legacy `directory-watcher` entry point with the connector-agnostic source worker.

Exit criteria: local sources can be added, selected, synchronized, disabled, re-enabled, and purged at runtime; a 100,000-item synthetic tree scans with bounded memory.

## Phase 4: Revision-Safe Index Pipeline

- Generalize jobs to carry source, collection, document, expected Source Revision, Source Configuration Revision, priority, retry schedule, and eligibility generation.
- Implement atomic job claims, per-source/project fairness, configurable global concurrency, and default per-source concurrency one.
- Fetch through the connector into bounded temporary storage, verify transfer metadata and size, then reuse the existing conversion/PageIndex pipeline.
- Exclude old indexes when a new revision appears and publish with compare-and-swap only while every revision and lifecycle fence still matches.
- Coalesce duplicate revision jobs, supersede stale work, implement five transient retries, and clean temporary files on all outcomes.
- Restrict retrieval SQL to active Projects and successfully indexed current revisions.

Exit criteria: concurrent revision, disable, principal-change, and purge race tests prove stale workers cannot re-enter retrieval.

## Phase 5: SMB Connector

- Adapt the existing SMB client to the connector contract without materializing full listings.
- Preserve host/share/base-path scope, relative-path identity, folder hierarchy, and on-demand streamed fetch.
- Detect and skip supported link/reparse constructs; represent uncertain traversal as an incomplete run.
- Move SMB credentials from fixed files into encrypted per-source records while retaining first-migration import support.

Exit criteria: multiple SMB sources with different credentials and schedules run concurrently and one source's outage or throttling does not block others.

## Phase 6: Seeyon V8.1SP2 Connector

- Implement token acquisition and memory-only per-source single-flight token cache.
- Implement registered-library validation using only supported REST endpoints.
- Normalize all Seeyon IDs as strings at the connector boundary.
- Traverse each registered root recursively with bounded pagination and persisted metadata hierarchy.
- Use `fr_id` for document identity, `file_id + fr_size` for revision, and current `file_id` for fetch.
- Implement one `401` reauthentication retry, scoped `403` handling, incomplete subtree behavior, and principal-change reconciliation.
- Cover replacement upload, unchanged scan, empty library, partial traversal failure, item/root authorization denial, and token-race fixtures.

Exit criteria: the verified replacement scenario updates one existing document identity, downloads the new `file_id`, excludes the old index during refresh, and atomically publishes the new revision.

## Phase 7: Administration And Retrieval UI

- Replace manual Project creation/upload/rename controls with source administration and read-only Project views.
- Build source list, create/edit forms per connector, validation feedback, encrypted-secret replacement fields, selection controls, registration controls, and manual sync actions.
- Implement `None`, `Explicit`, and continuous `All` UI, including Seeyon's “all registered libraries” wording.
- Add lazy folder browsing, item status/reason, run history, Retrieval Coverage, source health, next retry, audit history, restore, and confirmed purge flows.
- Show source name and type beside every Project in selectors, search results, citations, and conversation scope.
- Keep dimensions stable for large counts and test narrow/mobile layouts for overflow and action clarity.

Exit criteria: Playwright covers source creation through retrieval, runtime changes without restart, same-name Projects, partial indexing, error recovery, deregistration/restore, and purge confirmation.

## Phase 8: Deployment And Operational Hardening

- Mount the Local Source Access Root read-only into Web, source worker, and index worker.
- Mount `/run/secrets/reasonkb_master_key:ro` only into services that require credential access.
- Remove credentials and corpus mounts from retrieval API.
- Replace the Compose `directory-watcher` service with `source-worker`; add health checks and graceful job recovery.
- Update installer to create the master key and administrator bootstrap safely, import legacy SMB secrets once, and preserve file permissions.
- Add retention workers for missing indexes, Pending Purge, audit expiry, and abandoned temporary artifacts.
- Document backup/restore of SQLite plus master key and recovery after credential-key loss.

Exit criteria: full Docker Compose verification passes with local, SMB, and Seeyon sources enabled simultaneously and all runtime source changes apply without container recreation.

## Phase 9: Capacity, Failure, And Security Verification

- Validate 100 enabled sources, 1,000 Projects, and 100,000 documents with bounded worker memory and acceptable SQLite lock latency.
- Inject crashes after page upsert, before run completion, during fetch, conversion, index publication, deactivation, and purge.
- Exercise network partitions, throttling, credential rotation, principal changes, token stampedes, stale job races, and disk exhaustion.
- Verify no secret appears in logs, API payloads, jobs, audit records, error summaries, process arguments, or retrieval containers.
- Verify all connectors remain read-only and local path traversal cannot escape the mounted root.
- Run native unit/integration tests during implementation, then rebuild and validate the full Docker product path before handoff.

## Suggested Change Boundaries

Keep implementation commits reviewable in this order:

1. Migration framework and schema only.
2. Administrator session and credential cryptography.
3. Connector interfaces and sync engine state machine.
4. Local connector and legacy migration cutover.
5. Revision-safe index queue and retrieval filtering.
6. SMB connector adaptation.
7. Seeyon connector plus contract fixtures.
8. Administration and retrieval UI replacement.
9. Compose, installer, retention, capacity, and end-to-end verification.

High-conflict files likely include `web/lib/db/schema.sql`, `web/lib/db/migrate.ts`, `services/index_worker/worker.py`, Docker Compose files, installer scripts, and Project APIs/components. Land schema and contract changes before parallel connector or UI work.

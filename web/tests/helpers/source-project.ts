import crypto from "node:crypto";
import Database from "better-sqlite3";

export function createProject(
  dbPath: string,
  input: {
    ownerUserId?: string;
    name: string;
    sourceKind?: "local" | "smb" | "seeyon";
    sourceDisplayName?: string;
  },
) {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID();
  const sourceId = `src_${suffix}`;
  const collectionId = `collection_${suffix}`;
  const projectId = `proj_${suffix}`;
  const kind = input.sourceKind ?? "local";
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO corpus_sources (
           id, kind, display_name, state, scope_json, config_json,
           config_revision, selection_policy, schedule_mode,
           sync_interval_seconds, max_document_size_bytes, health_state,
           validated_at, ever_validated_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'active', '{}', '{}', 1, 'explicit',
                   'scheduled', 60, 104857600, 'normal', ?, ?, ?, ?)`,
      ).run(
        sourceId,
        kind,
        input.sourceDisplayName ?? `${input.name} source`,
        now,
        now,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO source_collections (
           id, source_id, identity_key, external_id, root_external_id,
           display_name, origin, registration_state, validation_state,
           lifecycle_state, selected, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', 'active', 'valid',
                   'active', 1, ?, ?)`,
      ).run(
        collectionId,
        sourceId,
        `${kind}:${suffix}`,
        suffix,
        null,
        input.name,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO projects (
           id, owner_user_id, name, source_id, source_collection_id,
           lifecycle_state, retrieval_eligible, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      ).run(
        projectId,
        input.ownerUserId ?? "deployment",
        input.name,
        sourceId,
        collectionId,
        now,
        now,
      );
    })();
  } finally {
    db.close();
  }
  return {
    id: projectId,
    name: input.name,
    sourceId,
    collectionId,
    createdAt: now,
    updatedAt: now,
  };
}

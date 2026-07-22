import crypto from "node:crypto";
import Database from "better-sqlite3";
import { runImmediateTransaction } from "@/lib/db/immediate-transaction";

type Db = InstanceType<typeof Database>;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function collectionView(row: Record<string, unknown>) {
  return {
    id: row.id,
    sourceId: row.source_id,
    externalId: row.external_id,
    rootExternalId: row.root_external_id,
    displayName: row.display_name,
    origin: row.origin,
    registrationState: row.registration_state,
    validationState: row.validation_state,
    lifecycleState: row.lifecycle_state,
    selected: Boolean(row.selected),
    validationError: row.validation_error,
    projectId: row.project_id ?? null,
    exclusionRuleId: row.exclusion_rule_id ?? null,
    filterRevision: row.filter_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function collectionSelectSql() {
  return `SELECT c.*, p.id AS project_id, exclusion.id AS exclusion_rule_id
            FROM source_collections c
            LEFT JOIN projects p ON p.source_collection_id = c.id
            LEFT JOIN source_exclusion_rules exclusion
              ON exclusion.collection_id = c.id
             AND exclusion.target_type = 'collection'`;
}

function audit(
  db: Db,
  action: string,
  sourceId: string,
  after: Record<string, unknown>,
  now: string,
) {
  db.prepare(
    `INSERT INTO admin_audit_events (
       id, action, target_type, target_id, outcome, after_json, created_at
     ) VALUES (?, ?, 'source_collection', ?, 'success', ?, ?)`,
  ).run(
    `audit_${crypto.randomUUID()}`,
    action,
    sourceId,
    JSON.stringify(after),
    now,
  );
}

function ensureProject(db: Db, collectionId: string, now: string) {
  const row = db
    .prepare(
      `SELECT c.source_id, c.display_name, p.id AS project_id,
              EXISTS(
                SELECT 1 FROM source_exclusion_rules exclusion
                 WHERE exclusion.collection_id = c.id
                   AND exclusion.target_type = 'collection'
              ) AS excluded
         FROM source_collections c
         LEFT JOIN projects p ON p.source_collection_id = c.id
        WHERE c.id = ?`,
    )
    .get(collectionId) as
    | {
        source_id: string;
        display_name: string;
        project_id: string | null;
        excluded: number;
      }
    | undefined;
  if (!row) {
    throw new Error("Source Collection not found.");
  }
  if (row.project_id) {
    db.prepare(
      `UPDATE projects
          SET name = ?, lifecycle_state = ?, retrieval_eligible = 0,
              deleted_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(
      row.display_name,
      row.excluded ? "excluded" : "pending",
      now,
      row.project_id,
    );
    return row.project_id;
  }
  const projectId = `proj_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO projects (
       id, owner_user_id, name, source_id, source_collection_id,
       lifecycle_state, retrieval_eligible, created_at, updated_at
     ) VALUES (?, 'deployment', ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    projectId,
    row.display_name,
    row.source_id,
    collectionId,
    row.excluded ? "excluded" : "pending",
    now,
    now,
  );
  return projectId;
}

function deactivateProject(db: Db, collectionId: string, now: string) {
  db.prepare(
    `UPDATE projects
        SET lifecycle_state = CASE WHEN EXISTS (
              SELECT 1 FROM source_exclusion_rules exclusion
               WHERE exclusion.collection_id = ?
                 AND exclusion.target_type = 'collection'
            ) THEN 'excluded' ELSE 'inactive' END,
            retrieval_eligible = 0, updated_at = ?
      WHERE source_collection_id = ?`,
  ).run(collectionId, now, collectionId);
}

export function listSourceCollections(dbPath: string, sourceId: string) {
  const db = open(dbPath);
  try {
    const rows = db
      .prepare(
        `${collectionSelectSql()}
          WHERE c.source_id = ?
            AND c.registration_state <> 'deregistered'
            AND c.deleted_at IS NULL
          ORDER BY c.display_name COLLATE NOCASE`,
      )
      .all(sourceId) as Array<Record<string, unknown>>;
    return rows.map(collectionView);
  } finally {
    db.close();
  }
}

export function registerSeeyonCollection(
  dbPath: string,
  sourceId: string,
  input: { displayName: string; docLibId: string; rootArchiveId: string },
) {
  const now = new Date().toISOString();
  const identityKey = `seeyon:${input.docLibId}:${input.rootArchiveId}`;
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = db
        .prepare("SELECT kind, state FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
        .get(sourceId) as { kind: string; state: string } | undefined;
      if (!source) {
        throw new Error("Corpus Source not found.");
      }
      if (source.kind !== "seeyon") {
        throw new Error("Only Seeyon sources support manual Collection Registration.");
      }
      if (source.state === "pending_purge") {
        throw new Error("Cannot register a collection on a pending-purge source.");
      }
      const existing = db
        .prepare(
          `SELECT id, registration_state, validation_state
             FROM source_collections
            WHERE source_id = ? AND identity_key = ?`,
        )
        .get(sourceId, identityKey) as
        | { id: string; registration_state: string; validation_state: string }
        | undefined;
      let collectionId: string;
      if (existing) {
        if (existing.registration_state !== "deregistered") {
          throw new Error("This Seeyon document library is already registered.");
        }
        collectionId = existing.id;
        db.prepare(
          `UPDATE source_collections
              SET display_name = ?, registration_state = 'active',
                  validation_state = 'unvalidated', validation_error = NULL,
                  selected = 0,
                  lifecycle_state = CASE WHEN EXISTS (
                    SELECT 1 FROM source_exclusion_rules exclusion
                     WHERE exclusion.collection_id = source_collections.id
                       AND exclusion.target_type = 'collection'
                  ) THEN 'excluded' ELSE 'inactive' END,
                  updated_at = ?
            WHERE id = ?`,
        ).run(input.displayName, now, collectionId);
      } else {
        collectionId = `collection_${crypto.randomUUID()}`;
        db.prepare(
          `INSERT INTO source_collections (
             id, source_id, identity_key, external_id, root_external_id,
             display_name, origin, registration_state, validation_state,
             lifecycle_state, selected, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'registered', 'active', 'unvalidated',
                     'inactive', 0, ?, ?)`,
        ).run(
          collectionId,
          sourceId,
          identityKey,
          input.docLibId,
          input.rootArchiveId,
          input.displayName,
          now,
          now,
        );
      }
      audit(
        db,
        existing ? "collection.reregister" : "collection.register",
        collectionId,
        {
          sourceId,
          displayName: input.displayName,
          docLibId: input.docLibId,
          rootArchiveId: input.rootArchiveId,
        },
        now,
      );
      const row = db
        .prepare(`${collectionSelectSql()} WHERE c.id = ?`)
        .get(collectionId) as Record<string, unknown>;
      return collectionView(row);
    });
  } finally {
    db.close();
  }
}

export function setCollectionValidation(
  dbPath: string,
  collectionId: string,
  input: { valid: boolean; error?: string },
) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT c.source_id, s.selection_policy,
                  EXISTS(
                    SELECT 1 FROM source_exclusion_rules exclusion
                     WHERE exclusion.collection_id = c.id
                       AND exclusion.target_type = 'collection'
                  ) AS excluded
             FROM source_collections c
             JOIN corpus_sources s ON s.id = c.source_id
            WHERE c.id = ? AND c.registration_state = 'active'`,
        )
        .get(collectionId) as
        | { source_id: string; selection_policy: string; excluded: number }
        | undefined;
      if (!row) {
        return null;
      }
      const selected = input.valid && row.selection_policy === "all" ? 1 : 0;
      db.prepare(
        `UPDATE source_collections
            SET validation_state = ?, validation_error = ?, selected = ?,
                lifecycle_state = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.valid ? "valid" : "invalid",
        input.valid ? null : (input.error ?? "Collection validation failed."),
        selected,
        row.excluded ? "excluded" : selected ? "pending" : "inactive",
        now,
        collectionId,
      );
      if (selected) {
        ensureProject(db, collectionId, now);
      } else {
        deactivateProject(db, collectionId, now);
      }
      const result = db
        .prepare(`${collectionSelectSql()} WHERE c.id = ?`)
        .get(collectionId) as Record<string, unknown>;
      return collectionView(result);
    });
  } finally {
    db.close();
  }
}

export function setCollectionSelectionPolicy(
  dbPath: string,
  sourceId: string,
  policy: "none" | "explicit" | "all",
  explicitCollectionIds?: string[],
) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = db
        .prepare("SELECT selection_policy FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
        .get(sourceId) as { selection_policy: string } | undefined;
      if (!source) {
        throw new Error("Corpus Source not found.");
      }
      let selectedIds: string[];
      if (policy === "none") {
        selectedIds = [];
      } else if (policy === "all") {
        selectedIds = (
          db
            .prepare(
              `SELECT id FROM source_collections
                WHERE source_id = ?
                  AND registration_state = 'active'
                  AND validation_state = 'valid'
                  AND deleted_at IS NULL`,
            )
            .all(sourceId) as Array<{ id: string }>
        ).map((row) => row.id);
      } else if (explicitCollectionIds !== undefined) {
        selectedIds = [...new Set(explicitCollectionIds)];
      } else if (source.selection_policy === "all") {
        selectedIds = (
          db
            .prepare(
              `SELECT id FROM source_collections
                WHERE source_id = ? AND selected = 1 AND deleted_at IS NULL`,
            )
            .all(sourceId) as Array<{ id: string }>
        ).map((row) => row.id);
      } else {
        selectedIds = [];
      }
      if (selectedIds.length > 0) {
        const placeholders = selectedIds.map(() => "?").join(", ");
        const validRows = db
          .prepare(
            `SELECT id FROM source_collections
              WHERE source_id = ?
                AND id IN (${placeholders})
                AND registration_state = 'active'
                AND validation_state = 'valid'
                AND deleted_at IS NULL`,
          )
          .all(sourceId, ...selectedIds) as Array<{ id: string }>;
        if (validRows.length !== selectedIds.length) {
          throw new Error("Explicit selection contains an invalid or unknown collection.");
        }
      }
      db.prepare("UPDATE corpus_sources SET selection_policy = ?, updated_at = ? WHERE id = ?").run(
        policy,
        now,
        sourceId,
      );
      db.prepare(
        `UPDATE source_collections
            SET selected = 0,
                lifecycle_state = CASE WHEN EXISTS (
                  SELECT 1 FROM source_exclusion_rules exclusion
                   WHERE exclusion.collection_id = source_collections.id
                     AND exclusion.target_type = 'collection'
                ) THEN 'excluded' ELSE 'inactive' END,
                updated_at = ?
          WHERE source_id = ? AND deleted_at IS NULL`,
      ).run(now, sourceId);
      db.prepare(
        `UPDATE projects
            SET lifecycle_state = CASE WHEN EXISTS (
                  SELECT 1 FROM source_exclusion_rules exclusion
                   WHERE exclusion.collection_id = projects.source_collection_id
                     AND exclusion.target_type = 'collection'
                ) THEN 'excluded' ELSE 'inactive' END,
                retrieval_eligible = 0, updated_at = ?
          WHERE source_id = ?`,
      ).run(now, sourceId);
      for (const collectionId of selectedIds) {
        db.prepare(
          `UPDATE source_collections
              SET selected = 1,
                  lifecycle_state = CASE WHEN EXISTS (
                    SELECT 1 FROM source_exclusion_rules exclusion
                     WHERE exclusion.collection_id = source_collections.id
                       AND exclusion.target_type = 'collection'
                  ) THEN 'excluded' ELSE 'pending' END,
                  updated_at = ?
            WHERE id = ?`,
        ).run(now, collectionId);
        ensureProject(db, collectionId, now);
      }
      audit(db, "collection.selection.update", sourceId, { policy, selectedIds }, now);
      return {
        policy,
        collections: (
          db
            .prepare(
              `${collectionSelectSql()}
                WHERE c.source_id = ?
                  AND c.registration_state <> 'deregistered'
                  AND c.deleted_at IS NULL
                ORDER BY c.display_name COLLATE NOCASE`,
            )
            .all(sourceId) as Array<Record<string, unknown>>
        ).map(collectionView),
      };
    });
  } finally {
    db.close();
  }
}

export function deregisterSourceCollection(dbPath: string, collectionId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const row = db
        .prepare("SELECT source_id, selected, origin FROM source_collections WHERE id = ?")
        .get(collectionId) as
        | { source_id: string; selected: number; origin: string }
        | undefined;
      if (!row) {
        return false;
      }
      if (row.origin !== "registered") {
        throw new Error("Discovered collections cannot be deregistered.");
      }
      if (row.selected) {
        throw new Error("Deselect the Source Collection before deregistering it.");
      }
      db.prepare(
        `UPDATE source_collections
            SET registration_state = 'deregistered',
                lifecycle_state = CASE WHEN EXISTS (
                  SELECT 1 FROM source_exclusion_rules exclusion
                   WHERE exclusion.collection_id = source_collections.id
                     AND exclusion.target_type = 'collection'
                ) THEN 'excluded' ELSE 'inactive' END,
                updated_at = ?
          WHERE id = ?`,
      ).run(now, collectionId);
      deactivateProject(db, collectionId, now);
      audit(db, "collection.deregister", collectionId, { sourceId: row.source_id }, now);
      return true;
    });
  } finally {
    db.close();
  }
}

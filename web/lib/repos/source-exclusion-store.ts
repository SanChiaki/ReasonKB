import crypto from "node:crypto";
import Database from "better-sqlite3";
import { runImmediateTransaction } from "@/lib/db/immediate-transaction";

type Db = InstanceType<typeof Database>;

export type CreateSourceExclusionInput =
  | { targetType: "collection"; collectionId: string }
  | { targetType: "item"; sourceItemId: string };

type ExclusionRow = {
  id: string;
  source_id: string;
  collection_id: string;
  target_type: "collection" | "folder" | "document";
  target_external_id: string;
  display_path: string;
  created_at: string;
};

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function exclusionView(row: ExclusionRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    collectionId: row.collection_id,
    targetType: row.target_type,
    targetExternalId: row.target_external_id,
    displayPath: row.display_path,
    createdAt: row.created_at,
  };
}

function audit(
  db: Db,
  action: "source.exclusion.create" | "source.exclusion.delete",
  row: ExclusionRow,
  now: string,
) {
  db.prepare(
    `INSERT INTO admin_audit_events (
       id, action, target_type, target_id, outcome, after_json, created_at
     ) VALUES (?, ?, 'source_exclusion', ?, 'success', ?, ?)`,
  ).run(
    `audit_${crypto.randomUUID()}`,
    action,
    row.id,
    JSON.stringify(exclusionView(row)),
    now,
  );
}

function queueFilterSync(db: Db, sourceId: string, collectionId: string, now: string) {
  const state = db
    .prepare(
      `SELECT s.config_revision, s.state AS source_state,
              c.filter_revision, c.selected, c.validation_state,
              c.registration_state
         FROM source_collections c
         JOIN corpus_sources s ON s.id = c.source_id
        WHERE c.id = ? AND c.source_id = ?
          AND c.deleted_at IS NULL AND s.deleted_at IS NULL`,
    )
    .get(collectionId, sourceId) as
    | {
        config_revision: number;
        source_state: string;
        filter_revision: number;
        selected: number;
        validation_state: string;
        registration_state: string;
      }
    | undefined;
  if (
    !state ||
    state.source_state !== "active" ||
    !state.selected ||
    state.validation_state !== "valid" ||
    state.registration_state !== "active"
  ) {
    return { queued: 0, coalesced: 0 };
  }

  db.prepare(
    "UPDATE corpus_sources SET next_sync_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, sourceId);
  const active = db
    .prepare(
      `SELECT id, status
         FROM sync_runs
        WHERE collection_id = ? AND status IN ('queued', 'running')`,
    )
    .get(collectionId) as { id: string; status: "queued" | "running" } | undefined;
  if (active?.status === "queued") {
    db.prepare(
      `UPDATE sync_runs
          SET source_config_revision = ?, collection_filter_revision = ?,
              trigger_kind = 'filter_change'
        WHERE id = ? AND status = 'queued'`,
    ).run(state.config_revision, state.filter_revision, active.id);
    return { queued: 0, coalesced: 1 };
  }
  if (active) {
    db.prepare("UPDATE sync_runs SET follow_up_requested = 1 WHERE id = ?").run(active.id);
    return { queued: 0, coalesced: 1 };
  }

  db.prepare(
    `INSERT INTO sync_runs (
       id, source_id, collection_id, source_config_revision,
       collection_filter_revision, trigger_kind, status, started_at
     ) VALUES (?, ?, ?, ?, ?, 'filter_change', 'queued', ?)`,
  ).run(
    `sync_${crypto.randomUUID()}`,
    sourceId,
    collectionId,
    state.config_revision,
    state.filter_revision,
    now,
  );
  return { queued: 1, coalesced: 0 };
}

function markCollectionExcluded(
  db: Db,
  sourceId: string,
  collectionId: string,
  now: string,
) {
  db.prepare(
    `UPDATE source_collections
        SET lifecycle_state = 'excluded', updated_at = ?
      WHERE id = ? AND source_id = ?`,
  ).run(now, collectionId, sourceId);
  db.prepare(
    `UPDATE projects
        SET lifecycle_state = 'excluded', retrieval_eligible = 0, updated_at = ?
      WHERE source_id = ? AND source_collection_id = ?`,
  ).run(now, sourceId, collectionId);
  db.prepare(
    `UPDATE source_items
        SET lifecycle_state = 'excluded', updated_at = ?
      WHERE source_id = ? AND collection_id = ? AND deleted_at IS NULL`,
  ).run(now, sourceId, collectionId);
  db.prepare(
    `UPDATE documents
        SET lifecycle_state = 'excluded', retrieval_eligible = 0, updated_at = ?
      WHERE source_id = ? AND source_collection_id = ? AND deleted_at IS NULL`,
  ).run(now, sourceId, collectionId);
  db.prepare(
    `UPDATE jobs
        SET status = 'superseded', superseded_at = ?, updated_at = ?, finished_at = ?
      WHERE status = 'queued'
        AND document_id IN (
          SELECT id FROM documents
           WHERE source_id = ? AND source_collection_id = ? AND deleted_at IS NULL
        )`,
  ).run(now, now, now, sourceId, collectionId);
}

const AFFECTED_ITEMS_CTE = `
  WITH RECURSIVE affected(id) AS (
    SELECT id FROM source_items
     WHERE id = ? AND source_id = ? AND collection_id = ? AND deleted_at IS NULL
    UNION
    SELECT child.id
      FROM source_items child
      JOIN affected parent ON child.parent_item_id = parent.id
     WHERE child.source_id = ? AND child.collection_id = ? AND child.deleted_at IS NULL
  )
`;

function markItemTreeExcluded(
  db: Db,
  sourceId: string,
  collectionId: string,
  sourceItemId: string,
  now: string,
) {
  const cteParams = [sourceItemId, sourceId, collectionId, sourceId, collectionId];
  db.prepare(
    `${AFFECTED_ITEMS_CTE}
     UPDATE source_items
        SET lifecycle_state = 'excluded', updated_at = ?
      WHERE id IN (SELECT id FROM affected)`,
  ).run(...cteParams, now);
  db.prepare(
    `${AFFECTED_ITEMS_CTE}
     UPDATE documents
        SET lifecycle_state = 'excluded', retrieval_eligible = 0, updated_at = ?
      WHERE source_item_id IN (SELECT id FROM affected) AND deleted_at IS NULL`,
  ).run(...cteParams, now);
  db.prepare(
    `${AFFECTED_ITEMS_CTE}
     UPDATE jobs
        SET status = 'superseded', superseded_at = ?, updated_at = ?, finished_at = ?
      WHERE status = 'queued'
        AND document_id IN (
          SELECT id FROM documents
           WHERE source_item_id IN (SELECT id FROM affected) AND deleted_at IS NULL
        )`,
  ).run(...cteParams, now, now, now);
}

export function listSourceExclusions(dbPath: string, sourceId: string) {
  const db = open(dbPath);
  try {
    const source = db
      .prepare("SELECT 1 FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
      .get(sourceId);
    if (!source) return null;
    return (
      db
        .prepare(
          `SELECT id, source_id, collection_id, target_type,
                  target_external_id, display_path, created_at
             FROM source_exclusion_rules
            WHERE source_id = ?
            ORDER BY display_path COLLATE NOCASE, created_at, id`,
        )
        .all(sourceId) as ExclusionRow[]
    ).map(exclusionView);
  } finally {
    db.close();
  }
}

export function createSourceExclusion(
  dbPath: string,
  sourceId: string,
  input: CreateSourceExclusionInput,
) {
  const db = open(dbPath);
  const now = new Date().toISOString();
  try {
    return runImmediateTransaction(db, () => {
      let collectionId: string;
      let sourceItemId: string | null = null;
      let targetType: ExclusionRow["target_type"];
      let targetExternalId: string;
      let displayPath: string;

      if (input.targetType === "collection") {
        const collection = db
          .prepare(
            `SELECT id, external_id, display_name
               FROM source_collections
              WHERE id = ? AND source_id = ? AND registration_state = 'active'
                AND deleted_at IS NULL`,
          )
          .get(input.collectionId, sourceId) as
          | { id: string; external_id: string; display_name: string }
          | undefined;
        if (!collection) throw new Error("Source Collection not found.");
        collectionId = collection.id;
        targetType = "collection";
        targetExternalId = collection.external_id;
        displayPath = collection.display_name;
      } else {
        const item = db
          .prepare(
            `SELECT id, collection_id, external_id, item_type, relative_path, name
               FROM source_items
              WHERE id = ? AND source_id = ? AND deleted_at IS NULL`,
          )
          .get(input.sourceItemId, sourceId) as
          | {
              id: string;
              collection_id: string;
              external_id: string;
              item_type: string;
              relative_path: string;
              name: string;
            }
          | undefined;
        if (!item) throw new Error("Source item not found.");
        if (item.item_type !== "folder" && item.item_type !== "document") {
          throw new Error("Only source folders and documents can be excluded.");
        }
        collectionId = item.collection_id;
        sourceItemId = item.id;
        targetType = item.item_type;
        targetExternalId = item.external_id;
        displayPath = item.relative_path || item.name;
      }

      const duplicate = db
        .prepare(
          `SELECT id FROM source_exclusion_rules
            WHERE collection_id = ? AND target_type = ? AND target_external_id = ?`,
        )
        .get(collectionId, targetType, targetExternalId);
      if (duplicate) throw new Error("This source target is already excluded.");

      const row: ExclusionRow = {
        id: `exclusion_${crypto.randomUUID()}`,
        source_id: sourceId,
        collection_id: collectionId,
        target_type: targetType,
        target_external_id: targetExternalId,
        display_path: displayPath,
        created_at: now,
      };
      db.prepare(
        `INSERT INTO source_exclusion_rules (
           id, source_id, collection_id, target_type,
           target_external_id, display_path, created_at
         ) VALUES (@id, @source_id, @collection_id, @target_type,
                   @target_external_id, @display_path, @created_at)`,
      ).run(row);
      db.prepare(
        `UPDATE source_collections
            SET filter_revision = filter_revision + 1, updated_at = ?
          WHERE id = ? AND source_id = ?`,
      ).run(now, collectionId, sourceId);
      if (targetType === "collection") {
        markCollectionExcluded(db, sourceId, collectionId, now);
      } else {
        markItemTreeExcluded(db, sourceId, collectionId, sourceItemId!, now);
      }
      const sync = queueFilterSync(db, sourceId, collectionId, now);
      audit(db, "source.exclusion.create", row, now);
      return { exclusion: exclusionView(row), sync };
    });
  } finally {
    db.close();
  }
}

function isTargetStillExcluded(db: Db, row: ExclusionRow) {
  if (row.target_type === "collection") {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM source_exclusion_rules
            WHERE collection_id = ? AND target_type = 'collection' LIMIT 1`,
        )
        .get(row.collection_id),
    );
  }
  return Boolean(
    db
      .prepare(
        `WITH RECURSIVE ancestors(external_id, parent_item_id) AS (
           SELECT external_id, parent_item_id
             FROM source_items
            WHERE source_id = ? AND collection_id = ? AND external_id = ?
              AND deleted_at IS NULL
           UNION
           SELECT parent.external_id, parent.parent_item_id
             FROM source_items parent
             JOIN ancestors child ON parent.id = child.parent_item_id
            WHERE parent.deleted_at IS NULL
         )
         SELECT 1
           FROM source_exclusion_rules rule
          WHERE rule.collection_id = ?
            AND (
              rule.target_type = 'collection'
              OR rule.target_external_id IN (SELECT external_id FROM ancestors)
            )
          LIMIT 1`,
      )
      .get(
        row.source_id,
        row.collection_id,
        row.target_external_id,
        row.collection_id,
      ),
  );
}

export function deleteSourceExclusion(dbPath: string, sourceId: string, exclusionId: string) {
  const db = open(dbPath);
  const now = new Date().toISOString();
  try {
    return runImmediateTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT id, source_id, collection_id, target_type,
                  target_external_id, display_path, created_at
             FROM source_exclusion_rules
            WHERE id = ? AND source_id = ?`,
        )
        .get(exclusionId, sourceId) as ExclusionRow | undefined;
      if (!row) return null;
      db.prepare("DELETE FROM source_exclusion_rules WHERE id = ?").run(row.id);
      db.prepare(
        `UPDATE source_collections
            SET filter_revision = filter_revision + 1, updated_at = ?
          WHERE id = ? AND source_id = ?`,
      ).run(now, row.collection_id, sourceId);
      const stillExcluded = isTargetStillExcluded(db, row);
      const sync = queueFilterSync(db, sourceId, row.collection_id, now);
      audit(db, "source.exclusion.delete", row, now);
      return {
        exclusion: exclusionView(row),
        stillExcluded,
        restorationPending: !stillExcluded,
        sync,
      };
    });
  } finally {
    db.close();
  }
}

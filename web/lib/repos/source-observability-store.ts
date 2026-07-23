import Database from "better-sqlite3";

function open(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

export function getSourceRuntimeStatus(dbPath: string, sourceId: string) {
  const db = open(dbPath);
  try {
    const source = db
      .prepare("SELECT id FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
      .get(sourceId);
    if (!source) return null;

    const coverage = db
      .prepare(
        `SELECT
           COUNT(*) AS total_documents,
           SUM(CASE WHEN d.status = 'ready' AND d.retrieval_eligible = 1
                         AND di.document_id IS NOT NULL THEN 1 ELSE 0 END) AS retrievable_documents,
           SUM(CASE WHEN d.status = 'uploaded' AND d.lifecycle_state <> 'excluded'
                    THEN 1 ELSE 0 END) AS queued_documents,
           SUM(CASE WHEN d.status IN ('processing', 'indexing')
                         AND d.lifecycle_state <> 'excluded' THEN 1 ELSE 0 END) AS indexing_documents,
           SUM(CASE WHEN d.status = 'failed' AND d.lifecycle_state <> 'excluded'
                    THEN 1 ELSE 0 END) AS failed_documents,
           SUM(CASE WHEN d.lifecycle_state = 'excluded' THEN 1 ELSE 0 END) AS excluded_documents,
           SUM(CASE WHEN d.lifecycle_state = 'unsupported' THEN 1 ELSE 0 END) AS unsupported_documents,
           SUM(CASE WHEN d.lifecycle_state = 'unsupported'
                         AND si.lifecycle_state = 'unsupported'
                         AND si.deleted_at IS NULL
                         AND json_extract(si.metadata_json, '$.skipCode') = 'seeyon_missing_file_id'
                    THEN 1 ELSE 0 END) AS missing_file_id_documents,
           SUM(CASE WHEN d.lifecycle_state = 'oversized' THEN 1 ELSE 0 END) AS oversized_documents,
           SUM(CASE WHEN d.lifecycle_state = 'missing' THEN 1 ELSE 0 END) AS missing_documents,
           SUM(CASE WHEN d.lifecycle_state = 'access_revoked' THEN 1 ELSE 0 END) AS access_revoked_documents
         FROM documents d
         LEFT JOIN document_indexes di
           ON di.document_id = d.id AND di.is_current = 1
         LEFT JOIN source_items si ON si.id = d.source_item_id
        WHERE d.source_id = ?
          AND d.deleted_at IS NULL`,
      )
      .get(sourceId) as {
      total_documents: number;
      retrievable_documents: number;
      queued_documents: number;
      indexing_documents: number;
      failed_documents: number;
      excluded_documents: number;
      unsupported_documents: number;
      missing_file_id_documents: number;
      oversized_documents: number;
      missing_documents: number;
      access_revoked_documents: number;
    };
    const itemStates = db
      .prepare(
        `SELECT lifecycle_state, COUNT(*) AS count
           FROM source_items
          WHERE source_id = ? AND deleted_at IS NULL
          GROUP BY lifecycle_state`,
      )
      .all(sourceId) as Array<{ lifecycle_state: string; count: number }>;
    const syncRuns = db
      .prepare(
        `SELECT r.id, r.trigger_kind, r.status, r.started_at, r.completed_at,
                r.seen_item_count, r.changed_item_count, r.missing_item_count,
                r.error_summary, c.id AS collection_id,
                c.display_name AS collection_name
           FROM sync_runs r
           JOIN source_collections c ON c.id = r.collection_id
          WHERE r.source_id = ?
          ORDER BY r.started_at DESC
          LIMIT 25`,
      )
      .all(sourceId) as Array<Record<string, unknown>>;
    const discoveryRuns = db
      .prepare(
        `SELECT id, status, started_at, completed_at, item_count, error_summary
           FROM source_discovery_runs
          WHERE source_id = ?
          ORDER BY started_at DESC
          LIMIT 10`,
      )
      .all(sourceId) as Array<Record<string, unknown>>;

    const total = Number(coverage.total_documents ?? 0);
    const retrievable = Number(coverage.retrievable_documents ?? 0);
    const excluded = Number(coverage.excluded_documents ?? 0);
    const eligibleTotal = Math.max(0, total - excluded);
    return {
      coverage: {
        totalDocuments: total,
        retrievableDocuments: retrievable,
        queuedDocuments: Number(coverage.queued_documents ?? 0),
        indexingDocuments: Number(coverage.indexing_documents ?? 0),
        failedDocuments: Number(coverage.failed_documents ?? 0),
        excludedDocuments: excluded,
        unsupportedDocuments: Number(coverage.unsupported_documents ?? 0),
        missingFileIdDocuments: Number(coverage.missing_file_id_documents ?? 0),
        oversizedDocuments: Number(coverage.oversized_documents ?? 0),
        missingDocuments: Number(coverage.missing_documents ?? 0),
        accessRevokedDocuments: Number(coverage.access_revoked_documents ?? 0),
        percent:
          eligibleTotal === 0
            ? 100
            : Math.round((retrievable / eligibleTotal) * 1000) / 10,
      },
      itemStates: Object.fromEntries(
        itemStates.map((row) => [row.lifecycle_state, row.count]),
      ),
      syncRuns: syncRuns.map((row) => ({
        id: row.id,
        collectionId: row.collection_id,
        collectionName: row.collection_name,
        triggerKind: row.trigger_kind,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        seenItemCount: row.seen_item_count,
        changedItemCount: row.changed_item_count,
        missingItemCount: row.missing_item_count,
        errorSummary: row.error_summary,
      })),
      discoveryRuns: discoveryRuns.map((row) => ({
        id: row.id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        itemCount: row.item_count,
        errorSummary: row.error_summary,
      })),
    };
  } finally {
    db.close();
  }
}

export function listSourceItems(
  dbPath: string,
  sourceId: string,
  input: {
    collectionId: string;
    parentId?: string | null;
    cursor?: string | null;
    limit?: number;
  },
) {
  const db = open(dbPath);
  try {
    const collection = db
      .prepare(
        `SELECT id FROM source_collections
          WHERE id = ? AND source_id = ? AND deleted_at IS NULL`,
      )
      .get(input.collectionId, sourceId);
    if (!collection) return null;
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const cursor = decodeItemsCursor(input.cursor);
    const cursorSql = cursor
      ? `AND (
           CASE source_items.item_type WHEN 'folder' THEN 0 ELSE 1 END > ?
           OR (
             CASE source_items.item_type WHEN 'folder' THEN 0 ELSE 1 END = ?
             AND (
               source_items.name COLLATE NOCASE > ? COLLATE NOCASE
               OR (source_items.name = ? COLLATE NOCASE AND source_items.id > ?)
             )
           )
         )`
      : "";
    const rows = db
      .prepare(
        `SELECT source_items.id, external_id, parent_item_id, item_type,
                source_items.name, relative_path, source_items.mime_type,
                size_bytes, source_items.source_revision,
                source_items.lifecycle_state, source_items.document_id,
                source_items.updated_at, d.status AS document_status,
                CASE
                  WHEN d.import_error IS NOT NULL THEN d.import_error
                  WHEN d.error_message IS NOT NULL THEN d.error_message
                  WHEN source_items.lifecycle_state = 'missing' THEN 'Item is no longer present in the source.'
                  WHEN source_items.lifecycle_state = 'access_revoked' THEN 'Source access has been revoked.'
                  ELSE NULL
                END AS status_reason,
                EXISTS(
                  SELECT 1 FROM source_items child
                   WHERE child.parent_item_id = source_items.id
                     AND child.deleted_at IS NULL
                ) AS has_children
           FROM source_items
          LEFT JOIN documents d ON d.id = source_items.document_id
          WHERE source_items.source_id = ? AND source_items.collection_id = ?
            AND source_items.parent_item_id IS ?
            AND source_items.deleted_at IS NULL
            ${cursorSql}
          ORDER BY CASE source_items.item_type WHEN 'folder' THEN 0 ELSE 1 END,
                   source_items.name COLLATE NOCASE, source_items.id
          LIMIT ?`,
      )
      .all(
        sourceId,
        input.collectionId,
        input.parentId ?? null,
        ...(cursor
          ? [cursor.itemTypeRank, cursor.itemTypeRank, cursor.name, cursor.name, cursor.id]
          : []),
        limit + 1,
      ) as Array<Record<string, unknown>>;
    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const exclusionByItem = effectiveExclusions(db, input.collectionId, pageRows);
    return {
      items: pageRows.map((row) => {
        const exclusion = exclusionByItem.get(row.id as string);
        return {
          id: row.id,
          externalId: row.external_id,
          parentId: row.parent_item_id,
          itemType: row.item_type,
          name: row.name,
          relativePath: row.relative_path,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          sourceRevision: row.source_revision,
          lifecycleState: row.lifecycle_state,
          documentStatus: row.document_status,
          statusReason: exclusion
            ? `Excluded by source rule: ${exclusion.displayPath}`
            : row.status_reason,
          documentId: row.document_id,
          hasChildren: Boolean(row.has_children),
          exclusionRuleId: exclusion?.directRuleId ?? null,
          excludedByRuleId: exclusion?.ruleId ?? null,
          excludedByPath: exclusion?.displayPath ?? null,
          updatedAt: row.updated_at,
        };
      }),
      nextCursor:
        hasNextPage && pageRows.length > 0
          ? encodeItemsCursor(pageRows[pageRows.length - 1])
          : null,
    };
  } finally {
    db.close();
  }
}

type EffectiveExclusion = {
  ruleId: string;
  displayPath: string;
  directRuleId: string | null;
};

function effectiveExclusions(
  db: ReturnType<typeof open>,
  collectionId: string,
  rows: Array<Record<string, unknown>>,
) {
  const result = new Map<string, EffectiveExclusion>();
  if (rows.length === 0) return result;
  const collectionRule = db
    .prepare(
      `SELECT id, display_path FROM source_exclusion_rules
        WHERE collection_id = ? AND target_type = 'collection'`,
    )
    .get(collectionId) as { id: string; display_path: string } | undefined;
  const placeholders = rows.map(() => "?").join(", ");
  const itemRules = db
    .prepare(
      `WITH RECURSIVE ancestry(item_id, ancestor_id, depth) AS (
         SELECT id, id, 0 FROM source_items WHERE id IN (${placeholders})
         UNION
         SELECT ancestry.item_id, parent.id, ancestry.depth + 1
           FROM ancestry
           JOIN source_items current ON current.id = ancestry.ancestor_id
           JOIN source_items parent ON parent.id = current.parent_item_id
          WHERE parent.deleted_at IS NULL
       )
       SELECT ancestry.item_id, ancestry.depth, rule.id AS rule_id,
              rule.display_path
         FROM ancestry
         JOIN source_items ancestor ON ancestor.id = ancestry.ancestor_id
         JOIN source_exclusion_rules rule
           ON rule.collection_id = ancestor.collection_id
          AND rule.target_external_id = ancestor.external_id
          AND rule.target_type = ancestor.item_type
        ORDER BY ancestry.item_id, ancestry.depth`,
    )
    .all(...rows.map((row) => row.id)) as Array<{
    item_id: string;
    depth: number;
    rule_id: string;
    display_path: string;
  }>;
  for (const row of itemRules) {
    if (result.has(row.item_id)) continue;
    result.set(row.item_id, {
      ruleId: row.rule_id,
      displayPath: row.display_path,
      directRuleId: row.depth === 0 ? row.rule_id : null,
    });
  }
  if (collectionRule) {
    for (const row of rows) {
      const itemId = row.id as string;
      if (!result.has(itemId)) {
        result.set(itemId, {
          ruleId: collectionRule.id,
          displayPath: collectionRule.display_path,
          directRuleId: null,
        });
      }
    }
  }
  return result;
}

export class InvalidSourceItemsCursorError extends Error {}

function decodeItemsCursor(cursor?: string | null) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      itemTypeRank?: unknown;
      name?: unknown;
      id?: unknown;
    };
    if (
      (parsed.itemTypeRank !== 0 && parsed.itemTypeRank !== 1) ||
      typeof parsed.name !== "string" ||
      typeof parsed.id !== "string" ||
      !parsed.id
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as { itemTypeRank: 0 | 1; name: string; id: string };
  } catch {
    throw new InvalidSourceItemsCursorError("Invalid source item cursor.");
  }
}

function encodeItemsCursor(row: Record<string, unknown>) {
  return Buffer.from(
    JSON.stringify({
      itemTypeRank: row.item_type === "folder" ? 0 : 1,
      name: row.name,
      id: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

export function listAdminAuditEvents(dbPath: string, limit = 100) {
  const db = open(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, actor, action, target_type, target_id, outcome,
                before_json, after_json, error_summary, created_at
           FROM admin_audit_events
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      outcome: row.outcome,
      before: row.before_json ? JSON.parse(row.before_json as string) : null,
      after: row.after_json ? JSON.parse(row.after_json as string) : null,
      errorSummary: row.error_summary,
      createdAt: row.created_at,
    }));
  } finally {
    db.close();
  }
}

import Database from "better-sqlite3";

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

const activeProjectWhere = `
  p.deleted_at IS NULL
  AND p.source_id IS NOT NULL
  AND p.source_collection_id IS NOT NULL
  AND p.lifecycle_state = 'active'
  AND p.retrieval_eligible = 1
  AND s.deleted_at IS NULL
  AND s.state = 'active'
  AND c.deleted_at IS NULL
  AND c.registration_state = 'active'
  AND c.validation_state = 'valid'
  AND c.lifecycle_state = 'active'
  AND c.selected = 1
`;

type ProjectRow = {
  id: string;
  name: string;
  updated_at: string;
  document_count: number;
  source_id: string;
  source_display_name: string;
  source_kind: "local" | "smb" | "seeyon";
  collection_id: string;
  collection_external_id: string;
  collection_root_external_id: string | null;
};

function projectView(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    documentCount: row.document_count,
    updatedAt: row.updated_at,
    source: {
      id: row.source_id,
      displayName: row.source_display_name,
      kind: row.source_kind,
    },
    collection: {
      id: row.collection_id,
      externalId: row.collection_external_id,
      rootExternalId: row.collection_root_external_id,
    },
  };
}

const projectSelect = `
  SELECT p.id, p.name, p.updated_at,
         s.id AS source_id, s.display_name AS source_display_name,
         s.kind AS source_kind, c.id AS collection_id,
         c.external_id AS collection_external_id,
         c.root_external_id AS collection_root_external_id,
         COUNT(DISTINCT di.document_id) AS document_count
    FROM projects p
    JOIN corpus_sources s ON s.id = p.source_id
    JOIN source_collections c ON c.id = p.source_collection_id
    LEFT JOIN documents d
      ON d.project_id = p.id
     AND d.deleted_at IS NULL
     AND d.lifecycle_state = 'active'
     AND d.retrieval_eligible = 1
     AND d.status = 'ready'
    LEFT JOIN document_indexes di
      ON di.document_id = d.id
     AND di.is_current = 1
`;

export function listProjects(dbPath: string) {
  const db = open(dbPath);
  try {
    const rows = db
      .prepare(
        `${projectSelect}
         WHERE ${activeProjectWhere}
         GROUP BY p.id
         ORDER BY p.updated_at DESC, p.name COLLATE NOCASE`,
      )
      .all() as ProjectRow[];
    return rows.map(projectView);
  } finally {
    db.close();
  }
}

export function getProjectById(dbPath: string, projectId: string) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare(
        `${projectSelect}
         WHERE p.id = ? AND ${activeProjectWhere}
         GROUP BY p.id`,
      )
      .get(projectId) as ProjectRow | undefined;
    return row ? projectView(row) : null;
  } finally {
    db.close();
  }
}

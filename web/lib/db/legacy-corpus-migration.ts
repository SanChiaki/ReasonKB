import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MigrationDatabase } from "@/lib/db/migrations";
import {
  encryptSourceCredentials,
  loadMasterKey,
} from "@/lib/security/source-credentials";

export type LegacyCorpusMigrationOptions = {
  legacyLocalRoot?: string;
  legacySmbRoot?: string;
  uploadRoot?: string;
  masterKeyPath?: string;
  legacySmbUsernameFile?: string;
  legacySmbPasswordFile?: string;
  legacySmbDomain?: string;
  legacySmbPort?: number;
  legacySmbAuthProtocol?: "ntlm" | "negotiate";
};

type SourceDocument = {
  id: string;
  project_id: string;
  file_name: string;
  mime_type: string;
  source_kind: "directory" | "smb";
  source_root: string | null;
  source_relative_path: string;
  project_relative_path: string | null;
  source_mtime: string | null;
  source_size: number | null;
  file_size: number;
  content_hash: string | null;
  storage_path: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function stableId(prefix: string, ...parts: string[]) {
  const digest = crypto
    .createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function legacySourceRoot(
  kind: "directory" | "smb",
  storedRoot: string | null,
  options: LegacyCorpusMigrationOptions,
) {
  const root =
    storedRoot?.trim() ||
    (kind === "directory" ? options.legacyLocalRoot : options.legacySmbRoot)?.trim();
  if (!root) {
    throw new Error(`Cannot migrate legacy ${kind} documents without a source root`);
  }
  return root;
}

function sourceRevision(document: SourceDocument) {
  if (document.content_hash) {
    return document.content_hash;
  }
  return JSON.stringify({
    mtime: document.source_mtime,
    size: document.source_size ?? document.file_size,
  });
}

function collectionExternalId(document: SourceDocument) {
  const firstSegment = document.source_relative_path.split("/").filter(Boolean)[0];
  if (!firstSegment) {
    throw new Error(
      `Cannot derive a collection from document ${document.id}: empty source-relative path`,
    );
  }
  return firstSegment;
}

function decodeSmbPathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function legacySmbScope(root: string, options: LegacyCorpusMigrationOptions) {
  const normalized = root.trim();
  if (/^smb:\/\//i.test(normalized)) {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(`Cannot parse legacy SMB source root: ${root}`);
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeSmbPathPart);
    if (!url.hostname || parts.length < 1) {
      throw new Error(`Cannot parse legacy SMB source root: ${root}`);
    }
    const share = parts.shift()!;
    return {
      host: url.hostname.toLowerCase(),
      share,
      basePath: parts.join("/"),
      port: options.legacySmbPort ?? (url.port ? Number(url.port) : 445),
    };
  }

  const parts = normalized.replace(/^\\\\|^\/\//, "").split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Cannot parse legacy SMB source root: ${root}`);
  }
  const hostPart = parts.shift()!;
  const share = parts.shift()!;
  const portMatch = /^(.*):(\d+)$/.exec(hostPart);
  return {
    host: (portMatch?.[1] ?? hostPart).toLowerCase(),
    share,
    basePath: parts.join("/"),
    port: options.legacySmbPort ?? (portMatch ? Number(portMatch[2]) : 445),
  };
}

export function repairLegacySmbUriScopes(
  db: MigrationDatabase,
  options: LegacyCorpusMigrationOptions,
) {
  const sources = db
    .prepare(
      `SELECT id, scope_json, config_json
         FROM corpus_sources
        WHERE kind = 'smb' AND deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; scope_json: string; config_json: string }>;
  const now = new Date().toISOString();
  for (const source of sources) {
    const config = JSON.parse(source.config_json) as { migratedFromLegacy?: boolean };
    const scope = JSON.parse(source.scope_json) as { host?: string };
    if (config.migratedFromLegacy !== true || scope.host !== "smb:") {
      continue;
    }
    const roots = db
      .prepare(
        `SELECT DISTINCT source_root
           FROM documents
          WHERE source_id = ? AND source_kind = 'smb'
            AND source_root IS NOT NULL AND TRIM(source_root) <> ''`,
      )
      .all(source.id) as Array<{ source_root: string }>;
    if (roots.length !== 1) {
      throw new Error(
        `Cannot repair legacy SMB source ${source.id}: expected one document source root, found ${roots.length}`,
      );
    }
    const repairedScope = legacySmbScope(roots[0].source_root, options);
    db.prepare(
      `UPDATE corpus_sources
          SET scope_json = ?, health_state = 'unknown', consecutive_failure_count = 0,
              error_summary = NULL, validated_at = NULL,
              validation_requested_at = ?, next_sync_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(repairedScope), now, now, now, source.id);
  }
}

function importLegacySmbCredentials(
  db: MigrationDatabase,
  sourceId: string,
  options: LegacyCorpusMigrationOptions,
  now: string,
) {
  if (!options.masterKeyPath) {
    throw new Error("Cannot migrate legacy SMB source without the credential master key");
  }
  const usernamePath = options.legacySmbUsernameFile;
  const passwordPath = options.legacySmbPasswordFile;
  if (!usernamePath || !passwordPath || !fs.existsSync(usernamePath) || !fs.existsSync(passwordPath)) {
    throw new Error("Cannot migrate legacy SMB source without its username and password files");
  }
  const credentials = {
    username: fs.readFileSync(usernamePath, "utf8").trimEnd(),
    password: fs.readFileSync(passwordPath, "utf8").trimEnd(),
    domain: options.legacySmbDomain?.trim() ?? "",
  };
  if (!credentials.username || !credentials.password) {
    throw new Error("Cannot migrate legacy SMB source with empty credentials");
  }
  const encrypted = encryptSourceCredentials(
    loadMasterKey(options.masterKeyPath),
    sourceId,
    credentials,
  );
  db.prepare(
    `INSERT INTO source_credentials (
       source_id, encrypted_payload, key_version, created_at, updated_at
     ) VALUES (?, ?, 1, ?, ?)`,
  ).run(sourceId, encrypted, now, now);
}

function validateLegacyDocuments(db: MigrationDatabase) {
  const documents = db
    .prepare(
      `SELECT id, project_id, source_relative_path
         FROM documents
        WHERE source_kind IN ('directory', 'smb')`,
    )
    .all() as Array<{
    id: string;
    project_id: string;
    source_relative_path: string | null;
  }>;
  for (const document of documents) {
    if (!document.source_relative_path?.trim()) {
      throw new Error(
        `Cannot migrate source-backed document ${document.id} without a source-relative path`,
      );
    }
  }
}

function queueAndDeleteDemoUploads(db: MigrationDatabase, now: string) {
  const uploadDocuments = db
    .prepare(
      `SELECT id, project_id, storage_path
         FROM documents
        WHERE source_kind = 'upload'`,
    )
    .all() as Array<{ id: string; project_id: string; storage_path: string }>;
  if (uploadDocuments.length > 0) {
    const documentIds = uploadDocuments.map((document) => document.id);
    const placeholders = documentIds.map(() => "?").join(", ");

    for (const document of uploadDocuments) {
      if (document.storage_path) {
        db.prepare(
          `INSERT INTO managed_file_purge_queue (path, reason, created_at)
           VALUES (?, 'removed-demo-upload', ?)
           ON CONFLICT(path) DO NOTHING`,
        ).run(document.storage_path, now);
      }
    }

    db.prepare(`DELETE FROM document_index_runs WHERE document_id IN (${placeholders})`).run(
      ...documentIds,
    );
    db.prepare(`DELETE FROM document_indexes WHERE document_id IN (${placeholders})`).run(
      ...documentIds,
    );
    db.prepare(`DELETE FROM jobs WHERE document_id IN (${placeholders})`).run(...documentIds);
    db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...documentIds);
  }

  const emptyProjectIds = (
    db
      .prepare(
        `SELECT p.id
           FROM projects p
          WHERE NOT EXISTS (
            SELECT 1 FROM documents d WHERE d.project_id = p.id
          )`,
      )
      .all() as Array<{ id: string }>
  ).map((project) => project.id);
  if (emptyProjectIds.length > 0) {
    const placeholders = emptyProjectIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM conversation_projects WHERE project_id IN (${placeholders})`).run(
      ...emptyProjectIds,
    );
    db.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).run(...emptyProjectIds);
  }
}

export function migrateLegacyCorpus(
  db: MigrationDatabase,
  options: LegacyCorpusMigrationOptions,
) {
  validateLegacyDocuments(db);
  const now = new Date().toISOString();
  queueAndDeleteDemoUploads(db, now);

  const documents = db
    .prepare(
      `SELECT id, project_id, file_name, mime_type, source_kind, source_root,
              source_relative_path, project_relative_path, source_mtime,
              source_size, file_size, content_hash, storage_path, created_at,
              updated_at, deleted_at
         FROM documents
        WHERE source_kind IN ('directory', 'smb')
        ORDER BY project_id, source_relative_path`,
    )
    .all() as SourceDocument[];
  if (documents.length === 0) {
    return;
  }

  const scopes = new Map<string, { kind: "directory" | "smb"; root: string }>();
  for (const document of documents) {
    const root = legacySourceRoot(document.source_kind, document.source_root, options);
    scopes.set(`${document.source_kind}\0${root}`, { kind: document.source_kind, root });
  }
  if (scopes.size !== 1) {
    throw new Error(
      `Legacy database contains ${scopes.size} source scopes; expected exactly one`,
    );
  }

  const [{ kind, root }] = [...scopes.values()];
  const connectorKind = kind === "directory" ? "local" : "smb";
  const sourceId = stableId("src", "legacy", connectorKind, root);
  const displayName = connectorKind === "local" ? "Local Corpus" : "SMB Corpus";
  const syncInterval = connectorKind === "local" ? 30 : 300;
  const scope = connectorKind === "local" ? { rootPath: root } : legacySmbScope(root, options);
  const config = connectorKind === "local"
    ? { migratedFromLegacy: true }
    : {
        migratedFromLegacy: true,
        authProtocol: options.legacySmbAuthProtocol ?? "ntlm",
      };
  db.prepare(
    `INSERT INTO corpus_sources (
       id, kind, display_name, state, scope_json, config_json, config_revision,
       selection_policy, schedule_mode, sync_interval_seconds, health_state,
       validated_at, ever_validated_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'active', ?, ?, 1, 'all', 'scheduled', ?, 'unknown', ?, ?, ?, ?)`,
  ).run(
    sourceId,
    connectorKind,
    displayName,
    JSON.stringify(scope),
    JSON.stringify(config),
    syncInterval,
    now,
    now,
    now,
    now,
  );
  if (connectorKind === "smb") {
    importLegacySmbCredentials(db, sourceId, options, now);
  }

  const projects = new Map<string, SourceDocument[]>();
  for (const document of documents) {
    const entries = projects.get(document.project_id) ?? [];
    entries.push(document);
    projects.set(document.project_id, entries);
  }

  for (const [projectId, projectDocuments] of projects) {
    const project = db
      .prepare("SELECT name, created_at, updated_at, deleted_at FROM projects WHERE id = ?")
      .get(projectId) as
      | { name: string; created_at: string; updated_at: string; deleted_at: string | null }
      | undefined;
    if (!project) {
      throw new Error(`Source-backed documents reference missing Project ${projectId}`);
    }
    const collectionIds = new Set(projectDocuments.map(collectionExternalId));
    if (collectionIds.size !== 1) {
      throw new Error(
        `Legacy Project ${project.name} (${projectId}) contains documents from multiple collections`,
      );
    }
    const [externalId] = [...collectionIds];
    const collectionId = stableId("col", sourceId, externalId);
    const collectionLifecycle = project.deleted_at ? "inactive" : "active";
    const projectRetrievable = project.deleted_at ? 0 : 1;
    db.prepare(
      `INSERT INTO source_collections (
         id, source_id, identity_key, external_id, display_name, origin,
         registration_state, validation_state, lifecycle_state, selected,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'discovered', 'active', 'valid', ?, 1, ?, ?)`,
    ).run(
      collectionId,
      sourceId,
      `path:${externalId}`,
      externalId,
      project.name,
      collectionLifecycle,
      project.created_at,
      project.updated_at,
    );
    db.prepare(
      `UPDATE projects
          SET source_id = ?, source_collection_id = ?, lifecycle_state = ?,
              retrieval_eligible = ?
        WHERE id = ?`,
    ).run(sourceId, collectionId, collectionLifecycle, projectRetrievable, projectId);

    for (const document of projectDocuments) {
      const externalItemId = document.source_relative_path;
      const itemId = stableId("item", sourceId, externalItemId);
      const revision = sourceRevision(document);
      const itemLifecycle = document.deleted_at ? "missing" : "active";
      const documentRetrievable = document.deleted_at ? 0 : 1;
      db.prepare(
        `INSERT INTO source_items (
           id, source_id, collection_id, external_id, item_type, name,
           relative_path, mime_type, size_bytes, source_revision, fetch_locator,
           lifecycle_state, metadata_json, document_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'document', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        itemId,
        sourceId,
        collectionId,
        externalItemId,
        document.file_name,
        document.project_relative_path ?? externalItemId,
        document.mime_type,
        document.source_size ?? document.file_size,
        revision,
        document.storage_path,
        itemLifecycle,
        JSON.stringify({
          legacySourceKind: document.source_kind,
          mtime: document.source_mtime,
          contentHash: document.content_hash,
        }),
        document.id,
        document.created_at,
        document.updated_at,
      );
      db.prepare(
        `UPDATE documents
            SET source_id = ?, source_collection_id = ?, source_item_id = ?,
                source_item_external_id = ?, source_revision = ?,
                expected_source_revision = ?, expected_source_config_revision = 1,
                lifecycle_state = ?, retrieval_eligible = ?
          WHERE id = ?`,
      ).run(
        sourceId,
        collectionId,
        itemId,
        externalItemId,
        revision,
        revision,
        itemLifecycle,
        documentRetrievable,
        document.id,
      );
      db.prepare(
        `UPDATE document_indexes
            SET source_revision = COALESCE(source_revision, ?), is_current = 1
          WHERE document_id = ?`,
      ).run(revision, document.id);
      db.prepare(
        `UPDATE jobs
            SET source_id = ?, source_collection_id = ?,
                expected_source_revision = COALESCE(expected_source_revision, ?),
                expected_source_config_revision = COALESCE(expected_source_config_revision, 1),
                available_at = COALESCE(available_at, created_at)
          WHERE document_id = ?`,
      ).run(sourceId, collectionId, revision, document.id);
    }
  }
}

export function purgeQueuedManagedFiles(
  db: MigrationDatabase,
  uploadRoot: string | undefined,
) {
  if (!uploadRoot?.trim()) {
    return;
  }
  const root = path.resolve(uploadRoot);
  const rows = db
    .prepare(
      `SELECT path
         FROM managed_file_purge_queue
        WHERE purged_at IS NULL
        ORDER BY created_at`,
    )
    .all() as Array<{ path: string }>;
  for (const row of rows) {
    const candidate = path.resolve(row.path);
    const withinRoot = candidate.startsWith(`${root}${path.sep}`);
    if (!withinRoot) {
      db.prepare(
        `UPDATE managed_file_purge_queue
            SET error_summary = 'Path is outside the managed upload root'
          WHERE path = ?`,
      ).run(row.path);
      continue;
    }
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.lstatSync(candidate);
        if (stat.isDirectory()) {
          throw new Error("Refusing to remove a directory from the file purge queue");
        }
        fs.rmSync(candidate, { force: true });
      }
      db.prepare(
        `UPDATE managed_file_purge_queue
            SET purged_at = ?, error_summary = NULL
          WHERE path = ?`,
      ).run(new Date().toISOString(), row.path);
    } catch (error) {
      const summary = error instanceof Error ? error.message : "Managed file purge failed";
      db.prepare(
        `UPDATE managed_file_purge_queue
            SET error_summary = ?
          WHERE path = ?`,
      ).run(summary.slice(0, 500), row.path);
    }
  }
}

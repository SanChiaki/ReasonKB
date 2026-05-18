import crypto from "node:crypto";
import Database from "better-sqlite3";

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

export function createDocumentRecord(
  dbPath: string,
  input: {
    ownerUserId: string;
    projectId: string;
    fileName: string;
    storagePath: string;
    mimeType: string;
    fileSize: number;
    sourceKind?: string;
    sourceRoot?: string | null;
    sourceRelativePath?: string | null;
    projectRelativePath?: string | null;
    contentHash?: string | null;
    sourceMtime?: string | null;
    sourceSize?: number | null;
    mediaType?: string;
    importStatus?: string;
    importError?: string | null;
  },
) {
  const db = open(dbPath);
  const now = new Date().toISOString();
  const row = {
    id: `doc_${crypto.randomUUID()}`,
    project_id: input.projectId,
    owner_user_id: input.ownerUserId,
    file_name: input.fileName,
    storage_path: input.storagePath,
    mime_type: input.mimeType,
    file_size: input.fileSize,
    source_kind: input.sourceKind ?? "upload",
    source_root: input.sourceRoot ?? null,
    source_relative_path: input.sourceRelativePath ?? null,
    project_relative_path: input.projectRelativePath ?? null,
    content_hash: input.contentHash ?? null,
    source_mtime: input.sourceMtime ?? null,
    source_size: input.sourceSize ?? null,
    media_type: input.mediaType ?? inferMediaType(input.mimeType, input.fileName),
    import_status: input.importStatus ?? "imported",
    import_error: input.importError ?? null,
    status: "uploaded",
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO documents (
       id, project_id, owner_user_id, file_name, storage_path, mime_type,
       file_size, source_kind, source_root, source_relative_path,
       project_relative_path, content_hash, source_mtime, source_size,
       media_type, import_status, import_error, status, created_at, updated_at
     ) VALUES (
       @id, @project_id, @owner_user_id, @file_name, @storage_path, @mime_type,
       @file_size, @source_kind, @source_root, @source_relative_path,
       @project_relative_path, @content_hash, @source_mtime, @source_size,
       @media_type, @import_status, @import_error, @status, @created_at,
       @updated_at
     )`,
  ).run(row);

  db.close();
  return {
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    status: row.status,
  };
}

function inferMediaType(mimeType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
  if (isOfficeDocument(mimeType, lowerName)) return "office";
  if (
    mimeType === "text/markdown" ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown")
  ) {
    return "markdown";
  }
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/")) return "text";
  return "unsupported";
}

function isOfficeDocument(mimeType: string, lowerName: string) {
  if (
    lowerName.endsWith(".doc") ||
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".xls") ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xlsm") ||
    lowerName.endsWith(".ppt") ||
    lowerName.endsWith(".pptx")
  ) {
    return true;
  }
  return [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ].includes(mimeType);
}

export class InvalidPagesFilterError extends Error {}

export type DocumentIndexTreeNode = {
  id: string;
  title: string;
  summary: string | null;
  pageRange: string | null;
  depth: number;
  children: DocumentIndexTreeNode[];
};

export type DocumentIndexTree = {
  documentId: string;
  indexedAt: string;
  stats: {
    nodeCount: number;
    leafCount: number;
    maxDepth: number;
  };
  roots: DocumentIndexTreeNode[];
};

function parsePagesFilter(pages: string | null) {
  if (!pages) return null;

  const trimmed = pages.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 100) {
    throw new InvalidPagesFilterError("Too many page selectors.");
  }

  const selected = new Set<number>();
  for (const token of parts) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start < 1 || end < start) {
        throw new InvalidPagesFilterError("Invalid page range.");
      }
      if (end - start + 1 > 1000) {
        throw new InvalidPagesFilterError("Page range too large.");
      }

      for (let page = start; page <= end; page += 1) {
        selected.add(page);
      }
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new InvalidPagesFilterError("Invalid page selector.");
    }

    const page = Number.parseInt(token, 10);
    if (page < 1) {
      throw new InvalidPagesFilterError("Invalid page number.");
    }
    selected.add(page);
  }

  return selected;
}

export function listDocumentsByProject(dbPath: string, projectId: string) {
  const db = open(dbPath);
  const rows = db
    .prepare(
      `SELECT d.id, d.file_name, d.page_count, d.status, d.created_at, d.updated_at,
              d.error_message,
              source_kind, source_relative_path, project_relative_path,
              media_type, import_status, import_error,
              last_index_duration_ms, last_index_total_tokens,
              last_index_llm_call_count, last_indexed_at,
              di.document_id AS index_document_id
         FROM documents d
         LEFT JOIN document_indexes di ON di.document_id = d.id
        WHERE d.project_id = ?
          AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC`,
    )
    .all(projectId) as Array<{
    id: string;
    file_name: string;
    page_count: number | null;
    status: string;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    source_kind: string;
    source_relative_path: string | null;
    project_relative_path: string | null;
    media_type: string;
    import_status: string;
    import_error: string | null;
    last_index_duration_ms: number | null;
    last_index_total_tokens: number | null;
    last_index_llm_call_count: number | null;
    last_indexed_at: string | null;
    index_document_id: string | null;
  }>;

  db.close();
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    pageCount: row.page_count ?? 0,
    status: row.status,
    errorMessage: row.error_message,
    sourceKind: row.source_kind,
    sourceRelativePath: row.source_relative_path,
    projectRelativePath: row.project_relative_path,
    mediaType: row.media_type,
    importStatus: row.import_status,
    importError: row.import_error,
    lastIndexDurationMs: row.last_index_duration_ms,
    lastIndexTotalTokens: row.last_index_total_tokens,
    lastIndexLlmCallCount: row.last_index_llm_call_count,
    lastIndexedAt: row.last_indexed_at,
    hasIndexTree: row.index_document_id !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function listDocumentIndexRuns(dbPath: string, documentId: string) {
  const db = open(dbPath);
  const rows = db
    .prepare(
      `SELECT id, status, started_at, finished_at, duration_ms,
              text_extraction_ms, pageindex_ms, vision_extraction_ms,
              persist_ms, llm_call_count, prompt_tokens, completion_tokens,
              total_tokens, token_source, models_json, error_message
         FROM document_index_runs
        WHERE document_id = ?
        ORDER BY started_at DESC`,
    )
    .all(documentId) as Array<{
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: number;
    text_extraction_ms: number;
    pageindex_ms: number;
    vision_extraction_ms: number;
    persist_ms: number;
    llm_call_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    token_source: string;
    models_json: string;
    error_message: string | null;
  }>;

  db.close();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    textExtractionMs: row.text_extraction_ms,
    pageindexMs: row.pageindex_ms,
    visionExtractionMs: row.vision_extraction_ms,
    persistMs: row.persist_ms,
    llmCallCount: row.llm_call_count,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    tokenSource: row.token_source,
    models: parseModelsJson(row.models_json),
    errorMessage: row.error_message,
  }));
}

export function resetDocumentForReindex(dbPath: string, documentId: string) {
  const db = open(dbPath);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE documents
          SET status = 'uploaded',
              page_count = NULL,
              error_message = NULL,
              last_index_duration_ms = NULL,
              last_index_total_tokens = NULL,
              last_index_llm_call_count = NULL,
              last_indexed_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND deleted_at IS NULL`,
    )
    .run(now, documentId);
  db.close();
  return result.changes > 0;
}

function parseModelsJson(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

export function getDocumentDetail(dbPath: string, documentId: string) {
  const db = open(dbPath);
  const row = db
    .prepare(
      `SELECT d.id, d.project_id, d.file_name, d.storage_path, d.mime_type,
              d.file_size, d.page_count, d.status, d.error_message, d.created_at,
              d.updated_at, p.name AS project_name
         FROM documents d
         JOIN projects p ON p.id = d.project_id
        WHERE d.id = ?
          AND d.deleted_at IS NULL`,
    )
    .get(documentId) as
    | {
        id: string;
        project_id: string;
        file_name: string;
        storage_path: string;
        mime_type: string;
        file_size: number;
        page_count: number | null;
        status: string;
        error_message: string | null;
        created_at: string;
        updated_at: string;
        project_name: string;
      }
    | undefined;

  db.close();
  return row
    ? {
        id: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        fileName: row.file_name,
        storagePath: row.storage_path,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        pageCount: row.page_count ?? 0,
        status: row.status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export function getDocumentStructure(dbPath: string, documentId: string) {
  const db = open(dbPath);
  const row = db
    .prepare(`SELECT structure_json FROM document_indexes WHERE document_id = ?`)
    .get(documentId) as { structure_json: string } | undefined;

  db.close();
  return row ? JSON.parse(row.structure_json) : [];
}

export function getDocumentIndexTree(
  dbPath: string,
  documentId: string,
): DocumentIndexTree | null {
  const db = open(dbPath);
  const row = db
    .prepare(
      `SELECT structure_json, indexed_at
         FROM document_indexes
        WHERE document_id = ?`,
    )
    .get(documentId) as
    | {
        structure_json: string;
        indexed_at: string;
      }
    | undefined;

  db.close();
  if (!row) return null;

  const roots = normalizeStructure(parseStructureJson(row.structure_json));
  return {
    documentId,
    indexedAt: row.indexed_at,
    stats: summarizeTree(roots),
    roots,
  };
}

export function getDocumentPages(
  dbPath: string,
  documentId: string,
  pages: string | null,
) {
  const db = open(dbPath);
  const row = db
    .prepare(`SELECT pages_json FROM document_indexes WHERE document_id = ?`)
    .get(documentId) as { pages_json: string } | undefined;

  db.close();
  if (!row) return [];

  const parsed = JSON.parse(row.pages_json) as Array<{
    page: number;
    content: string;
  }>;
  const allowed = parsePagesFilter(pages);
  return allowed ? parsed.filter((entry) => allowed.has(entry.page)) : parsed;
}

function parseStructureJson(value: string | null) {
  if (!value) return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function normalizeStructure(structure: unknown) {
  const entries = Array.isArray(structure) ? structure : [structure];
  return entries.flatMap((entry, index) =>
    normalizeNode(entry, 0, [index], `node-${index}`),
  );
}

function normalizeNode(
  value: unknown,
  depth: number,
  path: number[],
  fallbackId: string,
): DocumentIndexTreeNode[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const raw = value as Record<string, unknown>;
  const children = readChildren(raw).flatMap((child, index) =>
    normalizeNode(child, depth + 1, [...path, index], `node-${path.join("-")}-${index}`),
  );
  const title = readString(raw.title) ?? readString(raw.name) ?? "Untitled section";
  return [
    {
      id: readString(raw.node_id) ?? readString(raw.id) ?? fallbackId,
      title,
      summary: readString(raw.summary) ?? readString(raw.prefix_summary),
      pageRange: formatPageRange(raw),
      depth,
      children,
    },
  ];
}

function readChildren(raw: Record<string, unknown>) {
  const children = raw.nodes ?? raw.children;
  return Array.isArray(children) ? children : [];
}

function readString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPageRange(raw: Record<string, unknown>) {
  const start =
    readNumber(raw.start_index) ??
    readNumber(raw.start_page) ??
    readNumber(raw.page_start) ??
    readNumber(raw.physical_index);
  const end =
    readNumber(raw.end_index) ??
    readNumber(raw.end_page) ??
    readNumber(raw.page_end) ??
    start;

  if (start === null) return null;
  if (end === null || end === start) return `${start}`;
  return `${start}-${end}`;
}

function summarizeTree(roots: DocumentIndexTreeNode[]) {
  const stats = {
    nodeCount: 0,
    leafCount: 0,
    maxDepth: 0,
  };
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stats.nodeCount += 1;
    stats.maxDepth = Math.max(stats.maxDepth, node.depth);
    if (node.children.length === 0) {
      stats.leafCount += 1;
    } else {
      stack.push(...node.children);
    }
  }
  return stats;
}

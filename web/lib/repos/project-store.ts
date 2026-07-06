import crypto from "node:crypto";
import Database from "better-sqlite3";

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function normalizeProjectName(name: string) {
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 120) {
    throw new Error("Project name must be between 1 and 120 characters.");
  }
  return trimmedName;
}

export function createProject(
  dbPath: string,
  input: { ownerUserId: string; name: string },
) {
  const normalizedName = normalizeProjectName(input.name);
  const db = open(dbPath);
  const now = new Date().toISOString();
  const row = {
    id: `proj_${crypto.randomUUID()}`,
    owner_user_id: input.ownerUserId,
    name: normalizedName,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO projects (id, owner_user_id, name, created_at, updated_at)
     VALUES (@id, @owner_user_id, @name, @created_at, @updated_at)`,
  ).run(row);

  db.close();
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjects(dbPath: string, ownerUserId: string) {
  const db = open(dbPath);
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.updated_at,
              COUNT(d.id) AS document_count
       FROM projects p
       LEFT JOIN documents d
         ON d.project_id = p.id
        AND d.deleted_at IS NULL
       WHERE p.owner_user_id = ?
         AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.updated_at DESC`,
    )
    .all(ownerUserId) as Array<{
    id: string;
    name: string;
    updated_at: string;
    document_count: number;
  }>;

  db.close();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    documentCount: row.document_count,
    updatedAt: row.updated_at,
  }));
}

export function getProjectById(
  dbPath: string,
  projectId: string,
  ownerUserId?: string,
) {
  const db = open(dbPath);
  const ownerFilter = ownerUserId ? "AND p.owner_user_id = ?" : "";
  const row = db
    .prepare(
      `SELECT p.id, p.name, p.updated_at,
              COUNT(d.id) AS document_count
         FROM projects p
         LEFT JOIN documents d
           ON d.project_id = p.id
          AND d.deleted_at IS NULL
        WHERE p.id = ?
          ${ownerFilter}
          AND p.deleted_at IS NULL
        GROUP BY p.id`,
    )
    .get(...(ownerUserId ? [projectId, ownerUserId] : [projectId])) as
    | { id: string; name: string; updated_at: string; document_count: number }
    | undefined;

  db.close();
  return row
    ? {
        id: row.id,
        name: row.name,
        documentCount: row.document_count,
        updatedAt: row.updated_at,
      }
    : null;
}

export function updateProjectName(
  dbPath: string,
  input: { ownerUserId: string; projectId: string; name: string },
) {
  const normalizedName = normalizeProjectName(input.name);
  const currentProject = getProjectById(dbPath, input.projectId, input.ownerUserId);
  if (!currentProject) {
    return null;
  }
  if (currentProject.name === normalizedName) {
    return currentProject;
  }

  const db = open(dbPath);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE projects
          SET name = ?, updated_at = ?
        WHERE id = ?
          AND owner_user_id = ?
          AND deleted_at IS NULL`,
    )
    .run(normalizedName, now, input.projectId, input.ownerUserId);

  db.close();
  if (result.changes === 0) {
    return null;
  }

  return getProjectById(dbPath, input.projectId, input.ownerUserId);
}

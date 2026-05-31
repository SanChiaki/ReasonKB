import Database from "better-sqlite3";

export type SystemSettings = {
  indexWorkerConcurrency: number;
  retrievalDocumentLimit: number;
  llmApiKeyConfigured: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmRetrievalModel: string;
  llmConfigured: boolean;
  llmMissingFields: string[];
  currentProjectsRootHostPath: string;
  pendingProjectsRootHostPath: string;
  projectsRootSwitchStatus: "idle" | "pending" | "complete";
  projectsRootSwitchUpdatedAt: string | null;
};

export type SystemSettingsUpdate = Partial<
  Pick<
    SystemSettings,
    | "indexWorkerConcurrency"
    | "retrievalDocumentLimit"
    | "llmBaseUrl"
    | "llmModel"
    | "llmRetrievalModel"
  >
> & {
  llmApiKey?: string | null;
  projectsRootHostPath?: string;
};

type SystemSettingsDefaults = {
  indexWorkerConcurrency: number;
  retrievalDocumentLimit: number;
  llmApiKey?: string;
  llmBaseUrl: string;
  llmModel: string;
  llmRetrievalModel: string;
  projectsRootHostPath: string;
};

const INDEX_WORKER_CONCURRENCY_KEY = "indexWorkerConcurrency";
const RETRIEVAL_DOCUMENT_LIMIT_KEY = "retrievalDocumentLimit";
const LLM_API_KEY_KEY = "llmApiKey";
const LLM_BASE_URL_KEY = "llmBaseUrl";
const LLM_MODEL_KEY = "llmModel";
const LLM_RETRIEVAL_MODEL_KEY = "llmRetrievalModel";
const PENDING_PROJECTS_ROOT_HOST_PATH_KEY = "pendingProjectsRootHostPath";
const PROJECTS_ROOT_SWITCH_UPDATED_AT_KEY = "projectsRootSwitchUpdatedAt";
const DEFAULT_LLM_MODEL = "openai/deepseek-v4-flash";
const FALLBACK_DEFAULTS: SystemSettingsDefaults = {
  indexWorkerConcurrency: 1,
  retrievalDocumentLimit: 5,
  llmApiKey: "",
  llmBaseUrl: "",
  llmModel: DEFAULT_LLM_MODEL,
  llmRetrievalModel: DEFAULT_LLM_MODEL,
  projectsRootHostPath: "",
};
const CREATE_SYSTEM_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function normalizeIndexWorkerConcurrency(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Index worker concurrency must be an integer.");
  }
  if (value < 1 || value > 16) {
    throw new Error("Index worker concurrency must be between 1 and 16.");
  }
  return value;
}

function normalizeRetrievalDocumentLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Retrieval document limit must be an integer.");
  }
  if (value < 1 || value > 50) {
    throw new Error("Retrieval document limit must be between 1 and 50.");
  }
  return value;
}

function normalizeOptionalString(value: unknown, label: string) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value.trim();
}

function normalizeBaseUrl(value: unknown) {
  const normalized = normalizeOptionalString(value, "Base URL");
  if (!normalized) {
    return "";
  }
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Unsupported protocol.");
    }
  } catch {
    throw new Error("Base URL must be a valid HTTP or HTTPS URL.");
  }
  return normalized;
}

function normalizeModel(value: unknown, label: string, fallback: string) {
  const normalized = normalizeOptionalString(value, label);
  return normalized || fallback;
}

function trimTrailingSeparators(value: string) {
  let normalized = value;
  while (
    normalized.length > 1 &&
    !/^[A-Za-z]:[\\/]$/.test(normalized) &&
    /[\\/]$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function isAbsoluteHostPath(value: string) {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

function normalizeHostPathUpdate(value: unknown) {
  const normalized = trimTrailingSeparators(
    normalizeOptionalString(value, "Projects root host path"),
  );
  if (!normalized) {
    throw new Error("Projects root host path is required.");
  }
  if (/[\r\n]/.test(normalized)) {
    throw new Error("Projects root host path must be a single line.");
  }
  if (!isAbsoluteHostPath(normalized)) {
    throw new Error("Projects root host path must be an absolute host path.");
  }
  return normalized;
}

function normalizeCurrentHostPath(value: unknown) {
  return trimTrailingSeparators(normalizeOptionalString(value, "Projects root host path"));
}

function normalizeNullableDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function ensureSystemSettingsTable(db: InstanceType<typeof Database>) {
  db.exec(CREATE_SYSTEM_SETTINGS_TABLE_SQL);
}

function readSetting(db: InstanceType<typeof Database>, key: string) {
  let row: { value_json: string } | undefined;
  try {
    row = db
      .prepare("SELECT value_json FROM system_settings WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("no such table: system_settings")
    ) {
      return undefined;
    }
    throw error;
  }
  if (!row) {
    return undefined;
  }
  return JSON.parse(row.value_json) as unknown;
}

function writeSetting(
  db: InstanceType<typeof Database>,
  key: string,
  value: unknown,
  updatedAt: string,
) {
  db.prepare(
    `INSERT INTO system_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), updatedAt);
}

function toSystemSettings(values: {
  indexWorkerConcurrency: number;
  retrievalDocumentLimit: number;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  llmRetrievalModel: string;
  currentProjectsRootHostPath: string;
  pendingProjectsRootHostPath: string;
  projectsRootSwitchUpdatedAt: string | null;
}): SystemSettings {
  const missingFields: string[] = [];
  if (!values.llmApiKey) {
    missingFields.push("API key");
  }
  if (!values.llmBaseUrl) {
    missingFields.push("Base URL");
  }
  if (!values.llmModel) {
    missingFields.push("Model");
  }
  const currentProjectsRootHostPath = normalizeCurrentHostPath(
    values.currentProjectsRootHostPath,
  );
  const pendingProjectsRootHostPath = normalizeCurrentHostPath(
    values.pendingProjectsRootHostPath,
  );
  const projectsRootSwitchStatus = pendingProjectsRootHostPath
    ? pendingProjectsRootHostPath === currentProjectsRootHostPath
      ? "complete"
      : "pending"
    : "idle";

  return {
    indexWorkerConcurrency: values.indexWorkerConcurrency,
    retrievalDocumentLimit: values.retrievalDocumentLimit,
    llmApiKeyConfigured: Boolean(values.llmApiKey),
    llmBaseUrl: values.llmBaseUrl,
    llmModel: values.llmModel,
    llmRetrievalModel: values.llmRetrievalModel || values.llmModel,
    llmConfigured: missingFields.length === 0,
    llmMissingFields: missingFields,
    currentProjectsRootHostPath,
    pendingProjectsRootHostPath,
    projectsRootSwitchStatus,
    projectsRootSwitchUpdatedAt: values.projectsRootSwitchUpdatedAt,
  };
}

export function getSystemSettings(
  dbPath: string,
  defaults: Partial<SystemSettingsDefaults> = {},
): SystemSettings {
  const normalizedDefaults = { ...FALLBACK_DEFAULTS, ...defaults };
  const db = open(dbPath);
  try {
    const savedConcurrency = readSetting(db, INDEX_WORKER_CONCURRENCY_KEY);
    const savedRetrievalDocumentLimit = readSetting(db, RETRIEVAL_DOCUMENT_LIMIT_KEY);
    const savedApiKey = readSetting(db, LLM_API_KEY_KEY);
    const savedBaseUrl = readSetting(db, LLM_BASE_URL_KEY);
    const savedModel = readSetting(db, LLM_MODEL_KEY);
    const savedRetrievalModel = readSetting(db, LLM_RETRIEVAL_MODEL_KEY);
    const savedProjectsRootHostPath = readSetting(db, PENDING_PROJECTS_ROOT_HOST_PATH_KEY);
    const savedProjectsRootUpdatedAt = readSetting(db, PROJECTS_ROOT_SWITCH_UPDATED_AT_KEY);
    return toSystemSettings({
      indexWorkerConcurrency:
        savedConcurrency === undefined
          ? normalizedDefaults.indexWorkerConcurrency
          : normalizeIndexWorkerConcurrency(savedConcurrency),
      retrievalDocumentLimit:
        savedRetrievalDocumentLimit === undefined
          ? normalizedDefaults.retrievalDocumentLimit
          : normalizeRetrievalDocumentLimit(savedRetrievalDocumentLimit),
      llmApiKey:
        savedApiKey === undefined
          ? normalizeOptionalString(normalizedDefaults.llmApiKey, "API key")
          : normalizeOptionalString(savedApiKey, "API key"),
      llmBaseUrl:
        savedBaseUrl === undefined
          ? normalizeBaseUrl(normalizedDefaults.llmBaseUrl)
          : normalizeBaseUrl(savedBaseUrl),
      llmModel:
        savedModel === undefined
          ? normalizeModel(normalizedDefaults.llmModel, "Model", FALLBACK_DEFAULTS.llmModel)
          : normalizeModel(savedModel, "Model", FALLBACK_DEFAULTS.llmModel),
      llmRetrievalModel:
        savedRetrievalModel === undefined
          ? normalizeModel(
              normalizedDefaults.llmRetrievalModel,
              "Retrieval model",
              normalizedDefaults.llmModel,
            )
          : normalizeModel(savedRetrievalModel, "Retrieval model", normalizedDefaults.llmModel),
      currentProjectsRootHostPath: normalizedDefaults.projectsRootHostPath,
      pendingProjectsRootHostPath:
        savedProjectsRootHostPath === undefined
          ? ""
          : normalizeCurrentHostPath(savedProjectsRootHostPath),
      projectsRootSwitchUpdatedAt: normalizeNullableDate(savedProjectsRootUpdatedAt),
    });
  } finally {
    db.close();
  }
}

export function updateSystemSettings(
  dbPath: string,
  updates: SystemSettingsUpdate,
  defaults: Partial<SystemSettingsDefaults> = FALLBACK_DEFAULTS,
): SystemSettings {
  const db = open(dbPath);
  const now = new Date().toISOString();
  const normalizedDefaults = { ...FALLBACK_DEFAULTS, ...defaults };
  try {
    ensureSystemSettingsTable(db);
    const transaction = db.transaction(() => {
      if (updates.indexWorkerConcurrency !== undefined) {
        const value = normalizeIndexWorkerConcurrency(updates.indexWorkerConcurrency);
        writeSetting(db, INDEX_WORKER_CONCURRENCY_KEY, value, now);
      }
      if (updates.retrievalDocumentLimit !== undefined) {
        const value = normalizeRetrievalDocumentLimit(updates.retrievalDocumentLimit);
        writeSetting(db, RETRIEVAL_DOCUMENT_LIMIT_KEY, value, now);
      }
      if (Object.hasOwn(updates, "llmApiKey")) {
        const value = normalizeOptionalString(updates.llmApiKey, "API key");
        writeSetting(db, LLM_API_KEY_KEY, value, now);
      }
      if (updates.llmBaseUrl !== undefined) {
        const value = normalizeBaseUrl(updates.llmBaseUrl);
        writeSetting(db, LLM_BASE_URL_KEY, value, now);
      }
      if (updates.llmModel !== undefined) {
        const value = normalizeModel(updates.llmModel, "Model", normalizedDefaults.llmModel);
        writeSetting(db, LLM_MODEL_KEY, value, now);
      }
      if (updates.llmRetrievalModel !== undefined) {
        const value = normalizeModel(
          updates.llmRetrievalModel,
          "Retrieval model",
          updates.llmModel ?? normalizedDefaults.llmModel,
        );
        writeSetting(db, LLM_RETRIEVAL_MODEL_KEY, value, now);
      }
      if (updates.projectsRootHostPath !== undefined) {
        const value = normalizeHostPathUpdate(updates.projectsRootHostPath);
        writeSetting(db, PENDING_PROJECTS_ROOT_HOST_PATH_KEY, value, now);
        writeSetting(db, PROJECTS_ROOT_SWITCH_UPDATED_AT_KEY, now, now);
      }
    });
    transaction();
    return getSystemSettings(dbPath, defaults);
  } finally {
    db.close();
  }
}

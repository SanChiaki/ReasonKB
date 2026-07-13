import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "..");
const varRoot = process.env.APP_VAR_ROOT ?? path.join(repoRoot, ".reasonkb", "var");
const corpusSource: "local" | "smb" =
  process.env.REASONKB_CORPUS_SOURCE?.trim().toLowerCase() === "smb"
    ? "smb"
    : "local";
const smbHost = process.env.REASONKB_SMB_HOST?.trim() ?? "";
const smbShare = process.env.REASONKB_SMB_SHARE?.trim() ?? "";
const smbBasePath = process.env.REASONKB_SMB_BASE_PATH?.trim() ?? "";
const smbPort = process.env.REASONKB_SMB_PORT?.trim() ?? "445";

function buildSmbCorpusTarget() {
  if (!smbHost || !smbShare) {
    return "";
  }
  const host = smbPort && smbPort !== "445" ? `${smbHost}:${smbPort}` : smbHost;
  const basePath = smbBasePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
  return `//${host}/${smbShare}${basePath ? `/${basePath}` : ""}`;
}

export const appConfig = {
  repoRoot,
  varRoot,
  dbPath: process.env.APP_DB_PATH ?? path.join(varRoot, "app.db"),
  uploadRoot: process.env.APP_UPLOAD_ROOT ?? path.join(varRoot, "uploads"),
  projectsRoot:
    process.env.PROJECTS_ROOT ?? path.join(repoRoot, ".reasonkb", "projects"),
  adminPasswordFile:
    process.env.REASONKB_ADMIN_PASSWORD_FILE ??
    "/run/secrets/reasonkb_admin_password",
  masterKeyPath:
    process.env.REASONKB_MASTER_KEY_FILE ??
    "/run/secrets/reasonkb_master_key",
  legacySmbUsernameFile:
    process.env.REASONKB_LEGACY_SMB_USERNAME_FILE ??
    "/run/reasonkb-legacy-secrets/smb_username",
  legacySmbPasswordFile:
    process.env.REASONKB_LEGACY_SMB_PASSWORD_FILE ??
    "/run/reasonkb-legacy-secrets/smb_password",
  legacySmbDomain: process.env.REASONKB_SMB_DOMAIN?.trim() ?? "",
  legacySmbPort: Number.parseInt(process.env.REASONKB_SMB_PORT ?? "445", 10),
  legacySmbAuthProtocol:
    process.env.REASONKB_SMB_AUTH_PROTOCOL?.trim().toLowerCase() === "negotiate"
      ? ("negotiate" as const)
      : ("ntlm" as const),
  localSourceAccessRoot:
    process.env.REASONKB_LOCAL_SOURCE_ACCESS_ROOT ??
    process.env.PROJECTS_ROOT ??
    path.join(repoRoot, ".reasonkb", "projects"),
  retrievalBaseUrl:
    process.env.RETRIEVAL_API_BASE_URL ?? "http://127.0.0.1:8001",
  currentProjectsRootHostPath:
    process.env.REASONKB_CURRENT_PROJECTS_ROOT ??
    process.env.REASONKB_PROJECTS_ROOT ??
    "",
  envFilePath: process.env.REASONKB_ENV_FILE_PATH ?? "",
  composeCommand:
    process.env.REASONKB_COMPOSE_COMMAND ??
    "docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans",
  hostBrowseRootContainerPath:
    process.env.REASONKB_HOST_BROWSE_CONTAINER_ROOT ?? "/host-browse",
  hostBrowseRootHostPath:
    process.env.REASONKB_HOST_BROWSE_ROOT ??
    process.env.REASONKB_PROJECTS_ROOT ??
    "",
  corpusSource,
  smbCorpusTarget: buildSmbCorpusTarget(),
};

import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "..");
const varRoot = process.env.APP_VAR_ROOT ?? path.join(repoRoot, ".reasonkb", "var");

export const appConfig = {
  repoRoot,
  varRoot,
  dbPath: process.env.APP_DB_PATH ?? path.join(varRoot, "app.db"),
  uploadRoot: process.env.APP_UPLOAD_ROOT ?? path.join(varRoot, "uploads"),
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
};

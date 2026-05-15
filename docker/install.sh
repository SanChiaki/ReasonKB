#!/usr/bin/env sh
set -eu

REASONKB_HOME="${REASONKB_HOME:-"$HOME/.reasonkb"}"
REASONKB_COMPOSE_URL="${REASONKB_COMPOSE_URL:-https://raw.githubusercontent.com/SanChiaki/ReasonKB/main/docker/compose.release.yml}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run ReasonKB." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required to run ReasonKB." >&2
  exit 1
fi

mkdir -p "$REASONKB_HOME/var" "$REASONKB_HOME/projects"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REASONKB_COMPOSE_URL" -o "$REASONKB_HOME/compose.yml"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$REASONKB_HOME/compose.yml" "$REASONKB_COMPOSE_URL"
else
  echo "curl or wget is required to download the ReasonKB compose file." >&2
  exit 1
fi

if [ ! -f "$REASONKB_HOME/.env" ]; then
  cat > "$REASONKB_HOME/.env" <<'EOF'
# Optional LLM defaults. Runtime settings saved in ReasonKB take precedence.
# PAGEINDEX_LLM_API_KEY=
# PAGEINDEX_LLM_BASE_URL=
# VISION_EXTRACTION_ENABLED=false
# VISION_MODEL=
EOF
fi

(
  cd "$REASONKB_HOME"
  docker compose --env-file ./.env -f compose.yml up -d
)

cat <<EOF
ReasonKB is starting.

Web UI: http://localhost:${WEB_PORT:-43170}
Project corpus: $REASONKB_HOME/projects
Runtime data: $REASONKB_HOME/var
EOF

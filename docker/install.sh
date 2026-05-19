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
# PAGEINDEX_LLM_MODEL=openai/deepseek-v4-flash
# PAGEINDEX_LLM_RETRIEVAL_MODEL=openai/deepseek-v4-flash
# VISION_EXTRACTION_ENABLED=false
# VISION_MODEL=
EOF
fi

SELECTED_PORTS=""

is_selected_port() {
  case " $SELECTED_PORTS " in
    *" $1 "*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remember_port() {
  SELECTED_PORTS="$SELECTED_PORTS $1"
}

is_port_available() {
  port="$1"

  case "$port" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac

  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  if command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && ! nc -z ::1 "$port" >/dev/null 2>&1
    return $?
  fi

  return 0
}

find_available_port() {
  port="$1"
  stop=$((port + 99))

  while [ "$port" -le "$stop" ]; do
    if is_port_available "$port" && ! is_selected_port "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
    port=$((port + 1))
  done

  echo "Could not find an available port in range $1-$stop." >&2
  return 1
}

env_file_value() {
  name="$1"

  sed -n "s/^$name=//p" "$REASONKB_HOME/.env" | tail -n 1
}

ensure_port_env() {
  name="$1"
  default_port="$2"
  current_value="$(eval "printf '%s' \"\${$name-}\"")"

  if [ -n "$current_value" ]; then
    eval "export $name"
    remember_port "$current_value"
    return 0
  fi

  current_value="$(env_file_value "$name")"
  if [ -n "$current_value" ]; then
    eval "$name=\$current_value"
    eval "export $name"
    remember_port "$current_value"
    return 0
  fi

  selected_port="$default_port"
  if ! is_port_available "$selected_port"; then
    selected_port="$(find_available_port "$default_port")"
    echo "Port $default_port is busy; using $selected_port for $name."
  fi

  printf '\n%s=%s\n' "$name" "$selected_port" >> "$REASONKB_HOME/.env"
  eval "$name=\$selected_port"
  eval "export $name"
  remember_port "$selected_port"
}

ensure_port_env WEB_PORT 43170
ensure_port_env RETRIEVAL_API_PORT 43171
ensure_port_env GOTENBERG_PORT 43172

(
  cd "$REASONKB_HOME"
  docker compose --env-file ./.env -f compose.yml pull
  docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans
)

cat <<EOF
ReasonKB is starting.

Web UI: http://localhost:${WEB_PORT:-43170}
Project corpus: $REASONKB_HOME/projects
Runtime data: $REASONKB_HOME/var
EOF

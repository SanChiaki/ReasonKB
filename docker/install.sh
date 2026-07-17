#!/usr/bin/env sh
set -eu

REASONKB_HOME="${REASONKB_HOME:-"$HOME/.reasonkb"}"
REASONKB_COMPOSE_URL="${REASONKB_COMPOSE_URL:-https://cdn.jsdelivr.net/gh/SanChiaki/ReasonKB@main/docker/compose.release.yml}"
DEFAULT_LLM_MODEL="openai/deepseek-v4-flash"
INSTALL_INTERACTIVE=0
INSTALL_ACTION="install"

case "${1:-}" in
  "")
    ;;
  --reset-admin-password)
    INSTALL_ACTION="reset-admin-password"
    ;;
  -h|--help)
    cat <<'EOF'
用法：
  install.sh
  install.sh --reset-admin-password

环境变量：
  REASONKB_HOME              ReasonKB 运行目录，默认 ~/.reasonkb
  REASONKB_ADMIN_PASSWORD    非交互模式使用的新管理员密码
  REASONKB_ADMIN_COOKIE_SECURE  管理员 Cookie Secure 模式：auto、true 或 false
EOF
    exit 0
    ;;
  *)
    echo "未知参数：$1" >&2
    echo "运行 install.sh --help 查看用法。" >&2
    exit 2
    ;;
esac

case "${REASONKB_INTERACTIVE:-auto}" in
  1|true|TRUE|yes|YES)
    INSTALL_INTERACTIVE=1
    ;;
  0|false|FALSE|no|NO)
    INSTALL_INTERACTIVE=0
    ;;
  *)
    if [ -n "${REASONKB_INSTALL_INPUT:-}" ] || { [ -r /dev/tty ] && [ -w /dev/tty ]; }; then
      INSTALL_INTERACTIVE=1
    fi
    ;;
esac

if [ "$INSTALL_INTERACTIVE" = "1" ]; then
  if [ -n "${REASONKB_INSTALL_INPUT:-}" ]; then
    exec 3< "$REASONKB_INSTALL_INPUT"
  elif [ -r /dev/tty ]; then
    exec 3< /dev/tty
  else
    echo "已请求交互式安装，但当前没有可用的输入终端。" >&2
    exit 1
  fi

  if [ -n "${REASONKB_INSTALL_OUTPUT:-}" ]; then
    : > "$REASONKB_INSTALL_OUTPUT"
  fi
fi

prompt_write() {
  if [ -n "${REASONKB_INSTALL_OUTPUT:-}" ]; then
    printf '%s' "$1" >> "$REASONKB_INSTALL_OUTPUT"
  elif [ "$INSTALL_INTERACTIVE" = "1" ] && [ -w /dev/tty ]; then
    printf '%s' "$1" > /dev/tty
  else
    printf '%s' "$1"
  fi
}

prompt_newline() {
  if [ -n "${REASONKB_INSTALL_OUTPUT:-}" ]; then
    printf '\n' >> "$REASONKB_INSTALL_OUTPUT"
  elif [ "$INSTALL_INTERACTIVE" = "1" ] && [ -w /dev/tty ]; then
    printf '\n' > /dev/tty
  else
    printf '\n'
  fi
}

read_prompt_line() {
  PROMPT_REPLY=""
  if [ "$INSTALL_INTERACTIVE" = "1" ]; then
    IFS= read -r PROMPT_REPLY <&3 || PROMPT_REPLY=""
    prompt_cr="$(printf '\r')"
    PROMPT_REPLY="${PROMPT_REPLY%"$prompt_cr"}"
  fi
}

prompt_value() {
  label="$1"
  default_value="$2"

  PROMPT_VALUE="$default_value"
  if [ "$INSTALL_INTERACTIVE" != "1" ]; then
    return 0
  fi

  if [ -n "$default_value" ]; then
    prompt_write "$label [$default_value]: "
  else
    prompt_write "$label: "
  fi

  read_prompt_line
  if [ -n "$PROMPT_REPLY" ]; then
    PROMPT_VALUE="$PROMPT_REPLY"
  fi
}

prompt_secret() {
  label="$1"
  default_value="$2"
  required="${3:-0}"

  PROMPT_VALUE="$default_value"
  if [ "$INSTALL_INTERACTIVE" != "1" ]; then
    return 0
  fi

  if [ -n "$default_value" ]; then
    prompt_write "$label [留空则保留现有值]: "
  elif [ "$required" = "1" ]; then
    prompt_write "$label: "
  else
    prompt_write "${label}（可选，按 Enter 跳过）: "
  fi

  if [ -z "${REASONKB_INSTALL_INPUT:-}" ] && [ -r /dev/tty ] && command -v stty >/dev/null 2>&1; then
    old_stty="$(stty -g < /dev/tty 2>/dev/null || true)"
    stty -echo < /dev/tty 2>/dev/null || true
    read_prompt_line
    if [ -n "$old_stty" ]; then
      stty "$old_stty" < /dev/tty 2>/dev/null || true
    else
      stty echo < /dev/tty 2>/dev/null || true
    fi
    prompt_newline
  else
    read_prompt_line
  fi

  if [ -n "$PROMPT_REPLY" ]; then
    PROMPT_VALUE="$PROMPT_REPLY"
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "运行 ReasonKB 需要先安装 Docker。" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "运行 ReasonKB 需要 Docker Compose v2。" >&2
  exit 1
fi

if [ "$INSTALL_ACTION" = "install" ]; then
  mkdir -p "$REASONKB_HOME/var"
fi

download_with_curl() {
  output_file="$1"
  attempt=1
  max_attempts=3
  retry_delay="${REASONKB_DOWNLOAD_RETRY_DELAY:-2}"
  status=1

  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -fsSL --connect-timeout 15 "$REASONKB_COMPOSE_URL" -o "$output_file"; then
      return 0
    else
      status=$?
    fi

    rm -f "$output_file"
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "curl 下载失败（第 $attempt/$max_attempts 次），准备重试..." >&2
      if [ "$retry_delay" != "0" ]; then
        sleep "$retry_delay"
      fi
    fi
    attempt=$((attempt + 1))
  done

  return "$status"
}

download_with_wget() {
  output_file="$1"

  wget -q --timeout=30 --tries=5 -O "$output_file" "$REASONKB_COMPOSE_URL"
}

validate_compose_file() {
  compose_file="$1"
  compose_name="$(basename "$compose_file")"

  if [ ! -f "$compose_file" ]; then
    echo "Compose 文件不存在：$compose_file" >&2
    return 1
  fi

  if [ -f "$REASONKB_HOME/.env" ]; then
    if ! (
      cd "$REASONKB_HOME"
      docker compose --env-file ./.env -f "$compose_name" config --services >/dev/null
    ); then
      echo "Compose 文件校验失败：$compose_file" >&2
      return 1
    fi
  elif ! (
    cd "$REASONKB_HOME"
    docker compose -f "$compose_name" config --services >/dev/null
  ); then
    echo "Compose 文件校验失败：$compose_file" >&2
    return 1
  fi
}

print_compose_download_help() {
  cat >&2 <<EOF
下载 ReasonKB Compose 文件失败。

下载地址：
  $REASONKB_COMPOSE_URL

这通常是当前机器访问 Compose 镜像地址时出现网络、代理或 TLS 中断导致的。
请重试、配置代理，或使用镜像/自定义 Compose 地址：

  REASONKB_COMPOSE_URL=https://your-mirror.example/compose.release.yml ./install.sh

如果已手动下载文件，可以直接指定本地文件：

  REASONKB_COMPOSE_URL=file:///absolute/path/to/compose.release.yml ./install.sh
EOF
}

download_compose_file() {
  tmp_file="$REASONKB_HOME/compose.yml.tmp.$$"

  rm -f "$tmp_file"

  if command -v curl >/dev/null 2>&1; then
    if ! download_with_curl "$tmp_file"; then
      rm -f "$tmp_file"
      echo "curl 无法下载 Compose 文件，安装已终止。" >&2
      print_compose_download_help
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! download_with_wget "$tmp_file"; then
      rm -f "$tmp_file"
      echo "wget 无法下载 Compose 文件，安装已终止。" >&2
      print_compose_download_help
      return 1
    fi
  else
    echo "未找到 curl 或 wget，无法下载 Compose 文件，安装已终止。" >&2
    print_compose_download_help
    return 1
  fi

  if ! validate_compose_file "$tmp_file"; then
    rm -f "$tmp_file"
    echo "下载到的 Compose 文件无效，安装已终止。" >&2
    print_compose_download_help
    return 1
  fi

  mv "$tmp_file" "$REASONKB_HOME/compose.yml"
}

if [ "$INSTALL_ACTION" = "install" ]; then
  download_compose_file

  if [ ! -f "$REASONKB_HOME/.env" ]; then
    cat > "$REASONKB_HOME/.env" <<'EOF'
# 挂载到 ReasonKB 的项目语料目录。
# 设置页可以更新这个值，但 Docker 容器需要重新创建后才会应用。
# REASONKB_PROJECTS_ROOT=/absolute/path/to/projects

# 设置页文件夹选择器可只读浏览的宿主机目录。
# 文件夹选择器只能选择这个目录下的文件夹。
# REASONKB_HOST_BROWSE_ROOT=/absolute/path/to/browse/root

# 管理员 Cookie 的 Secure 模式：auto 按实际访问协议判断，也可强制 true/false。
# REASONKB_ADMIN_COOKIE_SECURE=auto

# 可选的 LLM 默认配置。设置页保存的运行时配置优先于这些默认值。
# PAGEINDEX_LLM_API_KEY=
# PAGEINDEX_LLM_BASE_URL=
# PAGEINDEX_LLM_MODEL=openai/deepseek-v4-flash
# PAGEINDEX_LLM_RETRIEVAL_MODEL=openai/deepseek-v4-flash
# VISION_EXTRACTION_ENABLED=false
# VISION_MODEL=
EOF
  fi
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

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 1
  fi

  if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :$port" 2>/dev/null | grep . >/dev/null 2>&1; then
    return 1
  fi

  if command -v nc >/dev/null 2>&1; then
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || nc -z ::1 "$port" >/dev/null 2>&1; then
      return 1
    fi
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

  echo "无法在 $1-$stop 范围内找到可用端口。" >&2
  return 1
}

env_file_value() {
  name="$1"

  sed -n "s/^$name=//p" "$REASONKB_HOME/.env" | tail -n 1
}

current_env_or_file_value() {
  name="$1"
  default_value="$2"
  current_value="$(eval "printf '%s' \"\${$name-}\"")"

  if [ -n "$current_value" ]; then
    printf '%s\n' "$current_value"
    return 0
  fi

  current_value="$(env_file_value "$name")"
  if [ -n "$current_value" ]; then
    printf '%s\n' "$current_value"
    return 0
  fi

  printf '%s\n' "$default_value"
}

set_env_file_value() {
  name="$1"
  value="$2"
  tmp_file="$REASONKB_HOME/.env.tmp.$$"

  if [ -f "$REASONKB_HOME/.env" ]; then
    written=0
    : > "$tmp_file"
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$name="*)
          if [ "$written" = "0" ]; then
            printf '%s=%s\n' "$name" "$value" >> "$tmp_file"
            written=1
          fi
          ;;
        *)
          printf '%s\n' "$line" >> "$tmp_file"
          ;;
      esac
    done < "$REASONKB_HOME/.env"
    if [ "$written" = "0" ]; then
      printf '%s=%s\n' "$name" "$value" >> "$tmp_file"
    fi
    mv "$tmp_file" "$REASONKB_HOME/.env"
  else
    printf '%s=%s\n' "$name" "$value" > "$REASONKB_HOME/.env"
  fi
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
    echo "端口 ${default_port} 已被占用，${name} 将改用 ${selected_port}。"
  fi

  set_env_file_value "$name" "$selected_port"
  eval "$name=\$selected_port"
  eval "export $name"
  remember_port "$selected_port"
}

configure_value_env() {
  name="$1"
  default_value="$2"
  label="$3"
  current_value="$(current_env_or_file_value "$name" "$default_value")"

  prompt_value "$label" "$current_value"
  current_value="$PROMPT_VALUE"

  if [ -n "$current_value" ]; then
    set_env_file_value "$name" "$current_value"
    export "$name=$current_value"
  fi
}

derive_browse_root_default() {
  projects_root="$1"

  if [ "$projects_root" = "$REASONKB_HOME/projects" ]; then
    printf '%s\n' "$HOME"
    return 0
  fi

  case "$projects_root" in
    /mnt/?/*)
      drive_name="$(printf '%s\n' "$projects_root" | cut -d / -f 3)"
      printf '/mnt/%s\n' "$drive_name"
      ;;
    "$HOME"/*)
      printf '%s\n' "$HOME"
      ;;
    *)
      dirname "$projects_root"
      ;;
  esac
}

configure_paths() {
  configure_value_env \
    REASONKB_PROJECTS_ROOT \
    "$REASONKB_HOME/projects" \
    "本地数据源只读访问根目录"

  browse_default="$(current_env_or_file_value REASONKB_HOST_BROWSE_ROOT "")"
  if [ -z "$browse_default" ]; then
    browse_default="$(derive_browse_root_default "$REASONKB_PROJECTS_ROOT")"
  fi

  configure_value_env \
    REASONKB_HOST_BROWSE_ROOT \
    "$browse_default" \
    "管理页文件夹选择器可浏览的宿主机目录"

  mkdir -p "$REASONKB_PROJECTS_ROOT" "$REASONKB_HOST_BROWSE_ROOT"
}

write_secret_file() {
  path="$1"
  value="$2"

  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$value" > "$path"
  chmod 600 "$path" 2>/dev/null || true
}

reset_admin_password() {
  if [ ! -f "$REASONKB_HOME/compose.yml" ] || [ ! -f "$REASONKB_HOME/.env" ]; then
    echo "未找到现有 ReasonKB 部署：$REASONKB_HOME" >&2
    echo "请先完成安装，再执行管理员密码重置。" >&2
    return 1
  fi

  new_password="${REASONKB_ADMIN_PASSWORD:-}"
  confirmation="$new_password"
  if [ "$INSTALL_INTERACTIVE" = "1" ]; then
    prompt_write "ReasonKB 管理员密码重置"
    prompt_newline
    prompt_newline
    prompt_secret "新的管理员密码（至少 12 个字符）" "" 1
    new_password="$PROMPT_VALUE"
    prompt_secret "再次输入新的管理员密码" "" 1
    confirmation="$PROMPT_VALUE"
  fi

  if [ -z "$new_password" ]; then
    echo "未提供新的管理员密码。请使用交互模式，或设置 REASONKB_ADMIN_PASSWORD。" >&2
    return 1
  fi
  if [ "${#new_password}" -lt 12 ] || [ "${#new_password}" -gt 1024 ]; then
    echo "ReasonKB 管理员密码长度须为 12 至 1024 个字符。" >&2
    return 1
  fi
  if [ "$new_password" != "$confirmation" ]; then
    echo "两次输入的管理员密码不一致。" >&2
    return 1
  fi

  echo "正在拉取管理员密码重置工具..."
  (
    cd "$REASONKB_HOME"
    docker compose --env-file ./.env -f compose.yml pull migrate
  )
  echo "正在重置管理员密码..."
  if ! printf '%s\n' "$new_password" | (
    cd "$REASONKB_HOME"
    docker compose --env-file ./.env -f compose.yml run --rm --no-deps -T migrate \
      pnpm -C web exec tsx scripts/reset-admin-password.ts
  ); then
    echo "管理员密码重置失败，宿主机初始化密码文件未修改。" >&2
    return 1
  fi

  write_secret_file "$REASONKB_HOME/secrets/admin_password" "$new_password"
  echo "管理员密码已重置，所有现有管理员会话均已退出。"
}

generate_hex_secret() {
  bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return 0
  fi
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
    return 0
  fi
  echo "无法生成安全随机密钥：需要 openssl 或 /dev/urandom + od。" >&2
  return 1
}

ensure_runtime_secrets() {
  secrets_root="$REASONKB_HOME/secrets"
  mkdir -p "$secrets_root"
  chmod 700 "$secrets_root" 2>/dev/null || true
  set_env_file_value REASONKB_SECRETS_ROOT ./secrets

  if [ ! -f "$secrets_root/master.key" ]; then
    write_secret_file "$secrets_root/master.key" "$(generate_hex_secret 32)"
  else
    chmod 600 "$secrets_root/master.key" 2>/dev/null || true
  fi

  GENERATED_ADMIN_PASSWORD=""
  if [ ! -f "$secrets_root/admin_password" ]; then
    admin_password="${REASONKB_ADMIN_PASSWORD:-}"
    if [ -z "$admin_password" ] && [ "$INSTALL_INTERACTIVE" = "1" ]; then
      prompt_secret "ReasonKB 管理员密码（至少 12 个字符）" ""
      admin_password="$PROMPT_VALUE"
    fi
    if [ -z "$admin_password" ]; then
      admin_password="$(generate_hex_secret 18)"
      GENERATED_ADMIN_PASSWORD="$admin_password"
    fi
    if [ "${#admin_password}" -lt 12 ]; then
      echo "ReasonKB 管理员密码至少需要 12 个字符。" >&2
      return 1
    fi
    write_secret_file "$secrets_root/admin_password" "$admin_password"
  else
    chmod 600 "$secrets_root/admin_password" 2>/dev/null || true
  fi
}

configure_llm_defaults() {
  api_key_value="$(current_env_or_file_value PAGEINDEX_LLM_API_KEY "")"
  base_url_value="$(current_env_or_file_value PAGEINDEX_LLM_BASE_URL "")"
  model_value="$(current_env_or_file_value PAGEINDEX_LLM_MODEL "$DEFAULT_LLM_MODEL")"
  retrieval_model_value="$(current_env_or_file_value PAGEINDEX_LLM_RETRIEVAL_MODEL "$model_value")"

  if [ "$INSTALL_INTERACTIVE" = "1" ]; then
    prompt_newline
    prompt_write "可选：配置默认 LLM 服务。之后也可以在 http://localhost:43170/settings 中修改。"
    prompt_newline

    prompt_secret "LLM API Key" "$api_key_value"
    api_key_value="$PROMPT_VALUE"

    prompt_value "LLM 服务 Base URL" "$base_url_value"
    base_url_value="$PROMPT_VALUE"

    prompt_value "对话模型" "$model_value"
    model_value="$PROMPT_VALUE"

    prompt_value "检索模型" "$retrieval_model_value"
    retrieval_model_value="$PROMPT_VALUE"
  fi

  if [ -n "$api_key_value" ]; then
    set_env_file_value PAGEINDEX_LLM_API_KEY "$api_key_value"
    export PAGEINDEX_LLM_API_KEY="$api_key_value"
  fi
  if [ -n "$base_url_value" ]; then
    set_env_file_value PAGEINDEX_LLM_BASE_URL "$base_url_value"
    export PAGEINDEX_LLM_BASE_URL="$base_url_value"
  fi
  if [ -n "$model_value" ]; then
    set_env_file_value PAGEINDEX_LLM_MODEL "$model_value"
    export PAGEINDEX_LLM_MODEL="$model_value"
  fi
  if [ -n "$retrieval_model_value" ]; then
    set_env_file_value PAGEINDEX_LLM_RETRIEVAL_MODEL "$retrieval_model_value"
    export PAGEINDEX_LLM_RETRIEVAL_MODEL="$retrieval_model_value"
  fi
}

if [ "$INSTALL_ACTION" = "reset-admin-password" ]; then
  reset_admin_password
  exit 0
fi

if [ "$INSTALL_INTERACTIVE" = "1" ]; then
  prompt_write "ReasonKB 安装向导"
  prompt_newline
  prompt_newline
fi

configure_paths
configure_llm_defaults
ensure_runtime_secrets

if ! validate_compose_file "$REASONKB_HOME/compose.yml"; then
  echo "请检查网络、镜像源，或删除损坏的 compose.yml 后重试。" >&2
  exit 1
fi

ensure_port_env WEB_PORT 43170
ensure_port_env RETRIEVAL_API_PORT 43171
ensure_port_env GOTENBERG_PORT 43172

(
  cd "$REASONKB_HOME"
  docker compose --env-file ./.env -f compose.yml pull
  docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans
)

corpus_summary_line="数据源管理：http://localhost:${WEB_PORT:-43170}/admin/sources"

cat <<EOF
ReasonKB 正在启动。

Web 界面：http://localhost:${WEB_PORT:-43170}
$corpus_summary_line
运行数据目录：$REASONKB_HOME/var
EOF

if [ -n "${GENERATED_ADMIN_PASSWORD:-}" ]; then
  cat <<EOF

首次生成的管理员密码：$GENERATED_ADMIN_PASSWORD
请登录后妥善保管；安装器再次运行不会覆盖该密码。
EOF
fi

from pathlib import Path
import os
import shutil
import socket
import stat
import subprocess
import textwrap

import yaml


ROOT = Path(__file__).resolve().parents[2]
ACR_IMAGE = (
    "crpi-95tja6y49h58rco0.cn-shenzhen.personal.cr.aliyuncs.com/"
    "reasonkb/reasonkb"
)


def _sh_executable() -> str:
    shell = shutil.which("sh")
    if shell:
        return shell

    for candidate in (
        Path("C:/Program Files/Git/usr/bin/sh.exe"),
        Path("C:/Program Files/Git/bin/sh.exe"),
        Path("C:/msys64/usr/bin/sh.exe"),
    ):
        if candidate.exists():
            return str(candidate)

    import pytest

    pytest.skip("POSIX sh is required for install.sh integration tests")


def _shell_path(path: Path) -> str:
    shell = _sh_executable()
    result = subprocess.run(
        [shell, "-lc", "pwd"],
        cwd=path,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    return result.stdout.strip().replace("\\", "/")


def _shell_file_path(path: Path) -> str:
    return f"{_shell_path(path.parent)}/{path.name}"


def _windows_path(value: str) -> str:
    if os.name != "nt" and not (len(value) >= 3 and value[0] == "/" and value[2] == "/"):
        return value
    if len(value) >= 3 and value[0] == "/" and value[2] == "/":
        value = f"{value[1].upper()}:{value[2:]}"
    return value.replace("/", "\\")


def _installer_env(base_env: dict[str, str], fake_bin: Path) -> dict[str, str]:
    env = dict(base_env)
    env["REASONKB_TEST_FAKE_BIN"] = _shell_path(fake_bin)
    return env


def _run_install(
    tmp_path: Path,
    env: dict[str, str],
    *args: str,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            _sh_executable(),
            "-c",
            'PATH="$REASONKB_TEST_FAKE_BIN:/usr/bin:/bin:/mingw64/bin:$PATH"; export PATH; exec "$@"',
            "sh",
            _shell_file_path(ROOT / "docker" / "install.sh"),
            *args,
        ],
        cwd=tmp_path,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )


def _run_launcher(
    launcher: Path,
    env: dict[str, str],
    *args: str,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            _sh_executable(),
            "-c",
            'PATH="$REASONKB_TEST_FAKE_BIN:/usr/bin:/bin:/mingw64/bin:$PATH"; export PATH; exec "$@"',
            "sh",
            _shell_file_path(launcher),
            *args,
        ],
        cwd=launcher.parent,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )


def test_install_script_resets_a_forgotten_admin_password(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    reasonkb_home.mkdir()
    (reasonkb_home / ".env").write_text("WEB_PORT=43170\n", encoding="utf-8")
    (reasonkb_home / "compose.yml").write_text("services: {}\n", encoding="utf-8")

    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          printf '%s\n' "$*" >> "$REASONKB_HOME/docker-calls.txt"
          case " $* " in
            *" run "*)
              cat > "$REASONKB_HOME/reset-password-input.txt"
              ;;
          esac
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env(
        {
            **os.environ,
            "REASONKB_HOME": str(reasonkb_home),
            "REASONKB_INTERACTIVE": "0",
            "REASONKB_ADMIN_PASSWORD": "replacement admin password",
        },
        fake_bin,
    )

    result = _run_install(tmp_path, env, "--reset-admin-password")

    assert result.returncode == 0, result.stderr
    assert "管理员密码已重置" in result.stdout
    assert (reasonkb_home / "reset-password-input.txt").read_text(
        encoding="utf-8"
    ) == "replacement admin password\n"
    assert (reasonkb_home / "secrets" / "admin_password").read_text(
        encoding="utf-8"
    ) == "replacement admin password\n"
    calls = (reasonkb_home / "docker-calls.txt").read_text(encoding="utf-8")
    assert "pull migrate" in calls
    assert "run --rm --no-deps -T migrate" in calls
    assert "scripts/reset-admin-password.ts" in calls


def test_install_script_does_not_update_bootstrap_secret_when_reset_fails(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    secrets_root = reasonkb_home / "secrets"
    secrets_root.mkdir(parents=True)
    (reasonkb_home / ".env").write_text("WEB_PORT=43170\n", encoding="utf-8")
    (reasonkb_home / "compose.yml").write_text("services: {}\n", encoding="utf-8")
    (secrets_root / "admin_password").write_text("original admin password\n")

    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          case " $* " in
            *" run "*) cat >/dev/null; exit 1 ;;
            *) exit 0 ;;
          esac
        fi
        exit 1
        """,
    )

    env = _installer_env(
        {
            **os.environ,
            "REASONKB_HOME": str(reasonkb_home),
            "REASONKB_INTERACTIVE": "0",
            "REASONKB_ADMIN_PASSWORD": "replacement admin password",
        },
        fake_bin,
    )

    result = _run_install(tmp_path, env, "--reset-admin-password")

    assert result.returncode != 0
    assert "初始化密码文件未修改" in result.stderr
    assert (secrets_root / "admin_password").read_text(
        encoding="utf-8"
    ) == "original admin password\n"


def test_install_script_rejects_invalid_compose_download(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    reasonkb_home.mkdir()
    (reasonkb_home / "compose.yml").write_text("services: {}\n", encoding="utf-8")
    invalid_compose = tmp_path / "invalid-compose.yml"
    invalid_compose.write_text("services:\n  web: invalid\n", encoding="utf-8")

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        set -eu
        output=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "-o" ]; then
            shift
            output="$1"
            break
          fi
          shift
        done
        cp "$REASONKB_INVALID_COMPOSE" "$output"
        """,
    )
    _write_executable(
        fake_bin / "wget",
        """
        #!/usr/bin/env sh
        exit 1
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          case " $* " in
            *" config "*)
              compose_file=""
              while [ "$#" -gt 0 ]; do
                if [ "$1" = "-f" ]; then
                  shift
                  compose_file="$1"
                fi
                shift
              done
              if grep -q '^  web: invalid$' "$compose_file"; then
                echo "services.web must be a mapping" >&2
                exit 1
              fi
              exit 0
              ;;
            *)
              exit 0
              ;;
          esac
        fi
        exit 1
        """,
    )

    env = _installer_env(
        {
            **os.environ,
            "REASONKB_HOME": str(reasonkb_home),
            "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
            "REASONKB_INVALID_COMPOSE": str(invalid_compose),
            "REASONKB_INTERACTIVE": "0",
        },
        fake_bin,
    )

    result = _run_install(tmp_path, env)

    assert result.returncode != 0
    assert "Compose 文件校验失败" in result.stderr
    assert "下载 ReasonKB Compose 文件失败" in result.stderr
    assert "services.web must be a mapping" in result.stderr
    assert (reasonkb_home / "compose.yml").read_text(encoding="utf-8") == "services: {}\n"


def test_dockerignore_excludes_local_env_files_from_image_context():
    patterns = {
        line.strip()
        for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }

    assert ".env" in patterns
    assert ".env.*" in patterns


def test_release_compose_uses_acr_images_without_local_builds():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    app_services = [
        "migrate",
        "web",
        "mcp-server",
        "retrieval-api",
        "index-worker",
        "source-worker",
    ]
    for service_name in app_services:
        service = compose["services"][service_name]
        assert "build" not in service
        assert service["image"] == f"${{REASONKB_IMAGE:-{ACR_IMAGE}:latest}}"

    gotenberg = compose["services"]["gotenberg"]
    assert "build" not in gotenberg
    assert gotenberg["image"] == f"${{GOTENBERG_IMAGE:-{ACR_IMAGE}:gotenberg-8}}"


def test_release_compose_requests_published_image_platform():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    for service in compose["services"].values():
        assert service["platform"] == "${REASONKB_PLATFORM:-linux/amd64}"


def test_release_compose_always_pulls_published_images():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    for service in compose["services"].values():
        assert service["pull_policy"] == "always"


def test_release_compose_runs_privileged_migration_before_retrieval():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    master_key_mount = (
        "${REASONKB_SECRETS_ROOT:-./secrets}/master.key:"
        "/run/secrets/reasonkb_master_key:ro"
    )
    migrate = compose["services"]["migrate"]
    legacy_secrets_mount = (
        "${REASONKB_SECRETS_ROOT:-./secrets}:"
        "/run/reasonkb-legacy-secrets:ro"
    )
    assert migrate["command"] == ["sh", "./docker/entrypoints/migrate.sh"]
    assert master_key_mount in migrate["volumes"]
    assert legacy_secrets_mount in migrate["volumes"]
    assert migrate["environment"]["REASONKB_MASTER_KEY_FILE"] == (
        "/run/secrets/reasonkb_master_key"
    )

    for service_name in ("source-worker", "index-worker"):
        service = compose["services"][service_name]
        assert master_key_mount in service["volumes"]
        assert service["environment"]["REASONKB_MASTER_KEY_FILE"] == (
            "/run/secrets/reasonkb_master_key"
        )
        assert "SYS_ADMIN" not in service.get("cap_add", [])

    retrieval = compose["services"]["retrieval-api"]
    assert retrieval["depends_on"]["migrate"]["condition"] == (
        "service_completed_successfully"
    )
    assert master_key_mount not in retrieval.get("volumes", [])
    assert not any("/data/projects" in volume for volume in retrieval.get("volumes", []))
    assert legacy_secrets_mount not in compose["services"]["web"]["volumes"]
    assert legacy_secrets_mount not in retrieval.get("volumes", [])

    retrieval_entrypoint = (
        ROOT / "docker" / "entrypoints" / "retrieval-api.sh"
    ).read_text()
    web_entrypoint = (ROOT / "docker" / "entrypoints" / "web.sh").read_text()
    migrate_entrypoint = (ROOT / "docker" / "entrypoints" / "migrate.sh").read_text()
    assert "db:migrate" not in retrieval_entrypoint
    assert "db:migrate" not in web_entrypoint
    assert "pnpm -C web db:migrate" in migrate_entrypoint


def test_release_compose_health_checks_background_workers():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    for service_name in ("source-worker", "index-worker"):
        service = compose["services"][service_name]
        heartbeat = service["environment"]["REASONKB_WORKER_HEARTBEAT_FILE"]
        healthcheck = service["healthcheck"]
        assert heartbeat in healthcheck["test"]
        assert healthcheck["start_period"] == "15s"


def test_credential_entrypoints_validate_master_key_before_starting():
    for entrypoint in ("migrate.sh", "web.sh", "source-worker.sh", "index-worker.sh"):
        content = (ROOT / "docker" / "entrypoints" / entrypoint).read_text()
        assert "python -m services.common.source_credentials" in content
        if entrypoint == "migrate.sh":
            start_command = "pnpm -C web db:migrate"
        elif entrypoint == "web.sh":
            start_command = "pnpm -C web exec next start"
        else:
            start_command = "exec python -m services."
        assert content.index("python -m services.common.source_credentials") < content.index(
            start_command
        )


def test_release_web_reads_runtime_env_file_for_llm_defaults():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    web = compose["services"]["web"]
    assert web["env_file"] == [
        {"path": "${REASONKB_ENV_FILE:-./.env}", "required": False},
    ]
    for name in (
        "PAGEINDEX_LLM_API_KEY",
        "PAGEINDEX_LLM_BASE_URL",
        "PAGEINDEX_LLM_MODEL",
        "PAGEINDEX_LLM_RETRIEVAL_MODEL",
    ):
        assert name not in web["environment"]


def test_release_web_defaults_admin_cookie_security_to_protocol_detection():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    assert compose["services"]["web"]["environment"]["REASONKB_ADMIN_COOKIE_SECURE"] == (
        "${REASONKB_ADMIN_COOKIE_SECURE:-auto}"
    )


def test_web_mounts_the_api_key_pepper_only_into_the_web_service():
    pepper_mount = (
        "${REASONKB_SECRETS_ROOT:-./secrets}/api_key_pepper:"
        "/run/secrets/reasonkb_api_key_pepper:ro"
    )
    for compose_name in ("compose.yml", "compose.release.yml"):
        compose = yaml.safe_load((ROOT / "docker" / compose_name).read_text())
        web = compose["services"]["web"]
        assert web["environment"]["REASONKB_API_KEY_PEPPER_FILE"] == (
            "/run/secrets/reasonkb_api_key_pepper"
        )
        assert pepper_mount in web["volumes"]
        for service_name, service in compose["services"].items():
            if service_name != "web":
                assert pepper_mount not in service.get("volumes", [])


def test_mcp_http_service_forwards_to_web_without_mounting_secrets():
    for compose_name in ("compose.yml", "compose.release.yml"):
        compose = yaml.safe_load((ROOT / "docker" / compose_name).read_text())
        service = compose["services"]["mcp-server"]
        assert service["command"] == ["node", "./web/mcp/http.mjs"]
        assert service["environment"]["REASONKB_URL"] == "http://web:3000"
        assert service["environment"]["REASONKB_MCP_HOST"] == "0.0.0.0"
        assert service["environment"]["REASONKB_MCP_PORT"] == 3002
        assert service["ports"] == [
            "${MCP_BIND_ADDRESS:-127.0.0.1}:"
            "${MCP_PORT:-43173}:3002"
        ]
        assert not service.get("volumes")
        assert service["depends_on"]["web"]["condition"] == "service_started"


def test_release_web_exposes_current_host_projects_root_to_settings_ui():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    web = compose["services"]["web"]
    assert (
        web["environment"]["REASONKB_CURRENT_PROJECTS_ROOT"]
        == "${REASONKB_PROJECTS_ROOT:-./projects}"
    )
    assert web["environment"]["REASONKB_ENV_FILE_PATH"] == "/app/runtime.env"
    assert "REASONKB_COMPOSE_COMMAND" in web["environment"]
    assert "${REASONKB_ENV_FILE:-./.env}:/app/runtime.env" in web["volumes"]
    assert (
        web["environment"]["REASONKB_HOST_BROWSE_ROOT"]
        == "${REASONKB_HOST_BROWSE_ROOT:-${HOME:-.}}"
    )
    assert web["environment"]["REASONKB_HOST_BROWSE_CONTAINER_ROOT"] == "/host-browse"
    assert (
        "${REASONKB_HOST_BROWSE_ROOT:-${HOME:-.}}:/host-browse:ro"
        in web["volumes"]
    )


def test_release_web_exposes_remote_corpus_source_to_settings_ui():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    web = compose["services"]["web"]
    assert web["environment"]["REASONKB_CORPUS_SOURCE"] == "${REASONKB_CORPUS_SOURCE:-local}"
    assert web["environment"]["REASONKB_SMB_HOST"] == "${REASONKB_SMB_HOST:-}"
    assert web["environment"]["REASONKB_SMB_SHARE"] == "${REASONKB_SMB_SHARE:-}"
    assert web["environment"]["REASONKB_SMB_BASE_PATH"] == "${REASONKB_SMB_BASE_PATH:-}"
    assert web["environment"]["REASONKB_SMB_PORT"] == "${REASONKB_SMB_PORT:-445}"


def test_gotenberg_mirror_dockerfile_tracks_official_image():
    dockerfile = (ROOT / "docker" / "Dockerfile.gotenberg").read_text(encoding="utf-8")

    assert dockerfile.strip() == "FROM gotenberg/gotenberg:8"


def test_root_dockerfile_matches_compose_build_dockerfile_for_acr_auto_build():
    assert (ROOT / "Dockerfile").read_text(encoding="utf-8") == (
        ROOT / "docker" / "Dockerfile"
    ).read_text(encoding="utf-8")


def test_acr_publish_embeds_git_revision_label():
    dockerfile = (ROOT / "docker" / "Dockerfile").read_text(encoding="utf-8")
    publish_script = (ROOT / "docker" / "publish-acr.sh").read_text(encoding="utf-8")

    assert "ARG REASONKB_GIT_SHA=unknown" in dockerfile
    assert "org.opencontainers.image.revision=$REASONKB_GIT_SHA" in dockerfile
    assert 'GIT_SHA="$(git rev-parse HEAD)"' in publish_script
    assert "--build-arg" in publish_script
    assert "REASONKB_GIT_SHA=$GIT_SHA" in publish_script


def _reserve_port(port: int) -> socket.socket | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(1)
    except OSError:
        sock.close()
        return None
    return sock


def _write_executable(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def test_install_script_assigns_available_ports_when_defaults_are_busy(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        set -eu
        output=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "-o" ]; then
            shift
            output="$1"
            break
          fi
          shift
        done
        cp "$REASONKB_FAKE_COMPOSE_SOURCE" "$output"
        """,
    )
    _write_executable(
        fake_bin / "lsof",
        """
        #!/usr/bin/env sh
        case " $* " in
          *":43170 "*|*":43171 "*|*":43172 "*|*":43173 "*)
            exit 0
            ;;
        esac
        exit 1
        """,
    )
    _write_executable(
        fake_bin / "ss",
        """
        #!/usr/bin/env sh
        exit 0
        """,
    )
    _write_executable(
        fake_bin / "nc",
        """
        #!/usr/bin/env sh
        exit 1
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          env | sort > "$REASONKB_HOME/docker-env.txt"
          printf '%s\\n' "$@" >> "$REASONKB_HOME/docker-args.txt"
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env({
        **os.environ,
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": _shell_file_path(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
    }, fake_bin)
    for key in ("WEB_PORT", "RETRIEVAL_API_PORT", "GOTENBERG_PORT", "MCP_PORT"):
        env.pop(key, None)

    result = _run_install(tmp_path, env)

    assert result.returncode == 0, result.stderr
    dotenv = (reasonkb_home / ".env").read_text(encoding="utf-8")
    configured_ports = {
        key: value
        for line in dotenv.splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured_ports["WEB_PORT"] != "43170"
    assert configured_ports["RETRIEVAL_API_PORT"] != "43171"
    assert configured_ports["GOTENBERG_PORT"] != "43172"
    assert configured_ports["MCP_PORT"] != "43173"
    assert _windows_path(configured_ports["REASONKB_PROJECTS_ROOT"]) == str(
        reasonkb_home / "projects"
    )
    assert configured_ports["REASONKB_HOST_BROWSE_ROOT"]
    assert _windows_path(configured_ports["REASONKB_HOST_BROWSE_ROOT"]) == str(Path.home())
    assert len(
        {
            configured_ports["WEB_PORT"],
            configured_ports["RETRIEVAL_API_PORT"],
            configured_ports["GOTENBERG_PORT"],
            configured_ports["MCP_PORT"],
        }
    ) == 4
    assert "Web 界面：http://localhost:" in result.stdout
    assert "MCP HTTP：http://localhost:" in result.stdout
    master_key = (reasonkb_home / "secrets" / "master.key").read_text(encoding="utf-8").strip()
    admin_password = (
        reasonkb_home / "secrets" / "admin_password"
    ).read_text(encoding="utf-8").strip()
    api_key_pepper = (
        reasonkb_home / "secrets" / "api_key_pepper"
    ).read_text(encoding="utf-8").strip()
    assert len(master_key) == 64
    assert len(admin_password) >= 12
    assert len(api_key_pepper) == 64
    cli_launcher = reasonkb_home / "bin" / "reasonkb"
    mcp_launcher = reasonkb_home / "bin" / "reasonkb-mcp"
    if os.name != "nt":
        assert stat.S_IMODE((reasonkb_home / "secrets" / "master.key").stat().st_mode) == 0o600
        assert stat.S_IMODE((reasonkb_home / "secrets" / "admin_password").stat().st_mode) == 0o600
        assert stat.S_IMODE((reasonkb_home / "secrets" / "api_key_pepper").stat().st_mode) == 0o600
        assert stat.S_IMODE(cli_launcher.stat().st_mode) == 0o700
        assert stat.S_IMODE(mcp_launcher.stat().st_mode) == 0o700
    assert "docker compose" in cli_launcher.read_text(encoding="utf-8")
    assert "exec -T" in cli_launcher.read_text(encoding="utf-8")
    assert "/app/tools/reasonkb-cli.mjs" in cli_launcher.read_text(encoding="utf-8")
    assert "exec -T" in mcp_launcher.read_text(encoding="utf-8")
    assert "/app/tools/reasonkb-mcp.mjs" in mcp_launcher.read_text(encoding="utf-8")
    assert f"首次生成的管理员密码：{admin_password}" in result.stdout
    docker_args = (reasonkb_home / "docker-args.txt").read_text(encoding="utf-8")
    assert "pull" in docker_args.splitlines()
    assert docker_args.splitlines()[-4:] == [
        "up",
        "-d",
        "--force-recreate",
        "--remove-orphans",
    ]

    (reasonkb_home / "docker-args.txt").write_text("", encoding="utf-8")
    launcher_env = _installer_env(
        {
            **os.environ,
            "REASONKB_API_KEY": "rkb_live_test",
        },
        fake_bin,
    )
    cli_result = _run_launcher(cli_launcher, launcher_env, "projects")
    assert cli_result.returncode == 0, cli_result.stderr
    cli_args = (reasonkb_home / "docker-args.txt").read_text(encoding="utf-8")
    assert "exec" in cli_args.splitlines()
    assert "-T" in cli_args.splitlines()
    assert "/app/tools/reasonkb-cli.mjs" in cli_args.splitlines()
    assert cli_args.splitlines()[-1] == "projects"

    (reasonkb_home / "docker-args.txt").write_text("", encoding="utf-8")
    mcp_result = _run_launcher(mcp_launcher, launcher_env)
    assert mcp_result.returncode == 0, mcp_result.stderr
    mcp_args = (reasonkb_home / "docker-args.txt").read_text(encoding="utf-8")
    assert "-T" in mcp_args.splitlines()
    assert "/app/tools/reasonkb-mcp.mjs" in mcp_args.splitlines()


def test_install_script_persists_environment_configuration(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    projects_root = tmp_path / "corpus"
    browse_root = tmp_path

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        set -eu
        output=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "-o" ]; then
            shift
            output="$1"
            break
          fi
          shift
        done
        cp "$REASONKB_FAKE_COMPOSE_SOURCE" "$output"
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env({
        **os.environ,
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": _shell_file_path(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_PROJECTS_ROOT": str(projects_root),
        "REASONKB_HOST_BROWSE_ROOT": str(browse_root),
        "PAGEINDEX_LLM_API_KEY": "sk-env-test",
        "PAGEINDEX_LLM_BASE_URL": "https://llm.example.test/v1",
        "PAGEINDEX_LLM_MODEL": "openai/env-chat",
        "PAGEINDEX_LLM_RETRIEVAL_MODEL": "openai/env-retrieval",
    }, fake_bin)

    result = _run_install(tmp_path, env)

    assert result.returncode == 0, result.stderr
    dotenv = (reasonkb_home / ".env").read_text(encoding="utf-8")
    configured = {
        key: value
        for line in dotenv.splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured["REASONKB_PROJECTS_ROOT"] == str(projects_root)
    assert configured["REASONKB_HOST_BROWSE_ROOT"] == str(browse_root)
    assert configured["PAGEINDEX_LLM_API_KEY"] == "sk-env-test"
    assert configured["PAGEINDEX_LLM_BASE_URL"] == "https://llm.example.test/v1"
    assert configured["PAGEINDEX_LLM_MODEL"] == "openai/env-chat"
    assert configured["PAGEINDEX_LLM_RETRIEVAL_MODEL"] == "openai/env-retrieval"
    assert "项目语料目录" in dotenv
    assert "设置页保存的运行时配置优先于这些默认值" in dotenv


def test_install_script_preserves_backslashes_when_updating_existing_env_values(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    reasonkb_home.mkdir()
    windows_root = tmp_path / "windows-like"
    projects_root = str(windows_root / "ReasonKB Corpus" / "Projects")
    browse_root = str(windows_root / "Shared Corpus")
    (reasonkb_home / ".env").write_text(
        "\n".join(
            [
                "REASONKB_PROJECTS_ROOT=C:\\old\\projects",
                "REASONKB_HOST_BROWSE_ROOT=D:\\old\\browse",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        set -eu
        output=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "-o" ]; then
            shift
            output="$1"
            break
          fi
          shift
        done
        cp "$REASONKB_FAKE_COMPOSE_SOURCE" "$output"
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env({
        **os.environ,
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": _shell_file_path(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_PROJECTS_ROOT": projects_root,
        "REASONKB_HOST_BROWSE_ROOT": browse_root,
    }, fake_bin)

    result = _run_install(tmp_path, env)

    assert result.returncode == 0, result.stderr
    configured = {
        key: value
        for line in (reasonkb_home / ".env").read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured["REASONKB_PROJECTS_ROOT"] == projects_root
    assert configured["REASONKB_HOST_BROWSE_ROOT"] == browse_root


def test_install_script_stops_when_curl_download_fails(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    reasonkb_home.mkdir()
    (reasonkb_home / "compose.yml").write_text("services: {}\n", encoding="utf-8")

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        count_file="$REASONKB_HOME/curl-count.txt"
        count=0
        if [ -f "$count_file" ]; then
          count="$(cat "$count_file")"
        fi
        count=$((count + 1))
        printf '%s\\n' "$count" > "$count_file"
        echo "curl SSL EOF" >&2
        exit 35
        """,
    )
    _write_executable(
        fake_bin / "wget",
        """
        #!/usr/bin/env sh
        printf 'wget was called\n' > "$REASONKB_HOME/wget-called.txt"
        exit 0
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env({
        **os.environ,
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": _shell_file_path(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_DOWNLOAD_RETRY_DELAY": "0",
    }, fake_bin)

    result = _run_install(tmp_path, env)

    assert result.returncode != 0
    assert "curl 无法下载 Compose 文件，安装已终止" in result.stderr
    assert (reasonkb_home / "curl-count.txt").read_text(encoding="utf-8").strip() == "3"
    assert not (reasonkb_home / "wget-called.txt").exists()
    assert (reasonkb_home / "compose.yml").read_text(encoding="utf-8") == "services: {}\n"


def test_install_script_explains_compose_download_failures(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        count_file="$REASONKB_HOME/curl-count.txt"
        count=0
        if [ -f "$count_file" ]; then
          count="$(cat "$count_file")"
        fi
        count=$((count + 1))
        printf '%s\\n' "$count" > "$count_file"
        echo "curl SSL EOF" >&2
        exit 35
        """,
    )
    _write_executable(
        fake_bin / "wget",
        """
        #!/usr/bin/env sh
        echo "wget TLS EOF" >&2
        exit 4
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env({
        **os.environ,
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_DOWNLOAD_RETRY_DELAY": "0",
    }, fake_bin)

    result = _run_install(tmp_path, env)

    assert result.returncode != 0
    assert "https://example.invalid/compose.yml" in result.stderr
    assert "下载 ReasonKB Compose 文件失败" in result.stderr
    assert "REASONKB_COMPOSE_URL" in result.stderr
    assert (reasonkb_home / "curl-count.txt").read_text(encoding="utf-8").strip() == "3"
    assert not (reasonkb_home / "compose.yml").exists()


def test_install_script_prompts_for_source_access_root_and_llm_configuration(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    prompt_input = tmp_path / "prompt-input.txt"
    prompt_output = tmp_path / "prompt-output.txt"
    projects_root = tmp_path / "interactive-projects"
    browse_root = tmp_path / "interactive-browse"
    prompt_input.write_text(
        "\n".join(
            [
                str(projects_root),
                str(browse_root),
                "sk-interactive-test",
                "https://interactive.example.test/v1",
                "openai/interactive-chat",
                "openai/interactive-retrieval",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    _write_executable(
        fake_bin / "curl",
        """
        #!/usr/bin/env sh
        set -eu
        output=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "-o" ]; then
            shift
            output="$1"
            break
          fi
          shift
        done
        cp "$REASONKB_FAKE_COMPOSE_SOURCE" "$output"
        """,
    )
    _write_executable(
        fake_bin / "docker",
        """
        #!/usr/bin/env sh
        set -eu
        if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
          exit 0
        fi
        if [ "$1" = "compose" ]; then
          exit 0
        fi
        exit 1
        """,
    )

    env = _installer_env({
        **os.environ,
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": _shell_file_path(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "1",
        "REASONKB_INSTALL_INPUT": _shell_file_path(prompt_input),
        "REASONKB_INSTALL_OUTPUT": _shell_file_path(prompt_output),
    }, fake_bin)
    for key in (
        "REASONKB_PROJECTS_ROOT",
        "REASONKB_HOST_BROWSE_ROOT",
        "PAGEINDEX_LLM_API_KEY",
        "PAGEINDEX_LLM_BASE_URL",
        "PAGEINDEX_LLM_MODEL",
        "PAGEINDEX_LLM_RETRIEVAL_MODEL",
    ):
        env.pop(key, None)

    result = _run_install(tmp_path, env)

    assert result.returncode == 0, result.stderr
    dotenv = (reasonkb_home / ".env").read_text(encoding="utf-8")
    configured = {
        key: value
        for line in dotenv.splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured["REASONKB_PROJECTS_ROOT"] == str(projects_root)
    assert configured["REASONKB_HOST_BROWSE_ROOT"] == str(browse_root)
    assert configured["PAGEINDEX_LLM_API_KEY"] == "sk-interactive-test"
    assert configured["PAGEINDEX_LLM_BASE_URL"] == "https://interactive.example.test/v1"
    assert configured["PAGEINDEX_LLM_MODEL"] == "openai/interactive-chat"
    assert configured["PAGEINDEX_LLM_RETRIEVAL_MODEL"] == "openai/interactive-retrieval"
    prompt_log = prompt_output.read_text(encoding="utf-8")
    assert "本地数据源只读访问根目录" in prompt_log
    assert "项目语料来源" not in prompt_log
    assert "SMB 用户名" not in prompt_log
    assert "可选，按 Enter 跳过" in prompt_log
    assert "LLM 服务 Base URL" in prompt_log

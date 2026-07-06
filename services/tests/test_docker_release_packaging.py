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
    if not shell:
        import pytest

        pytest.skip("POSIX sh is required for install.sh integration tests")
    return shell


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

    app_services = ["web", "retrieval-api", "index-worker", "directory-watcher"]
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


def test_release_compose_mounts_smb_secrets_for_remote_corpus_workers():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    for service_name in ("directory-watcher", "index-worker"):
        service = compose["services"][service_name]
        assert "${REASONKB_SECRETS_ROOT:-./secrets}:/app/secrets:ro" in service["volumes"]
        assert service["environment"]["REASONKB_CORPUS_SOURCE"] == "${REASONKB_CORPUS_SOURCE:-local}"
        assert service["environment"]["REASONKB_SMB_USERNAME_FILE"] == "${REASONKB_SMB_USERNAME_FILE:-/app/secrets/smb_username}"
        assert service["environment"]["REASONKB_SMB_PASSWORD_FILE"] == "${REASONKB_SMB_PASSWORD_FILE:-/app/secrets/smb_password}"
        assert "SYS_ADMIN" not in service.get("cap_add", [])


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
          *":43170 "*|*":43171 "*|*":43172 "*)
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

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": str(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
    }
    for key in ("WEB_PORT", "RETRIEVAL_API_PORT", "GOTENBERG_PORT"):
        env.pop(key, None)

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

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
    assert configured_ports["REASONKB_PROJECTS_ROOT"] == str(reasonkb_home / "projects")
    assert configured_ports["REASONKB_HOST_BROWSE_ROOT"] == os.environ["HOME"]
    assert len(
        {
            configured_ports["WEB_PORT"],
            configured_ports["RETRIEVAL_API_PORT"],
            configured_ports["GOTENBERG_PORT"],
        }
    ) == 3
    assert "Web 界面：http://localhost:" in result.stdout
    docker_args = (reasonkb_home / "docker-args.txt").read_text(encoding="utf-8")
    assert "pull" in docker_args.splitlines()
    assert docker_args.splitlines()[-4:] == [
        "up",
        "-d",
        "--force-recreate",
        "--remove-orphans",
    ]


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

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": str(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_PROJECTS_ROOT": str(projects_root),
        "REASONKB_HOST_BROWSE_ROOT": str(browse_root),
        "PAGEINDEX_LLM_API_KEY": "sk-env-test",
        "PAGEINDEX_LLM_BASE_URL": "https://llm.example.test/v1",
        "PAGEINDEX_LLM_MODEL": "openai/env-chat",
        "PAGEINDEX_LLM_RETRIEVAL_MODEL": "openai/env-retrieval",
    }

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

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


def test_install_script_falls_back_to_wget_when_curl_download_fails(tmp_path):
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
        set -eu
        output=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            -qO|-O)
              shift
              output="$1"
              ;;
          esac
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

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": str(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_DOWNLOAD_RETRY_DELAY": "0",
    }

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (reasonkb_home / "compose.yml").read_text(encoding="utf-8") == (
        ROOT / "docker" / "compose.release.yml"
    ).read_text(encoding="utf-8")
    assert (reasonkb_home / "curl-count.txt").read_text(encoding="utf-8").strip() == "3"


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

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_INTERACTIVE": "0",
        "REASONKB_DOWNLOAD_RETRY_DELAY": "0",
    }

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "https://example.invalid/compose.yml" in result.stderr
    assert "下载 ReasonKB Compose 文件失败" in result.stderr
    assert "REASONKB_COMPOSE_URL" in result.stderr
    assert str(reasonkb_home / "compose.yml") in result.stderr
    assert (reasonkb_home / "curl-count.txt").read_text(encoding="utf-8").strip() == "3"


def test_install_script_prompts_for_corpus_and_llm_configuration(tmp_path):
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
                "local",
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

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": str(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "1",
        "REASONKB_INSTALL_INPUT": str(prompt_input),
        "REASONKB_INSTALL_OUTPUT": str(prompt_output),
    }
    for key in (
        "REASONKB_PROJECTS_ROOT",
        "REASONKB_HOST_BROWSE_ROOT",
        "PAGEINDEX_LLM_API_KEY",
        "PAGEINDEX_LLM_BASE_URL",
        "PAGEINDEX_LLM_MODEL",
        "PAGEINDEX_LLM_RETRIEVAL_MODEL",
    ):
        env.pop(key, None)

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    dotenv = (reasonkb_home / ".env").read_text(encoding="utf-8")
    configured = {
        key: value
        for line in dotenv.splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured["REASONKB_PROJECTS_ROOT"] == str(projects_root)
    assert configured["REASONKB_CORPUS_SOURCE"] == "local"
    assert configured["REASONKB_HOST_BROWSE_ROOT"] == str(browse_root)
    assert configured["PAGEINDEX_LLM_API_KEY"] == "sk-interactive-test"
    assert configured["PAGEINDEX_LLM_BASE_URL"] == "https://interactive.example.test/v1"
    assert configured["PAGEINDEX_LLM_MODEL"] == "openai/interactive-chat"
    assert configured["PAGEINDEX_LLM_RETRIEVAL_MODEL"] == "openai/interactive-retrieval"
    prompt_log = prompt_output.read_text(encoding="utf-8")
    assert "项目语料目录" in prompt_log
    assert "可选，按 Enter 跳过" in prompt_log
    assert "LLM 服务 Base URL" in prompt_log


def test_install_script_interactive_smb_flow_writes_env_and_secret_files(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    prompt_input = tmp_path / "prompt-input.txt"
    prompt_output = tmp_path / "prompt-output.txt"
    prompt_input.write_text(
        "\n".join(
            [
                "smb",
                r"\\fileserver\Projects\Division A",
                "alice",
                "super-secret",
                "DOMAIN",
                "",
                "",
                "",
                "",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    _write_executable(fake_bin / "curl", """
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
    """)
    _write_executable(fake_bin / "docker", """
    #!/usr/bin/env sh
    set -eu
    if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
      exit 0
    fi
    if [ "$1" = "compose" ]; then
      exit 0
    fi
    exit 1
    """)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": str(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "1",
        "REASONKB_INSTALL_INPUT": str(prompt_input),
        "REASONKB_INSTALL_OUTPUT": str(prompt_output),
    }

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    configured = {
        key: value
        for line in (reasonkb_home / ".env").read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured["REASONKB_CORPUS_SOURCE"] == "smb"
    assert configured["REASONKB_SMB_HOST"] == "fileserver"
    assert configured["REASONKB_SMB_SHARE"] == "Projects"
    assert configured["REASONKB_SMB_BASE_PATH"] == "Division A"
    assert configured["REASONKB_SMB_DOMAIN"] == "DOMAIN"
    assert configured["REASONKB_SMB_USERNAME_FILE"] == "./secrets/smb_username"
    assert configured["REASONKB_SMB_PASSWORD_FILE"] == "./secrets/smb_password"
    assert (reasonkb_home / "secrets" / "smb_username").read_text(encoding="utf-8") == "alice\n"
    assert (reasonkb_home / "secrets" / "smb_password").read_text(encoding="utf-8") == "super-secret\n"
    assert "super-secret" not in result.stdout
    assert "super-secret" not in prompt_output.read_text(encoding="utf-8")

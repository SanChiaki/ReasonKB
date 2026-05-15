from pathlib import Path
import os
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


def test_gotenberg_mirror_dockerfile_tracks_official_image():
    dockerfile = (ROOT / "docker" / "Dockerfile.gotenberg").read_text(encoding="utf-8")

    assert dockerfile.strip() == "FROM gotenberg/gotenberg:8"


def test_root_dockerfile_matches_compose_build_dockerfile_for_acr_auto_build():
    assert (ROOT / "Dockerfile").read_text(encoding="utf-8") == (
        ROOT / "docker" / "Dockerfile"
    ).read_text(encoding="utf-8")


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
    reserved = [
        sock
        for port in (43170, 43171, 43172)
        if (sock := _reserve_port(port)) is not None
    ]

    try:
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
              env | sort > "$REASONKB_HOME/docker-env.txt"
              printf '%s\\n' "$@" > "$REASONKB_HOME/docker-args.txt"
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
        }
        for key in ("WEB_PORT", "RETRIEVAL_API_PORT", "GOTENBERG_PORT"):
            env.pop(key, None)

        result = subprocess.run(
            ["sh", str(ROOT / "docker" / "install.sh")],
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
        assert len(
            {
                configured_ports["WEB_PORT"],
                configured_ports["RETRIEVAL_API_PORT"],
                configured_ports["GOTENBERG_PORT"],
            }
        ) == 3
        assert "Web UI: http://localhost:" in result.stdout
        assert (reasonkb_home / "docker-args.txt").read_text(encoding="utf-8").splitlines()[
            -2:
        ] == ["up", "-d"]
    finally:
        for sock in reserved:
            sock.close()

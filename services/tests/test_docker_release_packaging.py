from pathlib import Path

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


def test_gotenberg_mirror_dockerfile_tracks_official_image():
    dockerfile = (ROOT / "docker" / "Dockerfile.gotenberg").read_text(encoding="utf-8")

    assert dockerfile.strip() == "FROM gotenberg/gotenberg:8"


def test_root_dockerfile_matches_compose_build_dockerfile_for_acr_auto_build():
    assert (ROOT / "Dockerfile").read_text(encoding="utf-8") == (
        ROOT / "docker" / "Dockerfile"
    ).read_text(encoding="utf-8")

from pathlib import Path
import os


REPO_ROOT = Path(__file__).resolve().parents[2]
VAR_ROOT = Path(os.getenv("APP_VAR_ROOT", REPO_ROOT / ".reasonkb" / "var"))
DB_PATH = Path(os.getenv("APP_DB_PATH", VAR_ROOT / "app.db"))
UPLOAD_ROOT = Path(os.getenv("APP_UPLOAD_ROOT", VAR_ROOT / "uploads"))
CONVERTED_ROOT = Path(os.getenv("APP_CONVERTED_ROOT", VAR_ROOT / "converted"))
PROJECTS_ROOT = Path(os.getenv("PROJECTS_ROOT", REPO_ROOT / ".reasonkb" / "projects"))
GOTENBERG_URL = os.getenv("GOTENBERG_URL", "http://gotenberg:3000")
OFFICE_CONVERSION_TIMEOUT_SECONDS = float(os.getenv("OFFICE_CONVERSION_TIMEOUT_SECONDS", "120"))
INDEX_JOB_TIMEOUT_SECONDS = float(os.getenv("INDEX_JOB_TIMEOUT_SECONDS", "1800"))
INDEX_WORKER_CONCURRENCY = max(1, int(os.getenv("INDEX_WORKER_CONCURRENCY", "1")))
VISION_MODEL = os.getenv("VISION_MODEL")
VISION_EXTRACTION_ENABLED = os.getenv("VISION_EXTRACTION_ENABLED", "false").lower() == "true"
DIRECTORY_SCAN_INTERVAL_SECONDS = float(os.getenv("DIRECTORY_SCAN_INTERVAL_SECONDS", "5"))
INDEX_DEBUG_METRICS = os.getenv("INDEX_DEBUG_METRICS", "false").lower() == "true"

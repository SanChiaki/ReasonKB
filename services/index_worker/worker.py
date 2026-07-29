import multiprocessing
import os
import hashlib
import queue
import signal
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from services.common.settings import DB_PATH, INDEX_JOB_TIMEOUT_SECONDS, INDEX_WORKER_CONCURRENCY
from services.common.sqlite_store import open_db
from services.common.system_settings import get_index_worker_concurrency
from services.index_worker.index_document import process_document_job
from services.source_worker.connectors.seeyon import (
    SeeyonTokenCache,
    configure_process_token_cache,
)
from services.common.worker_health import write_worker_heartbeat


@dataclass
class ActiveDocumentJob:
    process: multiprocessing.Process
    error_queue: Any
    started_at: float


def claim_next_job(db_path: str, worker_id: str = "index-worker"):
    now = datetime.now(timezone.utc).isoformat()
    with open_db(db_path) as conn:
        row = conn.execute(
            """
            WITH next_job AS (
              SELECT j.id, j.document_id
                FROM jobs j
                JOIN documents d ON d.id = j.document_id
               WHERE type = 'document_index'
                 AND j.status = 'queued'
                 AND (j.available_at IS NULL OR j.available_at <= ?)
                 AND (
                   j.source_id IS NULL OR NOT EXISTS (
                     SELECT 1 FROM jobs source_running
                      WHERE source_running.status = 'running'
                        AND source_running.source_id = j.source_id
                   )
                 )
               ORDER BY j.priority ASC,
                        (SELECT COUNT(*) FROM jobs running
                          WHERE running.status = 'running'
                            AND COALESCE(running.source_id, '') = COALESCE(j.source_id, '')) ASC,
                        (SELECT COUNT(*)
                           FROM jobs running
                           JOIN documents running_document
                             ON running_document.id = running.document_id
                          WHERE running.status = 'running'
                            AND running_document.project_id = d.project_id) ASC,
                        j.created_at ASC
               LIMIT 1
            )
            UPDATE jobs
               SET status = 'running', progress = 5, updated_at = ?,
                   attempt_count = attempt_count + 1, claimed_at = ?,
                   worker_id = ?, finished_at = NULL
             WHERE id = (SELECT id FROM next_job)
               AND status = 'queued'
            RETURNING id, document_id
            """,
            (now, now, now, worker_id),
        ).fetchone()
        if row is None:
            return None

        conn.execute(
            """
            UPDATE documents
               SET status = 'indexing', updated_at = ?
             WHERE id = ?
            """,
            (now, row["document_id"]),
        )
        return row["id"]


def _process_document_job_child(
    db_path: str,
    job_id: str,
    error_queue=None,
    token_cache: SeeyonTokenCache | None = None,
) -> None:
    try:
        if token_cache is not None:
            configure_process_token_cache(token_cache)
        process_document_job(db_path, job_id)
    except BaseException as exc:
        if error_queue is not None:
            error_queue.put((exc.__class__.__name__, str(exc)))


def run_document_job_with_timeout(
    db_path: str,
    job_id: str,
    timeout_seconds: float = INDEX_JOB_TIMEOUT_SECONDS,
) -> None:
    error_queue = multiprocessing.Queue()
    process = multiprocessing.Process(
        target=_process_document_job_child,
        args=(db_path, job_id, error_queue),
    )
    process.start()
    process.join(timeout_seconds)

    if process.is_alive():
        process.terminate()
        process.join(5)
        if process.is_alive():
            process.kill()
            process.join()
        raise TimeoutError(f"Document index job {job_id} timed out after {timeout_seconds:g} seconds")

    error_message = _child_error_message(error_queue)
    if error_message:
        raise RuntimeError(error_message)

    if process.exitcode:
        raise RuntimeError(f"Document index job {job_id} exited with code {process.exitcode}")


def start_document_job(db_path: str, job_id: str) -> ActiveDocumentJob:
    return start_document_job_with_token_cache(db_path, job_id)


def start_document_job_with_token_cache(
    db_path: str,
    job_id: str,
    token_cache: SeeyonTokenCache | None = None,
) -> ActiveDocumentJob:
    error_queue = multiprocessing.Queue()
    process = multiprocessing.Process(
        target=_process_document_job_child,
        args=(db_path, job_id, error_queue, token_cache),
    )
    process.start()
    return ActiveDocumentJob(process=process, error_queue=error_queue, started_at=time.monotonic())


def start_queued_jobs(
    db_path: str,
    active_jobs: dict[str, ActiveDocumentJob],
    concurrency: int = INDEX_WORKER_CONCURRENCY,
    token_cache: SeeyonTokenCache | None = None,
) -> int:
    started_count = 0
    while len(active_jobs) < concurrency:
        job_id = claim_next_job(db_path)
        if job_id is None:
            break
        if token_cache is None:
            active_jobs[job_id] = start_document_job(db_path, job_id)
        else:
            active_jobs[job_id] = start_document_job_with_token_cache(
                db_path,
                job_id,
                token_cache,
            )
        started_count += 1
    return started_count


def collect_finished_jobs(
    db_path: str,
    active_jobs: dict[str, ActiveDocumentJob],
    timeout_seconds: float = INDEX_JOB_TIMEOUT_SECONDS,
) -> int:
    finished_count = 0
    for job_id, active_job in list(active_jobs.items()):
        process = active_job.process
        process.join(0)
        if process.is_alive():
            if time.monotonic() - active_job.started_at < timeout_seconds:
                continue
            process.terminate()
            process.join(5)
            if process.is_alive():
                process.kill()
                process.join()
            fail_document_job(
                db_path,
                job_id,
                f"Document index job {job_id} timed out after {timeout_seconds:g} seconds",
            )
            del active_jobs[job_id]
            finished_count += 1
            continue

        error_message = _child_error_message(active_job.error_queue)
        if error_message:
            fail_document_job(db_path, job_id, error_message)
        elif process.exitcode:
            fail_document_job(
                db_path,
                job_id,
                f"Document index job {job_id} exited with code {process.exitcode}",
            )
        del active_jobs[job_id]
        finished_count += 1
    return finished_count


def stop_active_jobs(active_jobs: dict[str, ActiveDocumentJob], db_path: str | None = None) -> None:
    for job_id, active_job in list(active_jobs.items()):
        process = active_job.process
        if process.is_alive():
            process.terminate()
            process.join(5)
            if process.is_alive():
                process.kill()
                process.join()
            if db_path is not None:
                fail_document_job(
                    db_path,
                    job_id,
                    f"Document index job {job_id} stopped before completion",
                )
        elif process.exitcode:
            error_message = _child_error_message(active_job.error_queue)
            if db_path is not None:
                fail_document_job(
                    db_path,
                    job_id,
                    error_message or f"Document index job {job_id} exited with code {process.exitcode}",
                )
        del active_jobs[job_id]


def _child_error_message(error_queue) -> str | None:
    if error_queue is None:
        return None
    try:
        error_type, error_message = error_queue.get(timeout=0.1)
    except queue.Empty:
        return None
    return f"{error_type}: {error_message}"


def fail_document_job(db_path: str, job_id: str, error_message: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with open_db(db_path) as conn:
        job = conn.execute(
            """
            SELECT j.document_id, j.status, j.attempt_count, j.max_attempts,
                   j.expected_source_revision, j.expected_source_config_revision,
                   d.source_id, d.source_collection_id, d.source_item_id,
                   d.expected_source_revision AS document_expected_source_revision,
                   d.lifecycle_state, s.config_revision, s.state AS source_state,
                   c.selected AS collection_selected,
                   c.lifecycle_state AS collection_lifecycle_state,
                   p.lifecycle_state AS project_lifecycle_state
              FROM jobs j
              JOIN documents d ON d.id = j.document_id
              JOIN projects p ON p.id = d.project_id
              LEFT JOIN corpus_sources s ON s.id = d.source_id
              LEFT JOIN source_collections c ON c.id = d.source_collection_id
             WHERE j.id = ?
            """,
            (job_id,),
        ).fetchone()
        if job is None or job["status"] != "running":
            return

        document_id = job["document_id"]
        if _job_is_superseded(job):
            conn.execute(
                """
                UPDATE jobs SET status = 'superseded', superseded_at = ?,
                       error_message = ?, updated_at = ?, finished_at = ?
                 WHERE id = ? AND status = 'running'
                """,
                (now, error_message, now, now, job_id),
            )
            _finish_running_index_runs(conn, job_id, "superseded", now, error_message)
            return

        if _is_access_denied_failure(error_message):
            summary = "SourceAccessDenied: source item access denied"
            conn.execute(
                """
                UPDATE jobs SET status = 'failed', progress = 0, error_message = ?,
                       updated_at = ?, finished_at = ?
                 WHERE id = ? AND status = 'running'
                """,
                (summary, now, now, job_id),
            )
            conn.execute(
                """
                UPDATE documents SET status = 'failed', lifecycle_state = 'access_revoked',
                       retrieval_eligible = 0, error_message = ?, updated_at = ?
                 WHERE id = ?
                """,
                (summary, now, document_id),
            )
            if job["source_item_id"]:
                conn.execute(
                    """
                    UPDATE source_items SET lifecycle_state = 'access_revoked', updated_at = ?
                     WHERE id = ?
                    """,
                    (now, job["source_item_id"]),
                )
            conn.execute(
                """
                UPDATE document_indexes SET is_current = 0, retired_at = ?
                 WHERE document_id = ? AND is_current = 1
                """,
                (now, document_id),
            )
            if job["source_id"]:
                conn.execute(
                    """
                    UPDATE corpus_sources SET health_state = 'needs_attention',
                           consecutive_failure_count = consecutive_failure_count + 1,
                           error_summary = ?, updated_at = ? WHERE id = ?
                    """,
                    (summary, now, job["source_id"]),
                )
            _finish_running_index_runs(conn, job_id, "failed", now, summary)
            return

        if _is_transient_failure(error_message) and job["attempt_count"] < job["max_attempts"]:
            retry_at = (
                datetime.now(timezone.utc)
                + timedelta(seconds=_retry_delay_seconds(int(job["attempt_count"]), job_id))
            ).isoformat()
            conn.execute(
                """
                UPDATE jobs SET status = 'queued', progress = 0,
                       error_message = ?, available_at = ?, updated_at = ?,
                       claimed_at = NULL, worker_id = NULL, finished_at = NULL
                 WHERE id = ? AND status = 'running'
                """,
                (error_message, retry_at, now, job_id),
            )
            conn.execute(
                """
                UPDATE documents SET status = 'uploaded', error_message = NULL, updated_at = ?
                 WHERE id = ? AND expected_source_revision IS ?
                """,
                (now, document_id, job["expected_source_revision"]),
            )
            _finish_running_index_runs(conn, job_id, "failed", now, error_message)
            return

        conn.execute(
            "UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?",
            (error_message, now, now, job_id),
        )
        conn.execute(
            """
            UPDATE documents
               SET status = 'failed', error_message = ?, updated_at = ?
             WHERE id = ?
            """,
            (error_message, now, document_id),
        )

        _finish_running_index_runs(conn, job_id, "failed", now, error_message)


def _job_is_superseded(job) -> bool:
    if not job["source_id"]:
        return False
    return bool(
        job["expected_source_revision"] != job["document_expected_source_revision"]
        or job["expected_source_config_revision"] != job["config_revision"]
        or job["source_state"] != "active"
        or not job["collection_selected"]
        or job["collection_lifecycle_state"] in {"inactive", "missing", "pending_purge"}
        or job["project_lifecycle_state"] not in {"pending", "active"}
        or job["lifecycle_state"] != "active"
    )


def _is_transient_failure(error_message: str) -> bool:
    lowered = error_message.lower()
    transient_markers = (
        "timeout",
        "timed out",
        "connection",
        "temporarily unavailable",
        "remote fetch",
        "download failed",
        "office conversion failed",
        "no space left on device",
        "database or disk is full",
        "disk full",
        "http 429",
        "http 502",
        "http 503",
        "http 504",
        "keyerror: 'completed'",
        "unsupported operand type(s) for +: 'int' and 'nonetype'",
        "failed to complete toc transformation",
        "left running by a previous worker",
        "stopped before completion",
    )
    return any(marker in lowered for marker in transient_markers)


def _is_access_denied_failure(error_message: str) -> bool:
    return "sourceaccessdenied:" in error_message.replace(" ", "").lower()


def _retry_delay_seconds(attempt_count: int, job_id: str) -> int:
    schedule = (60, 300, 900, 3600, 21600)
    base = schedule[min(max(0, attempt_count - 1), len(schedule) - 1)]
    digest = hashlib.sha256(f"{job_id}:{attempt_count}".encode("utf-8")).digest()
    jitter = 0.9 + (int.from_bytes(digest[:2], "big") / 65535) * 0.2
    return max(1, round(base * jitter))


def _finish_running_index_runs(conn, job_id: str, status: str, now: str, error_message: str) -> None:
    running_runs = conn.execute(
        """
        SELECT id, started_at
          FROM document_index_runs
         WHERE job_id = ? AND status = 'running'
         ORDER BY started_at DESC
        """,
        (job_id,),
    ).fetchall()
    for run in running_runs:
        conn.execute(
            """
            UPDATE document_index_runs
               SET status = ?, finished_at = ?, duration_ms = ?, error_message = ?
             WHERE id = ?
            """,
            (status, now, _duration_since_iso_ms(run["started_at"]), error_message, run["id"]),
        )


def sweep_stale_running_runs(db_path: str) -> int:
    with open_db(db_path) as conn:
        stale_runs = conn.execute(
            """
            SELECT r.id, r.started_at, j.finished_at, j.updated_at, j.error_message
              FROM document_index_runs r
              JOIN jobs j ON j.id = r.job_id
             WHERE r.status = 'running'
               AND j.status IN ('failed', 'completed')
            """
        ).fetchall()
        for run in stale_runs:
            finished_at = run["finished_at"] or run["updated_at"] or datetime.now(timezone.utc).isoformat()
            duration_ms = _duration_between_iso_ms(run["started_at"], finished_at)
            error_message = run["error_message"]
            status = "failed" if error_message else "completed"
            conn.execute(
                """
                UPDATE document_index_runs
                   SET status = ?,
                       finished_at = ?,
                       duration_ms = ?,
                       error_message = ?
                 WHERE id = ?
                """,
                (status, finished_at, duration_ms, error_message, run["id"]),
            )
    return len(stale_runs)


def fail_orphaned_running_jobs(db_path: str) -> int:
    with open_db(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id
              FROM jobs
             WHERE type = 'document_index'
               AND status = 'running'
             ORDER BY updated_at ASC
            """
        ).fetchall()

    for row in rows:
        fail_document_job(
            db_path,
            row["id"],
            f"Document index job {row['id']} was left running by a previous worker process",
        )
    return len(rows)


def _duration_since_iso_ms(started_at: str) -> int:
    return _duration_between_iso_ms(started_at, datetime.now(timezone.utc).isoformat())


def _duration_between_iso_ms(started_at: str, finished_at: str) -> int:
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        finished = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    if finished.tzinfo is None:
        finished = finished.replace(tzinfo=timezone.utc)
    return max(0, int((finished - started).total_seconds() * 1000))


def run_forever(
    poll_seconds: float = 2.0,
    concurrency: int = INDEX_WORKER_CONCURRENCY,
):
    fail_orphaned_running_jobs(str(DB_PATH))
    sweep_stale_running_runs(str(DB_PATH))
    heartbeat_path = os.environ.get(
        "REASONKB_WORKER_HEARTBEAT_FILE", "/tmp/reasonkb-index-worker.heartbeat"
    )
    manager = multiprocessing.Manager()
    token_cache = SeeyonTokenCache(
        tokens=manager.dict(),
        in_flight=manager.dict(),
        guard=manager.RLock(),
    )
    active_jobs: dict[str, ActiveDocumentJob] = {}
    try:
        while True:
            write_worker_heartbeat(heartbeat_path)
            collect_finished_jobs(str(DB_PATH), active_jobs)
            runtime_concurrency = get_index_worker_concurrency(
                str(DB_PATH),
                default=concurrency,
            )
            started_count = start_queued_jobs(
                str(DB_PATH),
                active_jobs,
                concurrency=runtime_concurrency,
                token_cache=token_cache,
            )
            if started_count == 0:
                time.sleep(poll_seconds)
    finally:
        stop_active_jobs(active_jobs, str(DB_PATH))
        manager.shutdown()


def _handle_shutdown_signal(signum, frame):
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _handle_shutdown_signal)
    signal.signal(signal.SIGINT, _handle_shutdown_signal)
    run_forever()

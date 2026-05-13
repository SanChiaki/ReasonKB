import multiprocessing
import queue
import signal
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from services.common.settings import DB_PATH, INDEX_JOB_TIMEOUT_SECONDS, INDEX_WORKER_CONCURRENCY
from services.common.sqlite_store import open_db
from services.index_worker.index_document import process_document_job


@dataclass
class ActiveDocumentJob:
    process: multiprocessing.Process
    error_queue: Any
    started_at: float


def claim_next_job(db_path: str):
    now = datetime.now(timezone.utc).isoformat()
    with open_db(db_path) as conn:
        row = conn.execute(
            """
            WITH next_job AS (
              SELECT id, document_id
                FROM jobs
               WHERE type = 'document_index'
                 AND status = 'queued'
               ORDER BY created_at ASC
               LIMIT 1
            )
            UPDATE jobs
               SET status = 'running', progress = 5, updated_at = ?
             WHERE id = (SELECT id FROM next_job)
               AND status = 'queued'
            RETURNING id, document_id
            """,
            (now,),
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


def _process_document_job_child(db_path: str, job_id: str, error_queue=None) -> None:
    try:
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
    error_queue = multiprocessing.Queue()
    process = multiprocessing.Process(
        target=_process_document_job_child,
        args=(db_path, job_id, error_queue),
    )
    process.start()
    return ActiveDocumentJob(process=process, error_queue=error_queue, started_at=time.monotonic())


def start_queued_jobs(
    db_path: str,
    active_jobs: dict[str, ActiveDocumentJob],
    concurrency: int = INDEX_WORKER_CONCURRENCY,
) -> int:
    started_count = 0
    while len(active_jobs) < concurrency:
        job_id = claim_next_job(db_path)
        if job_id is None:
            break
        active_jobs[job_id] = start_document_job(db_path, job_id)
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
            "SELECT document_id FROM jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if job is None:
            return

        document_id = job["document_id"]
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

        running_runs = conn.execute(
            """
            SELECT id, started_at
              FROM document_index_runs
             WHERE job_id = ?
               AND status = 'running'
             ORDER BY started_at DESC
            """,
            (job_id,),
        ).fetchall()
        for run in running_runs:
            duration_ms = _duration_since_iso_ms(run["started_at"])
            conn.execute(
                """
                UPDATE document_index_runs
                   SET status = 'failed',
                       finished_at = ?,
                       duration_ms = ?,
                       error_message = ?
                 WHERE id = ?
                """,
                (now, duration_ms, error_message, run["id"]),
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
    active_jobs: dict[str, ActiveDocumentJob] = {}
    try:
        while True:
            collect_finished_jobs(str(DB_PATH), active_jobs)
            started_count = start_queued_jobs(str(DB_PATH), active_jobs, concurrency=max(1, concurrency))
            if started_count == 0:
                time.sleep(poll_seconds)
    finally:
        stop_active_jobs(active_jobs, str(DB_PATH))


def _handle_shutdown_signal(signum, frame):
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _handle_shutdown_signal)
    signal.signal(signal.SIGINT, _handle_shutdown_signal)
    run_forever()

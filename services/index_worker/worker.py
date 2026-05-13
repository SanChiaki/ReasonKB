import multiprocessing
import time
from datetime import datetime, timezone

from services.common.settings import DB_PATH, INDEX_JOB_TIMEOUT_SECONDS
from services.common.sqlite_store import open_db
from services.index_worker.index_document import process_document_job


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


def _process_document_job_child(db_path: str, job_id: str, error_queue) -> None:
    try:
        process_document_job(db_path, job_id)
    except BaseException as exc:
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

    if not error_queue.empty():
        error_type, error_message = error_queue.get()
        raise RuntimeError(f"{error_type}: {error_message}")

    if process.exitcode:
        raise RuntimeError(f"Document index job {job_id} exited with code {process.exitcode}")


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


def run_forever(poll_seconds: float = 2.0):
    sweep_stale_running_runs(str(DB_PATH))
    while True:
        job_id = claim_next_job(str(DB_PATH))
        if job_id is None:
            time.sleep(poll_seconds)
            continue
        try:
            run_document_job_with_timeout(str(DB_PATH), job_id)
        except Exception as exc:
            fail_document_job(str(DB_PATH), job_id, str(exc))


if __name__ == "__main__":
    run_forever()

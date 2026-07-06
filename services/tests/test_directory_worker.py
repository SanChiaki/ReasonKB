import pytest

from services.directory_watcher import worker


def test_run_forever_logs_sync_errors_and_retries(monkeypatch, capsys):
    calls = 0
    sleeps = 0

    def fake_sync_configured_source():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ConnectionError("temporary SMB scan failure")
        return {"created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}

    def fake_sleep(seconds):
        nonlocal sleeps
        sleeps += 1
        if calls >= 2:
            raise KeyboardInterrupt

    monkeypatch.setattr(worker, "sync_configured_source", fake_sync_configured_source)
    monkeypatch.setattr(worker.time, "sleep", fake_sleep)

    with pytest.raises(KeyboardInterrupt):
        worker.run_forever(poll_seconds=0)

    captured = capsys.readouterr()
    assert calls == 2
    assert sleeps == 2
    assert "directory watcher sync failed: temporary SMB scan failure" in captured.err


def test_run_forever_redacts_credential_words_from_sync_errors(monkeypatch, capsys):
    calls = 0

    def fake_sync_configured_source():
        nonlocal calls
        calls += 1
        raise ConnectionError("bad password super-secret")

    def fake_sleep(seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(worker, "sync_configured_source", fake_sync_configured_source)
    monkeypatch.setattr(worker.time, "sleep", fake_sleep)

    with pytest.raises(KeyboardInterrupt):
        worker.run_forever(poll_seconds=0)

    captured = capsys.readouterr()
    assert calls == 1
    assert "directory watcher sync failed" in captured.err
    assert "password" not in captured.err.lower()
    assert "super-secret" not in captured.err

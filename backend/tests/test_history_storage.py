"""The protected store for archived customer evidence.

The bucket does the protecting (versioning, Object Lock default retention, an IAM
policy that denies delete). These tests cover what the application adds on top: it
refuses to write evidence that did not come back locked, never deletes, and reports a
bucket that is not configured as required so that deletion stays unavailable.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import FakeHistoryS3

import hms_backend.app.core.object_storage as object_storage
from hms_backend.app.core.config import settings
from hms_backend.app.core.object_storage import (
    HistoryStorageError,
    HistoryStorageUnavailable,
    LocalObjectStorage,
    S3HistoryStorage,
    get_history_storage,
    history_storage_problems,
    set_history_storage,
    set_object_storage,
)

SEVEN_YEARS = 365 * 7


def store_for(fake: FakeHistoryS3) -> S3HistoryStorage:
    return S3HistoryStorage(bucket="hms-history", client=fake)


def test_a_locked_write_is_accepted_and_read_back() -> None:
    fake = FakeHistoryS3()
    store = store_for(fake)
    store.put("history/a/cert.pdf", b"pdf-bytes")
    assert store.get("history/a/cert.pdf") == b"pdf-bytes"


def test_evidence_that_comes_back_without_object_lock_is_rejected() -> None:
    store = store_for(FakeHistoryS3(lock_objects=False))
    with pytest.raises(HistoryStorageError, match="without Object Lock"):
        store.put("history/a/cert.pdf", b"pdf-bytes")


def test_evidence_whose_retention_has_already_ended_is_rejected() -> None:
    store = store_for(FakeHistoryS3(retain_days=-1))
    with pytest.raises(HistoryStorageError, match="retention has already ended"):
        store.put("history/a/cert.pdf", b"pdf-bytes")


def test_the_application_never_deletes_archived_evidence() -> None:
    fake = FakeHistoryS3()
    store = store_for(fake)
    store.put("history/a/cert.pdf", b"x")
    with pytest.raises(PermissionError):
        store.delete("history/a/cert.pdf")
    assert "history/a/cert.pdf" in fake.objects


@pytest.mark.parametrize(
    ("fake", "expected"),
    [
        (FakeHistoryS3(), []),
        (FakeHistoryS3(days=0, years=0, mode="COMPLIANCE"), "shorter"),
        (FakeHistoryS3(versioning=None), "versioning is not enabled"),
        (FakeHistoryS3(versioning="Suspended"), "versioning is not enabled"),
        (FakeHistoryS3(lock=False), "Object Lock is not enabled"),
        (FakeHistoryS3(mode=None), "no default retention mode"),
        (FakeHistoryS3(years=3), "shorter"),
        (FakeHistoryS3(years=0, days=SEVEN_YEARS), []),
        (FakeHistoryS3(years=10), []),
    ],
)
def test_a_bucket_is_checked_for_versioning_lock_and_enough_retention(
    fake: FakeHistoryS3, expected: list[str] | str
) -> None:
    problems = store_for(fake).check_protection(min_retention_days=SEVEN_YEARS)
    if expected == []:
        assert problems == []
    else:
        assert any(str(expected) in problem for problem in problems), problems


def test_an_unreadable_bucket_counts_as_unprotected() -> None:
    class Denied(FakeHistoryS3):
        def get_bucket_versioning(self, **_: object) -> dict[str, str]:
            raise PermissionError("denied")

        def get_object_lock_configuration(self, **_: object) -> dict[str, str]:
            raise PermissionError("denied")

    problems = store_for(Denied()).check_protection(min_retention_days=SEVEN_YEARS)
    assert len(problems) == 2


def test_outside_local_and_test_a_missing_history_bucket_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "history_object_storage_s3_bucket", "")
    with pytest.raises(HistoryStorageUnavailable):
        get_history_storage()
    assert history_storage_problems() == ["protected history storage is not configured"]


def test_local_and_test_runs_fall_back_to_the_ordinary_store(
    tmp_path: Path,
) -> None:
    store = LocalObjectStorage(tmp_path)
    set_object_storage(store)
    try:
        assert get_history_storage() is store
        assert history_storage_problems() == []
    finally:
        set_object_storage(None)


def test_a_configured_bucket_is_used_even_in_test(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "history_object_storage_s3_bucket", "hms-history")
    assert isinstance(get_history_storage(), S3HistoryStorage)


def test_the_protection_result_is_cached_then_rechecked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeHistoryS3()
    set_history_storage(store_for(fake))
    monkeypatch.setattr(settings, "history_storage_check_ttl_seconds", 300)

    assert history_storage_problems() == []
    assert history_storage_problems() == []
    assert fake.calls.count("get_object_lock_configuration") == 1

    # A bucket that stops being protected is noticed once the cache expires.
    fake.lock = False
    monkeypatch.setattr(settings, "history_storage_check_ttl_seconds", 0)
    assert history_storage_problems() != []
    assert fake.calls.count("get_object_lock_configuration") == 2


def test_the_cache_is_cleared_when_the_store_is_replaced() -> None:
    first = FakeHistoryS3(lock=False)
    set_history_storage(store_for(first))
    assert history_storage_problems() != []
    set_history_storage(store_for(FakeHistoryS3()))
    assert history_storage_problems() == []
    assert object_storage._protection_checked_at is not None


def test_a_written_version_is_pinned_and_reads_ignore_newer_uploads() -> None:
    fake = FakeHistoryS3()
    store = store_for(fake)
    stored = store.put_evidence("history/a/cert.pdf", b"original", content_type="x")
    assert stored.version_id and stored.retention_mode == "GOVERNANCE"
    fake.put_object(Bucket="hms-history", Key="history/a/cert.pdf", Body=b"newer")
    assert store.get_version("history/a/cert.pdf", stored.version_id) == b"original"
    assert store.get("history/a/cert.pdf") == b"newer"  # latest, which is not pinned


def test_a_write_without_a_version_id_is_rejected() -> None:
    store = store_for(FakeHistoryS3(return_version_id=False))
    with pytest.raises(HistoryStorageError, match="version id"):
        store.put_evidence("history/a/cert.pdf", b"x", content_type="x")


def test_retention_shorter_than_the_batch_is_rejected_and_names_the_version() -> None:
    from datetime import UTC, datetime, timedelta

    store = store_for(FakeHistoryS3(retain_days=10))
    with pytest.raises(HistoryStorageError, match="shorter than the batch") as caught:
        store.put_evidence(
            "history/a/cert.pdf",
            b"x",
            content_type="x",
            min_retain_until=datetime.now(UTC) + timedelta(days=30),
        )
    assert caught.value.version_id  # the orphan can be recorded


def test_a_missing_version_is_reported_as_missing() -> None:
    store = store_for(FakeHistoryS3())
    with pytest.raises(object_storage.ObjectNotFoundError):
        store.get_version("history/a/cert.pdf", "v-gone")
    store.put("history/a/cert.pdf", b"x")
    with pytest.raises(object_storage.ObjectNotFoundError):
        store.describe_version("history/a/cert.pdf", "v-gone")


def test_a_protected_store_will_not_read_without_a_pinned_version() -> None:
    store = store_for(FakeHistoryS3())
    with pytest.raises(HistoryStorageError, match="no pinned version"):
        object_storage.get_evidence(store, "history/a/cert.pdf", None)


def test_the_local_fallback_has_no_version_and_no_retention(tmp_path: Path) -> None:
    local = LocalObjectStorage(tmp_path)
    stored = object_storage.put_evidence(local, "history/a.pdf", b"x", content_type="x")
    assert stored.version_id is None and stored.retain_until is None
    assert object_storage.get_evidence(local, "history/a.pdf", None) == b"x"
    assert object_storage.describe_evidence(local, "history/a.pdf", None) is None


def test_retention_days_win_over_years_and_default_to_years_of_365(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "history_retention_years", 7)
    monkeypatch.setattr(settings, "history_retention_days", 0)
    assert settings.history_retention_period_days == 365 * 7
    monkeypatch.setattr(settings, "history_retention_days", 30)
    assert settings.history_retention_period_days == 30

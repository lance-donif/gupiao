import json
import sqlite3
import sys
from decimal import Decimal

import pytest

from assistant.project_budget import ledger, main, read_snapshot, record, snapshot

BEFORE = "2025-01-01T00:00:00Z"
START = "2025-01-02T00:00:00Z"
LATER = "2025-01-03T00:00:00Z"


def test_new_baselines_and_exact_replay(tmp_path):
    with ledger(tmp_path / "private" / "budget.db") as db:
        assert snapshot(db)["estimated_remaining_usd"] is None
        record(db, "estimate", "1.22", "e0", BEFORE, "prior estimate")
        record(db, "estimate", "0.01", "same-time", START, "already included")
        args = ("baseline", "20.00", "b1", START, "operator")
        record(db, *args)
        record(db, *args)
        record(db, "estimate", "0.000001", "e1", LATER, "token estimate")
        result = snapshot(db, "30")
        assert result["baseline_ref"] == "b1"
        assert result["post_baseline_estimates_usd"] == "0.000001"
        assert result["estimated_remaining_usd"] == "9.999999"
        assert result["verified_supplier_usd"] is None
        assert snapshot(db, "30", at=START)["estimated_remaining_usd"] == "10.00"
        with pytest.raises(ValueError, match="编号"):
            record(db, "baseline", "3", "b1", START, "operator")
        with pytest.raises(ValueError, match="时刻"):
            record(db, "baseline", "3", "other-ref", "2025-01-02T08:00:00+08:00", "operator")
        record(db, "baseline", "21", "b2", LATER, "new report")
        assert snapshot(db, "30")["estimated_remaining_usd"] == "9.00"
        assert db.execute("SELECT count(*) FROM budget_entries").fetchone()[0] == 5


def test_rejects_invalid_amounts_and_naive_timestamp(tmp_path):
    with ledger(tmp_path / "budget.db") as db:
        for malformed in ["-1", "NaN", "inf", "2e3", "1.0000001", "99999999999999999999"]:
            with pytest.raises(ValueError):
                record(db, "estimate", malformed, "bad", BEFORE, "rate")
        with pytest.raises(ValueError, match="时区"):
            record(db, "estimate", "0", "bad", "2025-01-01", "rate")
        with pytest.raises(ValueError, match="上限"):
            snapshot(db, "50001")
        record(db, "baseline", "51", "b", BEFORE, "cost")
        assert Decimal(snapshot(db, "40")["estimated_remaining_usd"]) == -11


def test_other_sqlite_ledger_untouched(tmp_path):
    path = tmp_path / "provider.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE model_charges(id INTEGER)")
    with pytest.raises(ValueError, match="其他数据库"), ledger(path):
        pass
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT name FROM sqlite_schema").fetchall() == [("model_charges",)]


def test_cli_private_file_and_history(tmp_path, monkeypatch, capsys):
    path = tmp_path / "budget.db"
    cli = ["project_budget", "--db", str(path)]
    monkeypatch.setattr(
        sys, "argv", [*cli, "baseline", "17", "--ref", "b1", "--at", BEFORE, "--source", "chat"]
    )
    main()
    assert json.loads(capsys.readouterr().out)["estimated_remaining_usd"] == "49983.00"
    monkeypatch.setattr(sys, "argv", [*cli, "list"])
    main()
    history = json.loads(capsys.readouterr().out)
    assert len(history) == 1
    assert history[0]["amount_usd"] == "17.00" and history[0]["source"] == "chat"
    assert path.stat().st_mode & 0o077 == 0


def test_optional_web_snapshot_scoped_and_read_only(tmp_path):
    missing = tmp_path / "unconfigured" / "project-budget.sqlite3"
    assert read_snapshot(missing) is None
    assert not missing.parent.exists()
    # The URI-escaped filename ensures paths with query/fragment characters refer to the exact file.
    private = tmp_path / "private?#" / "project-budget.sqlite3"
    with ledger(private) as db:
        record(db, "baseline", "27.45", "b", BEFORE, "account owner")
    before = (private.read_bytes(), private.stat().st_mtime_ns)
    state = read_snapshot(private)
    assert state["estimated_remaining_usd"] == "49972.55"
    assert state["verified_supplier_usd"] is None
    assert (private.read_bytes(), private.stat().st_mtime_ns) == before
    assert list(private.parent.iterdir()) == [private]
    assert read_snapshot(missing) is None

    foreign = tmp_path / "operational.db"
    with sqlite3.connect(foreign) as db:
        db.execute("CREATE TABLE charges(id)")
    with pytest.raises(ValueError, match="开发额度账本"):
        read_snapshot(foreign)

"""Review development budget estimates in a local project ledger."""

import argparse
import json
import os
import re
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "project-budget.sqlite3"
MAX_BUDGET = "50000"
MICROS = 1_000_000
APP_ID = 0x45435042


def _micros(value: str) -> int:
    if not re.fullmatch(r"(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?", value, flags=re.ASCII):
        raise ValueError("美元金额应为非负十进制数，最多保留六位小数")
    return int(Decimal(value) * MICROS)


def _usd(amount: int) -> str:
    whole, fraction = divmod(abs(amount), MICROS)
    cents = f"{fraction:06}".rstrip("0").ljust(2, "0")
    return f"{'-' if amount < 0 else ''}{whole}.{cents}"


def _utc(value: str) -> str:
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("时间必须包含时区，例如 2026-11-20T09:00:00Z")
    return moment.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


@contextmanager
def ledger(path: Path) -> Iterator[sqlite3.Connection]:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    with closing(sqlite3.connect(path, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN IMMEDIATE")
        app_id = db.execute("PRAGMA application_id").fetchone()[0]
        if app_id == 0 and db.execute("SELECT 1 FROM sqlite_schema LIMIT 1").fetchone() is None:
            db.execute(f"PRAGMA application_id={APP_ID}")
            db.execute("""CREATE TABLE budget_entries (
                ref TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('baseline','estimate')),
                micros INTEGER NOT NULL CHECK(micros >= 0),
                effective_at TEXT NOT NULL, source TEXT NOT NULL, recorded_at TEXT NOT NULL
            )""")
            db.execute("""CREATE UNIQUE INDEX single_baseline
                          ON budget_entries(effective_at) WHERE kind='baseline'""")
        elif app_id != APP_ID:
            raise ValueError("指定路径已有其他数据库，请使用独立的项目预算文件")
        db.commit()
        yield db


def record(db, kind, amount, ref, at, source):
    if kind not in {"baseline", "estimate"} or not ref.strip() or not source.strip():
        raise ValueError("每笔记录需要类型、唯一编号和来源说明")
    values = (kind, _micros(amount), _utc(at), source.strip())
    ref = ref.strip()
    with db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT kind,micros,effective_at,source FROM budget_entries WHERE ref=?", (ref,)
        ).fetchone()
        if existing is not None:
            if tuple(existing) != values:
                raise ValueError("该编号已用于其他记录")
            return
        try:
            db.execute(
                "INSERT INTO budget_entries(ref,kind,micros,effective_at,source,recorded_at) VALUES(?,?,?,?,?,?)",
                (ref, *values, _utc(datetime.now(UTC).isoformat())),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("该时刻已有累计用量记录") from exc


def snapshot(db, limit=MAX_BUDGET, *, at=None):
    ceiling = _micros(limit)
    if ceiling > _micros(MAX_BUDGET):
        raise ValueError("额度上限为 50000 美元")
    cutoff = _utc(at or datetime.now(UTC).isoformat())
    # One ordered read keeps the baseline and estimates on a consistent SQLite snapshot.
    entries = db.execute(
        "SELECT * FROM budget_entries WHERE effective_at<=? ORDER BY effective_at,ref", (cutoff,)
    ).fetchall()
    baseline = next((row for row in reversed(entries) if row["kind"] == "baseline"), None)
    estimates = sum(
        row["micros"]
        for row in entries
        if row["kind"] == "estimate" and (baseline is None or row["effective_at"] > baseline["effective_at"])
    )
    total = baseline["micros"] + estimates if baseline is not None else None
    return {
        "as_of_utc": cutoff,
        "limit_usd": _usd(ceiling),
        "user_reported_cumulative_usd": _usd(baseline["micros"]) if baseline is not None else None,
        "baseline_ref": baseline["ref"] if baseline is not None else None,
        "baseline_as_of_utc": baseline["effective_at"] if baseline is not None else None,
        "post_baseline_estimates_usd": _usd(estimates),
        "estimated_total_usd": _usd(total) if total is not None else None,
        "estimated_remaining_usd": _usd(ceiling - total) if total is not None else None,
        "verified_supplier_usd": None,
    }


def read_snapshot(path: Path):
    """Read the optional ledger from the supplied workspace without creating it."""
    path = Path(path)
    if not path.exists():
        return None
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA application_id").fetchone()[0] != APP_ID:
            raise ValueError("指定文件并非开发额度账本")
        return snapshot(db)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--limit", default=MAX_BUDGET, help="项目额度（美元），最高 50000")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in [("baseline", "登记用户报告的累计用量"), ("estimate", "登记一笔增量估算")]:
        action = commands.add_parser(name, help=help_text)
        action.add_argument("amount", help="美元")
        action.add_argument("--ref", required=True, help="重试时沿用的唯一编号")
        action.add_argument("--at", required=True, help="金额对应时刻，须包含时区")
        action.add_argument("--source", required=True, help="累计用量来源或增量估算依据")
    commands.add_parser("status", help="查看当前估算").add_argument("--at", help="按指定时间查看")
    commands.add_parser("list", help="查看每一笔原始记录")
    args = parser.parse_args()
    try:
        with ledger(args.db) as db:
            # Validate the requested ceiling before recording anything.
            if _micros(args.limit) > _micros(MAX_BUDGET):
                raise ValueError("额度上限为 50000 美元")
            if args.command in {"baseline", "estimate"}:
                record(db, args.command, args.amount, args.ref, args.at, args.source)
            if args.command == "list":
                report = []
                for row in db.execute("SELECT * FROM budget_entries ORDER BY effective_at,ref"):
                    entry = dict(row)
                    entry["amount_usd"] = _usd(entry.pop("micros"))
                    report.append(entry)
            else:
                at = args.at if args.command == "status" else None
                report = snapshot(db, args.limit, at=at)
    except (ValueError, OSError, sqlite3.Error) as exc:
        parser.exit(1, str(exc) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

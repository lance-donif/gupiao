"""Chat Completions transport and a transactional USD spending ledger.

Run `python -m assistant.provider --help` to inspect and reconcile requests.
All ledger amounts use integer millionths of a dollar, rounded up on insertion.
"""

import argparse
import ipaddress
import json
import os
import sqlite3
import uuid
from contextlib import closing
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

import httpx

MICROS = 1_000_000
MAX_BUDGET = 50_000
MAX_BODY_CHARS = 240_000


def _number(raw, name, maximum):
    try:
        value = Decimal(str(raw))
        if not value.is_finite() or not 0 <= value <= maximum:
            raise ValueError
    except (ValueError, InvalidOperation):
        raise ValueError(f"{name} must be between 0 and {maximum}") from None
    return value


def _micro(dollars):
    return int((dollars * MICROS).to_integral_value(rounding=ROUND_CEILING))


def _tokens(name, default):
    text = os.getenv(name) or str(default)
    if not text.isascii() or not text.isdecimal() or not 1 <= int(text) <= 8_000_000:
        raise ValueError(f"Invalid {name}")
    return int(text)


def _local(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Provider:
    def __init__(self, db_path, *, transport=None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.transport = transport
        self.limit = int(
            _number(os.getenv("ASSISTANT_BUDGET_USD") or MAX_BUDGET, "ASSISTANT_BUDGET_USD", MAX_BUDGET)
            * MICROS
        )
        self.base = (os.getenv("MODEL_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        endpoint = urlsplit(self.base)
        self.local = _local(endpoint.hostname)
        if (
            not endpoint.hostname
            or endpoint.username is not None
            or endpoint.password is not None
            or endpoint.query
            or endpoint.fragment
            or endpoint.scheme not in (("http", "https") if self.local else ("https",))
        ):
            raise ValueError("MODEL_BASE_URL must be an HTTPS URL or a loopback URL")
        self.host = endpoint.hostname
        self.key = os.getenv("MODEL_API_KEY", "")
        self.model = os.getenv("MODEL_NAME", "").strip()
        self.output_limit = _tokens("MODEL_MAX_OUTPUT_TOKENS", 2048)
        self.billable_output_limit = _tokens("MODEL_BILLABLE_OUTPUT_CEILING_TOKENS", self.output_limit)
        if self.billable_output_limit < self.output_limit:
            raise ValueError("Billable output ceiling must cover MODEL_MAX_OUTPUT_TOKENS")
        self.token_field = os.getenv("MODEL_MAX_TOKENS_FIELD") or "max_completion_tokens"
        if self.token_field not in ("max_tokens", "max_completion_tokens"):
            raise ValueError("Invalid MODEL_MAX_TOKENS_FIELD")
        self.rates = [
            _number(os.getenv(name) or "0", name, 100_000)
            for name in ("MODEL_INPUT_USD_PER_MILLION", "MODEL_OUTPUT_USD_PER_MILLION")
        ]
        with closing(self._connect()) as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS model_charges (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    endpoint TEXT NOT NULL, model TEXT NOT NULL, reserved INTEGER NOT NULL,
                    input_rate TEXT NOT NULL, output_rate TEXT NOT NULL,
                    provider_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
                    estimated INTEGER, reconciled INTEGER, reference TEXT UNIQUE,
                    reconciled_at TEXT, outcome TEXT NOT NULL DEFAULT 'pending'
                )
            """)

    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    def _usage(self, db):
        return db.execute("""
            SELECT COALESCE(SUM(CASE WHEN reconciled IS NULL THEN estimated END),0) AS estimated,
                   COALESCE(SUM(reconciled),0) AS reconciled,
                   COALESCE(SUM(CASE WHEN reconciled IS NULL AND estimated IS NULL
                                 THEN reserved ELSE 0 END),0) AS held,
                   COUNT(CASE WHEN reconciled IS NULL AND estimated IS NULL THEN 1 END) AS pending
            FROM model_charges
        """).fetchone()

    def budget(self):
        with closing(self._connect()) as db:
            row = self._usage(db)
        booked = row["estimated"] + row["reconciled"]
        return {
            "currency": "USD",
            "accounting": "local",
            "limit": self.limit / MICROS,
            "booked": booked / MICROS,
            "estimated": row["estimated"] / MICROS,
            "reconciled": row["reconciled"] / MICROS,
            "held": row["held"] / MICROS,
            "free": max(0, self.limit - booked - row["held"]) / MICROS,
            "pending_requests": row["pending"],
        }

    def _cost(self, input_count, output_count):
        # Tokens times the USD-per-million price yields microdollars.
        amount = input_count * self.rates[0] + output_count * self.rates[1]
        return int(amount.to_integral_value(rounding=ROUND_CEILING))

    def _reserve(self, amount):
        entry = uuid.uuid4().hex
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._usage(db)
            if amount + row["estimated"] + row["reconciled"] + row["held"] > self.limit:
                raise RuntimeError("本次请求的费用预留超出剩余额度。")
            db.execute(
                """INSERT INTO model_charges
                (id, endpoint, model, reserved, input_rate, output_rate)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (entry, self.base, self.model, amount, *(str(rate) for rate in self.rates)),
            )
            db.commit()
        return entry

    def _record(self, entry, outcome, provider_id=None, usage=None):
        estimated = inputs = outputs = None
        if isinstance(usage, dict):
            inputs, outputs = usage.get("prompt_tokens"), usage.get("completion_tokens")
            if all(type(value) is int and 0 <= value <= 16_000_000 for value in (inputs, outputs)):
                estimated = self._cost(inputs, outputs)
                ticks = usage.get("cost_in_usd_ticks")
                if self.host == "api.x.ai" and type(ticks) is int and 0 <= ticks < 10**17:
                    # xAI reports 10^10 ticks per USD. Preserve asymmetric rounding.
                    estimated = (ticks + 9999) // 10000
            else:
                inputs = outputs = None
        if self.local and self.rates == [0, 0]:
            estimated = 0
        with closing(self._connect()) as db:
            db.execute(
                """UPDATE model_charges SET outcome=?, provider_id=?, input_tokens=?,
                output_tokens=?, estimated=? WHERE id=?""",
                (outcome, provider_id, inputs, outputs, estimated, entry),
            )

    def complete(self, messages, *, response_format=None):
        if not self.model:
            raise RuntimeError("请先配置 MODEL_NAME。")
        if not self.local and (not self.key or not all(self.rates)):
            raise RuntimeError("远程模型需要 MODEL_API_KEY 和输入、输出计费单价。")
        if self.host == "api.x.ai" and not os.getenv("MODEL_BILLABLE_OUTPUT_CEILING_TOKENS"):
            raise RuntimeError("xAI 需要设置覆盖推理用量的 MODEL_BILLABLE_OUTPUT_CEILING_TOKENS。")
        if (
            not isinstance(messages, list)
            or not messages
            or any(
                not isinstance(m, dict)
                or set(m) != {"role", "content"}
                or m["role"] not in ("user", "system", "assistant")
                or not isinstance(m["content"], str)
                for m in messages
            )
        ):
            raise ValueError("Invalid chat messages")
        params = {
            "model": self.model,
            "messages": messages,
            self.token_field: self.output_limit,
            "stream": False,
        }
        if response_format is not None:
            if not isinstance(response_format, dict) or response_format.get("type") != "json_schema":
                raise ValueError("Expected a json_schema response format")
            schema = response_format.get("json_schema")
            if not isinstance(schema, dict) or not isinstance(schema.get("schema"), dict):
                raise ValueError("Missing output JSON schema")
            params["response_format"] = response_format
        payload = json.dumps(params, ensure_ascii=False, separators=(",", ":"))
        if len(payload) > MAX_BODY_CHARS:
            raise ValueError("模型请求超过 240000 字符。")
        encoded = payload.encode("utf-8")
        # UTF-8 bytes conservatively cover byte-level tokenizers. Allow additional
        # provider chat-template framing and reserve the configured full output ceiling.
        input_ceiling = len(encoded) + 64 * len(messages) + 256
        entry = self._reserve(self._cost(input_ceiling, self.billable_output_limit))
        headers = {"Content-Type": "application/json", "X-Client-Request-Id": entry}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        try:
            with httpx.Client(
                transport=self.transport, timeout=httpx.Timeout(90, connect=10), trust_env=not self.local
            ) as client:
                response = client.post(self.base + "/chat/completions", content=encoded, headers=headers)
                response.raise_for_status()
        except httpx.HTTPError as error:
            status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else "network"
            self._record(entry, f"error:{status}")
            raise RuntimeError(f"模型调用失败（{status}），账本记录 {entry}。") from None
        data = None
        try:
            data = response.json()
            if not isinstance(data, dict):
                raise TypeError
            provider_id = data.get("id") or response.headers.get("x-request-id")
            if not isinstance(provider_id, str):
                provider_id = None
            choice = data["choices"][0]
            if choice.get("finish_reason") == "length":
                self._record(entry, "truncated", provider_id, data.get("usage"))
                raise RuntimeError("达到模型输出或上下文长度上限，回复不完整。请缩短任务或提高模型上限。")
            content = choice["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            self._record(
                entry,
                "invalid_response",
                response.headers.get("x-request-id"),
                data.get("usage") if isinstance(data, dict) else None,
            )
            raise RuntimeError(f"模型响应格式异常，账本记录 {entry}。") from None
        self._record(entry, "complete", provider_id, data.get("usage"))
        return content.strip()

    def reconcile(self, entry_id, amount, reference, *, recover_pending=False):
        actual = _number(amount, "amount", 100_000_000)
        if actual != actual.quantize(Decimal("0.000001")):
            raise ValueError("Use up to six decimal places")
        micros = _micro(actual)
        if not reference or not reference.strip() or len(reference) > 256:
            raise ValueError("Provide a unique billing line reference")
        reference = reference.strip()
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM model_charges WHERE id=?", (entry_id,)).fetchone()
            if not row:
                raise KeyError(entry_id)
            if row["reconciled"] == micros and row["reference"] == reference:
                return
            if row["reconciled"] is not None or (row["outcome"] == "pending" and not recover_pending):
                raise ValueError("Request already reconciled or potentially in flight")
            if db.execute("SELECT 1 FROM model_charges WHERE reference=?", (reference,)).fetchone():
                raise ValueError("Billing reference already used")
            db.execute(
                """UPDATE model_charges SET reconciled=?, reference=?,
                reconciled_at=CURRENT_TIMESTAMP WHERE id=?""",
                (micros, reference, entry_id),
            )
            db.commit()


def main():
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser(description="Inspect locally recorded model charges (USD)")
    parser.add_argument("--db", required=True)
    group = parser.add_subparsers(dest="command", required=True)
    group.add_parser("list")
    group.add_parser("status")
    check = group.add_parser("reconcile")
    check.add_argument("request_id")
    check.add_argument("amount_usd")
    check.add_argument("billing_line_reference")
    check.add_argument(
        "--recover-pending",
        action="store_true",
        help="Recover an interrupted dispatch. Stop workers and verify final billing first.",
    )
    args = parser.parse_args()
    path = Path(args.db).resolve()
    if not path.is_file():
        parser.exit(1, "Ledger database does not exist. Check ASSISTANT_DB.\n")
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
        if not db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_charges'"
        ).fetchone():
            parser.exit(1, "Selected database contains no model ledger.\n")
    provider = Provider(path)
    if args.command == "list":
        with closing(provider._connect()) as db:
            for row in db.execute("SELECT * FROM model_charges ORDER BY rowid"):
                print(json.dumps(dict(row), ensure_ascii=False))
    else:
        if args.command == "reconcile":
            provider.reconcile(
                args.request_id,
                args.amount_usd,
                args.billing_line_reference,
                recover_pending=args.recover_pending,
            )
        print(json.dumps(provider.budget()))


if __name__ == "__main__":
    main()

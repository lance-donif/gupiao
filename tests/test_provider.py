import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from assistant.provider import Provider
from assistant.search import WebSearch

CONFIG = {
    "MODEL_BASE_URL": "https://model.example/v1",
    "MODEL_API_KEY": "test",
    "MODEL_NAME": "test",
    "MODEL_INPUT_USD_PER_MILLION": "1",
    "MODEL_OUTPUT_USD_PER_MILLION": "2",
    "MODEL_MAX_OUTPUT_TOKENS": "10",
}
MESSAGES = [{"role": "user", "content": "你好"}]


def completion(request):
    return httpx.Response(
        200,
        json={
            "id": "r1",
            "usage": {"prompt_tokens": 3, "completion_tokens": 7},
            "choices": [{"message": {"content": "你好！"}}],
        },
    )


class ProviderTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db_path = Path(temp.name) / "new" / "app.db"
        env = patch.dict(os.environ, CONFIG, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def provider(self, handler=completion):
        return Provider(self.db_path, transport=httpx.MockTransport(handler))

    def test_truncation_stops_run_and_accounts_usage(self):
        def handler(req):
            body = completion(req).json()
            body["choices"][0]["finish_reason"] = "length"
            return httpx.Response(200, json=body)

        model = self.provider(handler)
        with self.assertRaisesRegex(RuntimeError, "长度上限"):
            model.complete(MESSAGES)
        self.assertEqual(model.budget()["estimated"], 0.000017)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT outcome FROM model_charges").fetchone(), ("truncated",))

    def test_transport_and_reconciliation(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://model.example/v1/chat/completions")
            self.assertEqual(request.headers["authorization"], "Bearer test")
            self.assertEqual(json.loads(request.content)["max_completion_tokens"], 10)
            return completion(request)

        model = self.provider(handler)
        self.assertEqual(model.complete(MESSAGES), "你好！")
        self.assertEqual(model.budget()["estimated"], 0.000017)
        with sqlite3.connect(self.db_path) as db:
            entry = db.execute("SELECT id FROM model_charges").fetchone()[0]
        for _ in range(2):
            model.reconcile(entry, "0.010000", "invoice:1")
        status = self.provider().budget()
        self.assertEqual(status["booked"], 0.01)
        self.assertEqual(status["reconciled"], 0.01)
        self.assertEqual(status["estimated"], 0)
        self.assertEqual(status["free"], 49999.99)
        with self.assertRaises(ValueError):
            model.reconcile(entry, 1, "invoice:2")

    def test_structured_response_format_dispatched_only_on_request(self):
        schema = {
            "type": "json_schema",
            "json_schema": {
                "name": "answer",
                "strict": True,
                "schema": {"type": "object", "properties": {"text": {"type": "string"}}},
            },
        }
        received = []

        def handler(req):
            received.append(json.loads(req.content))
            return completion(req)

        model = self.provider(handler)
        model.complete(MESSAGES)
        model.complete(MESSAGES, response_format=schema)
        self.assertNotIn("response_format", received[0])
        self.assertEqual(received[1]["response_format"], schema)

    def test_failed_call_retains_hold_and_missing_credentials_never_dispatch(self):
        def handler(request):
            raise httpx.ReadTimeout("timeout", request=request)

        model = self.provider(handler)
        with self.assertRaisesRegex(RuntimeError, "network"):
            model.complete(MESSAGES)
        self.assertGreater(model.budget()["held"], 0)
        self.assertEqual(model.budget()["pending_requests"], 1)
        os.environ.pop("MODEL_API_KEY")
        with self.assertRaisesRegex(RuntimeError, "MODEL_API_KEY"):
            self.provider().complete(MESSAGES)
        self.assertEqual(model.budget()["pending_requests"], 1)

    def test_reservation_is_atomic_across_clients(self):
        os.environ["ASSISTANT_BUDGET_USD"] = "0.00065"
        ready = threading.Event()
        finish = threading.Event()
        result = []

        def first(request):
            ready.set()
            if not finish.wait(10):
                raise TimeoutError
            return completion(request)

        first_model = self.provider(first)
        thread = threading.Thread(target=lambda: result.append(first_model.complete(MESSAGES)))
        thread.start()
        try:
            self.assertTrue(ready.wait(5))
            second_model = self.provider()
            self.assertGreater(second_model.budget()["held"], 0)
            with self.assertRaisesRegex(RuntimeError, "剩余额度"):
                second_model.complete(MESSAGES)
        finally:
            finish.set()
            thread.join(5)
        self.assertEqual(result, ["你好！"])
        self.assertEqual(first_model.budget()["held"], 0)

    def test_no_usage_keeps_hold_and_invalid_data_fails(self):
        def incomplete(request):
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        model = self.provider(incomplete)
        self.assertEqual(model.complete(MESSAGES), "ok")
        self.assertGreater(model.budget()["held"], 0)
        model = self.provider(lambda req: httpx.Response(200, content=b"bogus"))
        with self.assertRaisesRegex(RuntimeError, "格式异常"):
            model.complete(MESSAGES)
        self.assertEqual(model.budget()["pending_requests"], 2)

    def test_limits_and_local_transport(self):
        model = self.provider()
        with self.assertRaises(ValueError):
            model.complete([{"role": "user", "content": "大" * 240000}])
        self.assertEqual(model.budget()["pending_requests"], 0)
        with patch.dict(
            os.environ,
            {
                "MODEL_BASE_URL": "http://127.0.0.1:8080/v1",
                "MODEL_NAME": "llama",
                "ASSISTANT_BUDGET_USD": "0",
            },
            clear=True,
        ):
            model = self.provider()
            self.assertEqual(model.complete(MESSAGES), "你好！")
            self.assertEqual(model.budget()["booked"], 0)
        with patch.dict(os.environ, {"ASSISTANT_BUDGET_USD": "50000.01"}), self.assertRaises(ValueError):
            self.provider()

    def test_xai_requires_total_ceiling_and_uses_reported_cost(self):
        os.environ["MODEL_BASE_URL"] = "https://api.x.ai/v1"
        with self.assertRaisesRegex(RuntimeError, "CEILING"):
            self.provider().complete(MESSAGES)
        os.environ["MODEL_BILLABLE_OUTPUT_CEILING_TOKENS"] = "100000"

        def handler(req):
            data = completion(req).json()
            data["usage"]["cost_in_usd_ticks"] = 343456
            return httpx.Response(200, json=data)

        model = self.provider(handler)
        model.complete(MESSAGES)
        self.assertEqual(model.budget()["estimated"], 0.000035)

    def test_wikipedia_and_searxng(self):
        def wiki(req):
            self.assertEqual(req.url.params["srsearch"], "测试")
            return httpx.Response(
                200,
                json={"query": {"search": [{"title": "百科", "pageid": 42, "snippet": "科<span>学</span>"}]}},
            )

        self.assertEqual(
            WebSearch(transport=httpx.MockTransport(wiki))("测试"),
            [{"title": "百科", "snippet": "科学", "url": "https://zh.wikipedia.org/?curid=42"}],
        )
        os.environ["SEARXNG_BASE_URL"] = "https://internal.test"

        def searx(req):
            self.assertEqual(req.url.path, "/search")
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"title": "bad", "url": "javascript:alert(1)"},
                        {"title": "good", "url": "https://example.org", "content": "a &amp; b"},
                    ]
                },
            )

        self.assertEqual(
            WebSearch(transport=httpx.MockTransport(searx))("测试"),
            [{"title": "good", "snippet": "a & b", "url": "https://example.org"}],
        )

    def test_failed_search(self):
        search = WebSearch(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
        with self.assertRaisesRegex(RuntimeError, "检索失败"):
            search("测试")


class ProjectCostsTests(unittest.TestCase):
    def test_readonly_paginated_billing_with_precise_dollars(self):
        from datetime import date

        from assistant.billing import project_costs

        def page(request):
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.host, "api.openai.com")
            self.assertEqual(request.url.params["project_ids"], "proj_example")
            self.assertEqual(request.headers["Authorization"], "Bearer admin-test")
            second = "page" in request.url.params
            start = 86400 if second else 0
            payload = {
                "data": [
                    {
                        "start_time": start,
                        "end_time": start + 86400,
                        "results": [
                            {"project_id": "proj_example", "amount": {"currency": "usd", "value": 0.00019}}
                        ],
                    }
                ],
                "has_more": not second,
                "next_page": None if second else "next",
            }
            return httpx.Response(200, json=payload)

        report = project_costs(
            "proj_example",
            date(1970, 1, 1),
            date(1970, 1, 3),
            "admin-test",
            transport=httpx.MockTransport(page),
        )
        self.assertEqual(report["provider_reported_usd"], "0.00038")
        self.assertEqual(len(report["buckets"]), 2)

    def test_refuses_other_projects_and_missing_credentials(self):
        from datetime import date

        from assistant.billing import project_costs

        dates = (date(1970, 1, 1), date(1970, 1, 2))
        with self.assertRaisesRegex(ValueError, "OPENAI_ADMIN_KEY"):
            project_costs("proj_example", *dates, "")
        page = {
            "data": [
                {
                    "start_time": 0,
                    "end_time": 86400,
                    "results": [{"project_id": "proj_wrong", "amount": {"currency": "usd", "value": 8}}],
                }
            ],
            "has_more": False,
        }
        with self.assertRaisesRegex(RuntimeError, "verify"):
            project_costs(
                "proj_example",
                *dates,
                "admin-test",
                transport=httpx.MockTransport(lambda req: httpx.Response(200, json=page)),
            )


class WikiTopicTests(unittest.TestCase):
    def test_chinese_question_uses_topic_then_original_on_empty(self):
        question = "什么是量子纠缠？请用通俗的语言解释一下。"
        queries = []

        def page(req):
            queries.append(req.url.params["srsearch"])
            return httpx.Response(200, json={"query": {"search": []}})

        with patch.dict(os.environ, {"SEARXNG_BASE_URL": ""}):
            with self.assertLogs("assistant.search", "INFO") as logs:
                self.assertEqual(WebSearch(transport=httpx.MockTransport(page))(question), [])
            self.assertEqual(queries, ["量子纠缠", question])
            self.assertNotIn("量子", logs.output[0])


class ArticleReadTests(unittest.TestCase):
    def test_extracts_only_for_search_results_from_official_api(self):
        seen = []

        def handler(req):
            self.assertEqual(req.url.host, "zh.wikipedia.org")
            self.assertEqual(req.url.path, "/w/api.php")
            if req.url.params.get("prop") == "extracts":
                self.assertEqual(req.url.params["pageids"], "42")
                seen.append("lead")
                return httpx.Response(200, json={"query": {"pages": {"42": {"extract": "正文。 " * 400}}}})
            seen.append("search")
            return httpx.Response(
                200, json={"query": {"search": [{"title": "量子", "snippet": "摘要", "pageid": 42}]}}
            )

        with patch.dict(os.environ, {"SEARXNG_BASE_URL": ""}):
            search = WebSearch(transport=httpx.MockTransport(handler))
            row = search("量子")[0]
            for url in ("https://example.net/wiki", "https://zh.wikipedia.org/?curid=7"):
                other = {**row, "url": url}
                self.assertEqual(search.read(other), other)
            richer = search.read(row)
            self.assertEqual(richer["url"], row["url"])
            self.assertTrue(richer["snippet"].startswith("正文。"))
            self.assertEqual(len(richer["snippet"]), 1200)
            self.assertEqual(seen, ["search", "lead"])
            resumed = WebSearch(transport=httpx.MockTransport(handler))
            self.assertEqual(resumed.read_checkpoint(row), richer)
            impostor = {**row, "url": "https://example.net/?curid=42"}
            self.assertEqual(resumed.read_checkpoint(impostor), impostor)
            self.assertEqual(seen, ["search", "lead", "lead"])
        with patch.dict(os.environ, {"SEARXNG_BASE_URL": "https://search.example"}):
            search = WebSearch(transport=httpx.MockTransport(handler))
            self.assertEqual(search.read(row), row)
            self.assertEqual(seen, ["search", "lead", "lead"])

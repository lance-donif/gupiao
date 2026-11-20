"""HTTP boundaries, sandboxed DOM extraction, and optional dependency handling."""

import os
import shutil
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import httpx
import pytest

from assistant import browser_reader as reader

ROW = {"url": "https://zh.wikipedia.org/?curid=7", "title": "条目", "snippet": "搜索摘录"}


@pytest.fixture
def public_origin(monkeypatch):
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("208.80.154.224", 443))]
    )


@pytest.mark.parametrize(
    "url",
    [
        None,
        "https://zh.wikipedia.org/wiki/咖啡",
        "https://zh.wikipedia.org:443/?curid=7",
        "http://127.0.0.1/?curid=7",
        "https://zh.wikipedia.org/?curid=7&next=start",
        "https://zh.wikipedia.org/?curid=0",
        "https://zh.wikipedia.org/?curid=7#x",
        "https://operator@zh.wikipedia.org/?curid=7",
    ],
)
def test_requires_canonical_id_before_fetch(monkeypatch, url):
    monkeypatch.setattr(reader, "_article_html", lambda *_: pytest.fail("unexpected fetch"))
    with pytest.raises(ValueError, match="条目编号"):
        reader.read_wikipedia({"url": url})


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "::1", "fe80::123"])
def test_rejects_nonpublic_wiki_resolution(monkeypatch, address):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [(0, 0, 0, "", (address, 443))])
    with pytest.raises(RuntimeError, match="地址解析异常"):
        reader.read_wikipedia(ROW, transport=httpx.MockTransport(lambda _: pytest.fail("unexpected fetch")))


def test_api_origin_is_fixed_and_checks_identity(public_origin, monkeypatch):
    html = '<div class="mw-parser-output"><p>百科正文。</p></div>'

    def get(request):
        assert request.method == "GET"
        assert request.url.host == "zh.wikipedia.org"
        assert request.url.path == "/w/api.php"
        assert request.url.params["pageid"] == "7"
        assert request.url.params["action"] == "parse"
        assert "cookie" not in request.headers and "authorization" not in request.headers
        return httpx.Response(200, json={"parse": {"pageid": 7, "title": "条目正文", "text": html}})

    def extract(document):
        assert document == html
        return "百科正文。"

    monkeypatch.setattr(reader, "_extract", extract)
    result = reader.read_wikipedia(ROW, transport=httpx.MockTransport(get))
    assert result == {"url": ROW["url"], "title": "条目正文", "snippet": "百科正文。"}


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"location": "https://unrelated.example/article"}),
        httpx.Response(200, text="<html>error</html>"),
        httpx.Response(200, json={"error": {"code": "missingtitle"}}),
        httpx.Response(200, json={"parse": {"pageid": 8, "title": "错误", "text": "<p>资料</p>"}}),
        httpx.Response(200, headers={"content-type": "application/json"}, content=b"x" * 400),
    ],
)
def test_http_errors_stop_before_chromium(public_origin, monkeypatch, response):
    calls = []

    def request(url):
        calls.append(url)
        return response

    monkeypatch.setattr(reader, "MAX_RESPONSE", 256)
    monkeypatch.setattr(reader, "_extract", lambda *_: pytest.fail("unexpected browser launch"))
    with pytest.raises(RuntimeError):
        reader.read_wikipedia(ROW, transport=httpx.MockTransport(request))
    assert len(calls) == 1


def test_real_offline_chromium_extracts_text_without_subrequests(monkeypatch):
    p = pytest.importorskip("playwright.sync_api")
    executable = os.getenv("RESEARCH_CHROMIUM_PATH") or shutil.which("chromium")
    if executable:
        monkeypatch.setenv("RESEARCH_CHROMIUM_PATH", executable)
    else:
        with p.sync_playwright() as playwright:
            if not Path(playwright.chromium.executable_path).exists():
                pytest.skip("Chromium executable not installed")
    requests = []

    class Observer(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(204)
            self.end_headers()

    with ThreadingHTTPServer(("127.0.0.1", 0), Observer) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        host = f"http://127.0.0.1:{server.server_port}"
        html = (
            '<div class="mw-parser-output"><aside><p>菜单</p></aside>'
            f'<img src="{host}/picture"><iframe src="{host}/embedded"></iframe>'
            '<p>百科文章<sup>1</sup>。</p><script>document.querySelector("p").remove()</script>'
            "<p>进一步阅读。</p><p>" + "文" * 1500 + "</p></div>"
        )
        try:
            result = reader._extract(html)
            assert result.startswith("百科文章。 进一步阅读。 ")
            assert len(result) == 1200
            assert not requests
            with pytest.raises(RuntimeError, match="正文段落"):
                reader._extract("<div>no article</div>")
        finally:
            server.shutdown()
            worker.join()

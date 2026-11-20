"""Read public Chinese Wikipedia article HTML in a fresh, offline Chromium context."""

import ipaddress
import json
import os
import re
import socket
import time

import httpx

ARTICLE = re.compile(r"https://zh\.wikipedia\.org/\?curid=([1-9][0-9]{0,15})")
WIKI_HOST = "zh.wikipedia.org"
API = f"https://{WIKI_HOST}/w/api.php"
DOCUMENT = "https://article.invalid/"
MAX_RESPONSE = 4 * 1024 * 1024
MAX_SNIPPET = 1200
HEADERS = {
    "User-Agent": "EchoResearch/1.0 (https://github.com/lance-donif/gupiao; public article reader)",
    "Accept": "application/json",
    "Accept-Encoding": "identity",
}
POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox"
# Run this local expression only. Never evaluate code from the article or from a model.
_EXTRACT = """(maxLength) => {
    const article = document.querySelector(".mw-parser-output");
    if (!article) return "";
    for (const node of article.querySelectorAll(
        "sup, script, style, template, table, nav, aside, figure, form, .hatnote, .navbox, .metadata, .noprint"
    )) node.remove();
    const parts = [];
    let length = 0;
    for (const paragraph of article.querySelectorAll("p")) {
        const text = (paragraph.textContent || "").replace(/\\s+/g, " ").trim();
        if (text) {
            parts.push(text);
            length += text.length + 1;
        }
        if (length >= maxLength) break;
    }
    return parts.join(" ").slice(0, maxLength);
}"""


def _public_origin():
    # The client always uses the literal API origin. A deployment with an egress
    # proxy also relies on that administrator-controlled proxy for upstream DNS and TLS.
    try:
        entries = socket.getaddrinfo(WIKI_HOST, 443, type=socket.SOCK_STREAM)
        addresses = [ipaddress.ip_address(entry[4][0]) for entry in entries]
    except (OSError, ValueError):
        raise RuntimeError("无法解析中文维基百科的公开地址") from None
    if not addresses or any(not ip.is_global or ip.is_multicast for ip in addresses):
        raise RuntimeError("中文维基百科地址解析异常")


def _article_html(page_id, transport):
    _public_origin()
    params = {
        "action": "parse",
        "pageid": page_id,
        "prop": "text",
        "format": "json",
        "formatversion": 2,
        "disableeditsection": 1,
    }
    try:
        with httpx.Client(
            transport=transport,
            headers=HEADERS,
            timeout=10,
            follow_redirects=False,
        ) as client:
            deadline = time.monotonic() + 20
            with client.stream("GET", API, params=params) as response:
                if response.status_code != 200:
                    raise RuntimeError(f"获取维基百科正文失败（HTTP {response.status_code}）")
                if (
                    response.headers.get("content-type", "").split(";")[0].strip().lower()
                    != "application/json"
                ):
                    raise RuntimeError("维基百科正文响应类型无效")
                payload = bytearray()
                for part in response.iter_bytes(chunk_size=65536):
                    if len(payload) + len(part) > MAX_RESPONSE or time.monotonic() > deadline:
                        raise RuntimeError("维基百科正文超出读取限制")
                    payload.extend(part)
        parsed = json.loads(payload)["parse"]
        if type(parsed["pageid"]) is not int or str(parsed["pageid"]) != page_id:
            raise ValueError
        title, html = parsed["title"], parsed["text"]
        if not isinstance(title, str) or not title.strip() or not isinstance(html, str) or not html.strip():
            raise ValueError
        return title.strip()[:200], html
    except (httpx.HTTPError, KeyError, TypeError, ValueError, RecursionError):
        raise RuntimeError("未能获取指定维基百科条目的 HTML 正文") from None


def _extract(html):
    try:
        from playwright.sync_api import Error, sync_playwright
    except ImportError:
        raise RuntimeError("Chromium 阅读器缺少 Playwright，请按 docs/browser.md 安装可选依赖") from None

    try:
        with (
            sync_playwright() as playwright,
            playwright.chromium.launch(
                chromium_sandbox=True,
                executable_path=os.getenv("RESEARCH_CHROMIUM_PATH") or None,
                args=["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
                timeout=10000,
            ) as browser,
        ):
            context = browser.new_context(
                java_script_enabled=False,
                service_workers="block",
                accept_downloads=False,
                offline=True,
                permissions=[],
                locale="zh-CN",
            )
            try:
                page = context.new_page()
                served = False

                def route(request):
                    nonlocal served
                    resource = request.request
                    if (
                        not served
                        and resource.url == DOCUMENT
                        and resource.method == "GET"
                        and resource.is_navigation_request()
                        and resource.frame == page.main_frame
                    ):
                        served = True
                        request.fulfill(
                            status=200,
                            body=html,
                            headers={
                                "Content-Type": "text/html; charset=utf-8",
                                "Content-Security-Policy": POLICY,
                                "X-DNS-Prefetch-Control": "off",
                                "Referrer-Policy": "no-referrer",
                            },
                        )
                    else:
                        request.abort()

                context.route("**/*", route)
                page.goto(DOCUMENT, wait_until="domcontentloaded", timeout=8000)
                # Reading the static DOM via the automation protocol works with page scripts disabled.
                result = page.evaluate(_EXTRACT, MAX_SNIPPET)
            finally:
                context.close()
        if not isinstance(result, str) or not result.strip():
            raise RuntimeError("浏览器未找到可阅读的维基百科正文段落")
        return result.strip()
    except (Error, OSError):
        raise RuntimeError("Chromium 阅读失败，请检查浏览器安装及进程沙箱权限") from None


def read_wikipedia(source, *, transport=None):
    url = source.get("url") if isinstance(source, dict) else None
    match = ARTICLE.fullmatch(url) if isinstance(url, str) else None
    if not match:
        raise ValueError("浏览器只读取中文维基百科的公开条目编号")
    title, html = _article_html(match.group(1), transport)
    return {"url": url, "title": title, "snippet": _extract(html)}

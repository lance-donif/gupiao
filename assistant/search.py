"""Public research via Chinese Wikipedia or a configured SearXNG instance."""

import logging
import os
import re
from collections import deque
from html.parser import HTMLParser
from threading import Lock
from urllib.parse import urlencode, urlsplit

import httpx

WIKI_API = "https://zh.wikipedia.org/w/api.php"
HEADERS = {"User-Agent": "GuAssistant/1.0 (research; github.com/lance-donif/gupiao)"}


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def _plain(value, maximum):
    if not isinstance(value, str):
        return ""
    parser = _PlainText()
    parser.feed(value)
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()[:maximum]


def _web_link(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
        return ""
    try:
        url = urlsplit(value)
        if (
            url.scheme in ("http", "https")
            and url.hostname
            and url.username is None
            and url.password is None
            and "\\" not in value
        ):
            return value
    except ValueError:
        pass
    return ""


def _wiki_query(query):
    # Encyclopedia search indexes article topics. Remove common conversational
    # wrappers while preserving the terms, relationships, and names in the question.
    topic = re.sub(r"^(?:请问|请教一下|请帮我|请|帮我)\s*", "", query)
    topic = re.sub(r"^(?:用通俗(?:的)?(?:语言|话)|简单地?|详细地?)\s*", "", topic)
    topic = re.sub(r"^(?:什么是|什么叫做?|介绍|解释|说明|讲讲|查查|科普)(?:一下)?\s*", "", topic)
    topic = re.split(r"[？?。！!\n]", topic, maxsplit=1)[0]
    topic = re.sub(r"(?:是什么|是怎么回事|(?:的)?(?:基本原理|定义|含义))$", "", topic)
    topic = topic.strip(" ，,:：。“”《》")
    return topic if 2 <= len(topic) <= 100 else query


class WebSearch:
    def __init__(self, *, transport=None):
        self.transport = transport
        self._recent_pages = deque(maxlen=512)
        self._pages_lock = Lock()
        self.searx = os.getenv("SEARXNG_BASE_URL", "").rstrip("/")
        if self.searx and not _web_link(self.searx):
            raise ValueError("Invalid SEARXNG_BASE_URL")

    def __call__(self, query):
        if not isinstance(query, str) or not query.strip() or len(query.strip()) > 1000:
            raise ValueError("检索问题须为 1 至 1000 个字符。")
        query = query.strip()
        if self.searx:
            endpoint = self.searx + "/search"
            params = {"q": query, "format": "json", "safesearch": "1"}
        else:
            endpoint = WIKI_API
            params = {
                "action": "query",
                "list": "search",
                "srsearch": _wiki_query(query),
                "srlimit": "5",
                "format": "json",
                "utf8": "1",
            }
        try:
            with httpx.Client(
                transport=self.transport,
                timeout=12,
                headers=HEADERS,
            ) as client:
                response = client.get(endpoint, params=params)
                response.raise_for_status()
                body = response.json()
                rows = body["results"] if self.searx else body["query"]["search"]
                if not self.searx and rows == [] and params["srsearch"] != query:
                    response = client.get(endpoint, params={**params, "srsearch": query})
                    response.raise_for_status()
                    rows = response.json()["query"]["search"]
            if not isinstance(rows, list):
                raise TypeError
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise RuntimeError("联网检索失败，请检查检索服务。") from None
        sources = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            title = _plain(row.get("title"), 200)
            if self.searx:
                link = _web_link(row.get("url"))
                snippet = _plain(row.get("content"), 800)
            else:
                page = row.get("pageid")
                link = (
                    f"https://zh.wikipedia.org/?{urlencode({'curid': page})}"
                    if type(page) is int and page > 0
                    else ""
                )
                snippet = _plain(row.get("snippet"), 800)
            if title and link and link not in seen:
                seen.add(link)
                sources.append({"title": title, "url": link, "snippet": snippet})
            if len(sources) == 5:
                break
        if not sources:
            logging.getLogger(__name__).info(
                "Research returned no sources (backend=%s)", "searxng" if self.searx else "wikipedia"
            )
        if not self.searx:
            with self._pages_lock:
                self._recent_pages.extend(item["url"] for item in sources)
        return sources

    def read(self, source):
        """Read the lead of a page returned by this instance's Wikipedia search."""
        with self._pages_lock:
            if source.get("url") not in self._recent_pages:
                return source
        return self.read_checkpoint(source)

    def read_checkpoint(self, source):
        """Read a server-stored search result after a worker restart via the fixed wiki API."""
        if self.searx:
            return source
        link = source.get("url", "")
        match = re.fullmatch(r"https://zh\.wikipedia\.org/\?curid=([1-9][0-9]{0,15})", link)
        if not match:
            return source
        if os.getenv("RESEARCH_READER", "api") == "chromium":
            from .browser_reader import read_wikipedia

            return read_wikipedia(source, transport=self.transport)
        page_id = match.group(1)
        params = {
            "action": "query",
            "prop": "extracts",
            "pageids": page_id,
            "exintro": 1,
            "explaintext": 1,
            "exchars": 1200,
            "format": "json",
        }
        try:
            with httpx.Client(transport=self.transport, timeout=12, headers=HEADERS) as client:
                response = client.get(WIKI_API, params=params)
                response.raise_for_status()
                pages = response.json()["query"]["pages"]
                # A page may have been deleted after it appeared in search.
                page = pages.get(page_id, {})
                intro = page.get("extract", "")
                if not isinstance(intro, str):
                    raise TypeError
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            raise RuntimeError("读取维基百科条目正文失败。") from None
        excerpt = re.sub(r"\s+", " ", intro).strip()[:1200]
        return {**source, "snippet": excerpt or source["snippet"]}

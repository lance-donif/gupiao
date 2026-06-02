#!/usr/bin/env python3
"""
Generate API documentation for the active backend surface.

Background:
- The legacy backend under server/ (FastAPI/Celery) is retired.
- The active backend surface is the TypeScript "HTTP shell" under backend/src/http/.
- There is currently no authoritative OpenAPI artifact emitted by the new HTTP shell.

Default behavior:
- Generate docs by scanning backend/src/http/index.ts for route guards.
- If that file is missing, write a clear "manual/retired" stub and exit 0.

This script must not default to reading server/openapi.json.

Usage:
  python3 scripts/generate_api_docs.py
  python3 scripts/generate_api_docs.py --output docs/api-reference.md
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


BEIJING_TZ = timezone(timedelta(hours=8))


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    match: str  # exact|prefix
    notes: str


class RouteIndex:
    """
    Simple in-memory index (data structure) that deduplicates routes by (method, path, match).
    """

    def __init__(self) -> None:
        self._routes: dict[tuple[str, str, str], Route] = {}

    def add(self, route: Route) -> None:
        key = (route.method.upper(), route.path, route.match)
        self._routes[key] = route

    def extend(self, routes: Iterable[Route]) -> None:
        for route in routes:
            self.add(route)

    def to_sorted_list(self) -> list[Route]:
        return sorted(self._routes.values(), key=lambda r: (r.path, r.method, r.match))


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate API docs for the backend HTTP shell.")
    parser.add_argument("--output", default="docs/api-reference.md")
    return parser.parse_args(argv)


def _scan_http_shell_routes(ts_path: Path) -> list[Route]:
    content = ts_path.read_text(encoding="utf-8")
    lines = content.splitlines()

    exact_re = re.compile(r"if \(method === '([A-Z]+)' && url\.pathname === '([^']+)'\) \{")
    prefix_re = re.compile(r"if \(method === '([A-Z]+)' && url\.pathname\.startsWith\('([^']+)'\)\) \{")

    routes: list[Route] = []

    def guess_notes(block: list[str]) -> str:
        joined = "\n".join(block)
        if "/health" in joined:
            return "健康检查 (returns { ok: true, now: <Beijing ISO> })."
        if "readRequestBody" in joined and "JSON.parse" in joined:
            keys = sorted(set(re.findall(r"body\\.([a-zA-Z0-9_]+)", joined)))
            if keys:
                return "JSON request body keys: " + ", ".join(f"`{k}`" for k in keys) + "."
            return "Accepts JSON request body."
        if "url.searchParams.get" in joined:
            params = sorted(set(re.findall(r"url\\.searchParams\\.get\\('([^']+)'\\)", joined)))
            if params:
                return "Query params: " + ", ".join(f"`{p}`" for p in params) + "."
        return ""

    # Naive block capture: look ahead a small window for hints.
    window = 30
    for idx, line in enumerate(lines):
        exact_match = exact_re.search(line)
        if exact_match:
            method, path = exact_match.group(1), exact_match.group(2)
            block = lines[idx : min(len(lines), idx + window)]
            routes.append(Route(method=method, path=path, match="exact", notes=guess_notes(block)))
            continue

        prefix_match = prefix_re.search(line)
        if prefix_match:
            method, prefix = prefix_match.group(1), prefix_match.group(2)
            block = lines[idx : min(len(lines), idx + window)]
            routes.append(Route(method=method, path=f"{prefix}*", match="prefix", notes=guess_notes(block)))
            continue

    # Hard-coded derived route: /api/batches/latest/:groupId/progress is implemented inside the "latest" handler.
    routes.append(
        Route(
            method="GET",
            path="/api/batches/latest/:groupId/progress",
            match="derived",
            notes="Progress view for latest batch of a group (derived from /api/batches/latest/* handler).",
        )
    )
    return routes


def _render_http_shell_docs(*, routes: list[Route]) -> str:
    now = datetime.now(BEIJING_TZ).isoformat()
    lines: list[str] = []
    lines.append("# API Reference")
    lines.append("")
    lines.append(f"**Generated (Beijing/UTC+8):** {now}")
    lines.append("")
    lines.append("This document is generated from the TypeScript backend HTTP shell route table.")
    lines.append("")
    lines.append("## Backend HTTP Shell")
    lines.append("")
    lines.append("- Source of truth: `backend/src/http/index.ts`")
    lines.append("- Default dev port in code: `8787`")
    lines.append("- Local dev convention (for web proxy compatibility): run with `PORT=8000`")
    lines.append("")
    lines.append("## Endpoints")
    lines.append("")
    for route in routes:
        match_note = f" ({route.match})" if route.match != "exact" else ""
        lines.append(f"### `{route.method.upper()} {route.path}`{match_note}")
        if route.notes:
            lines.append("")
            lines.append(route.notes)
        lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append("- OpenAPI is not emitted by the HTTP shell at the moment; docs are generated by source scanning.")
    lines.append("- If you need a formal spec, maintain it manually in docs or add a spec emitter in backend (future work).")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    root_dir = Path(__file__).resolve().parents[1]
    http_shell_ts = root_dir / "backend" / "src" / "http" / "index.ts"

    if http_shell_ts.exists():
        index = RouteIndex()
        index.extend(_scan_http_shell_routes(http_shell_ts))
        doc = _render_http_shell_docs(routes=index.to_sorted_list())
        output_path.write_text(doc, encoding="utf-8")
        print(f"[generate_api_docs] wrote: {output_path}")
        return 0

    # No new source: write a clear stub and succeed (generate_docs.py must not fail the whole docs run).
    stub = "\n".join(
        [
            "# API Reference",
            "",
            f"**Generated (Beijing/UTC+8):** {datetime.now(BEIJING_TZ).isoformat()}",
            "",
            "API docs generation is currently **retired** for OpenAPI-based sources.",
            "",
            "The active backend is the TypeScript HTTP shell under `backend/src/http/`, but the route source file",
            "was not found at generation time, so this document is a stub.",
            "",
            "Action items:",
            "- Ensure `backend/src/http/index.ts` exists in this checkout.",
            "- Or maintain API docs manually under docs/ until the backend emits a formal spec.",
            "",
        ]
    )
    output_path.write_text(stub, encoding="utf-8")
    print(f"[generate_api_docs] wrote stub: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""
Format code in the repository.

Current backend is TypeScript under backend/. The legacy Python backend under server/
is retired and is intentionally not formatted here.

What this script does:
1. Python (repo-level): best-effort Black/Ruff on root *.py + scripts/*.py
2. backend/: ESLint (supports --fix)
3. web/: Prettier (via npm scripts)

Usage:
  python3 scripts/format_code.py [--check]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol


class RunMode(str, Enum):
    CHECK = "check"
    FIX = "fix"


@dataclass(frozen=True)
class StepResult:
    name: str
    ok: bool


class Formatter(Protocol):
    name: str

    def run(self, *, mode: RunMode, root_dir: Path) -> StepResult: ...


def _run(cmd: list[str], *, cwd: Path, title: str) -> bool:
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)
    print("cwd:", str(cwd))
    print("cmd:", " ".join(cmd))
    completed = subprocess.run(cmd, cwd=str(cwd), check=False)
    return completed.returncode == 0


def _collect_python_targets(root_dir: Path) -> list[Path]:
    # Deterministic ordering helps debugging + makes output stable.
    targets: list[Path] = []
    targets.extend(sorted(root_dir.glob("*.py")))
    targets.extend(sorted((root_dir / "scripts").glob("*.py")))
    # Deduplicate while preserving order (stable set).
    seen: set[Path] = set()
    out: list[Path] = []
    for path in targets:
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out


class PythonRepoFormatter:
    name = "python(repo)"

    def run(self, *, mode: RunMode, root_dir: Path) -> StepResult:
        targets = _collect_python_targets(root_dir)
        if not targets:
            print("[python] no targets found, skipping")
            return StepResult(self.name, True)

        # Keep the script best-effort: if a tool isn't installed, skip it instead of failing the whole run.
        black_ok = True
        try:
            black_cmd = ["python3", "-m", "black", "--check" if mode == RunMode.CHECK else ""]
            black_cmd = [c for c in black_cmd if c]
            black_ok = _run(black_cmd + [str(p) for p in targets], cwd=root_dir, title="Python: Black")
        except Exception as exc:  # noqa: BLE001
            print("[python] black unavailable or failed to launch:", str(exc))
            black_ok = True

        ruff_ok = True
        try:
            ruff_cmd = ["python3", "-m", "ruff", "check"]
            if mode == RunMode.FIX:
                ruff_cmd.append("--fix")
            ruff_ok = _run(ruff_cmd + [str(p) for p in targets], cwd=root_dir, title="Python: Ruff")
        except Exception as exc:  # noqa: BLE001
            print("[python] ruff unavailable or failed to launch:", str(exc))
            ruff_ok = True

        return StepResult(self.name, black_ok and ruff_ok)


class BackendFormatter:
    name = "backend(eslint)"

    def run(self, *, mode: RunMode, root_dir: Path) -> StepResult:
        backend_dir = root_dir / "backend"
        if not (backend_dir / "package.json").exists():
            print("[backend] backend/ not found, skipping")
            return StepResult(self.name, True)
        cmd = ["pnpm", "--dir", str(backend_dir), "lint"]
        if mode == RunMode.FIX:
            cmd.extend(["--", "--fix"])
        ok = _run(cmd, cwd=root_dir, title="Backend: ESLint")
        return StepResult(self.name, ok)


class WebFormatter:
    name = "web(prettier)"

    def run(self, *, mode: RunMode, root_dir: Path) -> StepResult:
        web_dir = root_dir / "web"
        if not (web_dir / "package.json").exists():
            print("[web] web/ not found, skipping")
            return StepResult(self.name, True)
        script = "format:check" if mode == RunMode.CHECK else "format"
        ok = _run(["npm", "--prefix", str(web_dir), "run", script], cwd=root_dir, title="Web: Prettier")
        return StepResult(self.name, ok)


def _parse_args(argv: list[str]) -> RunMode:
    parser = argparse.ArgumentParser(description="Format code for backend/web + repo-level python scripts.")
    parser.add_argument("--check", action="store_true", help="Check only (no writes)")
    args = parser.parse_args(argv)
    return RunMode.CHECK if args.check else RunMode.FIX


def main(argv: list[str]) -> int:
    mode = _parse_args(argv)
    root_dir = Path(__file__).resolve().parents[1]

    print("[format_code] root_dir:", str(root_dir))
    print("[format_code] mode:", mode.value)

    steps: list[Formatter] = [
        PythonRepoFormatter(),
        BackendFormatter(),
        WebFormatter(),
    ]

    results: list[StepResult] = [step.run(mode=mode, root_dir=root_dir) for step in steps]

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    failures = 0
    for result in results:
        status = "OK" if result.ok else "FAIL"
        print(f"{status:>4}  {result.name}")
        if not result.ok:
            failures += 1

    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


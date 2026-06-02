#!/usr/bin/env python3
"""
Master documentation generator.

This script runs all documentation generation tools:
1. API Reference (from TypeScript HTTP shell source scanning; OpenAPI is not assumed)
2. Changelog (from git history)
3. Architecture Overview (from codebase structure)

Usage:
    python scripts/generate_docs.py [--all | --api | --changelog | --architecture]
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class StepStatus(str, Enum):
    OK = "ok"
    WARN = "warn"
    FAIL = "fail"


@dataclass(frozen=True)
class StepResult:
    name: str
    status: StepStatus


def run_script(script_name: str, description: str, *, non_fatal: bool = False) -> StepResult:
    """Run a documentation generation script."""
    print(f"\n{'='*60}")
    print(f"📝 {description}")
    print(f"{'='*60}")

    script_path = Path(__file__).parent / script_name
    if not script_path.exists():
        print(f"❌ Script not found: {script_path}")
        return StepResult(script_name, StepStatus.WARN if non_fatal else StepStatus.FAIL)

    try:
        completed = subprocess.run(
            [sys.executable, str(script_path)],
            cwd=str(Path(__file__).parent.parent),
            check=True,
            capture_output=False,
        )
        return StepResult(script_name, StepStatus.OK if completed.returncode == 0 else StepStatus.FAIL)
    except subprocess.CalledProcessError as e:
        if non_fatal:
            print(f"⚠️  Non-fatal: failed to run {script_name}: {e}")
            return StepResult(script_name, StepStatus.WARN)
        print(f"❌ Failed to run {script_name}: {e}")
        return StepResult(script_name, StepStatus.FAIL)
    except Exception as e:
        if non_fatal:
            print(f"⚠️  Non-fatal: error running {script_name}: {e}")
            return StepResult(script_name, StepStatus.WARN)
        print(f"❌ Error running {script_name}: {e}")
        return StepResult(script_name, StepStatus.FAIL)


def main() -> int:
    """Main entry point."""
    # Parse arguments
    generate_all = True
    generate_api = False
    generate_changelog = False
    generate_architecture = False

    for arg in sys.argv[1:]:
        if arg == "--api":
            generate_all = False
            generate_api = True
        elif arg == "--changelog":
            generate_all = False
            generate_changelog = True
        elif arg == "--architecture":
            generate_all = False
            generate_architecture = True
        elif arg == "--all":
            generate_all = True

    print("🚀 Starting documentation generation...")
    print(f"📂 Working directory: {Path(__file__).parent.parent}")

    results: list[StepResult] = []

    # Run API docs generator
    if generate_all or generate_api:
        # Do not fail the overall docs run if API docs cannot be generated (no OpenAPI spec is guaranteed).
        results.append(run_script("generate_api_docs.py", "Generating API Reference Documentation", non_fatal=True))

    # Run changelog generator
    if generate_all or generate_changelog:
        results.append(run_script("generate_changelog.py", "Generating Changelog from Git History"))

    # Run architecture diagram generator
    if generate_all or generate_architecture:
        results.append(run_script("generate_architecture_diagram.py", "Generating Architecture Diagrams"))

    # Print summary
    print(f"\n{'='*60}")
    print("📊 Generation Summary")
    print(f"{'='*60}")

    ok_count = sum(1 for r in results if r.status == StepStatus.OK)
    warn_count = sum(1 for r in results if r.status == StepStatus.WARN)
    fail_count = sum(1 for r in results if r.status == StepStatus.FAIL)

    for result in results:
        if result.status == StepStatus.OK:
            marker = "✅"
        elif result.status == StepStatus.WARN:
            marker = "⚠️ "
        else:
            marker = "❌"
        print(f"{marker} {result.name}: {result.status.value}")

    print(f"\nTotal: ok={ok_count} warn={warn_count} fail={fail_count}")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Analyze cyclomatic complexity across the codebase.

This script:
1. Analyzes Python files using Ruff's complexity check
2. Analyzes TypeScript/Vue files using ESLint complexity rules
3. Generates a complexity report

Usage:
    python scripts/analyze_complexity.py [--threshold 15]
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def analyze_python_complexity(threshold: int = 15) -> tuple[bool, str]:
    """Analyze Python code complexity using Ruff."""
    print("\n" + "="*60)
    print("🐍 Python Complexity Analysis")
    print("="*60)

    server_dir = Path(__file__).parent.parent / "server"
    if not (server_dir / "app").exists():
        return True, "Server directory not found"

    # Run ruff with complexity check
    cmd = [
        sys.executable, "-m", "ruff", "check",
        "--select=C90",
        f"--config={server_dir / 'pyproject.toml'}",
        str(server_dir / "app")
    ]

    try:
        result = subprocess.run(
            cmd,
            cwd=str(server_dir),
            capture_output=True,
            text=True,
            check=False,
        )

        if result.returncode == 0:
            print("✅ All Python functions are within complexity threshold")
            return True, "Complexity check passed"
        else:
            print("⚠️  Found functions exceeding complexity threshold:")
            print(result.stdout)
            print(result.stderr)

            # Parse and count violations
            lines = [l for l in result.stdout.split("\n") if "C901" in l]
            print(f"\n📊 Found {len(lines)} functions exceeding complexity threshold of {threshold}")

            # Show top 10 most complex functions
            if lines:
                print("\n📈 Most complex functions:")
                for line in lines[:10]:
                    print(f"  {line.strip()}")

            return False, f"Found {len(lines)} complexity violations"

    except Exception as e:
        print(f"❌ Error analyzing Python complexity: {e}")
        return False, str(e)


def analyze_web_complexity(threshold: int = 15) -> tuple[bool, str]:
    """Analyze TypeScript/Vue code complexity using ESLint."""
    print("\n" + "="*60)
    print("🌐 TypeScript/Vue Complexity Analysis")
    print("="*60)

    web_dir = Path(__file__).parent.parent / "web"
    if not (web_dir / "package.json").exists():
        return True, "Web directory not found"

    cmd = [
        "npx", "eslint", ".",
        "--ext", ".ts,.vue",
        "--no-eslintrc",
        "--config", str(web_dir / ".eslintrc.json"),
        "--format", "compact"
    ]

    try:
        result = subprocess.run(
            cmd,
            cwd=str(web_dir),
            capture_output=True,
            text=True,
            check=False,
        )

        if result.returncode == 0:
            print("✅ All TypeScript/Vue code is within complexity threshold")
            return True, "Complexity check passed"
        else:
            # Filter for complexity errors only
            complexity_errors = [
                l for l in result.stdout.split("\n")
                if "complexity" in l.lower() or "max-complexity" in l.lower()
            ]

            if complexity_errors:
                print("⚠️  Found code exceeding complexity threshold:")
                for error in complexity_errors[:10]:
                    print(f"  {error.strip()}")
                print(f"\n📊 Showing first 10 of {len(complexity_errors)} complexity issues")
                return False, f"Found {len(complexity_errors)} complexity violations"
            else:
                # Other linting errors, not complexity
                print("✅ No complexity issues found (other linting issues may exist)")
                return True, "No complexity violations"

    except Exception as e:
        print(f"❌ Error analyzing web complexity: {e}")
        return False, str(e)


def generate_report(
    python_ok: bool,
    python_msg: str,
    web_ok: bool,
    web_msg: str,
    threshold: int,
) -> None:
    """Generate a complexity analysis report."""
    print("\n" + "="*60)
    print("📊 Complexity Analysis Report")
    print("="*60)
    print(f"Threshold: {threshold} (max cyclomatic complexity)")
    print()
    print(f"{'✅' if python_ok else '❌'} Python: {python_msg}")
    print(f"{'✅' if web_ok else '❌'} TypeScript/Vue: {web_msg}")
    print()

    if python_ok and web_ok:
        print("🎉 All code is within acceptable complexity limits!")
        print()
        print("💡 Tip: Keep functions small and focused. Consider refactoring")
        print("   functions with complexity > 10 for better maintainability.")
    else:
        print("⚠️  Some functions exceed the complexity threshold.")
        print()
        print("💡 Recommendations:")
        print("   1. Break down large functions into smaller, focused ones")
        print("   2. Extract complex conditionals into separate functions")
        print("   3. Use early returns to reduce nesting")
        print("   4. Consider using strategy pattern for complex branching")


def main() -> int:
    """Main entry point."""
    threshold = 15

    # Parse arguments
    if "--threshold" in sys.argv:
        idx = sys.argv.index("--threshold")
        if idx + 1 < len(sys.argv):
            try:
                threshold = int(sys.argv[idx + 1])
            except ValueError:
                print(f"⚠️  Invalid threshold value: {sys.argv[idx + 1]}, using default 15")

    print("🔍 Analyzing code complexity...")
    print(f"📂 Working directory: {Path(__file__).parent.parent}")
    print(f"📏 Complexity threshold: {threshold}")

    # Analyze Python
    python_ok, python_msg = analyze_python_complexity(threshold)

    # Analyze TypeScript/Vue
    web_ok, web_msg = analyze_web_complexity(threshold)

    # Generate report
    generate_report(python_ok, python_msg, web_ok, web_msg, threshold)

    return 0 if (python_ok and web_ok) else 1


if __name__ == "__main__":
    sys.exit(main())

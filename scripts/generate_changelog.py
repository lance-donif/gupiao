#!/usr/bin/env python3
"""
Auto-generate changelog from git history.

This script:
1. Parses git commit history
2. Groups commits by type (feat, fix, docs, etc.)
3. Generates a formatted changelog in CHANGELOG.md

Usage:
    python scripts/generate_changelog.py [--since "2024-01-01"] [--output CHANGELOG.md]
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def get_git_log(since: str | None = None) -> list[dict]:
    """Get git log entries with commit hash, date, and message."""
    cmd = ["git", "log", "--pretty=format:%H|%ad|%s|%b", "--date=short"]
    if since:
        cmd.extend(["--since", since])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        lines = result.stdout.strip().split("\n")

        commits = []
        for line in lines:
            if not line.strip():
                continue
            parts = line.split("|", 3)
            if len(parts) >= 3:
                commits.append(
                    {
                        "hash": parts[0][:7],
                        "date": parts[1],
                        "subject": parts[2],
                        "body": parts[3] if len(parts) > 3 else "",
                    }
                )
        return commits
    except subprocess.CalledProcessError as e:
        print(f"Error getting git log: {e}")
        return []


def parse_commit_message(subject: str, body: str) -> dict:
    """Parse conventional commit message to extract type and scope."""
    # Pattern: type(scope): description or type: description
    pattern = r"^(?P<type>feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\((?P<scope>[^)]+)\))?:\s*(?P<description>.+)$"
    match = re.match(pattern, subject, re.IGNORECASE)

    if match:
        return {
            "type": match.group("type").lower(),
            "scope": match.group("scope"),
            "description": match.group("description"),
            "is_conventional": True,
        }
    else:
        # Try to infer type from keywords
        subject_lower = subject.lower()
        if any(kw in subject_lower for kw in ["add", "new", "create", "implement"]):
            commit_type = "feat"
        elif any(kw in subject_lower for kw in ["fix", "bug", "patch", "resolve"]):
            commit_type = "fix"
        elif any(kw in subject_lower for kw in ["doc", "readme", "comment"]):
            commit_type = "docs"
        elif any(kw in subject_lower for kw in ["refactor", "restructure", "rename"]):
            commit_type = "refactor"
        elif any(kw in subject_lower for kw in ["test", "spec"]):
            commit_type = "test"
        elif any(kw in subject_lower for kw in ["perf", "optim", "speed"]):
            commit_type = "perf"
        else:
            commit_type = "chore"

        return {
            "type": commit_type,
            "scope": None,
            "description": subject,
            "is_conventional": False,
        }


def group_commits_by_version(commits: list[dict]) -> dict[str, list[dict]]:
    """Group commits by approximate version (month-based for now)."""
    versions = defaultdict(list)

    for commit in commits:
        # Use YYYY-MM as version identifier
        date_str = commit.get("date", "unknown")
        if date_str and date_str != "unknown":
            # Group by month
            version = date_str[:7]  # YYYY-MM
        else:
            version = "unreleased"

        versions[version].append(commit)

    return dict(sorted(versions.items(), reverse=True))


def generate_changelog_entry(commit: dict) -> str:
    """Generate a single changelog entry."""
    parsed = parse_commit_message(commit["subject"], commit.get("body", ""))

    type_emojis = {
        "feat": "✨",
        "fix": "🐛",
        "docs": "📚",
        "style": "💅",
        "refactor": "♻️",
        "perf": "⚡",
        "test": "✅",
        "build": "📦",
        "ci": "👷",
        "chore": "🔧",
        "revert": "⏪",
    }

    emoji = type_emojis.get(parsed["type"], "📝")
    description = parsed["description"]
    commit_hash = commit["hash"]

    return f"- {emoji} {description} ([{commit_hash}](https://github.com/lance-donif/gupiao/commit/{commit_hash}))"


def generate_changelog(commits: list[dict]) -> str:
    """Generate complete changelog markdown."""
    lines = []
    lines.append("# Changelog")
    lines.append("")
    lines.append("All notable changes to this project will be documented in this file.")
    lines.append("")
    lines.append("This changelog is auto-generated from git commit history.")
    lines.append("")
    lines.append("---")
    lines.append("")

    if not commits:
        lines.append("*No commits found.*")
        return "\n".join(lines)

    # Group commits by version
    versions = group_commits_by_version(commits)

    for version, version_commits in versions.items():
        if version == "unreleased":
            lines.append("## [Unreleased]")
        else:
            # Try to get a date for the version
            first_commit = version_commits[-1] if version_commits else None
            if first_commit:
                date_str = first_commit.get("date", "")
                lines.append(f"## [{version}] - {date_str}")
            else:
                lines.append(f"## [{version}]")

        lines.append("")

        # Group by type
        by_type = defaultdict(list)
        for commit in version_commits:
            parsed = parse_commit_message(commit["subject"], commit.get("body", ""))
            by_type[parsed["type"]].append(commit)

        # Output in order
        type_order = ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "revert"]
        type_titles = {
            "feat": "🚀 Features",
            "fix": "🐛 Bug Fixes",
            "docs": "📚 Documentation",
            "refactor": "♻️ Code Refactoring",
            "perf": "⚡ Performance Improvements",
            "test": "✅ Tests",
            "build": "📦 Build System",
            "ci": "👷 CI/CD",
            "chore": "🔧 Chores",
            "revert": "⏪ Reverts",
        }

        for commit_type in type_order:
            if commit_type not in by_type:
                continue

            commits_of_type = by_type[commit_type]
            lines.append(f"### {type_titles.get(commit_type, commit_type.title())}")
            lines.append("")

            for commit in commits_of_type:
                lines.append(generate_changelog_entry(commit))

            lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*This changelog was auto-generated by `scripts/generate_changelog.py`*")

    return "\n".join(lines)


def main() -> int:
    """Main entry point."""
    output_path = "CHANGELOG.md"
    since_date = None

    # Parse arguments
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--since" and i + 1 < len(args):
            since_date = args[i + 1]
            i += 2
        elif args[i].startswith("--since="):
            since_date = args[i].split("=", 1)[1]
            i += 1
        elif args[i] == "--output" and i + 1 < len(args):
            output_path = args[i + 1]
            i += 2
        elif args[i].startswith("--output="):
            output_path = args[i].split("=", 1)[1]
            i += 1
        else:
            i += 1

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    print(f"📝 Generating changelog...")
    if since_date:
        print(f"📅 Fetching commits since {since_date}")

    # Get git log
    commits = get_git_log(since_date)

    if not commits:
        print("⚠️  No commits found")
        return 1

    print(f"✅ Found {len(commits)} commits")

    # Generate changelog
    markdown_changelog = generate_changelog(commits)

    # Write output
    output_file.write_text(markdown_changelog, encoding="utf-8")
    print(f"✅ Changelog written to {output_file}")

    # Print summary
    versions = group_commits_by_version(commits)
    print(f"📊 Organized into {len(versions)} version(s)")

    return 0


if __name__ == "__main__":
    sys.exit(main())

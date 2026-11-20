"""Read provider-reported costs for a dedicated OpenAI project and UTC time window."""

import argparse
import json
import os
import re
from datetime import UTC, date, datetime, time
from decimal import Decimal

import httpx

COSTS_URL = "https://api.openai.com/v1/organization/costs"


def project_costs(project, start, end, admin_key, *, transport=None):
    """Read all cost buckets. Preserve source precision and verify project scope."""
    if not admin_key:
        raise ValueError("Set OPENAI_ADMIN_KEY for this command")
    if not isinstance(project, str) or not re.fullmatch(r"proj_[A-Za-z0-9_-]+", project):
        raise ValueError("Provide the dedicated OpenAI project ID")
    if end <= start:
        raise ValueError("End date (exclusive) must follow start date")

    def timestamp(day):
        return int(datetime.combine(day, time.min, tzinfo=UTC).timestamp())

    params = {
        "start_time": timestamp(start),
        "end_time": timestamp(end),
        "bucket_width": "1d",
        "project_ids": project,
        "group_by": "project_id",
        "limit": 180,
    }
    total = Decimal(0)
    cursors = set()
    buckets = {}
    response_ids = []
    try:
        with httpx.Client(transport=transport, timeout=25, follow_redirects=False) as client:
            while True:
                response = client.get(
                    COSTS_URL, params=params, headers={"Authorization": f"Bearer {admin_key}"}
                )
                response.raise_for_status()
                payload = json.loads(response.content, parse_float=Decimal)
                if not isinstance(payload["data"], list) or type(payload["has_more"]) is not bool:
                    raise ValueError("Invalid billing page")
                if request_id := response.headers.get("x-request-id"):
                    response_ids.append(request_id)
                for row in payload["data"]:
                    begin, finish = row["start_time"], row["end_time"]
                    if (
                        type(begin) is not int
                        or type(finish) is not int
                        or not params["start_time"] <= begin < finish <= params["end_time"]
                        or begin in buckets
                        or not isinstance(row["results"], list)
                    ):
                        raise ValueError("Invalid billing bucket")
                    subtotal = Decimal(0)
                    for result in row["results"]:
                        amount = result["amount"]
                        if (
                            result["project_id"] != project
                            or amount["currency"] != "usd"
                            or type(amount["value"]) not in (Decimal, int)
                        ):
                            raise ValueError("Mismatched project, currency, or amount")
                        subtotal += amount["value"]
                    buckets[begin] = {"start": begin, "end": finish, "amount_usd": str(subtotal)}
                    total += subtotal
                if not payload["has_more"]:
                    break
                cursor = payload["next_page"]
                if not isinstance(cursor, str) or not cursor or cursor in cursors:
                    raise ValueError("Invalid billing cursor")
                cursors.add(cursor)
                params["page"] = cursor
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        raise RuntimeError("Could not verify OpenAI project costs: " + type(exc).__name__) from None

    return {
        "source": COSTS_URL,
        "project_id": project,
        "from_utc": str(start),
        "until_utc_exclusive": str(end),
        "fetched_at_utc": datetime.now(UTC).isoformat(),
        "provider_reported_usd": str(total),
        "request_ids": response_ids,
        "buckets": [buckets[key] for key in sorted(buckets)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", required=True, type=date.fromisoformat, help="Exclusive UTC date")
    args = parser.parse_args()
    try:
        report = project_costs(args.project, args.start, args.end, os.getenv("OPENAI_ADMIN_KEY"))
    except (RuntimeError, ValueError) as exc:
        parser.exit(1, str(exc) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

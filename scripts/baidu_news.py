"""Public Baidu economic calendar, with an explicit Beijing date and no cookie bootstrap."""
from datetime import datetime, timedelta, timezone
import math
import re
import time

import pandas as pd
import requests

BEIJING = timezone(timedelta(hours=8))
URL = "https://finance.pae.baidu.com/sapi/v1/financecalendar"
FIELD_NAMES = {
    "date": "日期", "time": "时间", "country": "国家", "region": "地区",
    "title": "事件", "timePeriod": "统计周期", "pubVal": "公布",
    "indicateVal": "预期", "formerVal": "前值", "star": "重要性",
}


def news_economic_baidu(date: str | None = None) -> pd.DataFrame:
    date = date or datetime.now(BEIJING).strftime("%Y%m%d")
    if not re.fullmatch(r"\d{8}", date):
        raise ValueError("date must be YYYYMMDD")
    day = datetime.strptime(date, "%Y%m%d").strftime("%Y-%m-%d")
    deadline = time.monotonic() + 7
    page = 0
    pages = 1
    rows = []
    while page < pages:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Baidu calendar source timeout")
        response = requests.get(
            URL,
            params={"start_date": day, "end_date": day, "pn": str(page),
                    "rn": "100", "cate": "economic_data", "finClientType": "pc"},
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            timeout=(min(3, remaining), min(5, remaining)),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("ResultCode") not in (0, "0"):
            raise ValueError("Invalid Baidu calendar result code")
        result = payload.get("Result")
        calendars = result.get("calendarInfo") if isinstance(result, dict) else None
        if not isinstance(calendars, list):
            raise ValueError("Invalid Baidu calendar response")
        matching = [item for item in calendars if isinstance(item, dict) and item.get("date") == day]
        if page == 0:
            total = sum(int(item.get("total", 0)) for item in matching)
            if total < 0:
                raise ValueError("Invalid Baidu calendar total")
            pages = max(1, math.ceil(total / 100))
        for item in matching:
            records = item.get("list", [])
            if not isinstance(records, list) or any(not isinstance(row, dict) for row in records):
                raise ValueError("Invalid Baidu calendar records")
            rows.extend(row for row in records if row.get("date") == day)
        page += 1
    frame = pd.DataFrame(rows).reindex(columns=list(FIELD_NAMES)).rename(columns=FIELD_NAMES)
    for column in ["公布", "预期", "前值", "重要性"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame

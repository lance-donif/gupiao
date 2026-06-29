"""Minimal AKTools-compatible HTTP wrapper for local integration.

This server exposes the subset of /api/public/* endpoints used by the
TypeScript backend. It delegates to installed akshare functions and returns
plain JSON arrays matching AKTools response shape.
"""

from __future__ import annotations

import math
from datetime import date, datetime, time
from typing import Any, Callable

import akshare as ak
import pandas as pd
import requests
from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="gupiao-aktools-compat", version="0.1.0")


STOCK_CHANGE_TYPES = [
    "火箭发射",
    "快速反弹",
    "大笔买入",
    "封涨停板",
    "打开跌停板",
    "有大买盘",
    "竞价上涨",
    "高开5日线",
    "向上缺口",
    "60日新高",
    "60日大幅上涨",
    "加速下跌",
    "高台跳水",
    "大笔卖出",
    "封跌停板",
    "打开涨停板",
    "有大卖盘",
    "竞价下跌",
    "低开5日线",
    "向下缺口",
    "60日新低",
    "60日大幅下跌",
]

EASTMONEY_CLIST_HOSTS = [
    "https://17.push2.eastmoney.com",
    "https://79.push2.eastmoney.com",
    "https://29.push2.eastmoney.com",
    "https://push2.eastmoney.com",
]

EASTMONEY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/center/boardlist.html",
}


def fetch_stock_changes_em(symbol: str | None = None) -> pd.DataFrame:
    symbols = [symbol] if symbol else STOCK_CHANGE_TYPES
    frames: list[pd.DataFrame] = []
    for item in symbols:
        frame = ak.stock_changes_em(symbol=item)
        if "异动类型" not in frame.columns:
            frame = frame.copy()
            frame["异动类型"] = item
        frames.append(frame)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def fetch_eastmoney_clist(params: dict[str, str]) -> list[dict[str, Any]]:
    errors: list[str] = []
    for host in EASTMONEY_CLIST_HOSTS:
        try:
            response = requests.get(
                f"{host}/api/qt/clist/get",
                params=params,
                headers=EASTMONEY_HEADERS,
                timeout=12,
            )
            response.raise_for_status()
            payload = response.json()
            rows = payload.get("data", {}).get("diff", [])
            if isinstance(rows, list):
                return rows
            errors.append(f"{host}: unexpected payload")
        except Exception as exc:  # noqa: BLE001 - expose upstream fallback failures in 502 body
            errors.append(f"{host}: {exc}")
    raise RuntimeError("; ".join(errors))


def fetch_board_names(board_type: str) -> pd.DataFrame:
    params = {
        "pn": "1",
        "pz": "5000",
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3" if board_type == "industry" else "f12",
        "fs": "m:90 t:2 f:!50" if board_type == "industry" else "m:90 t:3 f:!50",
        "fields": "f12,f14,f3,f62,f128,f136",
    }
    records = fetch_eastmoney_clist(params)
    return pd.DataFrame(
        {
            "排名": index + 1,
            "板块名称": row.get("f14"),
            "板块代码": row.get("f12"),
            "涨跌幅": row.get("f3"),
            "主力净流入": row.get("f62"),
            "领涨股票": row.get("f128"),
            "领涨股票-涨跌幅": row.get("f136"),
        }
        for index, row in enumerate(records)
    )


def resolve_board_code(symbol: str, board_type: str) -> str:
    if symbol.startswith("BK"):
        return symbol
    boards = fetch_board_names(board_type)
    matched = boards[boards["板块名称"] == symbol]
    if matched.empty:
        raise ValueError(f"unknown {board_type} board: {symbol}")
    return str(matched.iloc[0]["板块代码"])


def fetch_board_constituents(symbol: str, board_type: str) -> pd.DataFrame:
    board_code = resolve_board_code(symbol, board_type)
    params = {
        "pn": "1",
        "pz": "5000",
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3" if board_type == "industry" else "f12",
        "fs": f"b:{board_code} f:!50",
        "fields": "f12,f14,f2,f3,f4,f5,f6,f7,f8,f9,f15,f16,f17,f18",
    }
    records = fetch_eastmoney_clist(params)
    return pd.DataFrame(
        {
            "序号": index + 1,
            "代码": row.get("f12"),
            "名称": row.get("f14"),
            "最新价": row.get("f2"),
            "涨跌幅": row.get("f3"),
            "涨跌额": row.get("f4"),
            "成交量": row.get("f5"),
            "成交额": row.get("f6"),
            "振幅": row.get("f7"),
            "换手率": row.get("f8"),
            "市盈率-动态": row.get("f9"),
            "最高": row.get("f15"),
            "最低": row.get("f16"),
            "今开": row.get("f17"),
            "昨收": row.get("f18"),
        }
        for index, row in enumerate(records)
    )


def stock_board_industry_name_em() -> pd.DataFrame:
    return fetch_board_names("industry")


def stock_board_industry_cons_em(symbol: str = "小金属") -> pd.DataFrame:
    return fetch_board_constituents(symbol, "industry")


def stock_board_concept_name_em() -> pd.DataFrame:
    return fetch_board_names("concept")


def stock_board_concept_cons_em(symbol: str = "融资融券") -> pd.DataFrame:
    return fetch_board_constituents(symbol, "concept")


ENDPOINTS: dict[str, Callable[..., pd.DataFrame]] = {
    "stock_info_a_code_name": ak.stock_info_a_code_name,
    "stock_info_global_em": ak.stock_info_global_em,
    "stock_info_global_cls": ak.stock_info_global_cls,
    "stock_info_global_ths": ak.stock_info_global_ths,
    "news_economic_baidu": ak.news_economic_baidu,
    "stock_board_industry_name_em": stock_board_industry_name_em,
    "stock_board_industry_cons_em": stock_board_industry_cons_em,
    "stock_board_concept_name_em": stock_board_concept_name_em,
    "stock_board_concept_cons_em": stock_board_concept_cons_em,
    "stock_board_change_em": ak.stock_board_change_em,
    "stock_changes_em": fetch_stock_changes_em,
    "stock_individual_info_em": ak.stock_individual_info_em,
    "stock_zh_a_hist": ak.stock_zh_a_hist,
    "stock_zh_a_spot_em": ak.stock_zh_a_spot_em,
}


def to_json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if hasattr(value, "item"):
        return to_json_value(value.item())
    return value


def dataframe_to_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for raw in frame.to_dict(orient="records"):
        records.append({str(key): to_json_value(value) for key, value in raw.items()})
    return records


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/public/{endpoint}")
def public_endpoint(endpoint: str, request: Request) -> list[dict[str, Any]]:
    fetcher = ENDPOINTS.get(endpoint)
    if fetcher is None:
        raise HTTPException(status_code=404, detail=f"Unsupported endpoint: {endpoint}")

    try:
        frame = fetcher(**dict(request.query_params))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"akshare fetch failed: {exc}") from exc

    if not isinstance(frame, pd.DataFrame):
        raise HTTPException(status_code=502, detail=f"akshare returned non-DataFrame for {endpoint}")

    return dataframe_to_records(frame)

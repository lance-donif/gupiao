"""Summarize UTF-8 CSV. The container worker executes this file directly."""

import csv
import io
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
import uuid
from decimal import Decimal, InvalidOperation, localcontext

MAX_INPUT = 24 * 1024
MAX_OUTPUT = 512 * 1024
MAX_ROWS = 4096
MAX_COLUMNS = 256
MAX_CELL_CHARS = 2048
WORKER_TIMEOUT = 20
NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]


def _input(content):
    if not isinstance(content, str) or len(content) > MAX_INPUT or "\x00" in content:
        raise ValueError("需要 24 KiB 以内的 UTF-8 CSV 文本")
    try:
        data = content.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("CSV 必须是 UTF-8 文本") from exc
    if len(data) > MAX_INPUT:
        raise ValueError("CSV 超过 24 KiB")
    return data


def _decimal(text):
    if not NUMBER.fullmatch(text):
        return None
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError("CSV 数值超出支持的精度或指数范围") from exc
    parts = number.as_tuple()
    if len(parts.digits) > 256 or abs(parts.exponent) > 256:
        raise ValueError("CSV 数值最多 256 位有效数字，小数指数范围为 -256 至 256")
    return number


def _display(number):
    if number is None:
        return None
    if number == 0:
        return "0"
    normalized = number.normalize()
    return format(normalized, "f") if -20 <= normalized.adjusted() <= 30 else str(normalized)


def _summarize(content):
    reader = csv.reader(io.StringIO(content.removeprefix("\ufeff"), newline=""), strict=True)
    header = next((row for row in reader if row), None)
    if not header or not 1 <= len(header) <= MAX_COLUMNS:
        raise ValueError("CSV 必须有表头，最多 256 列")
    if any(len(name) > MAX_CELL_CHARS for name in header):
        raise ValueError("CSV 表头过长")
    columns = [
        {
            "name": name.strip() or f"列{i}",
            "numeric_count": 0,
            "empty_count": 0,
            "other_count": 0,
            "sum": None,
            "min": None,
            "max": None,
        }
        for i, name in enumerate(header, 1)
    ]
    rows = 0
    with localcontext() as context:
        # Worst-case accepted sum spans 768 decimal places plus four carry digits.
        context.prec = 1024
        for row in reader:
            if not row:
                continue
            rows += 1
            if rows > MAX_ROWS or len(row) > len(columns):
                raise ValueError("CSV 超过 4096 行，或数据行列数多于表头")
            for i, column in enumerate(columns):
                cell = row[i] if i < len(row) else ""
                if len(cell) > MAX_CELL_CHARS:
                    raise ValueError("CSV 单元格最多 2048 个字符")
                text = cell.strip()
                if not text:
                    column["empty_count"] += 1
                    continue
                number = _decimal(text)
                if number is None:
                    column["other_count"] += 1
                    continue
                column["numeric_count"] += 1
                if column["sum"] is None:
                    column.update(sum=number, min=number, max=number)
                else:
                    column["sum"] += number
                    column["min"] = min(column["min"], number)
                    column["max"] = max(column["max"], number)
        for column in columns:
            if column["numeric_count"]:
                column["kind"] = "mixed" if column["other_count"] else "number"
                for key in ("sum", "min", "max"):
                    column[key] = _display(column[key])
            else:
                column["kind"] = "text" if column["other_count"] else "empty"
    return {"row_count": rows, "column_count": len(columns), "columns": columns}


def _parse(content):
    try:
        return _summarize(content)
    except csv.Error as exc:
        raise ValueError("CSV 引号或字段格式无效") from exc


def _worker():
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        text = data.decode("utf-8")
        _input(text)
        result = _parse(text)
    except (ValueError, UnicodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def _bounded_output(process, deadline):
    output = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not selector.select(left):
                raise TimeoutError
            block = os.read(process.stdout.fileno(), 65536)
            if not block:
                break
            if len(output) + len(block) > MAX_OUTPUT:
                raise RuntimeError("CSV 隔离进程输出过大")
            output.extend(block)
    process.wait(timeout=max(0.001, deadline - time.monotonic()))
    return output


def _container(data):
    image_id = os.getenv("ECHO_TABLE_IMAGE_ID", "")
    if not IMAGE_ID.fullmatch(image_id):
        raise ValueError("容器模式需要本地不可变的 ECHO_TABLE_IMAGE_ID")
    name = "echo-table-" + uuid.uuid4().hex
    command = [
        *DOCKER,
        "run",
        "--pull=never",
        "--rm",
        "-i",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=.5",
        "--user=10001:10001",
        "--entrypoint=python",
        image_id,
        "-I",
        "/app/assistant/table_tools.py",
        "--worker",
    ]
    # A private unlinked input file lets the worker read without a pipe write deadlock.
    with tempfile.TemporaryFile() as stdin:
        stdin.write(data)
        stdin.seek(0)
        try:
            process = subprocess.Popen(
                command, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
            )
        except OSError as exc:
            raise RuntimeError("无法启动 Docker CSV 隔离进程") from exc
        try:
            output = _bounded_output(process, time.monotonic() + WORKER_TIMEOUT)
        except (TimeoutError, subprocess.TimeoutExpired, RuntimeError) as exc:
            process.kill()
            process.wait(timeout=3)
            # Killing the CLI may leave its detached daemon-side container running.
            try:
                subprocess.run(
                    [*DOCKER, "rm", "-f", name],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as cleanup:
                raise RuntimeError(f"CSV 隔离进程清理失败，请检查 {name}") from cleanup
            raise RuntimeError("CSV 隔离进程超时或输出过大") from exc
        finally:
            process.stdout.close()
    if process.returncode not in (0, 2):
        raise RuntimeError("CSV 隔离进程执行失败，请检查本地镜像和 Docker 服务")
    try:
        result = json.loads(output)
        if process.returncode == 2 and isinstance(result, dict) and isinstance(result.get("error"), str):
            raise ValueError(result["error"])
        if process.returncode or not isinstance(result, dict) or not isinstance(result.get("columns"), list):
            raise KeyError
    except (json.JSONDecodeError, UnicodeError, KeyError) as exc:
        raise RuntimeError("CSV 隔离进程响应格式无效") from exc
    return result


def summarize_csv(content):
    data = _input(content)
    runtime = os.getenv("ECHO_TABLE_RUNTIME", "local")
    if runtime == "local":
        return _parse(content)
    if runtime == "container":
        return _container(data)
    raise ValueError("ECHO_TABLE_RUNTIME 仅支持 local 或 container")


if __name__ == "__main__":
    if sys.argv[1:] != ["--worker"]:
        sys.exit("usage: python -I /app/assistant/table_tools.py --worker")
    sys.exit(_worker())

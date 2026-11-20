import json
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest

from assistant import table_tools
from assistant.table_tools import summarize_csv


@pytest.fixture(autouse=True)
def local_runtime(monkeypatch):
    monkeypatch.setenv("ECHO_TABLE_RUNTIME", "local")


def test_mixed_and_empty_columns_count_cells_and_use_exact_decimal():
    result = summarize_csv(
        '\ufeff项目,金额,空列,值\r\n"甲,乙",0.1,,NaN\r\n"跨\n行",.2,,3.20\r\n三,+1e-30,,Infinity\r\n四,-0.30\r\n'
    )
    assert result["row_count"] == 4
    assert result["column_count"] == 4
    by_name = {column["name"]: column for column in result["columns"]}
    assert by_name["金额"] == {
        "name": "金额",
        "kind": "number",
        "numeric_count": 4,
        "other_count": 0,
        "empty_count": 0,
        "sum": "1E-30",
        "min": "-0.3",
        "max": "0.2",
    }
    assert by_name["空列"]["empty_count"] == 4
    assert by_name["空列"]["kind"] == "empty" and by_name["空列"]["sum"] is None
    assert by_name["项目"]["kind"] == "text"
    assert by_name["值"] == {
        "name": "值",
        "kind": "mixed",
        "numeric_count": 1,
        "other_count": 2,
        "empty_count": 1,
        "sum": "3.2",
        "min": "3.2",
        "max": "3.2",
    }


def test_extreme_finite_values_and_duplicates_remain_distinct():
    numbers = ["9" * 250 + "e250", "1e-250"]
    summary = summarize_csv("x,x,\n" + "\n".join(f"{n},0, " for n in numbers))
    big, zeros, unnamed = summary["columns"]
    assert Decimal(big["sum"]) == Decimal("9" * 250 + "0" * 250 + "." + "0" * 249 + "1")
    assert zeros["sum"] == "0" and zeros["name"] == "x"
    assert unnamed["name"] == "列3"
    assert json.loads(json.dumps(summary)) == summary
    header_only = summarize_csv("\nname\n\n")
    assert header_only["row_count"] == 0 and header_only["columns"][0]["kind"] == "empty"


@pytest.mark.parametrize(
    "invalid",
    [
        "",
        "\0",
        "a\n" + "文" * 8192,
        "a\n" + "x" * 2049,
        "a,b\nx,y,z",
        'a\n"unterminated',
        "," * 256,
        "a\n" + "1\n" * 4097,
        "a\n1e257",
        "a\n" + "1" * 257,
        "a\n1e99999999999999999999999",
    ],
)
def test_rejects_invalid_or_excessive_input(invalid):
    with pytest.raises(ValueError):
        summarize_csv(invalid)


def test_container_command_and_worker_match_local(monkeypatch):
    content = "量,名\n1e3,甲\n-1.25,乙\n"
    expected = summarize_csv(content)
    monkeypatch.setenv("ECHO_TABLE_RUNTIME", "container")
    monkeypatch.setenv("ECHO_TABLE_IMAGE_ID", "sha256:" + "1" * 64)
    seen = []
    popen = subprocess.Popen

    def local_worker(command, **kwargs):
        assert set(kwargs["env"]) == {"PATH", "DOCKER_CONFIG"}
        assert not list(Path(kwargs["env"]["DOCKER_CONFIG"]).iterdir())
        seen.append(command)
        return popen([sys.executable, "-I", str(Path(table_tools.__file__).resolve()), "--worker"], **kwargs)

    monkeypatch.setattr(table_tools.subprocess, "Popen", local_worker)
    assert summarize_csv(content) == expected
    command = seen[0]
    assert {
        "--rm",
        "-i",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=128m",
        "--cpus=.5",
        "--pull=never",
        "--user=10001:10001",
        "--entrypoint=python",
    }.issubset(command)
    assert command[-4:] == ["sha256:" + "1" * 64, "-I", "/app/assistant/table_tools.py", "--worker"]
    assert content not in command
    with pytest.raises(ValueError, match="列数"):
        summarize_csv("a\n1,2")


def test_container_refuses_image_tags_and_invalid_runtimes(monkeypatch):
    monkeypatch.setenv("ECHO_TABLE_RUNTIME", "other")
    with pytest.raises(ValueError, match="RUNTIME"):
        summarize_csv("x\n1")
    monkeypatch.setenv("ECHO_TABLE_RUNTIME", "container")
    monkeypatch.setenv("ECHO_TABLE_IMAGE_ID", "org/image:latest")
    with pytest.raises(ValueError, match="IMAGE_ID"):
        summarize_csv("x\n1")


@pytest.mark.parametrize("mode", ["timeout", "overflow"])
def test_container_enforces_output_and_time_limits_and_cleans_up(monkeypatch, mode):
    monkeypatch.setenv("ECHO_TABLE_RUNTIME", "container")
    monkeypatch.setenv("ECHO_TABLE_IMAGE_ID", "sha256:" + "f" * 64)
    monkeypatch.setattr(table_tools, "WORKER_TIMEOUT", 0.15 if mode == "timeout" else 5)
    monkeypatch.setattr(table_tools, "MAX_OUTPUT", 16)
    popen = subprocess.Popen
    commands = []

    def stub(command, **kwargs):
        commands.append(command)
        program = "import time;time.sleep(2)" if mode == "timeout" else "print('x'*32)"
        return popen([sys.executable, "-c", program], **kwargs)

    def cleanup(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(table_tools.subprocess, "Popen", stub)
    monkeypatch.setattr(table_tools.subprocess, "run", cleanup)
    with pytest.raises(RuntimeError, match="超时或输出过大"):
        summarize_csv("x\n1")
    name = commands[0][commands[0].index("--name") + 1]
    assert commands[1][-3:] == ["rm", "-f", name]

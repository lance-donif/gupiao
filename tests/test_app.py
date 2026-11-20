import json
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from assistant.app import create_app
from assistant.provider import Provider
from assistant.search import WebSearch


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_BASE_URL", "http://127.0.0.1:18081/v1")
    monkeypatch.setenv("MODEL_NAME", "test")
    monkeypatch.setenv("QQ_APP_ID", "")
    monkeypatch.setenv("QQ_APP_SECRET", "")
    db = tmp_path / "suite.db"
    model = Provider(db)
    search = WebSearch()
    token = "a-test-workspace-token-1234"
    app = create_app(db_path=db, token=token, provider=model, search=search, workers=False)
    client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    return client, app.state.tasks, model


def test_http_contract_and_persistence(workspace):
    client, _queue, model = workspace
    assert client.get("/api/status", headers={"Authorization": ""}).status_code == 401
    assert client.get("/healthz").json()["status"] == "ok"
    assert client.get("/").status_code == 200
    cid = client.post("/api/conversations", json={}).json()["id"]
    mid = client.post("/api/memories", json={"content": "请用中文回答"}).json()["id"]
    did = client.post("/api/documents", json={"name": "议程.md", "content": "评审项目是星海"}).json()["id"]

    calls = []

    def complete(messages):
        calls.append(messages)
        return "星海"

    model.complete = complete
    body = {"text": "评审项目是什么？", "request_id": "browser-retry"}
    for _ in range(2):
        response = client.post(f"/api/conversations/{cid}/messages", json=body)
        assert response.json()["content"] == "星海"
    assert len(calls) == 1 and "请用中文回答" in str(calls) and "星海" in str(calls)
    assert len(client.get(f"/api/conversations/{cid}/messages").json()) == 2
    assert client.delete("/api/documents/" + did).status_code == 204
    assert client.delete("/api/memories/" + mid).status_code == 204
    assert client.delete("/api/conversations/" + cid).status_code == 204
    assert client.get(f"/api/conversations/{cid}/messages").status_code == 404
    assert client.post("/api/qq/link-code").status_code == 503
    assert client.post("/qq/webhook", json={}).status_code == 503
    assert client.get("/api/budget").json()["available_usd"] == model.budget()["free"]


def test_task_recurrence_single_claim_pause_export_and_delete(workspace):
    client, queue, model = workspace
    entered, release = threading.Event(), threading.Event()

    def complete(messages):
        entered.set()
        assert release.wait(5)
        return "研究周报"

    model.complete = complete
    task = client.post(
        "/api/tasks", json={"prompt": "生成周报", "kind": "draft", "frequency": "weekly"}
    ).json()
    url = "/api/tasks/" + task["id"]
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(queue.run_one)
        assert entered.wait(5)
        assert not queue.run_one()
        assert client.post(url + "/pause").json()["status"] == "paused"
        release.set()
        assert pending.result()
    state = client.get("/api/tasks").json()[0]
    assert state["status"] == "paused" and state["next_run_at"] is None and state["has_artifact"]
    assert client.post(url + "/resume").status_code == 200
    assert queue.run_one()
    assert client.get("/api/tasks").json()[0]["next_run_at"]
    assert not queue.run_one()
    assert "研究周报" in client.get(url + "/artifact").text
    zipped = client.get(url + "/artifact?format=docx")
    assert zipfile.is_zipfile(BytesIO(zipped.content))
    assert client.delete(url).status_code == 204
    assert client.get(url + "/artifact").status_code == 404


def test_research_job_failure_and_resume(workspace):
    client, queue, model = workspace
    task = queue.create("web:workspace", "研究潮汐能", "once")
    url = "/api/tasks/" + task["id"]
    calls = []

    def fail(messages, **kwargs):
        calls.append(1)
        raise RuntimeError("模型不可用")

    model.complete = fail
    assert queue.run_one()
    state = tasks_list(client)
    assert state["status"] == "failed" and not state["has_artifact"]
    assert not queue.run_one()
    assert client.get(url + "/artifact").status_code == 404

    def success(messages, **kwargs):
        if "检索" in messages[0]["content"] and "queries" in messages[0]["content"]:
            return json.dumps({"queries": ["潮汐能"]})
        return "根据资料，潮汐能来自潮汐。[1]"

    model.complete = success
    queue.engine.search = lambda _: [
        {"title": "潮汐能", "url": "https://example.org/tide", "snippet": "海洋能"}
    ]
    assert client.post(url + "/resume").status_code == 200
    assert queue.run_one()
    assert tasks_list(client)["status"] == "completed"
    assert "https://example.org/tide" in client.get(url + "/artifact").text
    assert len(calls) == 1


def tasks_list(client):
    return client.get("/api/tasks").json()[0]


def test_replayed_channel_controls_cannot_start_another_job(workspace):
    _, queue, model = workspace
    model.complete = lambda _: "done"
    args = ("contact", "编写通知", "once", "draft")
    task = queue.create(*args, request_id="qq-event-1")
    assert queue.create(*args, request_id="qq-event-1")["id"] == task["id"]
    with pytest.raises(ValueError):
        queue.create("contact", "另一个任务", "once", "draft", request_id="qq-event-1")
    with pytest.raises(KeyError):
        queue.get("stranger", task["id"])
    queue.change("contact", task["id"], "pause", request_id="qq-event-2")
    queue.change("contact", task["id"], "resume", request_id="qq-event-3")
    assert queue.run_one()
    assert queue.change("contact", task["id"], "resume", request_id="qq-event-3")["status"] == "completed"
    assert not queue.run_one()


def test_task_input_files_commit_atomically_before_worker_runs(workspace):
    client, queue, _ = workspace
    file = {"name": "账目.csv", "content": "项目,金额\n办公,18.90"}
    payload = {"prompt": "计算金额", "kind": "office", "files": [file], "request_id": "upload"}
    result = client.post("/api/tasks", json=payload)
    assert result.status_code == 201
    tid = result.json()["id"]
    assert client.get(f"/api/tasks/{tid}/files/账目.csv").text == file["content"]
    assert queue.get("web:workspace", tid)["files"][0]["name"] == "账目.csv"
    assert client.post("/api/tasks", json=payload).json()["id"] == tid
    payload["files"][0]["content"] += "\n书,3"
    assert client.post("/api/tasks", json=payload).status_code == 400
    payload.update(request_id="second", files=[file, file])
    assert client.post("/api/tasks", json=payload).status_code == 400
    assert len(client.get("/api/tasks").json()) == len(client.get("/api/conversations").json()) == 1

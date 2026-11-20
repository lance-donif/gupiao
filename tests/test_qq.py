import json
import sqlite3
import time
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from assistant.qq import DeliveryError, QQBot, QQRest, _key


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("QQ_APP_ID", "bot1")
    monkeypatch.setenv("QQ_APP_SECRET", "123456abcdef")
    engine = Mock()
    engine.channel_conversation.return_value = "conv"
    engine.reply.return_value = {"content": "结果", "sources": [{"title": "新闻"}]}
    linker = Mock()
    linker.route.side_effect = lambda owner: (owner, engine.channel_conversation(owner))
    monkeypatch.setattr("assistant.qq.Linking", lambda engine: linker)
    bot = QQBot(tmp_path / "bot.sqlite", engine)
    bot.rest = Mock()
    return bot


def sign(bot, body, stamp=None):
    timestamp = str(int(time.time()) if stamp is None else stamp)
    return {"x-signature-ed25519": bot.key.sign(timestamp.encode() + body).hex(),
            "x-signature-timestamp": timestamp, "x-bot-appid": bot.app_id}


def event(kind="C2C_MESSAGE_CREATE", text="你好", mid="message.01!", group="g1", user="u1"):
    data = {"id": mid, "content": text, "author": {"user_openid": user}}
    if kind == "GROUP_AT_MESSAGE_CREATE":
        data.update(group_openid=group, author={"member_openid": user})
    return json.dumps({"op": 0, "t": kind, "d": data}).encode()


def signed_post(bot, body):
    return bot.receive(body, sign(bot, body))


def test_official_signature_vector():
    # Published by Tencent in botgo/interaction/signature/interaction_test.go.
    body = ('{"id":"ROBOT1.0_veoihSEXDc8Q.g-6eLpNIa11bH8MisOjn-m-LKxCPntMk6exUXgcWCGpVO7L2QKTNZzjZzFFDSbiOFcqAPWyVA!!",'
            '"content":"哦一下","timestamp":"2024-10-15T16:33:15+08:00","author":{"id":"675860273","user_openid":"675860273"}}')
    signature = bytes.fromhex("e949b5b94ef4103df903fb031d1d16e358db3db83e79e117edd404c8508be3ce8a76d7bad1bed353194c126a1a5915b4ad8b5288c1191cc53a12acffccd82004")
    _key("123456abcdef").public_key().verify(signature, ("1728981195" + body).encode())


def test_webhook_challenge(bot):
    app = FastAPI()
    app.include_router(bot.router)
    client = TestClient(app)
    ts = str(int(time.time()))
    payload = {"op": 13, "d": {"plain_token": "abc12", "event_ts": ts}}
    response = client.post("/qq/webhook", json=payload, headers={"X-Bot-Appid": bot.app_id})
    assert response.status_code == 200
    assert response.json()["plain_token"] == "abc12"
    bot.key.public_key().verify(bytes.fromhex(response.json()["signature"]), (ts + "abc12").encode())
    payload["d"]["plain_token"] = '{"op":0}'
    assert client.post("/qq/webhook", json=payload, headers={"X-Bot-Appid": bot.app_id}).status_code == 400
    assert bot.process_one() is False


def test_dispatch_verification(bot):
    body = event()
    for headers in ({}, {"x-bot-appid": bot.app_id}, sign(bot, body + b" "),
                    sign(bot, body, 1234567890), {**sign(bot, body), "x-bot-appid": "other"}):
        with pytest.raises(HTTPException) as exc:
            bot.receive(body, headers)
        assert exc.value.status_code == 403
    assert bot.process_one() is False


def test_heartbeat_and_ignored_events(bot):
    assert signed_post(bot, b'{"op":1,"d":777}') == {"op": 11, "d": 777}
    assert signed_post(bot, event("GROUP_ADD_ROBOT")) == {"op": 12, "d": 0}
    assert bot.process_one() is False


def test_durable_ack_idempotency_and_scope(bot):
    body = event(text="/搜索 天气")
    for _ in range(2):
        assert signed_post(bot, body) == {"op": 12, "d": 0}
    bot.engine.reply.assert_not_called()
    # Reopen the persisted inbox as a restarted service.
    restored = QQBot(bot.inbox.path, bot.engine)
    restored.rest = bot.rest
    assert restored.process_one()
    assert not restored.process_one()
    bot.rest.send.assert_called_once_with("users", "u1", "message.01!", 1, "结果\n\n来源\n[1] 新闻")
    assert bot.engine.reply.call_args.kwargs["mode"] == "research"
    assert bot.engine.reply.call_args.args[2] == "天气"
    for group, user in [("g1", "u1"), ("g2", "u1"), ("g1", "u2")]:
        signed_post(bot, event("GROUP_AT_MESSAGE_CREATE", group=group, user=user))
        assert bot.process_one()
        assert bot.rest.send.call_args.args[:2] == ("groups", group)
    assert len({args.args[0] for args in bot.engine.channel_conversation.call_args_list}) == 4


def test_failed_delivery_reuses_saved_answer_and_sequence(bot):
    bot.engine.reply.return_value = {"content": "字" * 1001}
    bot.rest.send.side_effect = [None, DeliveryError("timeout", True), None]
    signed_post(bot, event())
    assert bot.process_one()
    with sqlite3.connect(bot.inbox.path) as db:
        assert db.execute("SELECT seq, status FROM qq_jobs").fetchone() == (2, "ready")
        db.execute("UPDATE qq_jobs SET available=0")
    assert bot.process_one()
    bot.engine.reply.assert_called_once()
    assert [c.args[3] for c in bot.rest.send.call_args_list] == [1, 2, 2]


def test_qq_rest_token_cache_auth_and_official_duplicate():
    seen = []
    def handler(request):
        seen.append(request)
        if request.url.path == "/app/getAppAccessToken":
            assert json.loads(request.content) == {"appId": "id", "clientSecret": "secret"}
            return httpx.Response(200, json={"expires_in": "7200", "access_token": "test-token"})
        assert request.headers["Authorization"] == "QQBot test-token"
        assert request.url.path == "/v2/groups/g/messages"
        assert request.url.host == "api.bot.qq.com"
        assert json.loads(request.content)["msg_seq"] == 2
        return httpx.Response(400, json={"code": 40054005})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        rest = QQRest("id", "secret", client.post)
        for _ in range(2):
            rest.send("groups", "g", "mid", 2, "hi")
    assert len(seen) == 3


def test_private_qq_memory_commands(bot):
    bot.engine.add_memory.return_value = {"id": "abc"}
    signed_post(bot, event(text="/记住 爱喝茶"))
    assert bot.process_one()
    bot.engine.add_memory.assert_called_once_with("qq:bot1:users:u1:u1", "爱喝茶")
    signed_post(bot, event("GROUP_AT_MESSAGE_CREATE", text="/记忆"))
    assert bot.process_one()
    bot.engine.memories.assert_not_called()
    bot.engine.reply.assert_not_called()


def test_bind_code_redacted_even_for_groups(bot):
    from assistant.linking import code_digest

    code = "A" * 26
    signed_post(bot, event(text=f"/绑定 {code}"))
    signed_post(bot, event("GROUP_AT_MESSAGE_CREATE", text=f"/绑定 {code}"))
    with sqlite3.connect(bot.inbox.path) as db:
        prompts = sorted(r[0] for r in db.execute("SELECT prompt FROM qq_jobs"))
    assert prompts == ["", code_digest(code)]
    assert bot.process_one()
    assert bot.process_one()
    bot.linking.bind_digest.assert_called_once_with("qq:bot1:users:u1:u1", code_digest(code))
    bot.engine.reply.assert_not_called()


def test_web_unlink_blocks_delivery_of_pending_private_answer(bot):
    bot.linking.route.side_effect = lambda owner: ("web:user", "bound-id")
    bot.linking.still_linked.return_value = False
    signed_post(bot, event())
    assert bot.process_one()
    bot.engine.reply.assert_called_once()
    assert bot.engine.reply.call_args.args[:2] == ("web:user", "bound-id")
    bot.rest.send.assert_not_called()
    with sqlite3.connect(bot.inbox.path) as db:
        assert db.execute("SELECT status, reply FROM qq_jobs").fetchone() == ("canceled", None)


def test_real_engine_shares_private_qq_conversation_with_linked_web_owner(tmp_path, monkeypatch):
    from assistant.engine import Engine

    monkeypatch.setenv("QQ_APP_ID", "qq42")
    monkeypatch.setenv("QQ_APP_SECRET", "local-test-secret")
    path = tmp_path / "workspace.sqlite"
    provider = Mock()
    provider.complete.return_value = "正在处理。"
    engine = Engine(path, provider, Mock())
    bot = QQBot(path, engine)
    bot.rest = Mock()
    engine.add_memory("web:alice", "输出使用简体中文")
    code = bot.linking.issue("web:alice")["code"]
    signed_post(bot, event(text=f"/绑定 {code}", mid="binding"))
    assert bot.process_one()
    assert bot.linking.status("web:alice")["linked"]
    signed_post(bot, event(text="介绍服务", mid="question"))
    assert bot.process_one()
    assert "输出使用简体中文" in str(provider.complete.call_args)
    conversation = engine.conversations("web:alice")[0]
    assert engine.messages("web:alice", conversation["id"])[-1]["content"] == "正在处理。"
    assert bot.rest.send.call_args.args == ("users", "u1", "question", 1, "正在处理。")
    signed_post(bot, event(text="/解绑", mid="unlink"))
    assert bot.process_one()
    assert bot.linking.status("web:alice")["linked"] is False


@pytest.mark.parametrize(("kind", "code"), [("写作", "draft"), ("研究", "research"), ("文件", "office")])
def test_task_kinds_translate_to_once_only_and_groups_cannot_submit(bot, kind, code):
    bot.tasks = Mock()
    bot.tasks.create.return_value = {"id": "abc"}
    body = event(text=f"/任务 {kind} 需求", mid="create")
    signed_post(bot, body)
    signed_post(bot, body)
    assert bot.process_one()
    assert bot.process_one() is False
    args = bot.tasks.create.call_args
    assert args.args == ("qq:bot1:users:u1:u1", "需求")
    assert args.kwargs["kind"] == code
    assert args.kwargs["frequency"] == "once"
    assert len(args.kwargs["request_id"]) == 64
    signed_post(bot, event("GROUP_AT_MESSAGE_CREATE", text=f"/任务 {kind} 需求", mid="group"))
    assert bot.process_one()
    bot.tasks.create.assert_called_once()
    bot.engine.reply.assert_not_called()
    assert "单聊" in bot.rest.send.call_args.args[-1]


def test_private_bound_qq_task_flow_and_unlinked_user_isolation(tmp_path, monkeypatch):
    from assistant.engine import Engine
    from assistant.tasks import TaskQueue

    path = tmp_path / "qqtask.sqlite"
    monkeypatch.setenv("QQ_APP_ID", "bot")
    monkeypatch.setenv("QQ_APP_SECRET", "test-secret")
    provider = Mock()
    provider.complete.return_value = "国际象棋规则摘要。"
    engine = Engine(path, provider, Mock())
    tasks = TaskQueue(engine)
    bot = QQBot(path, engine, tasks)
    bot.rest = Mock()

    def dispatch(text, mid, user="u1"):
        signed_post(bot, event(text=text, mid=mid, user=user))
        assert bot.process_one()
        return bot.rest.send.call_args.args[-1]

    code = bot.linking.issue("web:alice")["code"]
    assert "绑定成功" in dispatch(f"/绑定 {code}", "bind")
    assert "任务编号" in dispatch("/任务 写作 说明国际象棋", "create")
    task, = tasks.list("web:alice")
    tid = task["id"]
    assert tid in dispatch("/任务列表", "list")
    assert "没有这个任务" in dispatch(f"/暂停 {tid}", "another-user", "other")
    assert "排队中" in dispatch(f"/进度 {tid}", "status")
    assert "已暂停" in dispatch(f"/暂停 {tid}", "pause")
    assert tasks.run_one() is False
    assert "排队中" in dispatch(f"/恢复 {tid}", "resume")
    assert "排队中" in dispatch(f"/恢复 {tid}", "resume-already-queued")
    sent_before_run = bot.rest.send.call_count
    assert tasks.run_one()
    assert bot.rest.send.call_count == sent_before_run
    assert "已完成" in dispatch(f"/进度 {tid}", "finished")
    assert "国际象棋规则摘要" in dispatch(f"/成果 {tid}", "result")
    assert "已解除" in dispatch("/解绑", "unlink")
    assert "没有这个任务" in dispatch(f"/成果 {tid}", "after-unlink")
    provider.complete.assert_called_once()


def test_office_artifact_shows_names_and_scoped_file_preview(bot):
    bot.tasks = Mock()
    bot.linking.route.side_effect = lambda owner: ("web:alice", "link-cid")
    tid = "a" * 32
    bot.tasks.get.return_value = {"id": tid, "kind": "office", "has_artifact": True,
                                  "files": [{"name": "明细表.csv"}]}
    bot.tasks.artifact.return_value = "完成交付。"
    bot.tasks.office.read.return_value = "月份,总价\n一月,12"
    signed_post(bot, event(text=f"/成果 {tid}", mid="report"))
    assert bot.process_one()
    report = bot.rest.send.call_args.args[-1]
    assert "明细表.csv" in report and "Web" in report and "完成交付" in report
    signed_post(bot, event(text=f"/成果 {tid} 明细表.csv", mid="file"))
    assert bot.process_one()
    bot.tasks.office.read.assert_called_once_with("web:alice", tid, "明细表.csv")
    assert "一月,12" in bot.rest.send.call_args.args[-1]


def test_qq_pause_of_completed_recurring_task_and_replayed_command(tmp_path, monkeypatch):
    from assistant.engine import Engine
    from assistant.tasks import TaskQueue

    monkeypatch.setenv("QQ_APP_ID", "bot")
    monkeypatch.setenv("QQ_APP_SECRET", "test-secret")
    path = tmp_path / "recurring.sqlite"
    provider = Mock()
    provider.complete.return_value = "本期已完成。"
    engine = Engine(path, provider, Mock())
    tasks = TaskQueue(engine)
    owner = "qq:bot:users:u1:u1"
    tid = tasks.create(owner, "每周周报", frequency="weekly", kind="draft")["id"]
    assert tasks.run_one()
    completed = tasks.get(owner, tid)
    assert completed["status"] == "completed" and completed["next_run_at"]
    bot = QQBot(path, engine, tasks)
    bot.rest = Mock()
    signed_post(bot, event(text=f"/暂停 {tid}", mid="pause-next"))
    assert bot.process_one()
    paused = tasks.get(owner, tid)
    assert paused["status"] == "paused" and paused["next_run_at"] is None
    # A subsequent explicit resume must survive a redelivery of the older pause.
    signed_post(bot, event(text=f"/恢复 {tid}", mid="resume-next"))
    assert bot.process_one()
    with sqlite3.connect(path) as db:
        db.execute("UPDATE qq_jobs SET status='ready',seq=1,available=0,prompt=? WHERE mid='pause-next'",
                   (f"/暂停 {tid}",))
    assert bot.process_one()
    assert tasks.get(owner, tid)["status"] == "queued"

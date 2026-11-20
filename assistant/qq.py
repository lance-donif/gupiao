"""Official QQ Bot v2 signed Webhook and passive message delivery."""
import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .linking import Linking, code_digest
from .qq_queue import Inbox
from .store import ConversationBusy

LOG = logging.getLogger(__name__)
API = "https://api.bot.qq.com"
KINDS = {"GROUP_AT_MESSAGE_CREATE": "groups", "C2C_MESSAGE_CREATE": "users"}
TASK_COMMANDS = {"/任务", "/任务列表", "/进度", "/成果", "/暂停", "/恢复"}
TASK_KINDS = {"写作": "draft", "研究": "research", "文件": "office"}
TASK_STATES = {"queued": "排队中", "running": "运行中", "paused": "已暂停", "failed": "失败", "completed": "已完成"}
TASK_HELP = "发送 /任务 写作|研究|文件 任务说明，可创建一次性任务。用 /任务列表 查看编号。"
OPEN_ID = re.compile(r"[a-zA-Z0-9_-]{1,128}")


def _key(secret):
    raw = secret.encode()
    return Ed25519PrivateKey.from_private_bytes((raw * (32 // len(raw) + 1))[:32])


def _fresh(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9]{10}", value) and abs(time.time() - int(value)) < 300


class DeliveryError(Exception):
    def __init__(self, reason, retryable):
        super().__init__(reason)
        self.retryable = retryable


class QQRest:
    def __init__(self, app_id, secret, post=httpx.post):
        self.app_id = app_id
        self.secret = secret
        self.post = post
        self.token = ""
        self.deadline = 0

    def _post(self, path, **kwargs):
        try:
            response = self.post(API + path, timeout=15, **kwargs)
        except httpx.RequestError as exc:
            raise DeliveryError("network", True) from exc
        try:
            data = response.json()
            if not isinstance(data, dict):
                raise TypeError
        except (ValueError, TypeError) as exc:
            raise DeliveryError(f"invalid_response_http_{response.status_code}", True) from exc
        return response.status_code, data

    def access_token(self):
        if time.monotonic() >= self.deadline:
            status, data = self._post("/app/getAppAccessToken", json={
                "appId": self.app_id, "clientSecret": self.secret})
            try:
                ttl = int(data["expires_in"])
                token = data["access_token"]
                if status != 200 or not isinstance(token, str) or not token or ttl <= 0:
                    raise ValueError
            except (ValueError, TypeError, KeyError) as exc:
                raise DeliveryError(f"token_http_{status}", status == 429 or status >= 500) from exc
            self.token = token
            self.deadline = time.monotonic() + max(0, ttl - 60)
        return self.token

    def send(self, kind, target, mid, seq, text):
        status, data = self._post(f"/v2/{kind}/{target}/messages", headers={
            "Authorization": f"QQBot {self.access_token()}", "X-Union-Appid": self.app_id},
            json={"msg_type": 0, "content": text, "msg_id": mid, "msg_seq": seq})
        code = data.get("code", 0)
        if code == 40054005:  # Official duplicate message response for msg_id + msg_seq.
            return
        if status == 401:
            self.deadline = 0
        if code or not 200 <= status < 300:
            retry = status in (401, 408, 429) or status >= 500 or str(code).startswith("500")
            raise DeliveryError(f"send_http_{status}_code_{code}", retry)


def _chunks(content):
    # Four passive replies are permitted in both supported event types.
    return [content[i:i + 1000] for i in range(0, min(len(content), 4000), 1000)]


class QQBot:
    def __init__(self, db_path, engine, tasks=None):
        self.engine = engine
        self.tasks = tasks
        self.linking = None
        self.app_id = os.getenv("QQ_APP_ID", "").strip()
        secret = os.getenv("QQ_APP_SECRET", "").strip()
        if bool(self.app_id) != bool(secret):
            raise ValueError("QQ_APP_ID and QQ_APP_SECRET must be configured together")
        self.enabled = bool(secret)
        if self.enabled:
            self.linking = Linking(engine)
        self.key = _key(secret) if secret else None
        self.inbox = Inbox(db_path, self.app_id) if self.enabled else None
        self.rest = QQRest(self.app_id, secret)
        self.router = APIRouter()
        self.router.add_api_route("/qq/webhook", self.webhook, methods=["POST"])
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.worker = None

    def start(self):
        if self.enabled and not (self.worker and self.worker.is_alive()):
            self.stopping.clear()
            self.worker = threading.Thread(target=self._work, name="qq-delivery", daemon=True)
            self.worker.start()

    def stop(self):
        self.stopping.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=5)

    async def webhook(self, request: Request):
        if not self.enabled:
            raise HTTPException(503, "QQ 未配置")
        buf = bytearray()
        async for chunk in request.stream():
            if len(buf) + len(chunk) > 256 * 1024:
                raise HTTPException(413, "回调过大")
            buf.extend(chunk)
        return await run_in_threadpool(self.receive, bytes(buf), request.headers)

    def receive(self, raw, headers):
        app = headers.get("x-bot-appid")
        if app is not None and app != self.app_id:
            raise HTTPException(403, "AppID 无效")
        sig = headers.get("x-signature-ed25519")
        timestamp = headers.get("x-signature-timestamp")
        if sig is not None or timestamp is not None:
            if not _fresh(timestamp) or not isinstance(sig, str) or len(sig) != 128:
                raise HTTPException(403, "签名无效或已过期")
            try:
                self.key.public_key().verify(bytes.fromhex(sig), timestamp.encode() + raw)
            except (InvalidSignature, ValueError):
                raise HTTPException(403, "签名无效")
        try:
            payload = json.loads(raw)
            op, data = payload["op"], payload["d"]
        except (ValueError, TypeError, KeyError, RecursionError):
            raise HTTPException(400, "事件格式无效")
        if op == 13 and isinstance(data, dict):
            # Official validation example supplies X-Bot-Appid without signature.
            # Restrict unsigned challenges to fresh timestamps and opaque tokens so
            # this endpoint cannot sign a JSON dispatch body.
            token, ts = data.get("plain_token"), data.get("event_ts")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_./+=-]{1,256}", token):
                raise HTTPException(400, "验证令牌无效")
            if not _fresh(ts) or (sig is None and app != self.app_id):
                raise HTTPException(403, "验证请求无效")
            return {"plain_token": token, "signature": self.key.sign((ts + token).encode()).hex()}
        if sig is None:
            raise HTTPException(403, "需要 QQ 签名")
        if op == 1:
            return {"op": 11, "d": data}
        if op != 0:
            raise HTTPException(400, "未知操作")
        kind = KINDS.get(payload.get("t")) if isinstance(payload.get("t"), str) else None
        if kind:
            self._enqueue(kind, data)
        return {"op": 12, "d": 0}

    def _enqueue(self, kind, data):
        if not isinstance(data, dict) or not isinstance(data.get("author"), dict):
            raise HTTPException(400, "消息格式无效")
        group = kind == "groups"
        sender = data["author"].get("member_openid" if group else "user_openid")
        target = data.get("group_openid") if group else sender
        if not all(isinstance(x, str) and OPEN_ID.fullmatch(x) for x in (sender, target)):
            raise HTTPException(400, "OpenID 格式无效")
        mid = data.get("id")
        if not isinstance(mid, str) or not 1 <= len(mid) <= 512:
            raise HTTPException(400, "消息 ID 无效")
        content = data.get("content", "")
        if not isinstance(content, str):
            raise HTTPException(400, "消息正文无效")
        parts = content.strip().split(maxsplit=1)
        mode = "research" if parts and parts[0] in ("/search", "/搜索") else "chat"
        prompt = (parts[1] if len(parts) == 2 else "") if mode == "research" else content.strip()
        owner = f"qq:{self.app_id}:{kind}:{target}:{sender}"
        if parts and parts[0] == "/绑定":
            mode, prompt = "bind", ""
            if not group and len(parts) == 2:
                try:
                    prompt = code_digest(parts[1])
                except ValueError:
                    pass
        elif parts and parts[0] == "/解绑":
            mode, prompt = "unbind", ""
        self.inbox.put(owner, mid, kind, target, prompt, mode)
        self.wake.set()

    def _work(self):
        while not self.stopping.is_set():
            try:
                if self.process_one():
                    continue
            except (RuntimeError, sqlite3.Error, ValueError, OSError) as exc:
                LOG.error("QQ worker interrupted (%s)", type(exc).__name__)
            self.wake.wait(2)
            self.wake.clear()

    def _task_command(self, owner, command, argument, request_id, linked):
        if self.tasks is None:
            return "任务服务暂不可用。"
        if command == "/任务":
            parts = argument.split(maxsplit=1)
            if len(parts) != 2 or parts[0] not in TASK_KINDS:
                return TASK_HELP
            task = self.tasks.create(owner, parts[1], frequency="once", kind=TASK_KINDS[parts[0]],
                                     request_id=request_id)
            return f"任务编号 {task['id']}。发送 /进度 {task['id']} 查看状态。"
        if command == "/任务列表":
            tasks = self.tasks.list(owner)
            if not tasks:
                return "当前工作区还没有任务。" + TASK_HELP
            pages = (len(tasks) + 7) // 8
            if argument and not re.fullmatch(r"[1-9][0-9]?", argument):
                return f"用法：/任务列表 页码（1 到 {pages}）"
            page = int(argument or "1")
            if page > pages:
                return f"共有 {pages} 页。"
            rows = [f"任务列表 {page}/{pages}"]
            for task in tasks[(page - 1) * 8:page * 8]:
                title = " ".join(task["prompt"].split())[:45]
                rows.append(f"{task['id']}  {TASK_STATES[task['status']]}  {title}")
            return "\n".join(rows)
        parts = argument.split(maxsplit=1)
        if not parts or not re.fullmatch(r"[a-f0-9]{32}", parts[0]) or (len(parts) > 1 and command != "/成果"):
            return f"用法：{command} 任务编号，请用 /任务列表 查看。"
        tid = parts[0]
        task = self.tasks.get(owner, tid)
        if command == "/成果":
            if len(parts) > 1:
                return self.tasks.office.read(owner, tid, parts[1])
            if not task["has_artifact"]:
                return f"任务{TASK_STATES[task['status']]}，尚无完成的报告。"
            report = self.tasks.artifact(owner, tid)
            if task["kind"] == "office":
                names = [entry["name"] for entry in task["files"]]
                if names:
                    instructions = f"用 /成果 {tid} 文件名 阅读正文。"
                    if linked:
                        instructions += "也可从绑定的 Web 工作区下载。"
                    return "生成文件：" + "、".join(names) + "\n" + instructions + "\n\n" + report
            return report
        if command == "/进度":
            steps = task["activity"][-5:]
            detail = [f"任务{TASK_STATES[task['status']]}"] + steps
            if task["last_error"]:
                detail.append(task["last_error"])
            if task["has_artifact"]:
                detail.append(f"读取成果：/成果 {tid}")
            return "\n".join(detail)
        wanted = "pause" if command == "/暂停" else "resume"
        can_pause = task["status"] != "paused" and (task["status"] != "completed" or task["next_run_at"] is not None)
        if (wanted == "pause" and can_pause) or (
            wanted == "resume" and task["status"] in {"paused", "failed"}
        ):
            task = self.tasks.change(owner, tid, wanted, request_id=request_id)
        return f"任务{TASK_STATES[task['status']]}。"

    def _compose(self, job):
        prompt, owner = job["prompt"], job["owner"]
        if job["mode"] in ("bind", "unbind"):
            if job["kind"] != "users":
                return "请在与机器人的单聊中绑定或解绑。"
            if job["mode"] == "unbind":
                self.linking.unbind_qq(owner)
                return "已解除与 Web 工作区的绑定。"
            try:
                self.linking.bind_digest(owner, prompt)
            except ValueError:
                return "绑定失败。请从 Web 工作区获取新的绑定码，并在单聊发送 /绑定 加上绑定码。"
            return "绑定成功，当前单聊可使用 Web 工作区的记忆和资料。"
        if not prompt:
            return "请发送文字问题，或输入 /搜索 加上关键词。"
        routed_owner, cid = self.linking.route(owner)
        if routed_owner != owner:
            self.inbox.update(job, bound_cid=cid)
        rid = hashlib.sha256(f"{owner}|{job['mid']}".encode()).hexdigest()
        if job["mode"] == "chat":
            command, *args = prompt.split(maxsplit=1)
            argument = args[0] if args else ""
            if command in TASK_COMMANDS:
                if job["kind"] != "users":
                    return "请在与机器人的单聊中操作任务。"
                try:
                    return self._task_command(routed_owner, command, argument, rid, bool(job["bound_cid"]))
                except KeyError:
                    return "当前工作区没有这个任务或文件。"
                except (ValueError, ConversationBusy) as exc:
                    return str(exc)
            if command in ("/记住", "/记忆", "/忘记"):
                if job["kind"] != "users":
                    return "请在单聊中管理个人记忆。"
                if command == "/记住":
                    if not argument:
                        return "用法：/记住 要保存的内容"
                    memory = self.engine.add_memory(routed_owner, argument)
                    return f"已记住。编号 {memory['id']}"
                if command == "/忘记":
                    try:
                        self.engine.delete_memory(routed_owner, argument)
                    except KeyError:
                        return "未找到这个记忆编号。"
                    return "已删除这条记忆。"
                memories = self.engine.memories(routed_owner)
                return "\n".join(f"{m['id']}  {m['content']}" for m in memories) or "目前没有保存的记忆。"
        result = self.engine.reply(routed_owner, cid, prompt, mode=job["mode"], request_id=rid)
        content = result["content"]
        sources = [f"[{i}] {s['title']}" for i, s in enumerate(result.get("sources", []), 1)]
        if sources:
            content += "\n\n来源\n" + "\n".join(sources)
        return content

    def process_one(self):
        job = self.inbox.claim()
        if job is None:
            return False
        if job["reply"] is None:
            error = None
            try:
                content = self._compose(job)
            except (ValueError, TypeError, KeyError, RuntimeError, sqlite3.Error, OSError, httpx.HTTPError) as exc:
                # Repeating an ambiguous provider failure could incur a second charge.
                error = f"assistant_{type(exc).__name__}"
                LOG.warning("QQ assistant request failed (%s)", type(exc).__name__)
                content = "这次请求未能完成，请稍后再试或联系管理员。"
            if len(content) > 4000:
                content = content[:3980] + "\n（回复过长，已截断）"
            self.inbox.update(job, reply=content, error=error)
        chunks = _chunks(job["reply"])
        try:
            while job["seq"] <= len(chunks):
                if job["bound_cid"] and not self.linking.still_linked(job["owner"], job["bound_cid"]):
                    self.inbox.update(job, status="canceled", prompt="", reply=None, lease=None, error="unlinked")
                    return True
                seq = job["seq"]
                self.rest.send(job["kind"], job["target"], job["mid"], seq, chunks[seq - 1])
                self.inbox.update(job, seq=seq + 1)
        except DeliveryError as exc:
            attempts = job["attempts"] + 1
            retry = exc.retryable and attempts < 5
            self.inbox.update(job, status="ready" if retry else "failed", attempts=attempts,
                              error=str(exc), available=time.time() + 2 ** attempts, lease=None)
            LOG.warning("QQ delivery %s (%s)", "deferred" if retry else "failed", exc)
        else:
            self.inbox.update(job, status="sent", prompt="", reply=None, lease=None)
        return True

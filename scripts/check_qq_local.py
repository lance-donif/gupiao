"""Exercise signed QQ dispatch with a real loopback model and simulated Tencent REST."""

import asyncio
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from assistant.app import create_app
from assistant.qq import QQRest

MODEL_BASE = "http://127.0.0.1:18081/v1"
APP_ID, SENDER, MESSAGE_ID = "localbot", "localuser", "local-diagnostic-01"


async def run():
    secret = secrets.token_hex(16)
    settings = {
        "QQ_APP_ID": APP_ID, "QQ_APP_SECRET": secret, "MODEL_NAME": "qwen-local",
        "MODEL_BASE_URL": MODEL_BASE, "MODEL_MAX_OUTPUT_TOKENS": "64",
        "MODEL_BILLABLE_OUTPUT_CEILING_TOKENS": "64", "MODEL_MAX_TOKENS_FIELD": "max_tokens",
        "MODEL_API_KEY": "", "MODEL_INPUT_USD_PER_MILLION": "0",
        "MODEL_OUTPUT_USD_PER_MILLION": "0", "ASSISTANT_BUDGET_USD": "0",
        "SEARXNG_BASE_URL": "",
    }
    outbound = []

    def tencent(request):
        assert request.url.host == "api.bot.qq.com" and request.method == "POST"
        data = json.loads(request.content)
        if request.url.path == "/app/getAppAccessToken":
            assert data == {"appId": APP_ID, "clientSecret": secret}
            return httpx.Response(200, json={"access_token": "local-test-ticket", "expires_in": 7200})
        assert request.url.path == f"/v2/users/{SENDER}/messages"
        assert request.headers["Authorization"] == "QQBot local-test-ticket"
        assert data["msg_type"] == 0 and data["msg_id"] == MESSAGE_ID and data["msg_seq"] == 1
        outbound.append(data["content"])
        return httpx.Response(200, json={"id": "simulated-platform-ack"})

    with TemporaryDirectory() as directory, patch.dict(os.environ, settings):
        database = Path(directory) / "check.sqlite3"
        with httpx.Client(transport=httpx.MockTransport(tencent)) as capture:
            # Keep QQRest's real token handling and request serialization.
            with patch("assistant.qq.QQRest", lambda app, key: QQRest(app, key, post=capture.post)):
                app = create_app(db_path=database, token=secrets.token_hex(24))
            body = json.dumps({"op": 0, "t": "C2C_MESSAGE_CREATE", "d": {
                "id": MESSAGE_ID, "author": {"user_openid": SENDER},
                "content": "法国的首都是哪座城市？请只回答城市名称。"}}, ensure_ascii=False).encode()
            ts = str(int(time.time()))
            signature = Ed25519PrivateKey.from_private_bytes(secret.encode()).sign(ts.encode() + body)
            headers = {"X-Bot-Appid": APP_ID, "X-Signature-Ed25519": signature.hex(),
                       "X-Signature-Timestamp": ts, "Content-Type": "application/json"}
            async with app.router.lifespan_context(app), httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://asgi.local"
            ) as client:
                for _ in range(2):
                    response = await client.post("/qq/webhook", content=body, headers=headers)
                    response.raise_for_status()
                    assert response.json() == {"op": 12, "d": 0}
                with sqlite3.connect(database) as db:
                    deadline = time.monotonic() + 100
                    while time.monotonic() < deadline:
                        state, error = db.execute("SELECT status,error FROM qq_jobs").fetchone()
                        if state != "ready":
                            break
                        await asyncio.sleep(0.2)
                    assert (state, error) == ("sent", None), (state, error)
                    charges = db.execute("SELECT model,endpoint,input_tokens,output_tokens,estimated "
                                         "FROM model_charges").fetchall()
                    assert len(charges) == 1, charges
                    model, endpoint, inputs, outputs, cost = charges[0]
                    assert (model, endpoint, cost) == ("qwen-local", MODEL_BASE, 0)
                    assert inputs > 0 and 0 < outputs <= 64
                    assert len(outbound) == 1
                    answer = outbound[0]
                    assert "巴黎" in answer or "paris" in answer.lower(), answer
                    print(json.dumps({"answer": answer, "input_tokens": inputs, "output_tokens": outputs,
                                      "model": model, "estimated_usd": 0, "qq_transport": "simulated",
                                      "acknowledgements": 2, "messages_sent_to_simulator": 1},
                                     ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(run())

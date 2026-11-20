"""Exercise the real GUI, optimistic save and lifecycle through the signed-in Web API."""

import argparse
import hashlib
import json
import os
import secrets
import struct
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from assistant.app import create_app


def check(image):
    with tempfile.TemporaryDirectory(prefix="echo-desktop-check-") as folder:
        token = secrets.token_urlsafe(32)
        settings = {
            "ECHO_DESKTOP_IMAGE_ID": image,
            "QQ_APP_ID": "",
            "QQ_APP_SECRET": "",
            "MODEL_BASE_URL": "http://127.0.0.1:18081/v1",
            "MODEL_NAME": "local-diagnostic",
            "MODEL_API_KEY": "",
            "ASSISTANT_BUDGET_USD": "0",
        }
        with patch.dict(os.environ, settings):
            app = create_app(db_path=Path(folder) / "workspace.sqlite3", token=token, workers=False)
            with TestClient(app, headers={"Authorization": "Bearer " + token}) as client:
                project = client.post("/api/projects", json={"name": "图形验收"}).raise_for_status().json()
                base = f"/api/projects/{project['id']}"
                endpoint = base + "/desktop"
                path = base + "/files/简报.md"
                client.put(path, json={"content": "第一版", "expected_version": 0}).raise_for_status()
                session = (
                    client.post(endpoint, json={"name": "简报.md", "version": 1})
                    .raise_for_status()
                    .json()["session"]
                )
                live = endpoint + "/" + session["id"]
                try:
                    first = client.get(live + "/screen").raise_for_status().content
                    assert first[:8] == b"\x89PNG\r\n\x1a\n"
                    assert struct.unpack(">II", first[16:24]) == (1000, 650)
                    client.post(
                        live + "/input", json={"type": "key", "key": "Control_L+a"}
                    ).raise_for_status()
                    body = "编辑后的报告\n第二行来自 Linux 图形工作区"
                    client.post(live + "/input", json={"type": "text", "text": body}).raise_for_status()
                    second = client.get(live + "/screen").raise_for_status().content
                    assert first != second
                    assert client.post(live + "/save", json={}).raise_for_status().json()["version"] == 2
                    assert client.get(path).raise_for_status().json()["content"] == body
                    client.put(
                        path, json={"content": "另一设备的修改", "expected_version": 2}
                    ).raise_for_status()
                    assert client.post(live + "/save", json={}).status_code == 409
                    client.post(live + "/save", json={"target_name": "副本.md"}).raise_for_status()
                    assert client.get(base + "/files/副本.md").raise_for_status().json()["content"] == body
                    assert client.get(path).raise_for_status().json()["content"] == "另一设备的修改"
                finally:
                    client.delete(live).raise_for_status()
                assert client.get(endpoint).raise_for_status().json()["session"] is None
                return {
                    "resolution": [1000, 650],
                    "png_bytes": len(second),
                    "file_sha256": hashlib.sha256(body.encode()).hexdigest(),
                    "saved_version": 2,
                    "concurrent_save_status": 409,
                    "session_closed": True,
                }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="本机桌面镜像不可变 ID，格式 sha256:…")
    print(json.dumps(check(parser.parse_args().image), ensure_ascii=False))

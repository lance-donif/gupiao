"""Native text editor on a private X display. The CLI uses a container-local Unix socket."""

import json
import os
import socket
import subprocess
import sys
import time
import tkinter as tk
from contextlib import closing
from pathlib import Path

WIDTH, HEIGHT = 1000, 650
MAX_TEXT = 24 * 1024
MAX_COMMAND = MAX_TEXT * 6 + 4096
SOCKET = "/tmp/echo-editor.sock"
OK = b'{"ok":true}'
KEYS = {
    "BackSpace", "Delete", "Return", "Tab", "Left", "Right", "Up", "Down", "Home", "End",
    "Control_L+a", "Control_L+z", "Control_L+y", "Page_Up", "Page_Down",
}


def receive(stream, limit):
    result = bytearray()
    while chunk := stream.recv(min(65536, limit - len(result) + 1)):
        result.extend(chunk)
        if len(result) > limit:
            raise ValueError("请求或响应超过上限")
    return bytes(result)


def text_value(value):
    if not isinstance(value, str) or any(ord(c) < 32 and c not in "\n\r\t" for c in value):
        raise ValueError("需要 UTF-8 纯文本")
    if len(value.encode()) > MAX_TEXT:
        raise ValueError("文档超过 24 KiB")
    return value


class Editor:
    def __init__(self, root):
        self.root = root
        root.geometry(f"{WIDTH}x{HEIGHT}+0+0")
        root.overrideredirect(True)
        root.configure(bg="#e9e5dc")
        self.initial = None
        self.title = tk.StringVar(value="回声 · 项目编辑器")
        toolbar = tk.Frame(root, bg="#263c38", height=64)
        toolbar.pack(fill="x")
        toolbar.pack_propagate(False)
        tk.Label(toolbar, textvariable=self.title, anchor="w", bg="#263c38", fg="#ffffff",
                 font=("WenQuanYi Zen Hei", 17)).pack(side="left", padx=18, fill="x", expand=True)
        self.status = tk.StringVar(value="等待文件")
        tk.Label(toolbar, textvariable=self.status, bg="#263c38", fg="#e5f1ef",
                 font=("WenQuanYi Zen Hei", 12)).pack(side="right", padx=18)
        frame = tk.Frame(root, bg="#fbfaf6")
        frame.pack(fill="both", expand=True)
        self.body = tk.Text(frame, wrap="word", font=("WenQuanYi Zen Hei", 15), padx=18, pady=14,
                            bg="#fbfaf6", fg="#1e2927", borderwidth=0, highlightthickness=0,
                            undo=True, maxundo=80, selectbackground="#b9dcd2", selectforeground="#152c26")
        scroll = tk.Scrollbar(frame, command=self.body.yview)
        scroll.pack(side="right", fill="y")
        self.body.configure(yscrollcommand=scroll.set)
        self.body.pack(fill="both", expand=True)
        self.body.focus_force()

    def content(self):
        return self.body.get("1.0", "end-1c")

    def edit_text(self, text):
        text_value(text)
        selection = self.body.tag_ranges("sel")
        selected = self.body.get(*selection) if selection else ""
        if len(self.content().encode()) - len(selected.encode()) + len(text.encode()) > MAX_TEXT:
            raise ValueError("文档超过 24 KiB")
        self.body.edit_separator()
        if selection:
            self.body.replace(*selection, text)
            self.body.tag_remove("sel", "1.0", "end")
        else:
            self.body.insert("insert", text)
        self.body.edit_separator()
        self.body.see("insert")

    def input(self, action):
        kind = action.get("type")
        if kind == "click" and set(action) == {"type", "x", "y"}:
            x, y = action["x"], action["y"]
            if type(x) is not int or type(y) is not int or not (0 <= x < WIDTH and 0 <= y < HEIGHT):
                raise ValueError("点击坐标超出屏幕")
            widget = self.root.winfo_containing(x, y)
            if widget is not None:
                local = {"x": x - widget.winfo_rootx(), "y": y - widget.winfo_rooty()}
                widget.event_generate("<ButtonPress-1>", **local)
                widget.event_generate("<ButtonRelease-1>", **local)
        elif kind == "text" and set(action) == {"type", "text"}:
            self.edit_text(action["text"])
        elif kind == "key" and set(action) == {"type", "key"} and action["key"] in KEYS:
            key = action["key"]
            if key == "Control_L+a":
                self.body.tag_add("sel", "1.0", "end-1c")
                self.body.mark_set("insert", "end-1c")
            elif key in {"Control_L+z", "Control_L+y"}:
                try:
                    if key == "Control_L+z":
                        self.body.edit_undo()
                    else:
                        self.body.edit_redo()
                except tk.TclError:
                    pass  # No previous/next edit.
            elif key in {"Return", "Tab"}:
                self.edit_text("\n" if key == "Return" else "\t")
            else:
                symbol = {"Page_Up": "Prior", "Page_Down": "Next"}.get(key, key)
                self.body.focus_force()
                self.body.event_generate("<KeyPress>", keysym=symbol)
                self.body.event_generate("<KeyRelease>", keysym=symbol)
        else:
            raise ValueError("无法识别编辑操作")
        self.status.set("已在桌面编辑" if self.content() != self.initial[1] else "已载入")
        self.root.update_idletasks()

    def dispatch(self, verb, raw):
        if verb in ("init", "input"):
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("需要 JSON 对象")
        elif raw:
            raise ValueError("该操作无需输入")
        if verb == "init":
            if set(data) != {"name", "content"} or not isinstance(data["name"], str) or not 1 <= len(data["name"]) <= 80:
                raise ValueError("文件名无效")
            content = text_value(data["content"])
            signature = (data["name"], content)
            if self.initial is not None:
                if signature != self.initial:
                    raise ValueError("当前桌面已经载入其他文件")
                return OK
            self.initial = signature
            self.title.set(data["name"])
            self.body.insert("1.0", content)
            self.body.mark_set("insert", "1.0")
            self.body.edit_reset()
            self.body.focus_force()
            self.status.set("已载入")
            return OK
        if self.initial is None:
            raise ValueError("请先载入文档")
        if verb == "read":
            return self.content().encode()
        if verb == "input":
            self.input(data)
            return OK
        if verb == "screenshot":
            self.root.update_idletasks()
            capture = Path("/tmp/echo-display.png")
            subprocess.run(["/usr/bin/scrot", "-oz", str(capture)], check=True, timeout=4, stderr=subprocess.DEVNULL)
            return capture.read_bytes()
        raise ValueError("未知操作")


def serve():
    os.umask(0o077)
    display = subprocess.Popen(["/usr/bin/Xvfb", ":99", "-screen", "0", f"{WIDTH}x{HEIGHT}x24",
                                "-noreset", "-nolisten", "tcp"], stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while True:
            try:
                root = tk.Tk()
                break
            except tk.TclError:
                if display.poll() is not None or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        editor = Editor(root)
        with closing(socket.socket(socket.AF_UNIX)) as listener:
            listener.bind(SOCKET)
            listener.listen(8)

            def handle(_fd, _mask):
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(4)
                    try:
                        verb, raw = receive(connection, MAX_COMMAND).split(b"\n", 1)
                        result = editor.dispatch(verb.decode("ascii"), raw)
                        payload = b"\0" + result
                    except (ValueError, TypeError, KeyError):
                        payload = b"\1" + "无效的编辑请求或文档超过限制".encode()
                    except (OSError, subprocess.SubprocessError, tk.TclError):
                        payload = b"\1" + "图形桌面暂时不可用".encode()
                    try:
                        connection.sendall(payload)
                    except OSError:
                        pass  # The HTTP client may have canceled its screenshot.

            root.createfilehandler(listener.fileno(), tk.READABLE, handle)
            root.after(1800 * 1000, root.destroy)
            root.mainloop()
    finally:
        display.terminate()
        display.wait(timeout=3)


def client(verb):
    raw = sys.stdin.buffer.read(MAX_COMMAND + 1) if verb in ("init", "input") else b""
    if len(raw) > MAX_COMMAND:
        raise ValueError("请求过大")
    with closing(socket.socket(socket.AF_UNIX)) as stream:
        stream.settimeout(6)
        deadline = time.monotonic() + 6
        while True:
            try:
                stream.connect(SOCKET)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                if time.monotonic() >= deadline:
                    raise ValueError("图形桌面未就绪") from None
                time.sleep(0.10)
        stream.sendall(verb.encode() + b"\n" + raw)
        stream.shutdown(socket.SHUT_WR)
        result = receive(stream, 4 * 1024 * 1024)
    if not result or result[0] != 0:
        raise ValueError(result[1:].decode() or "编辑进程未响应")
    sys.stdout.buffer.write(result[1:])


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["serve"]:
            serve()
        elif len(sys.argv) == 2 and sys.argv[1] in {"init", "input", "read", "screenshot"}:
            client(sys.argv[1])
        else:
            sys.exit("unknown operation")
    except (OSError, ValueError, tk.TclError, subprocess.SubprocessError) as error:
        sys.exit(str(error))

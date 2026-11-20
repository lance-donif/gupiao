import { $, action, el, formField, panel, showError } from "./ui.js";

const shortcuts = [
  ["全选", "Control_L+a"],
  ["撤销", "Control_L+z"],
  ["重做", "Control_L+y"],
  ["退格", "BackSpace"],
  ["换行", "Return"],
  ["行首", "Home"],
  ["行尾", "End"],
  ["左移", "Left"],
  ["右移", "Right"],
  ["上移", "Up"],
  ["下移", "Down"],
];
const navigation = {
  Backspace: "BackSpace",
  Delete: "Delete",
  Enter: "Return",
  Home: "Home",
  End: "End",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
};

function current(box) {
  return box.isConnected && $("panel").open;
}

export async function addDesktopResume(api, pid, box, back) {
  try {
    const status = await api("status");
    if (!current(box) || !status.desktop_configured) return;
    const { session } = await api("projects/" + encodeURIComponent(pid) + "/desktop");
    if (current(box) && session) {
      box.append(
        action("继续 Linux 工作区 · " + session.name, () =>
          openDesktop(api, pid, session, back, true),
        ),
      );
    }
  } catch {
    // Project files remain usable if the optional desktop service is offline.
  }
}

export async function openDesktop(api, pid, file, back, resumeOnly = false) {
  const root = "projects/" + encodeURIComponent(pid);
  const endpoint = root + "/desktop";
  const box = panel("Linux 工作区");
  box.classList.add("desktop-pane");
  box.textContent = "正在连接 Linux 工作区…";
  try {
    const info = await api(endpoint);
    if (!current(box)) return;
    if (!info.enabled) throw new Error("服务器尚未启用 Linux 工作区。");
    let session = info.session;
    if (resumeOnly && session?.id !== file.id) {
      throw new Error("原来的 Linux 会话已结束或已被替换。请返回项目，重新选择要进入的会话。");
    }
    if (!session) {
      session = (
        await api(endpoint, {
          method: "POST",
          body: { name: file.name, version: file.version },
        })
      ).session;
    }
    if (!current(box)) return;
    if (session.name !== file.name || session.version !== file.version) {
      box.replaceChildren(
        el(
          "p",
          `你选择了「${file.name}」v${file.version}。已有的 Linux 会话正在编辑「${session.name}」v${session.version}。`,
        ),
      );
      box.append(
        action(
          `继续编辑「${session.name}」v${session.version}`,
          () => workspace(api, root, endpoint, session, box, back),
          "primary",
        ),
        action("返回项目文件", back),
      );
    } else workspace(api, root, endpoint, session, box, back);
  } catch (error) {
    if (!current(box)) return;
    box.replaceChildren(action("返回项目文件", back));
    showError(box, error);
  }
}

function workspace(api, root, endpoint, session, box, back) {
  const path = endpoint + "/" + encodeURIComponent(session.id);
  const info = el("p", "", "hint");
  const expires = new Date(session.expires_at);
  function updateInfo() {
    info.textContent =
      session.name +
      " · v" +
      session.version +
      (Number.isFinite(expires.valueOf())
        ? " · 会话到期 " + expires.toLocaleTimeString("zh-CN")
        : "");
  }
  updateInfo();
  const frame = el("img");
  frame.alt = "Linux 编辑器实时画面";
  frame.width = session.width;
  frame.height = session.height;
  frame.draggable = false;
  const screen = el("button", null, "desktop-screen");
  screen.type = "button";
  screen.setAttribute("aria-label", "Linux 编辑器画面，可点击定位光标或使用方向键");
  screen.append(frame);
  const viewport = el("div", null, "desktop-viewport");
  viewport.append(screen);

  const feedback = el("p", "", "hint");
  feedback.setAttribute("role", "status");
  const toolbar = el("div", null, "desktop-actions");
  const paste = el("form");
  const text = el("textarea");
  text.rows = 2;
  text.required = true;
  text.maxLength = 24576;
  formField(paste, "插入文本", text);
  const insert = el("button", "发送到编辑器", "secondary");
  insert.type = "submit";
  paste.append(insert);

  const saveArea = el("div");
  const saveControls = el("div", null, "desktop-actions");
  const conflict = el("section", null, "version-conflict");
  conflict.hidden = true;
  const sessionActions = el("div", null, "desktop-actions");
  const confirmStop = el("div", null, "version-conflict");
  confirmStop.hidden = true;
  const leave = action("离开工作区", back);
  sessionActions.append(leave);
  saveArea.append(saveControls, conflict);
  box.replaceChildren(
    info,
    viewport,
    toolbar,
    paste,
    saveArea,
    feedback,
    sessionActions,
    confirmStop,
  );

  let frameUrl,
    timer,
    screenSequence = 0,
    closed = false,
    stopped = false,
    busy = false,
    polling = false;
  const inputs = [text, insert];
  const dialog = $("panel");
  const observer = new MutationObserver(() => {
    if (!current(box)) cleanup();
  });
  observer.observe($("panel-body"), { childList: true });
  dialog.addEventListener("close", cleanup);
  function cleanup() {
    closed = true;
    clearInterval(timer);
    observer.disconnect();
    dialog.removeEventListener("close", cleanup);
    if (frameUrl) URL.revokeObjectURL(frameUrl);
  }

  function availability() {
    for (const input of inputs) input.disabled = busy || stopped;
    screen.setAttribute("aria-disabled", String(busy || stopped || !frameUrl));
    leave.disabled = busy;
  }
  function failure(error) {
    if (closed) return;
    if (error.reason === "desktop_session" || error.status === 404) {
      // A different request can hold the session lock briefly. Only mark the editor
      // expired when the server confirms that this specific session is gone.
      void api(endpoint)
        .then(({ session: active }) => {
          if (!closed && active?.id !== session.id) {
            stopped = true;
            availability();
            clearInterval(timer);
          }
        })
        .catch(() => {});
    }
    showError(box, error);
  }

  async function refresh() {
    if (!current(box) || stopped) return;
    const sequence = ++screenSequence;
    const blob = await api(path + "/screen", { raw: "blob" });
    if (closed || !current(box) || sequence !== screenSequence) return;
    if (blob.type.split(";")[0] !== "image/png") throw new Error("工作区未返回有效的 PNG 画面。");
    const next = URL.createObjectURL(blob);
    frame.src = next;
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = next;
    availability();
  }

  async function run(operation) {
    if (busy || stopped || closed) return;
    busy = true;
    ++screenSequence;
    box.querySelector(":scope > .form-error")?.remove();
    feedback.textContent = "";
    availability();
    try {
      await operation();
    } catch (error) {
      failure(error);
    } finally {
      busy = false;
      availability();
    }
  }

  async function input(body) {
    await api(path + "/input", { method: "POST", body });
    if (body.type === "text" && text.value === body.text) text.value = "";
    feedback.textContent = "已发送到 Linux 编辑器。";
    await refresh();
  }
  screen.onclick = (event) => {
    if (!event.detail || !frameUrl || !frame.naturalWidth) return;
    const bounds = frame.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = Math.min(
      session.width - 1,
      Math.max(0, Math.floor(((event.clientX - bounds.left) * session.width) / bounds.width)),
    );
    const y = Math.min(
      session.height - 1,
      Math.max(0, Math.floor(((event.clientY - bounds.top) * session.height) / bounds.height)),
    );
    void run(() => input({ type: "click", x, y }));
  };
  screen.onkeydown = (event) => {
    const modified = event.ctrlKey || event.metaKey;
    if (event.altKey || event.shiftKey || event.isComposing) return;
    const key = modified
      ? { a: "Control_L+a", z: "Control_L+z", y: "Control_L+y" }[event.key.toLowerCase()]
      : navigation[event.key];
    if (!key) return;
    event.preventDefault();
    void run(() => input({ type: "key", key }));
  };

  function control(parent, label, fn, className = "inline-action") {
    const button = action(label, () => run(fn), className);
    inputs.push(button);
    parent.append(button);
    return button;
  }
  for (const [label, key] of shortcuts) control(toolbar, label, () => input({ type: "key", key }));
  control(toolbar, "刷新画面", refresh);
  const zoom = action(
    "原始大小",
    () => {
      const native = zoom.getAttribute("aria-pressed") !== "true";
      zoom.setAttribute("aria-pressed", String(native));
      screen.style.width = native ? session.width + 2 + "px" : "";
    },
    "inline-action",
  );
  zoom.setAttribute("aria-pressed", "false");
  toolbar.append(zoom);
  paste.onsubmit = (event) => {
    event.preventDefault();
    const value = text.value;
    if (!value.length) return;
    if (new TextEncoder().encode(value).length > 24576) {
      failure(new Error("单次插入文本最大 24 KiB。"));
      return;
    }
    void run(() => input({ type: "text", text: value }));
  };

  async function save(target) {
    let result;
    try {
      result = await api(path + "/save", {
        method: "POST",
        body: target ? { target_name: target } : {},
      });
    } catch (error) {
      if (error.status !== 409 || error.reason !== "file_version") throw error;
      await showConflict(target || session.name, error);
      return;
    }
    if (!target) session.version = result.version;
    updateInfo();
    conflict.hidden = true;
    feedback.textContent = `已保存「${result.name}」v${result.version}。`;
    if (target) feedback.textContent += ` 此会话仍在编辑「${session.name}」。`;
  }
  async function showConflict(name, error) {
    conflict.hidden = false;
    conflict.replaceChildren(el("p", error.message + "。桌面中的内容仍保留，可另存为新文件。"));
    const compare = el("details");
    try {
      const latest = await api(root + "/files/" + encodeURIComponent(name));
      compare.append(
        el("summary", `对照「${latest.name}」v${latest.version}`),
        el("pre", latest.content, "artifact"),
      );
      conflict.append(compare);
    } catch (readError) {
      if (readError.status !== 404) throw readError;
    }
    saveAs.hidden = false;
    newName.focus();
  }
  control(saveControls, "保存到项目", () => save(), "primary");
  const saveAs = el("form");
  saveAs.hidden = true;
  const newName = el("input");
  newName.required = true;
  newName.maxLength = 75;
  const dot = session.name.lastIndexOf(".");
  newName.value = session.name.slice(0, dot) + "-副本" + session.name.slice(dot);
  formField(saveAs, "新文件名", newName);
  const submit = el("button", "保存副本", "primary");
  submit.type = "submit";
  saveAs.append(submit);
  saveAs.onsubmit = (event) => {
    event.preventDefault();
    const target = newName.value.trim();
    if (!target || target.toLowerCase() === session.name.toLowerCase()) {
      failure(new Error("请填写一个新的文件名。"));
      return;
    }
    void run(() => save(target));
  };
  inputs.push(submit, newName);
  control(saveControls, "另存为", async () => {
    saveAs.hidden = false;
  });
  saveArea.append(saveAs);

  control(
    sessionActions,
    "结束会话",
    async () => {
      confirmStop.hidden = false;
    },
    "danger",
  );
  confirmStop.append(el("p", "结束会话将删除 Linux 工作区和其中尚未保存的修改。"));
  control(
    confirmStop,
    "确认结束并丢弃未保存修改",
    async () => {
      await api(path, { method: "DELETE" });
      stopped = true;
      cleanup();
      await back();
    },
    "danger",
  );
  confirmStop.append(
    action("继续编辑", () => {
      confirmStop.hidden = true;
    }),
  );
  availability();
  const poll = async () => {
    if (document.hidden || busy || polling || stopped || closed) return;
    polling = true;
    try {
      await refresh();
    } catch (error) {
      failure(error);
    } finally {
      polling = false;
    }
  };
  timer = setInterval(poll, 6000);
  void poll();
}

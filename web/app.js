import {
  $,
  el,
  action,
  messageNode,
  formField,
  submitButton,
  panel,
  showError,
  confirmAction,
} from "./ui.js";
import { sessionToken, rememberToken, request, requestId } from "./api.js";
import { setupPanels } from "./panels.js";

const state = {
  token: sessionToken(),
  conversations: [],
  current: null,
  messages: [],
  status: null,
  mode: "chat",
  busy: false,
  loading: false,
  view: 0,
  retry: null,
};
const navQuery = matchMedia("(max-width:760px)");

function sidebar(open = false) {
  const visible = open && navQuery.matches;
  document.body.classList.toggle("nav-open", visible);
  $("scrim").hidden = !visible;
  document.querySelector("main").inert = visible;
  $("open-nav").setAttribute("aria-expanded", String(visible));
  if (visible) $("close-nav").focus();
}
navQuery.addEventListener("change", () => sidebar());
$("open-nav").onclick = () => sidebar(true);
$("close-nav").onclick = $("scrim").onclick = () => {
  sidebar();
  $("open-nav").focus();
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("panel").open && document.body.classList.contains("nav-open")) {
    sidebar();
    $("open-nav").focus();
  }
});
$("close-panel").onclick = () => $("panel").close();

function feedback(text = "") {
  $("feedback").textContent = text;
  $("feedback").hidden = !text;
}

function updateAccount() {
  const connected = Boolean(state.token);
  $("account-name").textContent = connected ? "当前工作区" : "连接工作台";
  $("account-note").textContent = connected ? "管理登录会话" : "使用访问令牌登录";
  const modelReady = connected && state.status?.model_configured;
  $("status").dataset.ready = String(Boolean(modelReady));
  $("status").querySelector("span").textContent = !connected
    ? "尚未连接"
    : modelReady
      ? "模型已配置"
      : state.status
        ? "模型待配置"
        : "工作区已连接";
}

function renderHistory() {
  const box = $("history-list");
  box.replaceChildren();
  if (!state.conversations.length) {
    box.append(el("p", state.token ? "还没有对话" : "登录后查看对话"));
    return;
  }
  for (const item of state.conversations) {
    const selected = String(item.id) === String(state.current);
    const row = el("div", null, "hist-row" + (selected ? " selected" : ""));
    const title = item.title || "新对话";
    const open = action(title, () => openConversation(item.id), "hist-open");
    open.title = title;
    if (selected) open.setAttribute("aria-current", "page");
    const remove = action(
      "×",
      () => {
        if (state.busy) return;
        confirmAction(
          "删除对话",
          "将删除「" + title + "」及其中的消息和关联任务。",
          "删除对话",
          async () => {
            await api("conversations/" + encodeURIComponent(item.id), { method: "DELETE" });
            if (String(state.current) === String(item.id)) newChat();
            state.conversations = state.conversations.filter(
              (other) => String(other.id) !== String(item.id),
            );
            renderHistory();
            $("panel").close();
          },
        );
      },
      "hist-remove",
    );
    remove.setAttribute("aria-label", "删除对话：" + title);
    open.disabled = remove.disabled = state.busy;
    row.append(open, remove);
    box.append(row);
  }
}

function updateTitle() {
  $("page-title").textContent =
    state.conversations.find((item) => String(item.id) === String(state.current))?.title ||
    "新对话";
}

function scrollBottom() {
  const pane = $("scroll-pane");
  pane.scrollTop = pane.scrollHeight;
}

function renderMessages(pendingText) {
  const box = $("messages");
  box.replaceChildren();
  for (const message of state.messages) box.append(messageNode(message));
  if (pendingText) {
    box.append(messageNode({ role: "user", content: pendingText }));
    const waiting = el(
      "div",
      state.mode === "research" ? "正在检索并整理回答…" : "回声正在回答…",
      "pending",
    );
    waiting.setAttribute("role", "status");
    box.append(waiting);
  }
  const empty = !box.childNodes.length;
  $("welcome").hidden = !empty;
  box.hidden = empty;
  scrollBottom();
}

function controls() {
  $("send").disabled = state.busy || state.loading || !$("prompt").value.trim();
  $("prompt").readOnly = state.busy;
  $("new-chat").disabled = state.busy;
  $("account").disabled = state.busy;
  for (const button of document.querySelectorAll(".mode-switch button, .starters button"))
    button.disabled = state.busy;
  $("compose").setAttribute("aria-busy", String(state.busy));
  renderHistory();
}

function draft(value) {
  $("prompt").value = value;
  $("prompt").style.height = "auto";
  $("prompt").style.height = Math.min($("prompt").scrollHeight, 150) + "px";
  controls();
}

function newChat() {
  if (state.busy) return;
  state.view++;
  state.loading = false;
  state.current = null;
  state.messages = [];
  state.retry = null;
  draft("");
  feedback();
  updateTitle();
  renderMessages();
  sidebar();
  $("prompt").focus();
}

function clearSession() {
  state.token = "";
  state.status = null;
  state.conversations = [];
  state.busy = false;
  rememberToken("");
  newChat();
  updateAccount();
}

async function api(path, options = {}) {
  const token = state.token;
  try {
    return await request(path, { ...options, token });
  } catch (error) {
    if ((error.status === 401 || error.status === 403) && state.token === token) {
      clearSession();
      $("panel").close();
      feedback("连接权限已失效，请重新登录。");
    }
    throw error;
  }
}

async function refreshConversations() {
  const token = state.token;
  const items = await api("conversations");
  if (token !== state.token) return;
  state.conversations = items;
  renderHistory();
  updateTitle();
}

async function refreshStatus() {
  const token = state.token;
  const data = await api("status");
  if (token !== state.token) return;
  state.status = data;
  updateAccount();
}

function login(after) {
  const box = panel("连接工作台");
  box.append(el("p", "输入管理员分配的访问令牌。此登录仅在当前标签页保留。"));
  const form = el("form");
  const input = el("input");
  input.type = "password";
  input.required = true;
  input.autocomplete = "off";
  input.spellcheck = false;
  formField(form, "访问令牌", input);
  const button = submitButton(form, "连接");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (!token || button.disabled) return;
    button.disabled = true;
    try {
      const list = await request("conversations", { token });
      if (!box.isConnected || !$("panel").open) return;
      state.token = token;
      rememberToken(token);
      state.conversations = list;
      input.value = "";
      $("panel").close();
      updateAccount();
      renderHistory();
      feedback();
      refreshStatus().catch((error) => feedback(error.message));
      if (after) await after();
    } catch (error) {
      showError(form, error);
    } finally {
      button.disabled = false;
    }
  };
  box.append(form);
  input.focus();
}

function connected(fn) {
  sidebar();
  if (state.token) void fn();
  else login(fn);
}

async function openConversation(id) {
  if (state.busy) {
    feedback("当前回答完成后即可切换对话。");
    return;
  }
  sidebar();
  const view = ++state.view;
  state.loading = true;
  state.current = id;
  state.messages = [];
  state.retry = null;
  draft("");
  feedback("正在加载对话…");
  updateTitle();
  renderMessages();
  $("send").disabled = true;
  try {
    const messages = await api("conversations/" + encodeURIComponent(id) + "/messages");
    if (view !== state.view) return;
    state.messages = messages;
    feedback();
    renderMessages();
  } catch (error) {
    if (view === state.view) {
      state.current = null;
      updateTitle();
      renderHistory();
      feedback(error.message);
    }
  } finally {
    if (view === state.view) {
      state.loading = false;
      controls();
    }
  }
}

function mode(value) {
  state.mode = value;
  for (const button of document.querySelectorAll(".mode-switch button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === value));
  }
}
for (const button of document.querySelectorAll(".mode-switch button")) {
  button.onclick = () => mode(button.dataset.mode);
}
for (const button of document.querySelectorAll(".starters button")) {
  button.onclick = () => {
    mode(button.dataset.mode);
    draft(button.dataset.text);
    $("prompt").focus();
  };
}

async function send() {
  const text = $("prompt").value.trim();
  if (state.busy || state.loading || !text) return;
  if (!state.token) {
    login(send);
    return;
  }
  const token = state.token;
  state.busy = true;
  controls();
  feedback();
  try {
    if (!state.current) {
      const row = await api("conversations", {
        method: "POST",
        body: { title: text.slice(0, 48) },
      });
      state.current = row.id;
      state.conversations.unshift(row);
      updateTitle();
      renderHistory();
    }
    const id = state.current;
    if (
      !state.retry ||
      state.retry.id !== id ||
      state.retry.text !== text ||
      state.retry.mode !== state.mode
    ) {
      state.retry = {
        id,
        text,
        mode: state.mode,
        key: requestId(),
      };
    }
    renderMessages(text);
    const response = await api("conversations/" + encodeURIComponent(id) + "/messages", {
      method: "POST",
      body: { text, mode: state.mode, request_id: state.retry.key },
    });
    if (token !== state.token) return;
    state.messages.push({ role: "user", content: text }, response);
    state.retry = null;
    draft("");
    renderMessages();
    feedback("已收到回复。");
    refreshConversations().catch((error) => feedback(error.message));
  } catch (error) {
    if (state.token === token) {
      renderMessages();
      feedback("消息未确认，输入内容已保留。" + error.message);
    }
  } finally {
    state.busy = false;
    controls();
  }
}

$("compose").onsubmit = (event) => {
  event.preventDefault();
  void send();
};
$("prompt").oninput = () => {
  $("prompt").style.height = "auto";
  $("prompt").style.height = Math.min($("prompt").scrollHeight, 150) + "px";
  $("send").disabled = state.busy || state.loading || !$("prompt").value.trim();
};
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    void send();
  }
};
$("new-chat").onclick = () => {
  newChat();
  mode("chat");
};
$("account").onclick = () => {
  sidebar();
  if (!state.token) {
    login();
    return;
  }
  const box = panel("工作区会话");
  box.append(
    el("p", "当前标签页已连接工作区。"),
    action(
      "退出登录",
      () => {
        clearSession();
        $("panel").close();
      },
      "secondary",
    ),
  );
};
const panels = setupPanels({ api, openConversation, refreshConversations });
for (const name of ["memories", "documents", "budget", "services", "tasks"]) {
  $("show-" + name).onclick = () => connected(panels[name]);
}
$("status").onclick = () => connected(panels.services);
updateAccount();
renderHistory();
if (state.token) {
  Promise.all([refreshConversations(), refreshStatus()]).catch((error) => feedback(error.message));
}

import { requestId } from "./api.js";
import {
  $,
  el,
  action,
  panel,
  formField,
  submitButton,
  detailList,
  showError,
  confirmAction,
} from "./ui.js";

const usd = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});
const money = (value) =>
  value != null && Number.isFinite(Number(value)) ? usd.format(Number(value)) : "未知";
const taskStates = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  paused: "已暂停",
};
const kinds = { research: "联网研究", draft: "撰写文稿", office: "文件工作" };
const cycles = { once: "仅一次", daily: "每天", weekly: "每周" };

async function loadPanel(title, fetchData, render) {
  const box = panel(title);
  box.textContent = "加载中…";
  try {
    const data = await fetchData();
    if (box.isConnected && $("panel").open) {
      box.replaceChildren();
      render(box, data);
    }
  } catch (error) {
    box.replaceChildren();
    showError(box, error);
  }
}

function submit(form, button, fn) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      showError(form, error);
    } finally {
      button.disabled = false;
    }
  });
}

function selector(options) {
  const select = el("select");
  for (const [value, text] of Object.entries(options)) select.add(new Option(text, value));
  return select;
}

function taskFileError(files) {
  if (files.length > 4) return "每个任务最多可添加四个源文件。";
  const names = new Set();
  for (const file of files) {
    if (!/\.(md|txt|csv)$/.test(file.name))
      return file.name + " 需要使用 .md、.txt 或 .csv 扩展名。";
    if (file.size > 24 * 1024) return file.name + " 超过 24 KiB。";
    if (names.has(file.name)) return "文件名重复：" + file.name;
    names.add(file.name);
  }
  return "";
}

async function readTaskFiles(files) {
  const error = taskFileError(files);
  if (error) throw new Error(error);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const result = [];
  for (const file of files) {
    let content;
    try {
      content = decoder.decode(await file.arrayBuffer());
    } catch {
      throw new Error(file.name + " 需要使用 UTF-8 编码。");
    }
    if (!content.trim()) throw new Error(file.name + " 缺少文本内容。");
    result.push({ name: file.name, content });
  }
  return result;
}

export function setupPanels({ api, openConversation, refreshConversations }) {
  const memories = () =>
    loadPanel(
      "长期记忆",
      () => api("memories"),
      (box, entries) => {
        box.append(el("p", "保存希望回声在此后对话中记住的信息。"));
        const form = el("form");
        const input = el("input");
        input.required = true;
        input.maxLength = 2000;
        input.placeholder = "例如：我喜欢简短的回答";
        formField(form, "新记忆", input);
        submit(form, submitButton(form, "保存记忆"), async () => {
          await api("memories", { method: "POST", body: { content: input.value.trim() } });
          await memories();
        });
        box.append(form, el("h3", "已保存", "panel-section"));
        if (!entries.length) box.append(el("p", "还没有保存记忆。", "hint"));
        for (const item of entries) {
          const row = el("div", null, "memory-row");
          row.append(
            el("span", item.content),
            action(
              "删除",
              () =>
                confirmAction("删除记忆", item.content, "删除记忆", async () => {
                  await api("memories/" + encodeURIComponent(item.id), { method: "DELETE" });
                  await memories();
                }),
              "",
            ),
          );
          box.append(row);
        }
      },
    );

  const documents = () =>
    loadPanel(
      "知识文件",
      () => api("documents"),
      (box, entries) => {
        const form = el("form");
        const input = el("input");
        input.type = "file";
        input.accept = ".txt,.md,text/plain,text/markdown";
        input.required = true;
        formField(form, "添加 UTF-8 文本或 Markdown 文件", input);
        submit(form, submitButton(form, "上传文件"), async () => {
          const file = input.files[0];
          if (!file || !/\.(txt|md)$/i.test(file.name))
            throw new Error("请选择 .md 或 .txt 文件。");
          if (file.size > 256 * 1024) throw new Error("每个文件最大 256 KiB。");
          let content;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          } catch {
            throw new Error("文件需要使用 UTF-8 编码。");
          }
          await api("documents", { method: "POST", body: { name: file.name, content } });
          await documents();
        });
        box.append(form, el("h3", "文件列表", "panel-section"));
        if (!entries.length) box.append(el("p", "还没有上传文件。", "hint"));
        for (const item of entries) {
          const row = el("div", null, "memory-row");
          row.append(
            el("span", item.name),
            action(
              "删除",
              () =>
                confirmAction("删除文件", item.name, "删除文件", async () => {
                  await api("documents/" + encodeURIComponent(item.id), { method: "DELETE" });
                  await documents();
                }),
              "",
            ),
          );
          box.append(row);
        }
      },
    );

  const budget = () =>
    loadPanel(
      "用量与额度",
      () => api("budget"),
      (box, data) => {
        box.append(
          detailList([
            ["预算上限", money(data.limit_usd)],
            ["本地已记账", money(data.booked_usd)],
            ["其中用量估算", money(data.estimated)],
            ["其中已核账", money(data.reconciled)],
            ["预留金额", money(data.held_usd)],
            ["剩余可用", money(data.available_usd)],
          ]),
          el(
            "p",
            "估算按模型用量和配置的价格计算。预留金额用于覆盖待确认请求，实际费用以供应商账单为准。",
            "hint",
          ),
        );
      },
    );

  const services = () =>
    loadPanel(
      "服务连接",
      async () => {
        const data = await api("status");
        const link = data.qq_configured ? await api("qq/link") : { linked: false };
        return { data, link };
      },
      (box, { data, link }) => {
        box.append(
          detailList([
            ["模型", data.model || "尚未指定"],
            ["模型配置", data.model_configured ? "已配置" : "未配置"],
            ["联网检索", data.search || "未配置"],
            ["QQ 机器人", data.qq_configured ? "已配置" : "未配置"],
          ]),
          el("p", "连接配置由工作台管理员在服务端管理。", "hint"),
        );
        if (!data.qq_configured) return;
        box.append(el("h3", "QQ 私聊绑定", "panel-section"));
        if (link.linked) {
          box.append(
            el("p", "已绑定至当前工作区。"),
            action("解除绑定", () =>
              confirmAction(
                "解除 QQ 绑定",
                "此 QQ 私聊将停止访问当前工作区。",
                "解除绑定",
                async () => {
                  await api("qq/link", { method: "DELETE" });
                  await services();
                },
              ),
            ),
          );
          return;
        }
        box.append(
          el("p", "绑定后，QQ 私聊可以访问此工作区的内容。只在自己的机器人私聊中使用绑定码。"),
        );
        const generate = action(
          "生成绑定码",
          async () => {
            generate.disabled = true;
            try {
              const code = await api("qq/link-code", { method: "POST" });
              box.querySelector(".link-code")?.remove();
              const output = el("div", null, "link-code");
              output.setAttribute("role", "status");
              output.append(
                el("p", "请在 10 分钟内向机器人私聊发送以下命令。"),
                el("code", "/绑定 " + code.code),
              );
              box.append(output);
            } catch (error) {
              showError(box, error);
            } finally {
              generate.disabled = false;
            }
          },
          "primary",
        );
        box.append(generate, action("刷新绑定状态", services, "secondary"));
      },
    );

  async function artifact(task, download) {
    const text = await api("tasks/" + encodeURIComponent(task.id) + "/artifact", { raw: true });
    if (!download) {
      const box = panel("任务成果");
      box.append(action("返回任务", tasks), el("pre", text, "artifact"));
      return;
    }
    saveBlob(
      new Blob([text], { type: "text/markdown;charset=utf-8" }),
      "echo-task-" + task.id + ".md",
    );
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const tasks = () =>
    loadPanel(
      "后台任务",
      () => api("tasks"),
      (box, entries) => {
        const form = el("form");
        const input = el("textarea");
        input.required = true;
        input.placeholder = "描述研究问题、文稿要求或文件任务…";
        const frequency = selector(cycles);
        const kind = selector(kinds);
        input.maxLength = 4000;
        formField(form, "任务内容", input);
        formField(form, "类型", kind);
        formField(form, "执行频率", frequency);
        const attachmentArea = el("div");
        const picker = el("input");
        picker.type = "file";
        picker.accept = ".md,.txt,.csv";
        picker.multiple = true;
        formField(attachmentArea, "源文件（可选）", picker);
        const help = el(
          "p",
          "可添加最多 4 个 UTF-8 文本、Markdown 或 CSV 文件，每个不超过 24 KiB。",
          "hint",
        );
        help.id = "task-file-hint";
        picker.setAttribute("aria-describedby", help.id);
        const selection = el("p", "", "hint");
        selection.setAttribute("role", "status");
        selection.setAttribute("aria-live", "polite");
        picker.onchange = () => {
          const files = Array.from(picker.files);
          const error = taskFileError(files);
          picker.setCustomValidity(error);
          selection.textContent = error || files.map((file) => file.name).join("、");
          selection.className = error ? "form-error" : "hint";
        };
        kind.onchange = () => {
          picker.disabled = kind.value !== "office";
          attachmentArea.hidden = picker.disabled;
        };
        kind.onchange();
        attachmentArea.append(help, selection);
        form.append(attachmentArea);
        let previousPayload, previousRequest;
        submit(form, submitButton(form, "创建任务"), async () => {
          const body = { prompt: input.value.trim(), kind: kind.value, frequency: frequency.value };
          if (kind.value === "office") body.files = await readTaskFiles(Array.from(picker.files));
          const payload = JSON.stringify(body);
          if (payload !== previousPayload) {
            previousPayload = payload;
            previousRequest = requestId();
          }
          await api("tasks", { method: "POST", body: { ...body, request_id: previousRequest } });
          picker.value = "";
          await Promise.all([tasks(), refreshConversations()]);
        });
        const title = el("h3", "任务列表", "panel-section");
        title.append(action("刷新状态", tasks, "inline-action"));
        box.append(form, title);
        if (!entries.length) box.append(el("p", "还没有后台任务。", "hint"));
        for (const task of entries) {
          const row = el("section", null, "task-row");
          row.append(
            el("h3", task.prompt),
            el(
              "small",
              [
                kinds[task.kind || "research"] || task.kind,
                cycles[task.frequency],
                taskStates[task.status] || task.status,
              ].join(" · "),
            ),
          );
          if (task.next_run_at) {
            const next = new Date(task.next_run_at);
            if (!Number.isNaN(next.valueOf()))
              row.append(el("small", "下次执行 " + next.toLocaleString("zh-CN")));
          }
          if (task.last_error) row.append(el("small", task.last_error));
          const buttons = el("div", null, "task-actions");
          const path = "tasks/" + encodeURIComponent(task.id);
          const addAction = (label, fn, target = buttons) => {
            const btn = action(
              label,
              async () => {
                btn.disabled = true;
                try {
                  await fn();
                } catch (error) {
                  showError(row, error);
                } finally {
                  btn.disabled = false;
                }
              },
              "",
            );
            target.append(btn);
          };
          if (task.has_artifact) {
            addAction("查看成果", () => artifact(task, false));
            addAction("下载 Markdown", () => artifact(task, true));
            addAction("下载 Word", async () => {
              const blob = await api(path + "/artifact?format=docx", { raw: "blob" });
              saveBlob(blob, "echo-task-" + task.id + ".docx");
            });
          }
          if (task.conversation_id)
            addAction("查看对话", async () => {
              $("panel").close();
              await openConversation(task.conversation_id);
            });
          if (["paused", "failed"].includes(task.status))
            addAction("恢复执行", async () => {
              await api(path + "/resume", { method: "POST" });
              await tasks();
            });
          else if (task.frequency !== "once" || ["queued", "running"].includes(task.status))
            addAction("暂停", async () => {
              await api(path + "/pause", { method: "POST" });
              await tasks();
            });
          addAction("删除", () =>
            confirmAction(
              "删除任务",
              "将移除任务和可下载的成果，并停止后续执行。",
              "删除任务",
              async () => {
                await api(path, { method: "DELETE" });
                await tasks();
              },
            ),
          );
          if (task.activity?.length || task.files?.length) {
            const details = el("details");
            details.append(el("summary", "执行步骤与文件"));
            if (task.activity?.length) {
              const steps = el("ol");
              for (const step of task.activity) steps.append(el("li", step));
              details.append(steps);
            }
            for (const file of task.files || []) {
              const url = path + "/files/" + encodeURIComponent(file.name);
              addAction(
                "下载 " + file.name,
                async () => {
                  saveBlob(await api(url, { raw: "blob" }), file.name);
                },
                details,
              );
              const format = /\.csv$/i.test(file.name)
                ? "xlsx"
                : /\.(?:md|txt)$/i.test(file.name)
                  ? "docx"
                  : null;
              if (format) {
                const filename = file.name.replace(/\.[^.]+$/, "." + format);
                addAction(
                  "下载 " + filename,
                  async () => {
                    saveBlob(await api(url + "?format=" + format, { raw: "blob" }), filename);
                  },
                  details,
                );
              }
            }
            row.append(details);
          }
          row.append(buttons);
          box.append(row);
        }
      },
    );

  return { memories, documents, tasks, services, budget };
}

import { addDesktopResume, openDesktop } from "./desktop.js";
import { action, confirmAction, el, formField, panel, showError, submitButton } from "./ui.js";

const segment = encodeURIComponent;
const projectPath = (id) => "projects/" + segment(id);
const filePath = (pid, name) => projectPath(pid) + "/files/" + segment(name);

function projectSelect(label, items) {
  const select = el("select");
  select.add(new Option(label, ""));
  for (const item of items) select.add(new Option(item.name, item.id));
  return select;
}

function validFile(name, text) {
  if (!/\.(md|txt|csv)$/.test(name.trim()))
    throw new Error("文件名需要以 .md、.txt 或 .csv 结尾。");
  if (!text.trim()) throw new Error("请输入文件内容。");
  if (new TextEncoder().encode(text).length > 24 * 1024)
    throw new Error("单个项目文件最大 24 KiB。");
}

async function showVersionConflict(api, projectId, name, form, expected, onAccept) {
  let current;
  try {
    current = await api(filePath(projectId, name));
  } catch (error) {
    if (error.status !== 404) throw error;
    await api(projectPath(projectId));
  }
  form.querySelector(".version-conflict")?.remove();
  const section = el("section", null, "version-conflict");
  section.setAttribute("role", "alert");
  const version = current?.version ?? 0;
  const explanation = current
    ? `版本冲突。你选择的是 v${expected}，项目文件现为 v${version}。当前内容已保留。`
    : "项目中的文件已删除。当前内容已保留，可以重新创建文件。";
  section.append(el("p", explanation));
  if (current) {
    const details = el("details");
    details.append(el("summary", "对照项目中的最新内容"), el("pre", current.content, "artifact"));
    section.append(details);
  }
  section.append(
    action(
      current ? `基于 v${version} 继续` : "以新文件继续",
      () => {
        onAccept(version);
        section.remove();
      },
      "secondary",
    ),
  );
  form.append(section);
  section.querySelector("summary, button").focus();
}

export function projectPanels({ api, loadPanel, submit }) {
  const projects = () =>
    loadPanel(
      "项目",
      () => api("projects"),
      (box, items) => {
        const form = el("form");
        const input = el("input");
        input.maxLength = 100;
        input.required = true;
        formField(form, "项目名称", input);
        submit(form, submitButton(form, "新建项目"), async () => {
          const created = await api("projects", {
            method: "POST",
            body: { name: input.value.trim() },
          });
          await openProject(created.id);
        });
        box.append(form, el("h3", "我的项目", "panel-section"));
        if (!items.length) box.append(el("p", "还没有项目。", "hint"));
        for (const item of items) {
          const row = el("div", null, "memory-row");
          row.append(action(item.name, () => openProject(item.id), "project-name"));
          box.append(row);
        }
      },
    );

  function openProject(pid) {
    return loadPanel(
      "项目文件",
      () => api(projectPath(pid)),
      (box, project) => {
        box.append(action("返回项目列表", projects), el("h3", project.name, "panel-section"));
        box.append(action("新建文件", () => editFile(project), "primary"));
        void addDesktopResume(api, pid, box, () => openProject(pid));
        for (const file of project.files) {
          const row = el("div", null, "memory-row");
          row.append(
            action(file.name, () => editFile(project, file.name), "project-name"),
            el("small", `v${file.version} · ${file.size_bytes} B`),
          );
          box.append(row);
        }
        if (!project.files.length) box.append(el("p", "此项目还没有文件。", "hint"));
        if (project.tasks?.length) {
          box.append(el("h3", "关联任务", "panel-section"));
          for (const task of project.tasks) {
            const row = el("div", null, "project-task");
            row.append(el("strong", task.prompt));
            if (task.inputs?.length)
              row.append(el("small", task.inputs.map((f) => f.name + " v" + f.version).join("、")));
            box.append(row);
          }
        }
        box.append(
          action(
            "删除项目",
            () =>
              confirmAction(
                "删除项目",
                `将删除「${project.name}」的文件和版本历史。`,
                "删除项目",
                async () => {
                  await api(projectPath(pid), { method: "DELETE" });
                  await projects();
                },
              ),
            "danger",
          ),
        );
      },
    );
  }

  async function editFile(project, original = null) {
    return loadPanel(
      original || "新建项目文件",
      async () =>
        original
          ? Promise.all([
              api(filePath(project.id, original)),
              api(filePath(project.id, original) + "/history"),
              api("status")
                .then((s) => s.desktop_configured)
                .catch(() => false),
            ])
          : [null, []],
      (box, [latest, versions, desktopEnabled]) => {
        box.append(action("返回项目文件", () => openProject(project.id)));
        const form = el("form");
        const name = el("input");
        name.required = true;
        name.placeholder = "报告.md";
        name.value = original || "";
        name.readOnly = Boolean(original);
        formField(form, "文件名", name);
        const content = el("textarea");
        content.required = true;
        content.rows = 7;
        content.value = latest?.content || "";
        formField(form, "文件内容", content);
        let expected = latest?.version || 0;
        const base = el("p", original ? "当前编辑版本 v" + expected : "", "hint");
        form.append(base);
        submit(form, submitButton(form, original ? "保存新版本" : "保存文件"), async () => {
          const filename = name.value.trim();
          validFile(filename, content.value);
          const path = filePath(project.id, filename);
          try {
            await api(path, {
              method: "PUT",
              body: { content: content.value, expected_version: expected },
            });
          } catch (error) {
            if (error.status !== 409) throw error;
            await showVersionConflict(api, project.id, filename, form, expected, (value) => {
              expected = value;
              name.readOnly = true;
              base.textContent = value ? "当前编辑版本 v" + value : "将重新创建文件。";
            });
            return;
          }
          await editFile(project, filename);
        });
        box.append(form);
        if (!original) return;
        if (desktopEnabled) {
          box.append(
            action("打开 Linux 工作区", () => {
              if (
                content.value !== latest.content &&
                !window.confirm(
                  "Linux 工作区将打开已保存的文件，离开会丢弃当前网页草稿。继续打开？",
                )
              )
                return;
              return openDesktop(api, project.id, latest, () => editFile(project, original));
            }),
          );
        }
        const history = el("details", null, "project-history");
        history.append(el("summary", "版本历史"));
        const choice = el("select");
        for (const v of versions) {
          const stamp = new Date(v.updated_at).toLocaleString("zh-CN");
          const origin = v.source_task_id ? "任务成果" : "手动编辑";
          choice.add(new Option(`v${v.version} · ${stamp} · ${origin}`, String(v.version)));
        }
        formField(history, "查看版本", choice);
        const preview = el("pre", latest.content, "artifact");
        history.append(preview);
        choice.onchange = async () => {
          const version = choice.value;
          preview.textContent = "加载中…";
          try {
            const item = await api(filePath(project.id, original) + "?version=" + segment(version));
            if (choice.value === version) preview.textContent = item.content;
          } catch (error) {
            if (choice.value === version) showError(history, error);
          }
        };
        box.append(
          history,
          action(
            "删除文件",
            () =>
              confirmAction(
                "删除文件",
                `将删除「${original}」及其全部版本历史。`,
                "确认删除文件",
                async () => {
                  await api(filePath(project.id, original) + "?expected_version=" + expected, {
                    method: "DELETE",
                  });
                  await openProject(project.id);
                },
              ),
            "danger",
          ),
        );
      },
    );
  }

  // File versions are concrete selections. Task retries reuse these values even if a newer version is saved.
  function taskSources(container) {
    const select = projectSelect("独立任务", []);
    formField(container, "关联项目（可选）", select);
    const files = el("div");
    container.append(files);
    let loaded = false,
      ready = false;
    const selected = new Map();
    async function enable() {
      if (loaded) return;
      loaded = true;
      try {
        for (const item of await api("projects")) select.add(new Option(item.name, item.id));
      } catch (error) {
        loaded = false;
        showError(container, error);
      }
    }
    select.onchange = async () => {
      const pid = select.value;
      selected.clear();
      files.replaceChildren();
      ready = false;
      if (!pid) return;
      files.textContent = "读取项目文件…";
      try {
        const project = await api(projectPath(pid));
        if (select.value !== pid) return;
        files.replaceChildren();
        if (project.files.length) files.append(el("p", "选中的版本会复制到任务工作区。", "hint"));
        for (const file of project.files) {
          const row = el("div", null, "project-input");
          const label = el("label");
          const check = el("input");
          check.type = "checkbox";
          label.append(check, document.createTextNode(file.name + " · v" + file.version));
          check.onchange = () => {
            if (check.checked) selected.set(file.name, file.version);
            else selected.delete(file.name);
          };
          row.append(label);
          files.append(row);
        }
        files.append(action("刷新项目文件", () => select.onchange(), "inline-action"));
        ready = true;
      } catch (error) {
        if (select.value === pid) {
          files.replaceChildren();
          showError(files, error);
        }
      }
    };
    function read(uploads) {
      if (!select.value) return {};
      if (!ready) throw new Error("请等待项目文件加载，或重新选择项目。");
      if (selected.size + uploads.length > 4) throw new Error("项目文件和上传文件合计最多四个。");
      if (uploads.some((f) => selected.has(f.name))) throw new Error("项目文件与上传文件重名。");
      return {
        project_id: select.value,
        project_files: [...selected].map(([name, version]) => ({ name, version })),
      };
    }
    return { enable, read };
  }

  function publishFile(task, file, back) {
    return loadPanel(
      "保存到项目",
      () => api("projects"),
      (box, items) => {
        box.append(action("返回任务", back), el("p", "任务文件 · " + file.name));
        if (!items.length) {
          box.append(el("p", "请先创建一个项目。"), action("打开项目", projects));
          return;
        }
        const form = el("form");
        const select = projectSelect("选择项目", items);
        select.required = true;
        formField(form, "目标项目", select);
        const target = el("input");
        target.required = true;
        target.value = file.name;
        formField(form, "目标文件名", target);
        const base = el("p", "", "hint");
        form.append(base);
        let versions = null,
          expected = 0;
        function update() {
          form.querySelector(".version-conflict")?.remove();
          const name = target.value.trim();
          const sameName = (file) => file.name.toLowerCase() === name.toLowerCase();
          const input = task.project_id === select.value && task.project_files?.find(sameName);
          expected = input?.version ?? versions?.find(sameName)?.version ?? 0;
          base.textContent = !versions
            ? ""
            : expected
              ? `将基于 v${expected} 保存新版本。`
              : "将创建新文件。";
        }
        select.onchange = async () => {
          const pid = select.value;
          versions = null;
          update();
          if (!pid) return;
          try {
            const project = await api(projectPath(pid));
            if (select.value === pid) {
              versions = project.files;
              update();
            }
          } catch (error) {
            if (select.value === pid) showError(form, error);
          }
        };
        target.oninput = update;
        if (items.some((project) => project.id === task.project_id)) {
          select.value = task.project_id;
          void select.onchange();
        }
        submit(form, submitButton(form, "保存到项目"), async () => {
          if (!versions) throw new Error("请先选择项目并等待文件列表加载。");
          const id = select.value,
            name = target.value.trim();
          const body = {
            task_id: task.id,
            source_name: file.name,
            target_name: name,
            expected_version: expected,
            source_run_id: task.run_id,
          };
          try {
            await api(projectPath(id) + "/publish", { method: "POST", body });
          } catch (error) {
            if (error.status !== 409 || !error.message.includes("文件版本")) throw error;
            await showVersionConflict(api, id, name, form, expected, (value) => {
              expected = value;
              base.textContent = value ? "将基于 v" + value + " 保存新版本。" : "将重新创建文件。";
            });
            return;
          }
          await editFile({ id }, name);
        });
        box.append(form);
      },
    );
  }

  return { projects, taskSources, publishFile };
}

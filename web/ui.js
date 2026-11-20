// Render only text and nodes created locally. Source URLs supplied by providers are untrusted.
export const $ = (id) => document.getElementById(id);

export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function action(label, onClick, className = "secondary") {
  const button = el("button", label, className);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function inline(node, text) {
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      node.append(el("strong", part.slice(2, -2)));
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      node.append(el("code", part.slice(1, -1)));
    } else node.append(document.createTextNode(part));
  }
}

function richText(node, text) {
  let paragraph = [],
    list = null,
    code = null;
  const flush = () => {
    if (paragraph.length) {
      const p = el("p");
      inline(p, paragraph.join("\n"));
      node.append(p);
      paragraph = [];
    }
    list = null;
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      flush();
      if (code === null) code = [];
      else {
        node.append(el("pre", code.join("\n")));
        code = null;
      }
    } else if (code !== null) code.push(line);
    else if (!line.trim()) flush();
    else if (/^#{1,6}\s+/.test(line)) {
      flush();
      node.append(el("strong", line.replace(/^#{1,6}\s+/, "")));
    } else if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const tag = /^\s*\d+\./.test(line) ? "ol" : "ul";
      if (list?.localName !== tag) {
        flush();
        list = el(tag);
        node.append(list);
      }
      const li = el("li");
      inline(li, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
      list.append(li);
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  if (code !== null) node.append(el("pre", code.join("\n")));
  flush();
}

export function messageNode(message) {
  const assistant = message.role === "assistant";
  const article = el("article", null, "message " + (assistant ? "assistant" : "user"));
  article.setAttribute("aria-label", assistant ? "回声" : "你");
  if (assistant) {
    article.append(el("div", "回声", "byline"));
    richText(article, String(message.content ?? ""));
  } else article.append(el("p", message.content));
  const sources = el("div", null, "sources");
  for (const [index, source] of (message.sources || []).entries()) {
    const url = safeUrl(source.url);
    if (!url) continue;
    const link = el("a", `[${index + 1}] ${source.title || url.hostname} ↗`);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (source.snippet) link.title = source.snippet;
    sources.append(link);
  }
  if (sources.childNodes.length) article.append(sources);
  return article;
}

export function detailList(entries) {
  const list = el("dl", null, "detail-list");
  for (const [name, value] of entries) {
    const row = el("div");
    row.append(el("dt", name), el("dd", value));
    list.append(row);
  }
  return list;
}

export function formField(form, label, input) {
  const wrapper = el("label", label);
  input.classList.add("field");
  wrapper.append(input);
  form.append(wrapper);
}

export function submitButton(form, label) {
  const button = el("button", label, "primary");
  button.type = "submit";
  form.append(button);
  return button;
}

export function panel(title) {
  $("panel-title").textContent = title;
  const section = el("section");
  $("panel-body").replaceChildren(section);
  if (!$("panel").open) $("panel").showModal();
  return section;
}

export function showError(container, error) {
  if (!container.isConnected) return;
  container.querySelector(".form-error")?.remove();
  const output = el("div", error.message || String(error), "form-error");
  output.setAttribute("role", "alert");
  container.prepend(output);
}

export function confirmAction(title, question, label, onConfirm) {
  const box = panel(title);
  const buttons = el("div", null, "actions");
  const ok = action(
    label,
    async () => {
      ok.disabled = true;
      try {
        await onConfirm();
      } catch (error) {
        showError(box, error);
        ok.disabled = false;
      }
    },
    "danger",
  );
  buttons.append(
    action("取消", () => $("panel").close()),
    ok,
  );
  box.append(el("p", question), buttons);
}

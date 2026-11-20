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

function appendCitations(node, text, sources) {
  let start = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>，。；！？)）]+|\[([1-9]\d?)\](?!\()/gi)) {
    if (!match[1]) continue;
    const source = sources.get(Number(match[1]));
    if (!source) continue;
    node.append(document.createTextNode(text.slice(start, match.index)));
    const button = action(
      match[0],
      () => {
        source.details.open = true;
        source.summary.focus();
        source.summary.scrollIntoView({ block: "nearest" });
      },
      "citation",
    );
    button.setAttribute("aria-label", `查看来源 ${match[1]}，${source.title}`);
    button.setAttribute("aria-controls", source.details.id);
    node.append(button);
    start = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(start)));
}

function inline(node, text, sources) {
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const strong = el("strong");
      appendCitations(strong, part.slice(2, -2), sources);
      node.append(strong);
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      node.append(el("code", part.slice(1, -1)));
    } else appendCitations(node, part, sources);
  }
}

function richText(node, text, sources) {
  let paragraph = [],
    list = null,
    code = null,
    fence = "";
  const flush = () => {
    if (paragraph.length) {
      const p = el("p");
      inline(p, paragraph.join("\n"), sources);
      node.append(p);
      paragraph = [];
    }
    list = null;
  };
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (code !== null) {
      if (marker && marker[1].startsWith(fence) && !line.slice(marker[0].length).trim()) {
        node.append(el("pre", code.join("\n")));
        code = null;
      } else code.push(line);
    } else if (marker) {
      flush();
      fence = marker[1];
      code = [];
    } else if (!line.trim()) flush();
    else if (/^#{1,6}\s+/.test(line)) {
      flush();
      const heading = el("strong");
      inline(heading, line.replace(/^#{1,6}\s+/, ""), sources);
      node.append(heading);
    } else if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const tag = /^\s*\d+\./.test(line) ? "ol" : "ul";
      if (list?.localName !== tag) {
        flush();
        list = el(tag);
        node.append(list);
      }
      const li = el("li");
      inline(li, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""), sources);
      list.append(li);
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  if (code !== null) node.append(el("pre", code.join("\n")));
  flush();
}

let sourceGroupSequence = 0;

export function messageNode(message) {
  const assistant = message.role === "assistant";
  const article = el("article", null, "message " + (assistant ? "assistant" : "user"));
  article.setAttribute("aria-label", assistant ? "回声" : "你");

  const sources = el("section", null, "sources");
  sources.setAttribute("aria-label", "本轮引用来源");
  const refs = new Map();
  const group = message.id || `view-${++sourceGroupSequence}`;
  for (const [index, source] of (message.sources || []).entries()) {
    const url = safeUrl(source.url);
    if (!url) continue;
    const number = index + 1;
    const title = source.title || url.hostname;
    const details = el("details");
    details.id = `source-${group}-${number}`;
    const summary = el("summary", `[${number}] ${title}`);
    const link = el("a", `阅读原文 · ${url.hostname} ↗`);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    details.append(summary);
    if (source.snippet) details.append(el("p", source.snippet));
    details.append(link);
    sources.append(details);
    refs.set(number, { details, summary, title });
  }

  if (assistant) {
    article.append(el("div", "回声", "byline"));
    richText(article, String(message.content ?? ""), refs);
  } else article.append(el("p", message.content));
  if (refs.size) article.append(sources);
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

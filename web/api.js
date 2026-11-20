const key = "echo.workspace.token";

export function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}

export function sessionToken() {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function rememberToken(token) {
  try {
    if (token) sessionStorage.setItem(key, token);
    else sessionStorage.removeItem(key);
  } catch {
    /* The session still works in memory while storage is disabled. */
  }
}

export async function request(path, { method = "GET", body, token, raw = false } = {}) {
  const headers = { Accept: raw === "blob" ? "*/*" : raw ? "text/markdown" : "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch("/api/" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new Error("无法连接服务，请检查网络后重试。");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    let detail = data?.detail;
    if (Array.isArray(detail)) detail = detail.map((item) => item.msg).join("，");
    const error = new Error(
      typeof detail === "string" ? detail : `请求失败（HTTP ${response.status}）`,
    );
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return;
  if (raw === "blob") return response.blob();
  return raw ? response.text() : response.json();
}

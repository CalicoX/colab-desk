// Webhook delivery. Built-in fetch only; http(s) only; SSRF guard; timeouts + retries.
export const KINDS = ["feishu", "telegram", "generic"];
export const DEFAULT_TEMPLATE = "[{status}] {job} ({duration}) @ {session}";

const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "0.0.0.0",
  "[::]",
  "::",
]);

export function renderTemplate(tpl, vars) {
  return String(tpl || DEFAULT_TEMPLATE).replace(/\{(job|status|duration|session)\}/g, (_, k) => String(vars[k] ?? ""));
}

export function maskSecret(s) {
  const v = String(s || "");
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 3)}••••${v.slice(-3)}`;
}

export function maskUrl(u) {
  try {
    const p = new URL(u);
    const tail = p.pathname.length > 6 ? `${p.pathname.slice(0, 4)}••••` : p.pathname;
    return `${p.protocol}//${p.host}${tail}`;
  } catch {
    return u ? "••••" : "";
  }
}

export function maskEndpoint(ep) {
  return {
    ...ep,
    url: maskUrl(ep.url),
    token: maskSecret(ep.token),
    secret: maskSecret(ep.secret),
  };
}

export function validateEndpoint(ep) {
  if (!ep || !KINDS.includes(ep.kind)) return "Unknown webhook kind";
  if (ep.kind === "telegram") {
    const token = String(ep.token || "").trim();
    if (!token) return "Telegram bot token required";
    if (/[\s/?#]|\.\./.test(token)) return "Invalid Telegram bot token";
    if (!String(ep.chatId || "").trim()) return "Telegram chat id required";
    return null;
  }
  let u;
  try {
    u = new URL(String(ep.url || "").trim());
  } catch {
    return "Invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Only http(s) URLs are allowed";
  }
  if (!u.hostname) return "URL hostname required";
  if (u.username || u.password) return "URL credentials are not allowed";
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.startsWith("169.254.")) {
    return "Blocked destination host";
  }
  return null;
}

export function buildRequest(ep, text, vars) {
  if (ep.kind === "telegram") {
    return {
      url: `https://api.telegram.org/bot${String(ep.token).trim()}/sendMessage`,
      body: { chat_id: String(ep.chatId).trim(), text },
    };
  }
  if (ep.kind === "feishu") {
    return {
      url: String(ep.url).trim(),
      body: { msg_type: "text", content: { text } },
    };
  }
  return {
    url: String(ep.url).trim(),
    body: { text, ...vars },
  };
}

function redactError(msg, ep, reqUrl) {
  let out = String(msg || "failed");
  if (reqUrl) out = out.replaceAll(reqUrl, "[url]");
  if (ep?.url) out = out.replaceAll(ep.url, "[url]");
  if (ep?.token) out = out.replaceAll(ep.token, "[token]");
  return out;
}

export async function deliver(
  ep,
  vars,
  {
    fetchImpl = globalThis.fetch,
    retries = 2,
    timeoutMs = 8000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const bad = validateEndpoint(ep);
  if (bad) return { ok: false, error: bad };
  const text = renderTemplate(ep.template || DEFAULT_TEMPLATE, vars);
  const req = buildRequest(ep, text, vars);
  let lastErr = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(req.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
        signal: ctl.signal,
        redirect: "error",
      });
      clearTimeout(timer);
      if (res.ok) return { ok: true, status: res.status };
      lastErr = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e) {
      clearTimeout(timer);
      lastErr =
        e?.name === "AbortError"
          ? `Timeout after ${timeoutMs}ms`
          : redactError(`Network error: ${e?.cause?.code || e?.message || "failed"}`, ep, req.url);
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  return { ok: false, error: lastErr };
}

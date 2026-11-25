function parseEnvPairs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

export function composeAction(input) {
  const command = input && input.command;
  const hardware = (input && input.hardware) || {};
  const fields = (input && input.fields) || {};
  const selected = input && input.selected;

  if (command === "usage" || command === "version" || command === "whoami") {
    return { action: { type: command } };
  }

  if (command === "run") {
    const script = String(fields.script || "").trim();
    if (!script) return { error: "script path is required" };
    const action = { type: "run", script };
    if (hardware.gpu) action.gpu = hardware.gpu;
    if (hardware.tpu) action.tpu = hardware.tpu;
    if (hardware.highMem) action.highMem = true;
    if (fields.keep) action.keep = true;
    const timeout = String(fields.timeout || "").trim();
    if (timeout) action.timeout = timeout;
    const env = parseEnvPairs(fields.env);
    if (env.length) action.env = env;
    const args = String(fields.args || "").trim().split(/\s+/).filter(Boolean);
    if (args.length) action.args = args;
    return { action };
  }

  if (!selected) return { error: "pick a session in the sidebar first" };
  const action = { type: command, session: selected };

  if (command === "exec") {
    const file = String(fields.file || "").trim();
    const timeout = String(fields.timeout || "").trim();
    if (timeout) action.timeout = timeout;
    const env = parseEnvPairs(fields.env);
    if (env.length) action.env = env;
    if (file) {
      action.file = file;
      return { action };
    }
    if (typeof input.code !== "string" || input.code.length === 0) {
      return { error: "exec needs code or a file" };
    }
    action.code = input.code;
    return { action };
  }

  if (command === "ssh") {
    const cmd = String(fields.command || input.code || "").trim();
    if (!cmd) return { error: "shell command is required" };
    action.command = cmd;
    return { action };
  }

  if (command === "ls" || command === "rm" || command === "drivemount") {
    const pathValue = String(fields.path || "").trim();
    if (pathValue) action.path = pathValue;
    if (command === "rm" && !action.path) return { error: "path is required" };
    return { action };
  }

  if (command === "upload" || command === "download") {
    action.local = String(fields.local || "").trim();
    action.remote = String(fields.remote || "").trim();
    return { action };
  }

  if (command === "install") {
    const requirements = String(fields.requirements || "").trim();
    if (requirements) {
      action.requirements = requirements;
      return { action };
    }
    action.packages = String(fields.packages || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return { action };
  }

  if (command === "log") {
    const lines = String(fields.lines || "").trim();
    if (lines) action.lines = lines;
    const eventType = String(fields.eventType || "").trim();
    if (eventType) action.eventType = eventType;
    const output = String(fields.output || "").trim();
    if (output) action.output = output;
    return { action };
  }

  return { action };
}

export function createDeskState() {
  return { view: null, bySession: Object.create(null) };
}

export function record(state, sessionName, entry) {
  const key = sessionName || "";
  const bucket = state.bySession[key] || [];
  bucket.push(entry);
  state.bySession[key] = bucket;
  return bucket;
}

export function showSession(state, sessionName) {
  state.view = sessionName || null;
  const bucket = state.bySession[state.view || ""];
  return bucket ? bucket.slice() : [];
}

export function parseColabNewSpec(rawInput) {
  if (!rawInput) return null;
  let text = "";
  if (typeof rawInput === "object") {
    if (typeof rawInput.command === "string") {
      text = rawInput.command;
    } else if (rawInput.name || rawInput.gpu || rawInput.tpu) {
      const name = String(rawInput.name || "").trim();
      const gpu = rawInput.gpu ? String(rawInput.gpu).trim() : null;
      const tpu = rawInput.tpu ? String(rawInput.tpu).trim() : null;
      const highMem = Boolean(rawInput.highMem || rawInput.high_mem);
      const hwLabel = (gpu || tpu || "CPU") + (highMem ? " + high-mem" : "");
      return { name: name || (gpu || tpu || "colab"), hw: { gpu, tpu, highMem }, hwLabel };
    } else {
      try { text = JSON.stringify(rawInput); } catch { return null; }
    }
  } else {
    text = String(rawInput);
  }

  // Also unwrap JSON-encoded input strings like {"command":"colab new ..."}
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.command === "string") text = parsed.command;
        else if (parsed.name || parsed.gpu || parsed.tpu) return parseColabNewSpec(parsed);
      }
    } catch {}
  }

  const m = text.match(/\bcolab\s+new\b([^\n;&|]*)/);
  if (!m) return null;
  const tail = m[1] || "";
  const nameMatch = tail.match(/(?:^|\s)(?:-s|--session)\s+['"]?([a-zA-Z0-9._-]+)['"]?/);
  const gpuMatch = tail.match(/(?:^|\s)--gpu\s+['"]?([a-zA-Z0-9._-]+)['"]?/i);
  const tpuMatch = tail.match(/(?:^|\s)--tpu\s+['"]?([a-zA-Z0-9._-]+)['"]?/i);
  const highMem = /(?:^|\s)--high-mem(?:\s|$)/.test(tail);

  const gpu = gpuMatch ? gpuMatch[1].toUpperCase() : null;
  const tpu = tpuMatch ? tpuMatch[1].toLowerCase() : null;
  const name = (nameMatch && nameMatch[1]) || gpu || tpu || "colab";
  const hwLabel = (gpu || tpu || "CPU") + (highMem ? " + high-mem" : "");
  return { name, hw: { gpu, tpu, highMem }, hwLabel };
}

export function isRetryableColabError(rawErr) {
  const text = String(rawErr || "");
  if (/TooManyAssignmentsError|too many assignments/i.test(text)) return false;
  if (/already exists/i.test(text)) return false;
  if (/\b(400|401|403)\b|Unauthorized|Bad Request|Forbidden|OAuth|not authenticated/i.test(text)) return false;
  if (/503|Service Unavailable|502|504|429|Too Many Requests|capacity|temporarily unavailable|timed out|timeout|ECONNRESET|fetch failed|Assignment request failed/i.test(text)) {
    return true;
  }
  return false;
}

export function summarizeColabError(rawErr, lang = "zh-CN") {
  const text = String(rawErr || "").replace(/\r\n/g, "\n").trim();
  const isEn = lang === "en";
  if (!text) return isEn ? "Failed to create session. Please try again later." : "创建会话失败，请稍后再试。";

  if (/503|Service Unavailable|capacity|temporarily unavailable/i.test(text)) {
    return isEn
      ? "This GPU/TPU tier is temporarily unavailable. Please try again later, or use Snipe in Background."
      : "当前硬件规格暂时无空闲节点，请稍后再试（可点「转后台抢卡」持续自动重试）。";
  }
  if (/TooManyAssignmentsError|too many assignments/i.test(text)) {
    return isEn
      ? "Active runtime limit reached. Stop an existing VM first."
      : "当前账号活跃节点数已达上限，请先停止一个旧会话再试。";
  }
  if (/already exists/i.test(text)) {
    return isEn
      ? "A session with this name already exists. Choose a different name."
      : "同名会话已存在，请更换一个会话名称。";
  }
  if (/\b(401|403)\b|Unauthorized|not authenticated|re-authenticate|OAuth/i.test(text)) {
    return isEn
      ? "Google Colab session expired. Please sign in again in Settings → Colab CLI."
      : "Google Colab 登录状态已过期，请前往「设置 → Colab 环境」重新登录。";
  }
  if (/\b400\b|Bad Request/i.test(text)) {
    return isEn
      ? "This hardware tier is unavailable for your account. Try another GPU or disable high-mem."
      : "当前账号暂不支持该硬件规格，请取消高内存或换选其他 GPU。";
  }
  if (/429|Too Many Requests/i.test(text)) {
    return isEn
      ? "Too many requests to Google Colab. Please try again in a moment."
      : "请求过于频繁，请稍后再试。";
  }
  if (/timeout|timed out/i.test(text)) {
    return isEn
      ? "Request timed out. Please try again later."
      : "申请节点超时，请稍后再试。";
  }

  // Strip Rich / Python Traceback walls and keep only the final exception summary line
  const cleaned = text
    .replace(/[╭╮╰╯│─━┃┏┓┗┛┣┫┳┻╋❯]+/g, " ")
    .replace(/\|+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = cleaned.length - 1; i >= 0; i--) {
    const line = cleaned[i];
    if (/^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception)\s*:/.test(line)) {
      const compact = line.replace(/\s+/g, " ").replace(/https?:\/\/\S+/g, "").trim();
      return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
    }
  }
  const last = cleaned[cleaned.length - 1] || text;
  const compact = last.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

// A failed `new` stays on the transcript already on screen. The new name only
// becomes the view after that session is actually in the list.
export function applyNewResult(state, input) {
  const names = Array.isArray(input.sessionNames) ? input.sessionNames : [];
  const created = !!input.ok && names.includes(input.requestedName);
  const stay = created ? input.requestedName : input.current || "";
  const entry = { ...(input.entry || {}) };
  if (!created) {
    entry.ok = false;
    if (!entry.error) entry.error = "session was not created";
  }
  record(state, stay, entry);
  return { view: stay, entries: showSession(state, stay) };
}

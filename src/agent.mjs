import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAction } from "./run.mjs";
import { loadStore } from "./store.mjs";

export const UPLOAD_DIR = path.join(os.tmpdir(), "colab-desk-uploads");
export const IMAGE_DIR = path.join(os.tmpdir(), "colab-desk-images");

export const PROVIDERS = [
  { id: "agy", name: "AGY", label: "AGY", transport: "acp", command: "agy", args: ["acp"] },
  { id: "grok", name: "Grok", label: "Grok", transport: "grok", command: "grok", args: [] },
  { id: "opencode", name: "OpenCode", label: "OpenCode", transport: "acp", command: "opencode", args: ["acp"] },
  { id: "api", name: "自定义 API", label: "自定义 API", transport: "openai-compat", command: null, args: [] },
];

const COLAB_OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "colab_exec",
      description: "在当前 Colab 会话中执行 Python 代码（内核状态持久保留，工作目录 /content）。",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 Python 代码" },
          outputImage: { type: "string", description: "可选：保存图表的本地路径，放在 /tmp/colab-desk-images/ 下" },
          timeout: { type: "number", description: "可选：超时秒数（0 表示不限）" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_ssh",
      description: "在当前 Colab 会话上运行单次 shell 命令（如 nvidia-smi、ls、df -h）。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_install",
      description: "在当前 Colab 会话安装 Python 依赖包（优先使用 uv，自动回退 pip）。",
      parameters: {
        type: "object",
        properties: {
          packages: { type: "array", items: { type: "string" }, description: "包名列表" },
        },
        required: ["packages"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_ls",
      description: "列出当前 Colab 会话远程目录文件（默认 content）。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_upload",
      description: "将本机文件上传到当前 Colab 会话。",
      parameters: {
        type: "object",
        properties: {
          local: { type: "string", description: "本地文件路径" },
          remote: { type: "string", description: "远程目标路径，如 /content/data.csv" },
        },
        required: ["local", "remote"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_download",
      description: "从当前 Colab 会话下载文件到本机。",
      parameters: {
        type: "object",
        properties: {
          remote: { type: "string", description: "远程文件路径" },
          local: { type: "string", description: "本地保存路径" },
        },
        required: ["remote", "local"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_status",
      description: "查看当前或全部 Colab 会话的状态与硬件信息。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_usage",
      description: "查看 Google Colab 账户计算单元余额与消耗速率。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "colab_sessions",
      description: "列出当前 Google Colab 所有活跃会话。",
      parameters: { type: "object", properties: {} },
    },
  },
];

const DEFAULT_GROK_MODELS = [
  { value: "grok-4.7-build-fast", name: "grok-4.7-build-fast (默认)" },
  { value: "grok-4.7", name: "grok-4.7" },
  { value: "grok-4.6", name: "grok-4.6" },
  { value: "grok-4.5", name: "grok-4.5" },
];

export function findExecutable(name, pathEnv = process.env.PATH || "") {
  const dirs = String(pathEnv).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return null;
}

export function buildColabSystemRules(context = {}) {
  const session = context.colabSession || null;
  const sessionInfo = context.sessionInfo || null;
  const lines = [
    "你正在 Colab Desk 桌面应用中协助一位不熟悉编程和命令行操作的用户操控 Google Colab 云端算力。",
    "所有对远程 Colab 虚拟机的操作都必须通过本机已安装的官方 `colab` CLI 完成（禁止自己编造或重写 Colab API）。",
    "",
    "核心规则：",
    "1. 默认用简洁易懂的中文向用户汇报结果和下一步建议，避免堆砌晦涩术语。",
  ];

  if (session) {
    const hw = sessionInfo?.hardware ? `，硬件：${sessionInfo.hardware}` : "";
    const shape = sessionInfo?.shape ? `，规格：${sessionInfo.shape}` : "";
    lines.push(`2. 当前选中的 Colab 会话名是 \`${session}\`${hw}${shape}。所有 \`colab\` 命令务必带上 \`-s ${session}\`（如 \`colab exec -s ${session}\`、\`colab ssh -s ${session} -- <cmd>\`、\`colab install -s ${session} <pkg>\`、\`colab ls -s ${session}\`、\`colab upload -s ${session} <local> <remote>\`、\`colab download -s ${session} <remote> <local>\`）。`);
  } else {
    lines.push("2. 当前没有选中的活跃 Colab 会话。如果需要执行远程代码，先运行 `colab sessions` 检查；如无会话，提示用户点击界面「新建会话」按钮（不要擅自 `colab new` 产生计费，除非用户明确要求创建）。");
  }

  lines.push(
    "3. 执行 Python 代码优先用 `colab exec -s <name>`（通过 stdin 或 `-f` 本地文件）；内核状态在多次 `exec` 间持久保留，默认工作目录为 `/content`。",
    `4. 如果代码生成图表/图片，请使用 \`colab exec -s <name> --output-image ${IMAGE_DIR}/plot_<timestamp>.png\` 保存图片，并在最终回复里用 Markdown 图片或原样路径给出该 \`${IMAGE_DIR}/...\` 路径，界面会自动内嵌显示图片。`,
    "5. 计费与安全护栏：除非用户明确要求，严禁主动执行 `colab new`（会产生计费）、`colab stop`（会销毁虚拟机）或 `colab rm`（会删除云端文件）。",
  );
  return lines.join("\n");
}

export function formatTurnPrompt(prompt, context = {}, includeRules = true) {
  const parts = [];
  if (includeRules) {
    parts.push(`[Colab Desk 上下文]\n${buildColabSystemRules(context)}`);
  } else if (context.colabSession) {
    parts.push(`[当前 Colab 会话: ${context.colabSession}${context.sessionInfo?.hardware ? ` (${context.sessionInfo.hardware})` : ""}]`);
  }
  if (Array.isArray(context.files) && context.files.length > 0) {
    const fileLines = context.files.map((f) => `- ${f.name}: ${f.path}`);
    parts.push(`[用户附加的本地文件（可用 colab upload 上传到云端）]\n${fileLines.join("\n")}`);
  }
  parts.push(`[用户消息]\n${prompt}`);
  return parts.join("\n\n");
}

export function parseGrokBillingPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload.config && typeof payload.config === "object" ? payload.config : payload;
  const rawUsed = typeof cfg.creditUsagePercent === "number"
    ? cfg.creditUsagePercent
    : typeof cfg.percent === "number"
      ? cfg.percent
      : null;
  if (rawUsed === null || !Number.isFinite(rawUsed)) return null;
  const usedPct = Math.max(0, Math.min(100, Math.round(rawUsed * 10) / 10));
  const remainingPct = Math.max(0, Math.min(100, Math.round(100 - rawUsed)));
  const periodObj = cfg.currentPeriod && typeof cfg.currentPeriod === "object" ? cfg.currentPeriod : {};
  const rawType = String(periodObj.type || "WEEKLY").toUpperCase();
  const windowLabel = rawType.includes("WEEK") ? "Weekly" : rawType.includes("DAY") ? "Daily" : rawType.includes("MONTH") ? "Monthly" : "Plan";
  const resetTime = periodObj.end || periodObj.End || cfg.billingPeriodEnd || cfg.period_end || null;
  const products = Array.isArray(cfg.productUsage)
    ? cfg.productUsage
        .filter((p) => p && typeof p.usagePercent === "number" && p.usagePercent > 0)
        .map((p) => ({ product: String(p.product || ""), usagePercent: p.usagePercent }))
    : [];
  return {
    usedPct,
    remainingPct,
    window: windowLabel,
    resetTime,
    products,
  };
}

export function parseAgyQuotaJson(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const data = parsed?.command?.data;
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const buckets = [];
    for (const g of groups) {
      const groupName = g?.name || "";
      for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
        const frac = typeof b?.remaining_fraction === "number" ? b.remaining_fraction : null;
        buckets.push({
          id: b?.id || `${groupName}-${b?.window || ""}`,
          group: groupName,
          name: b?.name || "",
          window: b?.window || "",
          remainingPct: frac === null ? null : Math.max(0, Math.min(100, Math.round(frac * 100))),
          resetTime: b?.reset_time || null,
          description: b?.description || "",
        });
      }
    }
    return {
      ok: buckets.length > 0,
      description: data?.description || "",
      buckets,
    };
  } catch {
    return { ok: false, description: "", buckets: [] };
  }
}

export function extractAcpModels(sessionNewResult) {
  const configOptions = Array.isArray(sessionNewResult?.configOptions) ? sessionNewResult.configOptions : [];
  const thoughtOpt = configOptions.find((opt) => opt && (opt.id === "thought_level" || opt.category === "thought_level"));
  const thoughtLevels = thoughtOpt && Array.isArray(thoughtOpt.options)
    ? {
        configId: thoughtOpt.id || "thought_level",
        current: thoughtOpt.currentValue || thoughtOpt.options[0]?.value || "",
        options: thoughtOpt.options.map((opt) => ({
          value: opt.value,
          name: opt.name || opt.value,
        })),
      }
    : null;

  const modelOpt = configOptions.find((opt) => opt && (opt.id === "model" || opt.category === "model"));
  if (modelOpt && Array.isArray(modelOpt.options) && modelOpt.options.length > 0) {
    return {
      mode: "configOption",
      configId: modelOpt.id || "model",
      current: modelOpt.currentValue || modelOpt.options[0].value,
      models: modelOpt.options.map((opt) => ({
        value: opt.value,
        name: opt.name || opt.value,
      })),
      thoughtLevels,
    };
  }
  const avail = sessionNewResult?.models?.availableModels;
  if (Array.isArray(avail) && avail.length > 0) {
    return {
      mode: "setModel",
      configId: "model",
      current: sessionNewResult.models.currentModelId || avail[0].modelId,
      models: avail.map((m) => ({
        value: m.modelId,
        name: m.name || m.modelId,
      })),
      thoughtLevels,
    };
  }
  return { mode: "none", configId: "model", current: "", models: [], thoughtLevels };
}

function formatToolActionTitle(rawName, rawInput, rawOutput = null) {
  const pickFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    const cmd = obj.command || obj.CommandLine || obj.cmd;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
    const file = obj.path || obj.Path || obj.file || obj.file_path || obj.TargetFile;
    if (typeof file === "string" && file.trim()) {
      const verb = rawName ? `${rawName} ` : "";
      return `${verb}${file.trim()}`.trim();
    }
    const query = obj.query || obj.Query || obj.url || obj.Url;
    if (typeof query === "string" && query.trim()) return query.trim();
    const desc = obj.description || obj.toolSummary;
    if (typeof desc === "string" && desc.trim()) return desc.trim();
    return "";
  };

  let extracted = pickFromObj(rawInput) || pickFromObj(rawOutput);
  if (!extracted && typeof rawInput === "string" && rawInput.trim().startsWith("{")) {
    try { extracted = pickFromObj(JSON.parse(rawInput)); } catch {}
  }
  const clean = (extracted || String(rawName || "").trim()).replace(/\s+/g, " ").trim();
  if (!clean) return "shell";
  return clean.length > 92 ? `${clean.slice(0, 89)}…` : clean;
}

export function parseAcpSessionUpdate(params) {
  const update = params?.update;
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;

  if (kind === "agent_message_chunk") {
    const text = update.content?.text ?? update.text ?? "";
    if (text) return { type: "text", text };
    return null;
  }
  if (kind === "agent_thought_chunk" || kind === "thought_chunk" || kind === "reasoning_chunk") {
    const text = update.content?.text ?? update.text ?? "";
    if (text) return { type: "thought", text };
    return null;
  }
  if (kind === "plan" && Array.isArray(update.entries) && update.entries.length > 0) {
    const summary = update.entries
      .map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "·"} ${e.content || e.title || ""}`)
      .filter(Boolean)
      .join("\n");
    if (summary) return { type: "thought", text: summary + "\n" };
    return null;
  }
  if (kind === "tool_call") {
    const baseName = update.title || update.name || "";
    const title = formatToolActionTitle(baseName, update.rawInput, null);
    return {
      type: "tool_call",
      toolCallId: update.toolCallId || update.id || String(Date.now()),
      title,
      kind: update.kind || "tool",
      status: update.status || "in_progress",
      input: update.rawInput ? formatCompact(update.rawInput) : "",
    };
  }
  if (kind === "tool_call_update") {
    const contentText = extractToolContent(update.content) || (update.rawOutput ? formatCompact(update.rawOutput) : "");
    const title = update.rawInput || update.rawOutput
      ? formatToolActionTitle(update.title || "", update.rawInput, update.rawOutput)
      : (update.title || undefined);
    return {
      type: "tool_update",
      toolCallId: update.toolCallId || update.id || "",
      title,
      status: update.status || "completed",
      output: contentText,
    };
  }
  if (kind === "usage_update") {
    return {
      type: "usage",
      used: update.used ?? null,
      size: update.size ?? null,
    };
  }
  return null;
}

export function parseGrokEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = obj.type;
  if (type === "text" && typeof obj.data === "string") {
    return { type: "text", text: obj.data };
  }
  if (type === "thought" || type === "thinking" || type === "reasoning") {
    const text =
      typeof obj.data === "string"
        ? obj.data
        : typeof obj.text === "string"
          ? obj.text
          : typeof obj.data?.text === "string"
            ? obj.data.text
            : "";
    if (text) return { type: "thought", text };
    return null;
  }
  if (type === "tool_use" || type === "tool_call") {
    const rawInput = obj.rawInput ?? obj.input ?? obj.arguments ?? obj.data?.input ?? "";
    const baseName = obj.toolName || obj.name || obj.tool || obj.title || obj.data?.name || "";
    const title = formatToolActionTitle(baseName, rawInput, null);
    return {
      type: "tool_call",
      toolCallId: obj.toolCallId || obj.id || obj.tool_use_id || obj.call_id || `${baseName || "tool"}-${Date.now()}`,
      title,
      kind: obj.kind || "tool",
      status: obj.status === "completed" ? "completed" : obj.status === "failed" ? "failed" : "in_progress",
      input: formatCompact(rawInput),
    };
  }
  if (type === "tool_call_update") {
    const contentText = extractToolContent(obj.content);
    const rawOut = obj.rawOutput;
    const rawText = rawOut
      ? (typeof rawOut.output_for_prompt === "string" ? rawOut.output_for_prompt : formatCompact(rawOut))
      : "";
    const exitCode = rawOut && typeof rawOut.exit_code === "number" ? rawOut.exit_code : null;
    let status = obj.status || undefined;
    if (status === "completed" && exitCode !== null && exitCode !== 0) {
      status = "failed";
    }
    const derivedTitle = (rawOut && typeof rawOut.command === "string" && rawOut.command.trim())
      ? formatToolActionTitle("", { command: rawOut.command }, null)
      : (obj.rawInput ? formatToolActionTitle(obj.title || "", obj.rawInput, null) : (obj.title && obj.title !== "run_terminal_command" ? obj.title : undefined));
    return {
      type: "tool_update",
      toolCallId: obj.toolCallId || obj.id || obj.tool_use_id || obj.call_id || "",
      title: derivedTitle,
      status,
      output: contentText || (status === "completed" || status === "failed" ? rawText : ""),
    };
  }
  if (type === "tool_result") {
    const output = obj.output ?? obj.content ?? obj.data ?? "";
    return {
      type: "tool_update",
      toolCallId: obj.toolCallId || obj.tool_use_id || obj.call_id || obj.id || "",
      status: obj.is_error ? "failed" : "completed",
      output: formatCompact(output),
    };
  }
  if (type === "error") {
    return { type: "error", error: obj.message || obj.error || formatCompact(obj) };
  }
  if (type === "end") {
    return {
      type: "grok_end",
      sessionId: obj.sessionId || null,
      usage: obj.usage || null,
      costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null,
    };
  }
  return null;
}

function extractToolContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (item.type === "content" && item.content?.text) return item.content.text;
        if (item.text) return item.text;
        if (item.content && typeof item.content === "string") return item.content;
        return formatCompact(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  return formatCompact(content);
}

function formatCompact(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

class AcpClient {
  constructor(provider, cwd) {
    this.provider = provider;
    this.cwd = cwd;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.readyPromise = null;
    this.buf = "";
    this.activeListener = null; // { sessionId, approvalMode, emit, registerPermission }
    this.modelCatalog = null;
    this.initResult = null;
    this.agentInfo = null;
    this.authMethods = [];
    this.supportsLogout = false;
    this.antigravityMeta = null;
    this.tier = null;
  }

  ensureStarted() {
    if (this.child && !this.child.killed && this.child.exitCode === null && this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = this._start();
    return this.readyPromise;
  }

  async _start() {
    const exe = findExecutable(this.provider.command);
    if (!exe) {
      throw new Error(`${this.provider.command} 未安装或不在 PATH 中`);
    }
    const child = spawn(exe, this.provider.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buf = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // Keep stderr drained so the child never blocks on pipe buffers.
    });
    child.on("exit", () => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`${this.provider.name} ACP 进程已退出`));
      }
      this.pending.clear();
      if (this.child === child) {
        this.child = null;
        this.readyPromise = null;
      }
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: true },
      },
      clientInfo: { name: "colab-desk", version: "0.2.1" },
    });
    this.initResult = init || null;
    this.agentInfo = init?.agentInfo || null;
    this.authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    this.supportsLogout = Boolean(init?.agentCapabilities?.auth?.logout);
    this.antigravityMeta = init?.agentCapabilities?._meta?.antigravity || null;
    return init;
  }

  _onStdout(chunk) {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    // Response to our request
    if (msg.id !== undefined && !msg.method) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    // Server -> Client notification
    if (msg.method === "session/update") {
      const listener = this.activeListener;
      if (listener && (!msg.params?.sessionId || msg.params.sessionId === listener.sessionId)) {
        const parsed = parseAcpSessionUpdate(msg.params);
        if (parsed) listener.emit(parsed);
      }
      return;
    }

    // Server -> Client request (e.g., session/request_permission)
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      this._handlePermissionRequest(msg.id, msg.params || {});
      return;
    }

    // Any other unsupported server request: respond cleanly with method not found
    if (msg.method && msg.id !== undefined) {
      this.sendRaw({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unsupported client method: ${msg.method}` },
      });
    }
  }

  async _handlePermissionRequest(rpcId, params) {
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOpt =
      options.find((o) => o.kind === "allow_once") ||
      options.find((o) => o.kind === "allow_always") ||
      options[0];
    const rejectOpt =
      options.find((o) => o.kind === "reject_once") ||
      options.find((o) => o.kind === "reject_always") ||
      options[options.length - 1];

    const listener = this.activeListener;
    if (!listener || listener.approvalMode === "auto") {
      if (allowOpt) {
        this.sendRaw({
          jsonrpc: "2.0",
          id: rpcId,
          result: { outcome: { outcome: "selected", optionId: allowOpt.optionId } },
        });
      } else {
        this.sendRaw({
          jsonrpc: "2.0",
          id: rpcId,
          result: { outcome: { outcome: "cancelled" } },
        });
      }
      return;
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = params.toolCall?.title || params.toolCall?.kind || "执行操作";
    const detail = formatCompact(params.toolCall?.rawInput || "");
    const allowed = await listener.registerPermission({ requestId, title, detail });
    const chosen = allowed ? allowOpt : rejectOpt;
    this.sendRaw({
      jsonrpc: "2.0",
      id: rpcId,
      result: chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } },
    });
  }

  sendRaw(payload) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {}
  }

  request(method, params, timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error(`${this.provider.name} ACP 未启动`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.provider.name} ${method} 超时`));
        }
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  async createSession() {
    await this.ensureStarted();
    const res = await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, 30_000);
    const catalog = extractAcpModels(res);
    if (catalog.models.length > 0) this.modelCatalog = catalog;
    if (res?._meta?.antigravity?.tier) {
      this.tier = res._meta.antigravity.tier;
    }
    return { sessionId: res.sessionId, catalog, tier: this.tier };
  }

  async authenticate(methodId = "oauth-personal", meta = undefined) {
    await this.ensureStarted();
    const params = meta ? { methodId, _meta: meta } : { methodId };
    const res = await this.request("authenticate", params, 180_000);
    this.modelCatalog = null;
    return res;
  }

  async logout() {
    await this.ensureStarted();
    const res = await this.request("logout", {}, 15_000);
    this.modelCatalog = null;
    this.tier = null;
    return res;
  }

  async setModel(sessionId, modelValue) {
    if (!modelValue) return;
    const mode = this.modelCatalog?.mode || "configOption";
    const configId = this.modelCatalog?.configId || "model";
    try {
      if (mode === "configOption") {
        await this.request("session/set_config_option", { sessionId, configId, value: modelValue }, 15_000);
      } else {
        await this.request("session/set_model", { sessionId, modelId: modelValue }, 15_000);
      }
    } catch {
      // Fallback to the other method if server prefers it
      try {
        if (mode === "configOption") {
          await this.request("session/set_model", { sessionId, modelId: modelValue }, 15_000);
        } else {
          await this.request("session/set_config_option", { sessionId, configId, value: modelValue }, 15_000);
        }
      } catch {}
    }
  }

  async setMode(sessionId, approvalMode) {
    const modeId = approvalMode === "auto" ? "auto" : "default";
    try {
      await this.request("session/set_mode", { sessionId, modeId }, 10_000);
    } catch {}
  }

  async setThoughtLevel(sessionId, level) {
    if (!level) return;
    const configId = this.modelCatalog?.thoughtLevels?.configId || "thought_level";
    try {
      await this.request("session/set_config_option", { sessionId, configId, value: level }, 15_000);
    } catch {}
  }

  cancel(sessionId) {
    if (!sessionId) return;
    this.notify("session/cancel", { sessionId });
  }

  stop() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
    this.child = null;
    this.readyPromise = null;
  }
}

export function resolveOpenAiChatEndpoints(baseUrl) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) return [];
  if (/\/chat\/completions$/i.test(clean)) return [clean];
  try {
    const parsed = new URL(clean);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname) {
      return [`${clean}/v1/chat/completions`, `${clean}/chat/completions`];
    }
    if (/\/v\d+(?:beta|alpha)?$/i.test(pathname)) {
      return [`${clean}/chat/completions`];
    }
    return [`${clean}/chat/completions`, `${clean}/v1/chat/completions`];
  } catch {
    return [`${clean}/v1/chat/completions`, `${clean}/chat/completions`];
  }
}

export function extractOpenAiContentText(val) {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return String(part.text ?? part.content ?? part.value ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function parseOpenAiJsonCompletion(data) {
  if (!data || typeof data !== "object") return null;
  if (data.error) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : data.error.message || data.error.msg || JSON.stringify(data.error);
    return { error: String(msg) };
  }
  const usage = data.usage
    ? {
        inputTokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
        outputTokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
        thoughtTokens: data.usage.completion_tokens_details?.reasoning_tokens || 0,
      }
    : null;
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && typeof choice === "object") {
    const msg = choice.message || choice.delta || {};
    const text = extractOpenAiContentText(msg.content);
    const thought = extractOpenAiContentText(msg.reasoning_content ?? msg.reasoning ?? msg.thinking);
    const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const toolCalls = rawToolCalls
      .map((tc) => ({
        id: String(tc?.id || ""),
        name: String(tc?.function?.name || tc?.name || ""),
        arguments:
          typeof tc?.function?.arguments === "string"
            ? tc.function.arguments
            : tc?.function?.arguments != null
              ? JSON.stringify(tc.function.arguments)
              : typeof tc?.arguments === "string"
                ? tc.arguments
                : tc?.arguments != null
                  ? JSON.stringify(tc.arguments)
                  : "{}",
      }))
      .filter((tc) => tc.name);
    return { text, thought, toolCalls, usage };
  }
  if (typeof data.output_text === "string" && data.output_text) {
    return { text: data.output_text, thought: "", toolCalls: [], usage };
  }
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (item && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    if (parts.length > 0) return { text: parts.join(""), thought: "", toolCalls: [], usage };
  }
  if (typeof data.message === "string" && data.message) {
    return { error: data.message };
  }
  if (typeof data.msg === "string" && data.msg) {
    return { error: data.msg };
  }
  return null;
}

export class AgentManager {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.acpClients = new Map();
    this.threads = new Map(); // key: `${colabSession}:${providerId}` -> { sessionId, initialized, lastModel, lastApproval }
    this.modelCache = new Map();
    this.quotaCache = null;
    this.pendingPermissions = new Map(); // requestId -> resolve(bool)
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
  }

  getAcpClient(providerId) {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) throw new Error(`unknown ACP provider: ${providerId}`);
    let client = this.acpClients.get(providerId);
    if (!client) {
      client = new AcpClient(provider, this.cwd);
      this.acpClients.set(providerId, client);
    }
    return client;
  }

  getApiProfiles() {
    const settings = loadStore().settings || {};
    const list = Array.isArray(settings.apiProfiles) ? settings.apiProfiles : [];
    const normalized = list
      .filter((p) => p && typeof p === "object")
      .map((p, idx) => ({
        id: String(p.id || `profile-${idx + 1}`),
        label: String(p.label || "").trim() || `API ${idx + 1}`,
        baseUrl: String(p.baseUrl || "").trim().replace(/\/+$/, ""),
        apiKey: String(p.apiKey || "").trim(),
        model: String(p.model || "").trim(),
      }));
    if (normalized.length > 0) return normalized;
    const legacy = settings.apiConfig;
    if (legacy && (legacy.baseUrl || legacy.model)) {
      return [{
        id: "default",
        label: String(legacy.label || "").trim() || "自定义 API",
        baseUrl: String(legacy.baseUrl || "").trim().replace(/\/+$/, ""),
        apiKey: String(legacy.apiKey || "").trim(),
        model: String(legacy.model || "").trim(),
      }];
    }
    return [];
  }

  getApiConfig(override, profileId = null) {
    const profiles = this.getApiProfiles();
    let base = null;
    if (profileId) {
      base = profiles.find((p) => p.id === profileId) || null;
    }
    if (!base) base = profiles[0] || loadStore().settings?.apiConfig || {};
    const merged = { ...base, ...(override || {}) };
    return {
      id: merged.id || profileId || "default",
      baseUrl: String(merged.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKey: String(merged.apiKey || "").trim(),
      model: String(merged.model || "").trim(),
      label: String(merged.label || "").trim() || "自定义 API",
    };
  }

  listProviders() {
    const profiles = this.getApiProfiles().filter((p) => p.baseUrl && p.model);
    const out = [];
    for (const p of PROVIDERS) {
      if (p.transport === "openai-compat") {
        if (profiles.length > 0) {
          for (const prof of profiles) {
            out.push({
              id: `api:${prof.id}`,
              profileId: prof.id,
              name: prof.label,
              label: prof.label,
              transport: p.transport,
              available: true,
              path: prof.baseUrl,
              models: [{ value: prof.model, name: prof.model }],
              defaultModel: prof.model,
            });
          }
        } else {
          out.push({
            id: "api",
            name: p.name,
            label: p.label,
            transport: p.transport,
            available: false,
            path: null,
            models: [],
            defaultModel: "",
          });
        }
        continue;
      }
      const cached = this.modelCache.get(p.id);
      const exePath = findExecutable(p.command);
      out.push({
        id: p.id,
        name: p.name,
        label: p.label,
        transport: p.transport,
        available: !!exePath,
        path: exePath,
        models: cached ? cached.models : p.id === "grok" ? DEFAULT_GROK_MODELS : [],
        defaultModel: cached ? cached.current : p.id === "grok" ? DEFAULT_GROK_MODELS[0].value : "",
        thoughtLevels: cached?.thoughtLevels || null,
      });
    }
    return out;
  }

  async fetchModels(providerId) {
    if (providerId === "api" || String(providerId).startsWith("api:")) {
      const profileId = String(providerId).startsWith("api:") ? String(providerId).slice(4) : null;
      const apiCfg = this.getApiConfig(null, profileId);
      const ok = Boolean(apiCfg.baseUrl && apiCfg.model);
      return {
        available: ok,
        current: apiCfg.model || "",
        models: ok ? [{ value: apiCfg.model, name: apiCfg.model }] : [],
        thoughtLevels: null,
      };
    }
    if (this.modelCache.has(providerId)) return this.modelCache.get(providerId);
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) throw new Error(`unknown provider: ${providerId}`);
    if (!findExecutable(provider.command)) {
      return { current: "", models: [], available: false, thoughtLevels: null };
    }

    if (provider.transport === "acp") {
      const client = this.getAcpClient(providerId);
      const { catalog } = await client.createSession();
      const result = {
        available: true,
        current: catalog.current,
        models: catalog.models,
        thoughtLevels: catalog.thoughtLevels || null,
      };
      this.modelCache.set(providerId, result);
      return result;
    }

    if (provider.id === "grok") {
      const models = await this._fetchGrokModels();
      const result = {
        available: true,
        current: models[0]?.value || DEFAULT_GROK_MODELS[0].value,
        models,
      };
      this.modelCache.set(providerId, result);
      return result;
    }

    return { available: false, current: "", models: [] };
  }

  _fetchGrokModels() {
    return new Promise((resolve) => {
      const exe = findExecutable("grok");
      if (!exe) {
        resolve(DEFAULT_GROK_MODELS);
        return;
      }
      const child = spawn(exe, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve(DEFAULT_GROK_MODELS);
      }, 6000);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", () => {
        clearTimeout(timer);
        const parsed = [];
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^\s*([*-])\s+([^\s]+)(.*)$/);
          if (m) {
            const isDefault = m[1] === "*" || /\(default\)/i.test(m[3]);
            parsed.push({
              value: m[2],
              name: isDefault ? `${m[2]} (默认)` : m[2],
              isDefault,
            });
          }
        }
        if (parsed.length === 0) {
          resolve(DEFAULT_GROK_MODELS);
          return;
        }
        parsed.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
        resolve(parsed.map(({ value, name }) => ({ value, name })));
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(DEFAULT_GROK_MODELS);
      });
    });
  }

  _execCapture(command, args, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      const exe = findExecutable(command);
      if (!exe) {
        resolve({ available: false, ok: false, stdout: "", stderr: `${command} 未安装` });
        return;
      }
      const child = spawn(exe, args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        done({ available: true, ok: false, stdout, stderr: "查询超时" });
      }, timeoutMs);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => done({ available: true, ok: false, stdout, stderr: err.message }));
      child.on("close", (code) => done({ available: true, ok: code === 0, stdout, stderr }));
    });
  }

  async _fetchGrokBilling() {
    const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
    let token = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(grokHome, "auth.json"), "utf8"));
      if (raw && typeof raw === "object") {
        let bestExp = "";
        for (const val of Object.values(raw)) {
          if (!val || typeof val !== "object" || typeof val.key !== "string" || !val.key) continue;
          const exp = String(val.expires_at || "");
          if (!token || exp > bestExp) {
            bestExp = exp;
            token = val.key;
          }
        }
      }
    } catch {}

    if (token) {
      try {
        const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "x-xai-token-auth": "xai-grok-cli",
            "User-Agent": "xai-grok-cli",
          },
          signal: AbortSignal.timeout(4500),
        });
        if (res.ok) {
          const payload = await res.json();
          const parsed = parseGrokBillingPayload(payload);
          if (parsed) return { ok: true, source: "live", ...parsed };
        }
      } catch {}
    }

    // Fallback to Grok statusline cache file
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(grokHome, "statusline-billing.json"), "utf8"));
      const parsed = parseGrokBillingPayload(cached);
      if (parsed) return { ok: true, source: "cache", ...parsed };
    } catch {}

    return { ok: false };
  }

  async fetchQuotas(force = false) {
    if (!force && this.quotaCache && Date.now() - this.quotaCache.fetchedAt < 60_000) {
      return this.quotaCache;
    }

    const grokAvailable = Boolean(findExecutable("grok"));
    const [agyRaw, grokBilling, oc30Raw, ocAllRaw] = await Promise.all([
      this._execCapture("agy", ["-p", "/quota", "--output-format", "json"], 12_000),
      grokAvailable ? this._fetchGrokBilling() : Promise.resolve({ ok: false }),
      this._execCapture("opencode", ["stats", "--days", "30", "--cost", "--json"], 8_000),
      this._execCapture("opencode", ["stats", "--all", "--cost", "--models", "--json"], 8_000),
    ]);

    const agyParsed = agyRaw.ok ? parseAgyQuotaJson(agyRaw.stdout) : { ok: false, description: "", buckets: [] };
    const agy = {
      available: agyRaw.available,
      ok: agyParsed.ok,
      buckets: agyParsed.buckets,
      description: agyParsed.description,
      error: agyParsed.ok ? null : (agyRaw.stderr || agyRaw.stdout || "无法获取 AGY 额度").trim(),
    };

    const grok = {
      available: grokAvailable,
      ok: Boolean(grokBilling?.ok),
      source: grokBilling?.source || null,
      billing: grokBilling?.ok ? grokBilling : null,
      note: grokAvailable && !grokBilling?.ok ? "未检测到 Grok 登录凭证（~/.grok/auth.json）" : null,
    };

    const parseOcStats = (rawOut) => {
      try {
        const parsed = JSON.parse(rawOut);
        const tok = parsed.tokens || {};
        const topModels = Array.isArray(parsed.models)
          ? parsed.models
              .map((m) => {
                const mt = m.tokens || {};
                const sum = (mt.input || 0) + (mt.output || 0) + (mt.reasoning || 0);
                return { id: m.model?.id || "", provider: m.model?.providerID || "", tokens: sum, cost: m.cost || 0 };
              })
              .filter((m) => m.id && m.tokens > 0)
              .sort((a, b) => b.tokens - a.tokens)
              .slice(0, 3)
          : [];
        return {
          sessions: parsed.sessions ?? 0,
          prompts: parsed.prompts ?? 0,
          steps: parsed.steps ?? 0,
          inputTokens: tok.input ?? 0,
          outputTokens: tok.output ?? 0,
          reasoningTokens: tok.reasoning ?? 0,
          cacheReadTokens: tok.cache?.read ?? 0,
          costUsd: typeof parsed.cost === "number" ? parsed.cost : 0,
          topModels,
        };
      } catch {
        return null;
      }
    };

    const ocAvailable = ocAllRaw.available || oc30Raw.available;
    const statsAll = ocAllRaw.ok && ocAllRaw.stdout.trim() ? parseOcStats(ocAllRaw.stdout) : null;
    const stats30d = oc30Raw.ok && oc30Raw.stdout.trim() ? parseOcStats(oc30Raw.stdout) : null;
    const opencode = {
      available: ocAvailable,
      ok: Boolean(statsAll || stats30d),
      stats: stats30d || statsAll,
      stats30d,
      statsAll,
      note: ocAvailable && !statsAll && !stats30d ? (ocAllRaw.stderr || "暂无法获取 OpenCode 统计").trim() : null,
    };

    const result = { fetchedAt: Date.now(), agy, grok, opencode };
    this.quotaCache = result;
    return result;
  }

  resetThread(colabSession, providerId) {
    const key = `${colabSession || ""}:${providerId || ""}`;
    if (providerId) {
      this.threads.delete(key);
    } else {
      for (const k of Array.from(this.threads.keys())) {
        if (k.startsWith(`${colabSession || ""}:`)) this.threads.delete(k);
      }
    }
  }

  resolvePermission(requestId, allow) {
    const resolver = this.pendingPermissions.get(requestId);
    if (!resolver) return false;
    this.pendingPermissions.delete(requestId);
    resolver(!!allow);
    return true;
  }

  isAcpAuthError(err) {
    if (!err) return false;
    if (err.code === -32000) return true;
    return /auth|unauthenticated|login|sign in/i.test(String(err.message || ""));
  }

  async getAcpAuthStatus(providerId = "agy") {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) {
      return { ok: false, installed: false, authenticated: false, error: `unknown ACP provider: ${providerId}` };
    }
    const exe = findExecutable(provider.command);
    if (!exe) {
      return {
        ok: true,
        provider: providerId,
        installed: false,
        path: null,
        authenticated: false,
        agentInfo: null,
        tier: null,
        authMethods: [],
        supportsLogout: false,
        error: `${provider.command} not found in PATH`,
      };
    }

    const client = this.getAcpClient(providerId);
    try {
      await client.ensureStarted();
    } catch (err) {
      return {
        ok: false,
        provider: providerId,
        installed: true,
        path: exe,
        authenticated: false,
        agentInfo: client.agentInfo,
        tier: null,
        authMethods: client.authMethods,
        supportsLogout: client.supportsLogout,
        error: err.message || String(err),
      };
    }

    try {
      const { catalog, tier } = await client.createSession();
      if (catalog.models.length > 0) {
        this.modelCache.set(providerId, {
          available: true,
          current: catalog.current,
          models: catalog.models,
        });
      }
      return {
        ok: true,
        provider: providerId,
        installed: true,
        path: exe,
        authenticated: true,
        agentInfo: client.agentInfo,
        tier: tier || client.tier || null,
        authMethods: client.authMethods,
        supportsLogout: client.supportsLogout,
        error: null,
      };
    } catch (err) {
      return {
        ok: true,
        provider: providerId,
        installed: true,
        path: exe,
        authenticated: false,
        authRequired: this.isAcpAuthError(err),
        agentInfo: client.agentInfo,
        tier: null,
        authMethods: client.authMethods,
        supportsLogout: client.supportsLogout,
        error: err.message || String(err),
      };
    }
  }

  async authenticateAcp(providerId = "agy", methodId = "oauth-personal") {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) return { ok: false, error: `unknown ACP provider: ${providerId}` };
    if (!findExecutable(provider.command)) {
      return { ok: false, error: `${provider.command} not installed` };
    }
    const client = this.getAcpClient(providerId);
    try {
      await client.authenticate(methodId || "oauth-personal");
      this.modelCache.delete(providerId);
      for (const k of Array.from(this.threads.keys())) {
        if (k.endsWith(`:${providerId}`)) this.threads.delete(k);
      }
      const status = await this.getAcpAuthStatus(providerId);
      return { ok: status.authenticated, status, error: status.authenticated ? null : status.error };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async logoutAcp(providerId = "agy") {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) return { ok: false, error: `unknown ACP provider: ${providerId}` };
    const client = this.getAcpClient(providerId);
    try {
      await client.logout();
      this.modelCache.delete(providerId);
      for (const k of Array.from(this.threads.keys())) {
        if (k.endsWith(`:${providerId}`)) this.threads.delete(k);
      }
      const status = await this.getAcpAuthStatus(providerId);
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async testApiConfig(cfg) {
    const api = this.getApiConfig(cfg);
    if (!api.baseUrl || !api.model) {
      return { ok: false, error: "请先填写 Base URL 和模型名称" };
    }
    const endpoints = resolveOpenAiChatEndpoints(api.baseUrl);
    if (endpoints.length === 0) {
      return { ok: false, error: "无效的 Base URL" };
    }
    const headers = { "content-type": "application/json" };
    if (api.apiKey) headers.authorization = `Bearer ${api.apiKey}`;
    let lastError = "无法连接到接口";
    for (let i = 0; i < endpoints.length; i += 1) {
      const endpoint = endpoints[i];
      const hasMore = i < endpoints.length - 1;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: api.model,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 8,
            stream: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const contentType = String(res.headers.get("content-type") || "").toLowerCase();
        const bodyText = await res.text().catch(() => "");
        if (!res.ok) {
          lastError = `${endpoint} → HTTP ${res.status}: ${bodyText.slice(0, 240)}`;
          if ((res.status === 404 || res.status === 405) && hasMore) continue;
          return { ok: false, error: lastError };
        }
        if (contentType.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(bodyText)) {
          lastError = `${endpoint} 返回了 HTML 页面而非 OpenAI JSON 接口`;
          if (hasMore) continue;
          return { ok: false, error: lastError };
        }
        if (bodyText.trim().startsWith("{")) {
          try {
            const parsed = parseOpenAiJsonCompletion(JSON.parse(bodyText));
            if (parsed?.error) {
              return { ok: false, error: `${endpoint} → ${parsed.error}` };
            }
          } catch {}
        }
        return { ok: true, model: api.model, endpoint };
      } catch (err) {
        lastError = `${endpoint} → ${err.message || String(err)}`;
        if (hasMore) continue;
      }
    }
    return { ok: false, error: lastError };
  }

  async runChat(input, emit, signal) {
    const providerId = String(input.provider || "agy");
    const isApiProfile = providerId === "api" || providerId.startsWith("api:");
    const provider = isApiProfile
      ? PROVIDERS.find((p) => p.id === "api")
      : PROVIDERS.find((p) => p.id === providerId);
    if (!provider) {
      emit({ type: "error", error: `未知的 Agent 引擎: ${providerId}` });
      return;
    }
    const promptText = String(input.prompt || "").trim();
    if (!promptText) {
      emit({ type: "error", error: "请输入对话内容" });
      return;
    }

    const colabSession = input.colabSession || "";
    const scopeKey = String(input.chatThreadId || colabSession || "");
    const threadKey = `${scopeKey}:${providerId}`;
    const approvalMode = input.approvalMode === "ask" ? "ask" : "auto";
    const model = String(input.model || "").trim();
    const thoughtLevel = String(input.thoughtLevel || "").trim();
    const context = {
      colabSession: colabSession || null,
      sessionInfo: input.sessionInfo || null,
      files: Array.isArray(input.files) ? input.files : [],
    };

    if (provider.transport === "openai-compat") {
      const profileId = providerId.startsWith("api:") ? providerId.slice(4) : null;
      await this._runOpenAiCompatTurn({ provider, providerId, profileId, threadKey, promptText, model, approvalMode, context, emit, signal });
      return;
    }

    if (!findExecutable(provider.command)) {
      emit({ type: "error", error: `未找到 ${provider.command} 命令。如未安装本机 CLI，可在「设置 → 智能体提供方」中配置自定义 API 密钥直接使用。` });
      return;
    }

    if (provider.transport === "acp") {
      await this._runAcpTurn({ provider, threadKey, promptText, model, thoughtLevel, approvalMode, context, emit, signal });
    } else if (provider.id === "grok") {
      await this._runGrokTurn({ provider, threadKey, promptText, model, approvalMode, context, emit, signal });
    }
  }

  async _executeColabTool(name, args, colabSession, signal) {
    const reqSession = () => {
      if (!colabSession) throw new Error("当前没有选中的 Colab 会话，请先创建一个会话");
      return colabSession;
    };
    let action;
    switch (name) {
      case "colab_exec":
        action = {
          type: "exec",
          session: reqSession(),
          code: args.code,
          outputImage: args.outputImage,
          timeout: args.timeout,
        };
        break;
      case "colab_ssh":
        action = { type: "ssh", session: reqSession(), command: args.command };
        break;
      case "colab_install":
        action = { type: "install", session: reqSession(), packages: Array.isArray(args.packages) ? args.packages : [] };
        break;
      case "colab_ls":
        action = { type: "ls", session: reqSession(), path: args.path };
        break;
      case "colab_upload":
        action = { type: "upload", session: reqSession(), local: args.local, remote: args.remote };
        break;
      case "colab_download":
        action = { type: "download", session: reqSession(), remote: args.remote, local: args.local };
        break;
      case "colab_status":
        action = colabSession ? { type: "status", session: colabSession } : { type: "status" };
        break;
      case "colab_usage":
        action = { type: "usage" };
        break;
      case "colab_sessions":
        action = { type: "sessions" };
        break;
      default:
        return { ok: false, output: `未知工具: ${name}` };
    }
    const res = await runAction(action, { signal });
    const out = [res.stdout, res.stderr, res.error].filter(Boolean).join("\n").trim() || (res.ok ? "(执行成功，无输出)" : "执行失败");
    return { ok: res.ok, output: out.slice(0, 16_000) };
  }

  async _runOpenAiCompatTurn({ provider, providerId, profileId, threadKey, promptText, model, approvalMode, context, emit, signal }) {
    const api = this.getApiConfig(null, profileId);
    if (!api.baseUrl || !api.model) {
      emit({ type: "error", error: "请先在「设置 → 智能体提供方」中配置自定义 API 的 Base URL 和模型名称" });
      return;
    }
    const activeModel = model || api.model;
    let candidateEndpoints = resolveOpenAiChatEndpoints(api.baseUrl);
    if (candidateEndpoints.length === 0) {
      emit({ type: "error", error: "自定义 API 的 Base URL 格式无效" });
      return;
    }
    const headers = { "content-type": "application/json" };
    if (api.apiKey) headers.authorization = `Bearer ${api.apiKey}`;

    let thread = this.threads.get(threadKey);
    if (!thread || !Array.isArray(thread.messages)) {
      thread = { messages: [] };
      this.threads.set(threadKey, thread);
    }

    const userContent = formatTurnPrompt(promptText, context, false);
    thread.messages.push({ role: "user", content: userContent });
    if (thread.messages.length > 30) thread.messages = thread.messages.slice(-30);

    emit({
      type: "meta",
      provider: providerId || provider.id,
      providerName: api.label || provider.name,
      model: activeModel,
      sessionId: threadKey,
    });

    const totalUsage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
    let includeStreamOptions = true;
    let includeTools = true;
    let preferStream = true;

    const addUsage = (u) => {
      if (!u) return;
      totalUsage.inputTokens += u.inputTokens ?? u.prompt_tokens ?? u.input_tokens ?? 0;
      totalUsage.outputTokens += u.outputTokens ?? u.completion_tokens ?? u.output_tokens ?? 0;
      totalUsage.thoughtTokens += u.thoughtTokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0;
    };

    const requestRound = async (messages, forceNonStream = false) => {
      let lastError = null;
      for (let i = 0; i < candidateEndpoints.length; i += 1) {
        const endpoint = candidateEndpoints[i];
        const hasNextEndpoint = i < candidateEndpoints.length - 1;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const useStream = !forceNonStream && preferStream;
          const payload = {
            model: activeModel,
            messages,
            stream: useStream,
          };
          if (includeTools) payload.tools = COLAB_OPENAI_TOOLS;
          if (useStream && includeStreamOptions) payload.stream_options = { include_usage: true };

          let res;
          try {
            res = await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
              signal,
            });
          } catch (err) {
            if (signal && signal.aborted) throw err;
            lastError = `无法连接 ${endpoint}: ${err.message || String(err)}`;
            break;
          }

          const contentType = String(res.headers.get("content-type") || "").toLowerCase();
          if (res.ok) {
            if (contentType.includes("text/html")) {
              try { await res.body?.cancel(); } catch {}
              lastError = `${endpoint} 返回了 HTML 页面（请检查 Base URL 是否需要 /v1 路径）`;
              if (hasNextEndpoint) break;
              return { error: lastError, endpoint };
            }
            candidateEndpoints = [endpoint];
            return { res, endpoint, contentType };
          }

          const errBody = await res.text().catch(() => "");
          let errDetail = errBody.slice(0, 400) || res.statusText;
          let errType = "";
          if (errBody.trim().startsWith("{")) {
            try {
              const parsedErr = JSON.parse(errBody);
              const e = parsedErr?.error;
              if (e && typeof e === "object") {
                errType = e.type || e.code || "";
                if (e.message || e.msg) errDetail = String(e.message || e.msg);
              } else if (typeof e === "string" && e) {
                errDetail = e;
              } else if (parsedErr?.message || parsedErr?.msg) {
                errDetail = String(parsedErr.message || parsedErr.msg);
              }
            } catch {}
          }
          lastError = `API 请求失败 (${endpoint} · HTTP ${res.status}${errType ? ` · ${errType}` : ""}): ${errDetail}`;

          if ((res.status === 404 || res.status === 405) && hasNextEndpoint) {
            break;
          }
          if (res.status === 400 || res.status === 422) {
            if (useStream && includeStreamOptions) {
              includeStreamOptions = false;
              continue;
            }
            if (includeTools && /tool|function/i.test(errBody)) {
              includeTools = false;
              continue;
            }
            if (useStream && /stream/i.test(errBody)) {
              preferStream = false;
              continue;
            }
            if (includeTools) {
              includeTools = false;
              continue;
            }
          }
          return { error: lastError, endpoint };
        }
      }
      return { error: lastError || "API 请求失败" };
    };

    const readRoundResponse = async (res, contentType) => {
      let assistantText = "";
      let thoughtText = "";
      let sseDataCount = 0;
      let streamError = null;
      const toolCallsMap = new Map();

      const processSseLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") return;
        sseDataCount += 1;
        let chunk;
        try { chunk = JSON.parse(dataStr); } catch { return; }
        if (chunk?.error) {
          streamError =
            typeof chunk.error === "string"
              ? chunk.error
              : chunk.error.message || chunk.error.msg || JSON.stringify(chunk.error);
          return;
        }
        if (chunk.usage) addUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || choice?.message;
        if (!delta) return;
        const reasoningPart = extractOpenAiContentText(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
        if (reasoningPart) {
          thoughtText += reasoningPart;
          emit({ type: "thought", text: reasoningPart });
        }
        const textPart = extractOpenAiContentText(delta.content);
        if (textPart) {
          assistantText += textPart;
          emit({ type: "text", text: textPart });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const prev = toolCallsMap.get(idx) || { id: "", name: "", arguments: "" };
            if (tc.id) prev.id = tc.id;
            if (tc.function?.name) prev.name += tc.function.name;
            if (typeof tc.function?.arguments === "string") {
              prev.arguments += tc.function.arguments;
            } else if (tc.function?.arguments != null) {
              prev.arguments += JSON.stringify(tc.function.arguments);
            }
            toolCallsMap.set(idx, prev);
          }
        }
      };

      const applyJsonBody = (rawText) => {
        let parsedJson;
        try { parsedJson = JSON.parse(rawText); } catch { return false; }
        const completion = parseOpenAiJsonCompletion(parsedJson);
        if (!completion) return false;
        if (completion.error) {
          streamError = completion.error;
          return true;
        }
        if (completion.usage) addUsage(completion.usage);
        if (completion.thought) {
          thoughtText += completion.thought;
          emit({ type: "thought", text: completion.thought });
        }
        if (completion.text) {
          assistantText += completion.text;
          emit({ type: "text", text: completion.text });
        }
        if (Array.isArray(completion.toolCalls)) {
          completion.toolCalls.forEach((tc, idx) => {
            toolCallsMap.set(idx, tc);
          });
        }
        return true;
      };

      let rawBody = "";
      if (contentType.includes("application/json") || !res.body) {
        rawBody = await res.text().catch(() => "");
        if (!applyJsonBody(rawBody) && rawBody.includes("data:")) {
          for (const line of rawBody.split(/\r?\n/)) processSseLine(line);
        }
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          if (sseDataCount === 0 && rawBody.length < 65_536) {
            rawBody += decoded.slice(0, 65_536 - rawBody.length);
          }
          sseBuf += decoded;
          const lines = sseBuf.split(/\r?\n/);
          sseBuf = lines.pop() || "";
          for (const rawLine of lines) processSseLine(rawLine);
        }
        const tail = decoder.decode();
        if (tail) {
          if (sseDataCount === 0 && rawBody.length < 65_536) {
            rawBody += tail.slice(0, 65_536 - rawBody.length);
          }
          sseBuf += tail;
        }
        if (sseBuf.trim()) {
          for (const rawLine of sseBuf.split(/\r?\n/)) processSseLine(rawLine);
        }
        if (sseDataCount === 0 && rawBody.trim()) {
          applyJsonBody(rawBody.trim());
        }
      }

      const toolCalls = Array.from(toolCallsMap.values()).filter((tc) => tc.name);
      return { assistantText, thoughtText, toolCalls, streamError, rawBody };
    };

    try {
      for (let round = 0; round < 12; round += 1) {
        if (signal && signal.aborted) {
          emit({ type: "done", stopReason: "cancelled", usage: totalUsage });
          return;
        }
        const messages = [
          { role: "system", content: buildColabSystemRules(context) },
          ...thread.messages,
        ];
        let reqRes = await requestRound(messages, false);
        if (reqRes.error) {
          emit({ type: "error", error: reqRes.error });
          return;
        }

        let parsed = await readRoundResponse(reqRes.res, reqRes.contentType);
        if (!parsed.streamError && !parsed.assistantText && !parsed.thoughtText && parsed.toolCalls.length === 0 && preferStream) {
          // Some local gateways accept stream:true with HTTP 200 but emit an empty body; retry once non-streaming
          preferStream = false;
          const fallbackReq = await requestRound(messages, true);
          if (!fallbackReq.error && fallbackReq.res) {
            reqRes = fallbackReq;
            parsed = await readRoundResponse(fallbackReq.res, fallbackReq.contentType);
          }
        }

        if (parsed.streamError) {
          emit({ type: "error", error: `API 返回错误 (${reqRes.endpoint}): ${parsed.streamError}` });
          return;
        }

        const { assistantText, thoughtText, toolCalls, rawBody } = parsed;
        if (toolCalls.length === 0) {
          if (!assistantText && !thoughtText) {
            const snippet = rawBody.trim().replace(/\s+/g, " ").slice(0, 220);
            emit({
              type: "error",
              error: `网关未返回任何回复内容 (${reqRes.endpoint} · ${reqRes.contentType || "unknown"})${snippet ? `: ${snippet}` : "。请检查网关地址（是否需要 /v1）、模型名或网关日志。"}`,
            });
            return;
          }
          if (assistantText) thread.messages.push({ role: "assistant", content: assistantText });
          emit({ type: "done", stopReason: "end_turn", usage: totalUsage });
          return;
        }

        thread.messages.push({
          role: "assistant",
          content: assistantText || null,
          tool_calls: toolCalls.map((tc, i) => ({
            id: tc.id || `call_${round}_${i}`,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments || "{}" },
          })),
        });

        for (let i = 0; i < toolCalls.length; i += 1) {
          const tc = toolCalls[i];
          const callId = tc.id || `call_${round}_${i}`;
          let parsedArgs = {};
          try { parsedArgs = JSON.parse(tc.arguments || "{}"); } catch {}

          emit({
            type: "tool_call",
            toolCallId: callId,
            title: `${tc.name}${parsedArgs.command ? `: ${parsedArgs.command}` : ""}`,
            kind: "tool",
            status: "in_progress",
            input: formatCompact(parsedArgs),
          });

          if (approvalMode === "ask") {
            const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const allowed = await new Promise((resolve) => {
              this.pendingPermissions.set(requestId, resolve);
              emit({ type: "permission_request", requestId, title: tc.name, detail: formatCompact(parsedArgs) });
              if (signal) {
                signal.addEventListener("abort", () => {
                  if (this.pendingPermissions.has(requestId)) {
                    this.pendingPermissions.delete(requestId);
                    resolve(false);
                  }
                }, { once: true });
              }
            });
            if (!allowed) {
              emit({ type: "tool_update", toolCallId: callId, status: "failed", output: "用户拒绝执行" });
              thread.messages.push({ role: "tool", tool_call_id: callId, content: "User denied this tool execution." });
              continue;
            }
          }

          let result;
          try {
            result = await this._executeColabTool(tc.name, parsedArgs, context.colabSession, signal);
          } catch (err) {
            result = { ok: false, output: err.message || String(err) };
          }
          emit({
            type: "tool_update",
            toolCallId: callId,
            status: result.ok ? "completed" : "failed",
            output: result.output,
          });
          thread.messages.push({ role: "tool", tool_call_id: callId, content: result.output });
        }
      }
      emit({ type: "done", stopReason: "max_turns", usage: totalUsage });
    } catch (err) {
      if (signal && signal.aborted) {
        emit({ type: "done", stopReason: "cancelled", usage: totalUsage });
      } else {
        emit({ type: "error", error: err.message || String(err) });
      }
    }
  }

  async _runAcpTurn({ provider, threadKey, promptText, model, thoughtLevel, approvalMode, context, emit, signal }) {
    const client = this.getAcpClient(provider.id);
    let thread = this.threads.get(threadKey);
    if (!thread) {
      try {
        const { sessionId, catalog } = await client.createSession();
        if (catalog.models.length > 0 && !this.modelCache.has(provider.id)) {
          this.modelCache.set(provider.id, {
            available: true,
            current: catalog.current,
            models: catalog.models,
            thoughtLevels: catalog.thoughtLevels || null,
          });
        }
        thread = {
          sessionId,
          initialized: false,
          lastModel: catalog.current || "",
          lastThought: catalog.thoughtLevels?.current || "",
          lastApproval: "",
        };
        this.threads.set(threadKey, thread);
      } catch (err) {
        if (this.isAcpAuthError(err)) {
          emit({
            type: "error",
            error: `${provider.name} ACP 需要先完成 Antigravity 认证：${err.message}`,
            authRequired: true,
            provider: provider.id,
            authMethods: client.authMethods,
          });
          return;
        }
        throw err;
      }
    }

    if (model && model !== thread.lastModel) {
      await client.setModel(thread.sessionId, model);
      thread.lastModel = model;
    }
    if (thoughtLevel && thoughtLevel !== thread.lastThought) {
      await client.setThoughtLevel(thread.sessionId, thoughtLevel);
      thread.lastThought = thoughtLevel;
    }
    if (approvalMode !== thread.lastApproval) {
      await client.setMode(thread.sessionId, approvalMode);
      thread.lastApproval = approvalMode;
    }

    emit({
      type: "meta",
      provider: provider.id,
      providerName: provider.name,
      model: thread.lastModel || model || "default",
      sessionId: thread.sessionId,
    });

    const formatted = formatTurnPrompt(promptText, context, !thread.initialized);
    thread.initialized = true;

    const onAbort = () => {
      client.cancel(thread.sessionId);
    };
    if (signal) {
      if (signal.aborted) {
        emit({ type: "error", error: "已中止对话" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    client.activeListener = {
      sessionId: thread.sessionId,
      approvalMode,
      emit,
      registerPermission: ({ requestId, title, detail }) =>
        new Promise((resolve) => {
          this.pendingPermissions.set(requestId, resolve);
          emit({ type: "permission_request", requestId, title, detail });
          if (signal) {
            signal.addEventListener(
              "abort",
              () => {
                if (this.pendingPermissions.has(requestId)) {
                  this.pendingPermissions.delete(requestId);
                  resolve(false);
                }
              },
              { once: true },
            );
          }
        }),
    };

    try {
      const res = await client.request("session/prompt", {
        sessionId: thread.sessionId,
        prompt: [{ type: "text", text: formatted }],
      });
      emit({ type: "done", stopReason: res?.stopReason || "end_turn", usage: res?.usage || null });
    } catch (err) {
      if (signal && signal.aborted) {
        emit({ type: "done", stopReason: "cancelled" });
      } else {
        // If the ACP session became stale, clear thread so next message creates a fresh one.
        this.threads.delete(threadKey);
        emit({ type: "error", error: err.message || String(err) });
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (client.activeListener?.sessionId === thread.sessionId) {
        client.activeListener = null;
      }
    }
  }

  _runGrokTurn({ provider, threadKey, promptText, model, approvalMode, context, emit, signal }) {
    return new Promise((resolve) => {
      const exe = findExecutable("grok");
      if (!exe) {
        emit({ type: "error", error: "grok 命令未找到" });
        resolve();
        return;
      }
      const existing = this.threads.get(threadKey);
      const argv = [
        "--output-format",
        "streaming-json",
        "--include-partial-messages",
        "--no-memory",
        "--permission-mode",
        approvalMode === "auto" ? "bypassPermissions" : "dontAsk",
      ];
      if (approvalMode === "auto") {
        argv.push("--always-approve");
      } else {
        argv.push("--allow", "Bash(colab *)");
      }
      if (model) argv.push("-m", model);
      argv.push("--rules", buildColabSystemRules(context));
      if (existing && existing.sessionId) {
        argv.push("-r", existing.sessionId);
      }
      const formatted = formatTurnPrompt(promptText, context, false);
      argv.push("-p", formatted);

      emit({
        type: "meta",
        provider: provider.id,
        providerName: provider.name,
        model: model || DEFAULT_GROK_MODELS[0].value,
        sessionId: existing?.sessionId || null,
      });

      const child = spawn(exe, argv, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buf = "";
      let stderr = "";
      let doneEmitted = false;

      const onAbort = () => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
          }, 500).unref();
        } catch {}
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          emit({ type: "done", stopReason: "cancelled" });
          resolve();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj;
          try {
            obj = JSON.parse(trimmed);
          } catch {
            continue;
          }
          const ev = parseGrokEvent(obj);
          if (!ev) continue;
          if (ev.type === "grok_end") {
            if (ev.sessionId) {
              this.threads.set(threadKey, { sessionId: ev.sessionId, initialized: true });
            }
            doneEmitted = true;
            emit({ type: "done", stopReason: "end_turn", usage: ev.usage, costUsd: ev.costUsd });
          } else {
            emit(ev);
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        emit({ type: "error", error: err.message });
        resolve();
      });

      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (signal && signal.aborted) {
          if (!doneEmitted) emit({ type: "done", stopReason: "cancelled" });
        } else if (code !== 0 && !doneEmitted) {
          emit({ type: "error", error: stderr.trim() || `grok 退出码 ${code}` });
        } else if (!doneEmitted) {
          emit({ type: "done", stopReason: "end_turn" });
        }
        resolve();
      });
    });
  }

  shutdown() {
    for (const [, client] of this.acpClients) {
      client.stop();
    }
    this.acpClients.clear();
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_CLIENT_VERSION = "0.8.2";

export const UPLOAD_DIR = path.join(os.tmpdir(), "colab-desk-uploads");
export const IMAGE_DIR = path.join(os.tmpdir(), "colab-desk-images");

export const PROVIDERS = [
  { id: "agy", name: "AGY", label: "AGY", transport: "acp", command: "agy", args: ["acp"] },
  { id: "grok", name: "Grok", label: "Grok", transport: "grok", command: "grok", args: [] },
  { id: "opencode", name: "OpenCode", label: "OpenCode", transport: "acp", command: "opencode", args: ["acp"] },
  { id: "api", name: "自定义 API", label: "自定义 API", transport: "openai-compat", command: null, args: [] },
];

export const COLAB_OPENAI_TOOLS = [
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

export const DEFAULT_GROK_MODELS = [
  { value: "grok-4.7-build-fast", name: "grok-4.7-build-fast (默认)" },
  { value: "grok-4.7", name: "grok-4.7" },
  { value: "grok-4.6", name: "grok-4.6" },
  { value: "grok-4.5", name: "grok-4.5" },
];

export const IMAGE_EXT_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

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

export function formatCompact(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function extractToolContent(content) {
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

export function formatToolActionTitle(rawName, rawInput, rawOutput = null) {
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

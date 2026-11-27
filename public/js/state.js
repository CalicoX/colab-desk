import { createDeskState } from "/desk.mjs";
import { resolveLanguage } from "/i18n.mjs";

export const SINGLE_SHAPE = new Set(["L4", "v5e1", "v6e1"]);
export const GPUS = new Set(["T4", "L4", "G4", "H100", "A100"]);
export const TPUS = new Set(["v5e1", "v6e1"]);
export const SESSION_MAX_HOURS = 12;

export const DEFAULT_SIDEBAR_WIDTH = 272;
export const MIN_SIDEBAR_WIDTH = 210;
export const MAX_SIDEBAR_WIDTH = 480;

export const SETTINGS_TABS = new Set(["general", "chat", "providers", "safety", "colab", "maintenance", "about"]);

export const API_PRESETS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.7-sonnet" },
  gemini: { label: "Gemini API", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro" },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:14b" },
};

export const SKINS = [
  { id: "amethyst", zh: "紫晶夜", en: "Amethyst", swatches: ["#14121b", "#211e2c", "#8273f5"] },
  { id: "obsidian", zh: "曜石黑", en: "Obsidian", swatches: ["#0c0c0e", "#18181c", "#e4e4ec"] },
  { id: "ocean", zh: "深海蓝", en: "Ocean", swatches: ["#0b1320", "#152236", "#2f9cf4"] },
  { id: "emerald", zh: "极光绿", en: "Emerald", swatches: ["#0c1613", "#152721", "#10b981"] },
  { id: "rose", zh: "玫瑰暮", en: "Rosé", swatches: ["#17141f", "#262033", "#e46c92"] },
  { id: "amber", zh: "琥珀暖", en: "Amber", swatches: ["#161310", "#25201a", "#e09132"] },
  { id: "nord", zh: "北欧冰", en: "Nord", swatches: ["#1c222d", "#293141", "#88c0d0"] },
  { id: "paper", zh: "暖纸白", en: "Paper", swatches: ["#f6f3ec", "#ede8dc", "#c75c35"] },
];

export function loadJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJsonStorage(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

export function emptyAgentUsageStats() {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    lastContextUsed: null,
    lastContextSize: null,
    byProvider: {},
  };
}

export const desk = createDeskState();

export const state = {
  languagePref: "auto", // "auto" | "zh-CN" | "en"
  themePref: "dark", // "system" | "dark" | "light"
  skinPref: "amethyst",
  activeLang: resolveLanguage("auto", navigator.language || navigator.languages?.[0] || "en"),
  composerMode: "agent", // "agent" | "notebook" | "cli"
  approvalMode: "auto", // "auto" | "ask"
  enterToSend: true,
  keepThoughtOpen: false,
  notifyOnComplete: true,
  cuAlertThreshold: 50,
  idleAlertMinutes: 30,
  lastActivityAt: Date.now(),
  cuAlertFired: false,
  idleAlertedSession: "",
  apiConfig: { label: "自定义 API", baseUrl: "", apiKey: "", model: "" },
  apiProfiles: [],
  editingApiProfileId: null,
  promptTemplates: [],
  envVars: [],
  bootstrapConfig: {
    autoMountDrive: false,
    enableHfTransfer: true,
    hfCacheToDrive: false,
    autoInstallUv: false,
    autoInjectEnv: true,
    customScript: "",
  },
  directScripts: [],
  activeRunnerScriptId: null,
  runnerParamValues: {},
  syncConfig: { localDir: "", remoteDir: "/content/project" },
  gpuAutoPoll: true,
  defaultHighMem: true,
  busySendMode: "queue", // "queue" | "steer"
  chatThreads: [], // [{ id, title, sessionName, pinned, createdAt, updatedAt }]
  activeThreadId: null,
  messageQueues: new Map(),
  pendingUnfinishedTasks: new Map(),
  activeAgentTurnContext: null,
  editingQueueItemId: null,
  pendingSteerItem: null,
  stopReasonKind: null, // "stop" | "steer" | null
  filesViewMode: "list", // "list" | "gallery"
  selectedRemotePaths: new Set(),
  lastListedEntries: [],
  lastParentPath: null,
  currentRemoteDir: "/content",
  activeTunnels: [],
  activeTunnelMode: (() => {
    try {
      return localStorage.getItem("colab-desk.tunnel-mode") === "ssh" ? "ssh" : "cloudflared";
    } catch {
      return "cloudflared";
    }
  })(),
  latestGpuInfo: null,
  providerListSnapshot: [],
  latestEnvCheck: null,
  latestAcpAuth: null,
  activeSettingsTab: "general",
  latestAgentQuota: null,
  hoveredPickerProviderId: "",

  // Session & runtime state
  selected: null,
  sessions: [],
  usageInfo: null,
  maxSeenBalance: 500,
  openMenuSession: null,
  navHistory: [],
  navIndex: -1,
  busyCount: 0,
  toastTimer: null,
  createController: null,
  createPollTimer: null,
  createTickTimer: null,
  activeAgentController: null,
  stagedFiles: [],
  providerModelsCache: {},
  connectedMap: loadJsonStorage("colab-desk.connected-at", {}),
  savedModelsByProvider: loadJsonStorage("colab-desk.agent-models", {}),
  savedThoughtByProvider: loadJsonStorage("colab-desk.agent-thoughts", {}),
  agentUsageStats: {
    ...emptyAgentUsageStats(),
    ...loadJsonStorage("colab-desk.agent-usage-stats", {}),
  },

  // Creation / background snipe state
  activeCreate: null,
  bgSnipe: null,
  agentCreate: null,

  // Workspace view & terminal state
  activeWorkspaceView: "chat", // "chat" | "split" | "terminal"
  termList: [],
  activeTermId: null,

  // Deleted thread undo stack
  deletedThreadStack: [],
  undoToastTimer: null,
  undoToastEl: null,
};

export function currentTranscriptKey() {
  return state.activeThreadId || "";
}

export function currentSessionObject() {
  return state.sessions.find((item) => item.name === state.selected) || null;
}

export function sessionConnectKey(session) {
  if (!session) return "";
  return `${session.name}:${session.endpoint || ""}`;
}

export function ensureConnectedAt(session) {
  if (!session) return null;
  const key = sessionConnectKey(session);
  if (!state.connectedMap[key]) {
    state.connectedMap[key] = Date.now();
    saveJsonStorage("colab-desk.connected-at", state.connectedMap);
  }
  return state.connectedMap[key];
}

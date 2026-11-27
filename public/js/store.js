import { dom } from "./dom.js";
import {
  currentTranscriptKey,
  desk,
  emptyAgentUsageStats,
  loadJsonStorage,
  saveJsonStorage,
  state,
} from "./state.js";
import { applyLanguage, applySkin, applyTheme } from "./theme.js";
import { renderUsageBadge } from "./usage.js";
import { setComposerMode, syncApprovalToggle, syncBusyModeToggle } from "./composer.js";
import { applySidebarWidth, renderInspector, setRailCollapsed, setSidebarCollapsed } from "./sessions.js";
import { renderTranscript } from "./transcript.js";

let storeSyncTimer = null;

export function buildSerializableHistory() {
  const serializable = {};
  for (const [k, list] of Object.entries(desk.bySession)) {
    serializable[k] = list.slice(-60).map((entry) => ({
      ...entry,
      streaming: false,
      permissions: [],
    }));
  }
  return serializable;
}

export function buildSerializableSettings() {
  return {
    languagePref: state.languagePref,
    themePref: state.themePref,
    skinPref: state.skinPref,
    composerMode: state.composerMode,
    approvalMode: state.approvalMode,
    enterToSend: state.enterToSend,
    keepThoughtOpen: state.keepThoughtOpen,
    notifyOnComplete: state.notifyOnComplete,
    cuAlertThreshold: state.cuAlertThreshold,
    idleAlertMinutes: state.idleAlertMinutes,
    apiConfig: state.apiConfig,
    apiProfiles: state.apiProfiles,
    promptTemplates: state.promptTemplates,
    envVars: state.envVars,
    bootstrapConfig: state.bootstrapConfig,
    directScripts: state.directScripts,
    syncConfig: state.syncConfig,
    gpuAutoPoll: state.gpuAutoPoll,
    defaultHighMem: state.defaultHighMem,
    busySendMode: state.busySendMode,
    chatThreads: state.chatThreads,
    activeThreadId: state.activeThreadId,
    provider: dom.agentProviderSelect.value || "agy",
    modelsByProvider: state.savedModelsByProvider,
    thoughtByProvider: state.savedThoughtByProvider,
    sidebarCollapsed: dom.app.classList.contains("is-sidebar-collapsed"),
    railCollapsed: dom.app.classList.contains("is-rail-collapsed"),
    sidebarWidth: parseFloat(getComputedStyle(dom.app).getPropertyValue("--sidebar-width")) || 272,
  };
}

export function flushStoreToDisk() {
  clearTimeout(storeSyncTimer);
  storeSyncTimer = null;
  const payload = {
    history: buildSerializableHistory(),
    usageStats: state.agentUsageStats,
    settings: buildSerializableSettings(),
  };
  fetch("/api/store", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export function scheduleStoreSync() {
  clearTimeout(storeSyncTimer);
  storeSyncTimer = setTimeout(flushStoreToDisk, 250);
}

export function persistDeskHistory() {
  const serializable = buildSerializableHistory();
  saveJsonStorage("colab-desk.history", serializable);
  scheduleStoreSync();
}

export function restoreDeskHistory(fromDisk) {
  const saved = fromDisk || loadJsonStorage("colab-desk.history", null);
  if (!saved || typeof saved !== "object") return;
  for (const [k, list] of Object.entries(saved)) {
    if (Array.isArray(list)) desk.bySession[k] = list;
  }
}

export async function hydrateFromLocalDisk() {
  try {
    const res = await fetch("/api/store");
    const json = await res.json();
    if (!json.ok || !json.data) return;
    const { history, usageStats, settings } = json.data;
    if (history && Object.keys(history).length > 0) {
      restoreDeskHistory(history);
    }
    if (usageStats && typeof usageStats === "object") {
      state.agentUsageStats = { ...emptyAgentUsageStats(), ...usageStats };
      renderUsageBadge();
    }
    if (settings && typeof settings === "object") {
      if (settings.composerMode === "cli" || settings.composerMode === "agent" || settings.composerMode === "notebook") {
        state.composerMode = settings.composerMode;
      }
      if (settings.approvalMode === "ask" || settings.approvalMode === "auto") {
        state.approvalMode = settings.approvalMode;
      }
      if (typeof settings.enterToSend === "boolean") state.enterToSend = settings.enterToSend;
      if (typeof settings.keepThoughtOpen === "boolean") state.keepThoughtOpen = settings.keepThoughtOpen;
      if (typeof settings.notifyOnComplete === "boolean") state.notifyOnComplete = settings.notifyOnComplete;
      if (typeof settings.cuAlertThreshold === "number") state.cuAlertThreshold = settings.cuAlertThreshold;
      if (typeof settings.idleAlertMinutes === "number") state.idleAlertMinutes = settings.idleAlertMinutes;
      if (Array.isArray(settings.apiProfiles)) {
        state.apiProfiles = settings.apiProfiles;
      } else if (settings.apiConfig && settings.apiConfig.baseUrl && settings.apiConfig.model) {
        state.apiProfiles = [{ id: "default", ...settings.apiConfig }];
      }
      if (settings.apiConfig && typeof settings.apiConfig === "object") {
        state.apiConfig = { ...state.apiConfig, ...settings.apiConfig };
      }
      if (Array.isArray(settings.promptTemplates)) {
        state.promptTemplates = settings.promptTemplates;
      }
      if (Array.isArray(settings.envVars)) state.envVars = settings.envVars;
      if (settings.bootstrapConfig && typeof settings.bootstrapConfig === "object") {
        state.bootstrapConfig = { ...state.bootstrapConfig, ...settings.bootstrapConfig };
      }
      if (Array.isArray(settings.directScripts)) state.directScripts = settings.directScripts;
      if (settings.syncConfig && typeof settings.syncConfig === "object") {
        state.syncConfig = { ...state.syncConfig, ...settings.syncConfig };
      }
      if (typeof settings.gpuAutoPoll === "boolean") state.gpuAutoPoll = settings.gpuAutoPoll;
      if (typeof settings.defaultHighMem === "boolean") {
        state.defaultHighMem = settings.defaultHighMem;
        dom.highMemInput.checked = state.defaultHighMem;
      }
      if (settings.busySendMode === "queue" || settings.busySendMode === "steer") {
        state.busySendMode = settings.busySendMode;
        syncBusyModeToggle(false);
      }
      if (Array.isArray(settings.chatThreads)) {
        state.chatThreads = settings.chatThreads.filter((x) => x && typeof x.id === "string");
      }
      // Always open on a fresh New Chat screen on app startup (no stale old thread pre-selected)
      state.activeThreadId = null;
      if (settings.modelsByProvider && typeof settings.modelsByProvider === "object") {
        Object.assign(state.savedModelsByProvider, settings.modelsByProvider);
      }
      if (settings.thoughtByProvider && typeof settings.thoughtByProvider === "object") {
        Object.assign(state.savedThoughtByProvider, settings.thoughtByProvider);
      }
      if (typeof settings.sidebarWidth === "number" && settings.sidebarWidth >= 210) {
        applySidebarWidth(settings.sidebarWidth, false);
      }
      if (typeof settings.sidebarCollapsed === "boolean") {
        setSidebarCollapsed(settings.sidebarCollapsed, false);
      }
      if (typeof settings.railCollapsed === "boolean") {
        setRailCollapsed(settings.railCollapsed, false);
      }
      if (settings.themePref === "system" || settings.themePref === "dark" || settings.themePref === "light") {
        applyTheme(settings.themePref, false);
      }
      if (typeof settings.skinPref === "string" && settings.skinPref) {
        applySkin(settings.skinPref, false);
      }
      if (settings.languagePref === "auto" || settings.languagePref === "zh-CN" || settings.languagePref === "en") {
        applyLanguage(settings.languagePref, false);
      }
      if (settings.provider) {
        try { localStorage.setItem("colab-desk.agent-provider", settings.provider); } catch {}
      }
      syncApprovalToggle(false);
      syncBusyModeToggle(false);
      setComposerMode(state.composerMode, false);
    }
    renderTranscript(currentTranscriptKey());
    renderInspector();
  } catch {}
}

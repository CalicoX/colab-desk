import { dom } from "./dom.js";
import {
  MIN_SIDEBAR_WIDTH,
  SKINS,
  currentSessionObject,
  currentTranscriptKey,
  state,
} from "./state.js";
import { tr } from "./utils.js";
import { hydrateFromLocalDisk, restoreDeskHistory } from "./store.js";
import { applyLanguage, applySkin, applyTheme, initThemeAndSkin } from "./theme.js";
import { refreshAgentQuota, renderUsageBadge } from "./usage-stats.js";
import { initThreadsAndQueue, migrateLegacyThreads, renderChatThreads } from "./threads.js";
import { renderTranscript } from "./transcript.js";
import { initProviders } from "./agent-pickers.js";
import { initAgentControls } from "./agent.js";
import {
  applySidebarWidth,
  checkCostAndIdleGuards,
  initSessionsAndLayout,
  refreshSessions,
  renderInspector,
  setRailCollapsed,
  setSidebarCollapsed,
  syncNavButtons,
} from "./sessions.js";
import { initComposer, setComposerMode, syncApprovalToggle, syncBusyModeToggle } from "./composer.js";
import {
  initCloudRail,
  refreshGpuTelemetry,
  refreshTunnels,
  renderTunnels,
  syncTunnelModeUi,
} from "./cloud-rail.js";
import { initGlobalShortcutsAndBridges } from "./shortcuts.js";
import { initLazyTriggers } from "./lazy.js";

// Lightweight startup Colab environment banner check (without eagerly loading settings.js)
async function checkColabEnvBanner() {
  try {
    const res = await fetch("/api/env/check");
    const data = await res.json();
    if (!data.ok || !data.env) return;
    state.latestEnvCheck = data.env;
    const needsSetup = !data.env.colabInstalled || !data.env.loggedIn;
    if (dom.envAlertBanner) {
      dom.envAlertBanner.hidden = !needsSetup;
      if (!data.env.colabInstalled) {
        dom.envAlertText.textContent = tr("ws.envBannerMissingCli");
      } else if (!data.env.loggedIn) {
        dom.envAlertText.textContent = tr("ws.envBannerNeedLogin");
      }
    }
  } catch {}
}

// Wire eager app-shell listeners, native WKWebView bridges, and lazy feature triggers
initThemeAndSkin();
initThreadsAndQueue();
initAgentControls();
initSessionsAndLayout();
initComposer();
initCloudRail();
initGlobalShortcutsAndBridges();
initLazyTriggers();

// Periodic background timers
setInterval(() => {
  if (currentSessionObject()) renderInspector();
}, 1000);
setInterval(() => {
  if (state.gpuAutoPoll && document.visibilityState === "visible" && currentSessionObject()) {
    refreshGpuTelemetry(true);
  }
}, 15_000);
setInterval(() => {
  checkCostAndIdleGuards();
}, 30_000);

// Restore instant localStorage preferences before first paint
try {
  const savedWidth = Number(localStorage.getItem("colab-desk.sidebar-width"));
  if (Number.isFinite(savedWidth) && savedWidth >= MIN_SIDEBAR_WIDTH) applySidebarWidth(savedWidth, false);
  if (localStorage.getItem("colab-desk.sidebar-collapsed") === "1") setSidebarCollapsed(true, false);
  if (localStorage.getItem("colab-desk.rail-collapsed") === "1") setRailCollapsed(true, false);
  const savedLang = localStorage.getItem("colab-desk.language");
  if (savedLang === "auto" || savedLang === "zh-CN" || savedLang === "en") state.languagePref = savedLang;
  const savedTheme = localStorage.getItem("colab-desk.theme");
  if (savedTheme === "system" || savedTheme === "dark" || savedTheme === "light") state.themePref = savedTheme;
  const savedSkin = localStorage.getItem("colab-desk.skin");
  if (savedSkin && SKINS.some((s) => s.id === savedSkin)) state.skinPref = savedSkin;
  const savedMode = localStorage.getItem("colab-desk.composer-mode");
  if (savedMode === "cli" || savedMode === "agent" || savedMode === "notebook") state.composerMode = savedMode;
  const savedApproval = localStorage.getItem("colab-desk.approval-mode");
  if (savedApproval === "ask" || savedApproval === "auto") state.approvalMode = savedApproval;
  const savedEnter = localStorage.getItem("colab-desk.enter-to-send");
  if (savedEnter === "0") state.enterToSend = false;
  const savedKeepThought = localStorage.getItem("colab-desk.keep-thought");
  if (savedKeepThought === "1") state.keepThoughtOpen = true;
} catch {}

// Initial synchronous render & hydration from ~/.config/colab-desk/state.json
restoreDeskHistory();
applyTheme(state.themePref, false);
applySkin(state.skinPref, false);
applyLanguage(state.languagePref, false);
renderUsageBadge();
syncApprovalToggle(false);
syncBusyModeToggle(false);
setComposerMode(state.composerMode, false);
syncNavButtons();
renderInspector();
syncTunnelModeUi();
renderTunnels();

hydrateFromLocalDisk().then((data) => {
  const settings = data?.settings;
  if (data?.usageStats) renderUsageBadge();
  if (settings && typeof settings === "object") {
    if (typeof settings.sidebarWidth === "number" && settings.sidebarWidth >= MIN_SIDEBAR_WIDTH) {
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
    syncApprovalToggle(false);
    syncBusyModeToggle(false);
    setComposerMode(state.composerMode, false);
  }

  migrateLegacyThreads();
  renderChatThreads();
  renderTranscript(currentTranscriptKey());
  renderInspector();
  initProviders();
  refreshSessions(null).then(() => {
    refreshGpuTelemetry(true);
    refreshTunnels();
  });
  refreshAgentQuota(false);
  checkColabEnvBanner();
});

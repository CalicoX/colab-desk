import {
  MIN_SIDEBAR_WIDTH,
  SKINS,
  currentSessionObject,
  currentTranscriptKey,
  state,
} from "./state.js";
import { hydrateFromLocalDisk, restoreDeskHistory } from "./store.js";
import { applyLanguage, applySkin, applyTheme, initThemeAndSkin } from "./theme.js";
import { initUsageModals, refreshAgentQuota, renderUsageBadge } from "./usage.js";
import { checkColabEnv, initSettings } from "./settings.js";
import { initThreadsAndQueue, migrateLegacyThreads, renderChatThreads } from "./threads.js";
import { renderTranscript } from "./transcript.js";
import { initAgentControls, initProviders } from "./agent.js";
import {
  applySidebarWidth,
  checkCostAndIdleGuards,
  initSessionsAndLayout,
  refreshSessions,
  renderInspector,
  setRailCollapsed,
  setSidebarCollapsed,
  syncHardwareChips,
  syncNavButtons,
} from "./sessions.js";
import { initSessionCreate } from "./session-create.js";
import { initNotebook } from "./notebook.js";
import { initComposer, setComposerMode, syncApprovalToggle, syncBusyModeToggle } from "./composer.js";
import { initFiles } from "./files.js";
import {
  initCloudTools,
  refreshGpuTelemetry,
  refreshTunnels,
  renderTunnels,
  syncTunnelModeUi,
} from "./cloud-tools.js";
import { initTerminal } from "./terminal.js";
import { initPaletteAndShortcuts } from "./palette.js";

// Wire all interactive event listeners & bridges
initThemeAndSkin();
initUsageModals();
initSettings();
initThreadsAndQueue();
initAgentControls();
initSessionsAndLayout();
initSessionCreate();
initNotebook();
initComposer();
initFiles();
initCloudTools();
initTerminal();
initPaletteAndShortcuts();

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
syncHardwareChips();
syncApprovalToggle(false);
syncBusyModeToggle(false);
setComposerMode(state.composerMode, false);
syncNavButtons();
renderInspector();
syncTunnelModeUi();
renderTunnels();

hydrateFromLocalDisk().then(() => {
  migrateLegacyThreads();
  renderChatThreads();
  renderTranscript(currentTranscriptKey());
  initProviders();
  refreshSessions(null).then(() => {
    refreshGpuTelemetry(true);
    refreshTunnels();
  });
  refreshAgentQuota(false);
  checkColabEnv();
});

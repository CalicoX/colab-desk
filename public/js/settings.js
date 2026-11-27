import { closeDialog, dom, openDialog } from "./dom.js";
import {
  API_PRESETS,
  DEFAULT_SIDEBAR_WIDTH,
  SETTINGS_TABS,
  desk,
  emptyAgentUsageStats,
  saveJsonStorage,
  state,
} from "./state.js";
import { L, escapeHtml, openExternalUrl, showToast, tr } from "./utils.js";
import { emit, on } from "./events.js";
import { flushStoreToDisk, persistDeskHistory, scheduleStoreSync } from "./store.js";
import { applyLanguage, applyTheme, renderSkinGrid, syncLanguageOptionLabel } from "./theme.js";
import { refreshAgentQuota } from "./usage-stats.js";
import { initProviders, loadProviderModels } from "./agent-pickers.js";
import { renderChatThreads, renderComposerQueue } from "./threads.js";
import { renderTranscript } from "./transcript.js";
import {
  applySidebarWidth,
  checkCostAndIdleGuards,
  refreshSessions,
  renderInspector,
  setRailCollapsed,
  setSidebarCollapsed,
} from "./sessions.js";
import { mountModalTemplate } from "./templates/mount.js";
import { SETTINGS_MODAL_HTML } from "./templates/settings-modal.js";

let settingsInitialized = false;

export function paintAcpAuthStatus(status) {
  state.latestAcpAuth = status;
  if (!status || !dom.agyAcpBadge || !dom.agyAcpDesc) return;
  const methods = Array.isArray(status.authMethods) ? status.authMethods : [];
  if (methods.length > 0 && dom.agyAcpMethod) {
    const prev = dom.agyAcpMethod.value;
    dom.agyAcpMethod.replaceChildren();
    for (const m of methods) {
      if (m.type === "terminal") continue;
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name || m.id} (${m.id})`;
      dom.agyAcpMethod.append(opt);
    }
    if (prev && Array.from(dom.agyAcpMethod.options).some((o) => o.value === prev)) {
      dom.agyAcpMethod.value = prev;
    }
  }

  if (!status.installed) {
    dom.agyAcpBadge.textContent = tr("settings.providers.acpMissing");
    dom.agyAcpBadge.className = "s-badge is-no";
    dom.agyAcpDesc.textContent = state.activeLang === "en"
      ? "agy CLI was not found in PATH. Install Antigravity CLI to use ACP authentication."
      : "未在 PATH 中找到 agy 命令，请先安装 Antigravity CLI。";
    dom.agyAcpLoginBtn.disabled = true;
    dom.agyAcpLogoutBtn.hidden = true;
    return;
  }

  dom.agyAcpLoginBtn.disabled = false;
  const srv = status.agentInfo
    ? `${status.agentInfo.name || "Antigravity ACP"} ${status.agentInfo.version || ""}`.trim()
    : "Antigravity ACP";
  const tierName = status.tier?.name ? ` · ${status.tier.name}` : "";

  if (status.authenticated) {
    dom.agyAcpBadge.textContent = `${tr("settings.providers.acpAuthed")}${tierName}`;
    dom.agyAcpBadge.className = "s-badge is-ok";
    dom.agyAcpDesc.textContent = `${srv} · ${status.path || "agy acp"}`;
    dom.agyAcpLogoutBtn.hidden = !status.supportsLogout;
  } else {
    dom.agyAcpBadge.textContent = tr("settings.providers.acpUnauthed");
    dom.agyAcpBadge.className = "s-badge is-warn";
    dom.agyAcpDesc.textContent = status.error
      ? `${srv} · ${status.error}`
      : `${srv} · ${state.activeLang === "en" ? "Click Sign in to authenticate via Antigravity ACP." : "点击下方按钮通过 Antigravity ACP 完成 Google 登录认证。"}`;
    dom.agyAcpLogoutBtn.hidden = true;
  }
}

export async function checkAgyAcpAuth() {
  if (dom.agyAcpRefreshBtn) dom.agyAcpRefreshBtn.disabled = true;
  if (dom.agyAcpBadge) {
    dom.agyAcpBadge.textContent = tr("settings.providers.acpChecking");
    dom.agyAcpBadge.className = "s-badge is-warn";
  }
  try {
    const res = await fetch("/api/agent/acp-auth?provider=agy");
    const data = await res.json();
    paintAcpAuthStatus(data);
  } catch (err) {
    if (dom.agyAcpDesc) dom.agyAcpDesc.textContent = err.message || "ACP auth check failed";
  } finally {
    if (dom.agyAcpRefreshBtn) dom.agyAcpRefreshBtn.disabled = false;
  }
}

export function selectSettingsTab(tabId) {
  state.activeSettingsTab = SETTINGS_TABS.has(tabId) ? tabId : "general";
  dom.settingsCrumbTab.textContent = tr(`settings.tab.${state.activeSettingsTab}`);
  dom.settingsModal.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.settingsTab === state.activeSettingsTab);
  });
  dom.settingsModal.querySelectorAll("[data-settings-pane]").forEach((pane) => {
    pane.classList.toggle("is-active", pane.dataset.settingsPane === state.activeSettingsTab);
  });
  if (state.activeSettingsTab === "colab") checkColabEnv();
  if (state.activeSettingsTab === "providers") {
    initProviders();
    checkAgyAcpAuth();
  }
}

export function openSettings(tabId = "general") {
  initSettings();
  dom.settingsSearchInput.value = "";
  filterSettingsRows("");
  renderSettingsModal();
  selectSettingsTab(tabId);
  openDialog(dom.settingsModal);
}

export function filterSettingsRows(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    dom.settingsModal.querySelectorAll("[data-settings-pane]").forEach((pane) => {
      pane.classList.toggle("is-active", pane.dataset.settingsPane === state.activeSettingsTab);
    });
    dom.settingsModal.querySelectorAll(".s-row").forEach((row) => { row.hidden = false; });
    dom.settingsModal.querySelectorAll(".s-group").forEach((g) => { g.hidden = false; });
    dom.settingsCrumbTab.textContent = tr(`settings.tab.${state.activeSettingsTab}`);
    return;
  }
  dom.settingsCrumbTab.textContent = `${tr("settings.search")} "${q}"`;
  dom.settingsModal.querySelectorAll("[data-settings-pane]").forEach((pane) => {
    let paneHas = false;
    pane.querySelectorAll(".s-group").forEach((group) => {
      let groupHas = false;
      group.querySelectorAll(".s-row").forEach((row) => {
        const hay = `${row.textContent || ""} ${row.dataset.search || ""}`.toLowerCase();
        const match = hay.includes(q);
        row.hidden = !match;
        if (match) groupHas = true;
      });
      group.hidden = !groupHas;
      if (groupHas) paneHas = true;
    });
    pane.classList.toggle("is-active", paneHas);
  });
}

export function paintEnvCheck(env) {
  state.latestEnvCheck = env;
  if (!env) return;

  const needsSetup = !env.colabInstalled || !env.loggedIn;
  if (dom.navColabDot) {
    dom.navColabDot.hidden = false;
    dom.navColabDot.className = `settings-nav-dot ${needsSetup ? "is-warn" : "is-ok"}`;
  }
  if (dom.envAlertBanner) {
    dom.envAlertBanner.hidden = !needsSetup;
    if (!env.colabInstalled) {
      dom.envAlertText.textContent = tr("ws.envBannerMissingCli");
    } else if (!env.loggedIn) {
      dom.envAlertText.textContent = tr("ws.envBannerNeedLogin");
    }
  }

  const cliDesc = document.querySelector("#env-cli-desc");
  const cliBadge = document.querySelector("#env-cli-badge");
  const authDesc = document.querySelector("#env-auth-desc");
  const authBadge = document.querySelector("#env-auth-badge");
  const toolsDesc = document.querySelector("#env-tools-desc");
  const installUvBtn = document.querySelector("#env-install-uv-btn");
  const installPipBtn = document.querySelector("#env-install-pip-btn");
  const loginBtn = document.querySelector("#env-login-btn");
  if (!cliDesc || !cliBadge) return;

  if (env.colabInstalled) {
    cliBadge.textContent = env.colabVersion ? `v${env.colabVersion}` : (state.activeLang === "en" ? "Installed" : "已安装");
    cliBadge.className = "s-badge is-ok";
    cliDesc.textContent = `${state.activeLang === "en" ? "Path: " : "路径："}${env.colabPath}`;
  } else {
    cliBadge.textContent = state.activeLang === "en" ? "Missing" : "未安装";
    cliBadge.className = "s-badge is-no";
    cliDesc.textContent = state.activeLang === "en"
      ? "colab binary not found in PATH. Install google-colab-cli below."
      : "未检测到 colab 命令，请点击下方一键安装 google-colab-cli。";
  }

  if (env.loggedIn) {
    authBadge.textContent = state.activeLang === "en" ? "Signed in" : "已登录";
    authBadge.className = "s-badge is-ok";
    authDesc.textContent = `${env.email || "Google"}${env.authProvider ? ` · ${env.authProvider}` : ""}${env.expiresIn ? (state.activeLang === "en" ? ` · expires in ${env.expiresIn}` : ` · 有效期 ${env.expiresIn}`) : ""}`;
  } else if (!env.colabInstalled) {
    authBadge.textContent = state.activeLang === "en" ? "Pending" : "待安装";
    authBadge.className = "s-badge is-warn";
    authDesc.textContent = state.activeLang === "en"
      ? "Install colab CLI first, then complete Google sign-in."
      : "请先安装 colab CLI，再完成 Google 账号授权。";
  } else {
    authBadge.textContent = state.activeLang === "en" ? "Not signed in" : "未登录";
    authBadge.className = "s-badge is-no";
    authDesc.textContent = env.error || (state.activeLang === "en"
      ? "Not signed in to Google Colab. Click Browser OAuth Login below."
      : "尚未登录 Google Colab，点击下方按钮在浏览器完成登录。");
  }

  const okLbl = state.activeLang === "en" ? "ok" : "可用";
  const noLbl = state.activeLang === "en" ? "missing" : "未安装";
  toolsDesc.textContent = `uv: ${env.hasUv ? okLbl : noLbl} · pip3: ${env.hasPip ? okLbl : noLbl} · python3: ${env.hasPython ? okLbl : noLbl}`;
  installUvBtn.disabled = !env.hasUv;
  installPipBtn.disabled = !env.hasPip;
  loginBtn.disabled = !env.colabInstalled;
}

export async function checkColabEnv() {
  const btn = document.querySelector("#env-recheck-btn");
  if (btn) { btn.disabled = true; btn.textContent = tr("settings.colab.checkingBtn"); }
  try {
    const res = await fetch("/api/env/check");
    const data = await res.json();
    if (data.ok && data.env) paintEnvCheck(data.env);
  } catch {}
  finally {
    if (btn) { btn.disabled = false; btn.textContent = tr("settings.colab.recheckBtn"); }
  }
}

export function renderApiProfilesList() {
  if (!dom.apiProfilesListEl) return;
  dom.apiProfilesListEl.replaceChildren();
  if (!state.apiProfiles.length) return;
  for (const prof of state.apiProfiles) {
    const item = document.createElement("div");
    item.className = "api-profile-item";
    const info = document.createElement("div");
    info.className = "s-copy";
    const titleEl = document.createElement("span");
    titleEl.className = "s-title";
    titleEl.textContent = `${prof.label} · ${prof.model}`;
    const descEl = document.createElement("span");
    descEl.className = "s-desc";
    descEl.textContent = prof.baseUrl;
    info.append(titleEl, descEl);

    const btns = document.createElement("div");
    btns.className = "s-actions";
    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "s-btn";
    useBtn.textContent = state.activeLang === "en" ? "Use" : "切换";
    useBtn.addEventListener("click", () => {
      dom.agentProviderSelect.value = `api:${prof.id}`;
      try { localStorage.setItem("colab-desk.agent-provider", `api:${prof.id}`); } catch {}
      loadProviderModels(`api:${prof.id}`);
      showToast(state.activeLang === "en" ? `Switched to ${prof.label}` : `已切换到 ${prof.label}`);
    });
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "s-btn";
    editBtn.textContent = state.activeLang === "en" ? "Edit" : "编辑";
    editBtn.addEventListener("click", () => {
      state.editingApiProfileId = prof.id;
      dom.apiLabelInput.value = prof.label || "";
      dom.apiModelInput.value = prof.model || "";
      dom.apiBaseUrlInput.value = prof.baseUrl || "";
      dom.apiKeyInput.value = prof.apiKey || "";
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "s-btn is-danger";
    delBtn.textContent = state.activeLang === "en" ? "Delete" : "删除";
    delBtn.addEventListener("click", async () => {
      state.apiProfiles = state.apiProfiles.filter((p) => p.id !== prof.id);
      if (state.editingApiProfileId === prof.id) state.editingApiProfileId = null;
      flushStoreToDisk();
      await initProviders();
      renderApiProfilesList();
    });
    btns.append(useBtn, editBtn, delBtn);
    item.append(info, btns);
    dom.apiProfilesListEl.append(item);
  }
}

export function renderEnvVarsList() {
  if (!dom.envVarsListEl) return;
  dom.envVarsListEl.replaceChildren();
  for (const item of state.envVars) {
    const row = document.createElement("div");
    row.className = "env-var-row";
    const masked = item.value ? `${String(item.value).slice(0, 4)}••••` : "(empty)";
    const left = document.createElement("span");
    left.textContent = `${item.key} = ${masked}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "s-btn is-danger";
    del.style.padding = "2px 7px";
    del.textContent = "×";
    del.addEventListener("click", () => {
      state.envVars = state.envVars.filter((x) => x.key !== item.key);
      flushStoreToDisk();
      renderEnvVarsList();
    });
    row.append(left, del);
    dom.envVarsListEl.append(row);
  }
}

export async function runBootstrapOnSession(targetSession, silent = false) {
  const sess = targetSession || state.selected;
  if (!sess) {
    if (!silent) showToast(L("请先连接一台 Colab 虚拟机", "Please connect to a Colab VM first"));
    return;
  }
  if (!silent) showToast(L(`正在初始化 ${sess}…`, `Bootstrapping ${sess}…`));
  if (dom.bootRunLog && !silent) {
    dom.bootRunLog.hidden = false;
    dom.bootRunLog.textContent = L(`正在初始化 ${sess}（挂载 / 注入环境变量 / 安装加速工具）…`, `Bootstrapping ${sess} (mount / env injection / tools)…`);
  }
  try {
    const res = await fetch("/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sess, envVars: state.envVars, config: state.bootstrapConfig }),
    }).then((r) => r.json());
    if (dom.bootRunLog && !silent) {
      dom.bootRunLog.textContent = res.ok
        ? L(`初始化完成：\n${res.log || "ok"}`, `Bootstrap completed:\n${res.log || "ok"}`)
        : L(`初始化失败：${res.error}\n${res.log || ""}`, `Bootstrap failed: ${res.error}\n${res.log || ""}`);
    }
    showToast(res.ok ? L(`VM ${sess} 初始化完成`, `VM ${sess} bootstrapped`) : L(`初始化失败：${res.error}`, `Bootstrap failed: ${res.error}`));
  } catch (err) {
    if (dom.bootRunLog && !silent) dom.bootRunLog.textContent = err.message;
  }
}

export function renderSettingsModal() {
  syncLanguageOptionLabel();
  renderSkinGrid();
  if (dom.settingLanguage) dom.settingLanguage.value = state.languagePref;
  if (dom.settingTheme) dom.settingTheme.value = state.themePref;
  if (dom.settingRailOpen) dom.settingRailOpen.checked = !dom.app.classList.contains("is-rail-collapsed");
  dom.settingEnterSend.checked = state.enterToSend;
  dom.settingApproval.value = state.approvalMode;
  dom.settingMode.value = state.composerMode;
  dom.settingKeepThought.checked = state.keepThoughtOpen;
  if (dom.settingNotifyComplete) dom.settingNotifyComplete.checked = state.notifyOnComplete;
  if (dom.settingCuAlert) dom.settingCuAlert.value = String(state.cuAlertThreshold);
  if (dom.settingIdleAlert) dom.settingIdleAlert.value = String(state.idleAlertMinutes);
  if (dom.settingGpuPoll) dom.settingGpuPoll.checked = state.gpuAutoPoll;
  if (dom.settingDefaultHighMem) dom.settingDefaultHighMem.checked = state.defaultHighMem;
  if (dom.settingBusySendMode) dom.settingBusySendMode.value = state.busySendMode;
  if (dom.bootMountDrive) dom.bootMountDrive.checked = !!state.bootstrapConfig.autoMountDrive;
  if (dom.bootHfTransfer) dom.bootHfTransfer.checked = state.bootstrapConfig.enableHfTransfer !== false;
  if (dom.bootHfDriveCache) dom.bootHfDriveCache.checked = !!state.bootstrapConfig.hfCacheToDrive;
  if (dom.bootInstallUv) dom.bootInstallUv.checked = !!state.bootstrapConfig.autoInstallUv;
  if (dom.bootInjectEnv) dom.bootInjectEnv.checked = state.bootstrapConfig.autoInjectEnv !== false;
  if (dom.bootCustomScript) dom.bootCustomScript.value = state.bootstrapConfig.customScript || "";
  renderEnvVarsList();
  renderApiProfilesList();
  if (!state.editingApiProfileId && state.apiProfiles.length === 0) {
    dom.apiLabelInput.value = state.apiConfig.label || "";
    dom.apiModelInput.value = state.apiConfig.model || "";
    dom.apiBaseUrlInput.value = state.apiConfig.baseUrl || "";
    dom.apiKeyInput.value = state.apiConfig.apiKey || "";
  }

  dom.settingProviderList.replaceChildren();
  const cliProviders = state.providerListSnapshot.filter((p) => p.transport !== "openai-compat");
  const hints = {
    agy: state.activeLang === "en" ? "Antigravity CLI (ACP · Antigravity Auth)" : "Antigravity CLI (ACP 协议 · Antigravity 认证)",
    grok: "Grok Build CLI (streaming-json)",
    opencode: state.activeLang === "en" ? "OpenCode CLI (ACP)" : "OpenCode CLI (ACP 协议)",
  };
  for (const p of cliProviders) {
    const row = document.createElement("div");
    row.className = "s-row";
    row.dataset.search = `${p.id} ${p.name} cli agent`;
    const copy = document.createElement("div");
    copy.className = "s-copy";
    const tEl = document.createElement("span");
    tEl.className = "s-title";
    tEl.textContent = p.name;
    const dEl = document.createElement("span");
    dEl.className = "s-desc";
    const missingTxt = state.activeLang === "en" ? "Not found in PATH" : "未在本机 PATH 中检测到";
    dEl.textContent = p.available ? `${hints[p.id] || p.transport} · ${p.path || tr("settings.providers.ready")}` : `${hints[p.id] || p.transport} · ${missingTxt}`;
    copy.append(tEl, dEl);
    const badge = document.createElement("span");
    badge.className = `s-badge ${p.available ? "is-ok" : "is-no"}`;
    badge.textContent = p.available ? tr("settings.providers.ready") : tr("settings.providers.notInstalled");
    row.append(copy, badge);
    dom.settingProviderList.append(row);
  }
  if (state.latestEnvCheck) paintEnvCheck(state.latestEnvCheck);
  if (state.latestAcpAuth) paintAcpAuthStatus(state.latestAcpAuth);
}

export async function triggerColabInstall(method) {
  const logEl = document.querySelector("#env-install-log");
  const uvBtn = document.querySelector("#env-install-uv-btn");
  const pipBtn = document.querySelector("#env-install-pip-btn");
  uvBtn.disabled = true;
  pipBtn.disabled = true;
  logEl.hidden = false;
  logEl.textContent = `正在通过 ${method} 安装 google-colab-cli，请稍候…`;
  try {
    const res = await fetch("/api/env/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method }),
    });
    const data = await res.json();
    logEl.textContent = data.ok
      ? `安装成功（${data.command}）\n${data.output || ""}`.trim()
      : `安装失败：${data.error || "未知错误"}\n${data.output || ""}`.trim();
    if (data.env) paintEnvCheck(data.env);
    if (data.ok) refreshSessions(state.selected);
  } catch (err) {
    logEl.textContent = `安装出错：${err.message}`;
  } finally {
    if (state.latestEnvCheck) paintEnvCheck(state.latestEnvCheck);
  }
}

export function initSettings() {
  if (settingsInitialized) return;
  settingsInitialized = true;
  mountModalTemplate("settings-modal", SETTINGS_MODAL_HTML);
  syncLanguageOptionLabel();
  renderSkinGrid();

  on("language:changed", () => {
    if (state.latestEnvCheck) paintEnvCheck(state.latestEnvCheck);
    if (state.latestAcpAuth) paintAcpAuthStatus(state.latestAcpAuth);
    if (dom.settingsModal?.open) renderSettingsModal();
  });

  document.querySelector("#close-settings-modal").addEventListener("click", () => closeDialog(dom.settingsModal));
  dom.settingsModal.addEventListener("click", (e) => { if (e.target === dom.settingsModal) closeDialog(dom.settingsModal); });

  dom.settingsModal.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      dom.settingsSearchInput.value = "";
      filterSettingsRows("");
      selectSettingsTab(btn.dataset.settingsTab);
    });
  });
  dom.settingsSearchInput.addEventListener("input", () => filterSettingsRows(dom.settingsSearchInput.value));
  dom.settingsModal.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== dom.settingsSearchInput && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      dom.settingsSearchInput.focus();
    }
  });

  document.querySelector("#settings-restore-defaults").addEventListener("click", () => {
    state.enterToSend = true;
    state.approvalMode = "auto";
    state.composerMode = "agent";
    state.keepThoughtOpen = false;
    state.gpuAutoPoll = true;
    state.defaultHighMem = true;
    emit("session-create:sync-hardware");
    state.busySendMode = "queue";
    emit("composer:sync-busy-mode", false);
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, false);
    setSidebarCollapsed(false, false);
    setRailCollapsed(false, false);
    applyLanguage("auto", false);
    emit("composer:sync-approval", false);
    emit("composer:sync-busy-mode", false);
    emit("composer:set-mode", { mode: "agent", sync: false });
    renderSettingsModal();
    flushStoreToDisk();
    showToast(tr("toast.defaultsRestored"));
  });

  document.querySelector("#setting-reset-sidebar").addEventListener("click", () => {
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, true);
    setSidebarCollapsed(false, true);
    setRailCollapsed(false, true);
    showToast(tr("toast.sidebarReset"));
  });

  dom.settingLanguage.addEventListener("change", () => {
    applyLanguage(dom.settingLanguage.value, true);
  });
  dom.settingRailOpen.addEventListener("change", () => {
    setRailCollapsed(!dom.settingRailOpen.checked, true);
  });

  // Antigravity (AGY) ACP authentication controls
  dom.agyAcpRefreshBtn.addEventListener("click", checkAgyAcpAuth);
  dom.agyAcpLoginBtn.addEventListener("click", async () => {
    const methodId = dom.agyAcpMethod.value || "oauth-personal";
    dom.agyAcpLoginBtn.disabled = true;
    dom.agyAcpLoginBtn.textContent = tr("settings.providers.acpLoggingIn");
    dom.agyAcpLog.hidden = false;
    dom.agyAcpLog.textContent = state.activeLang === "en"
      ? `Starting Antigravity ACP authenticate (${methodId})… Complete sign-in in the browser window.`
      : `正在通过 agy acp 发起 Antigravity 认证（${methodId}）… 请在弹出的浏览器窗口中完成登录。`;
    try {
      const res = await fetch("/api/agent/acp-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "agy", methodId }),
      });
      const data = await res.json();
      if (data.status) paintAcpAuthStatus(data.status);
      dom.agyAcpLog.textContent = data.ok
        ? (state.activeLang === "en" ? "Antigravity ACP authentication succeeded." : "Antigravity ACP 认证成功！")
        : `${state.activeLang === "en" ? "Authentication failed: " : "认证未完成："}${data.error || ""}`;
      if (data.ok) {
        delete state.providerModelsCache.agy;
        await initProviders();
        refreshAgentQuota(true);
      }
    } catch (err) {
      dom.agyAcpLog.textContent = `${state.activeLang === "en" ? "Error: " : "认证出错："}${err.message}`;
    } finally {
      dom.agyAcpLoginBtn.disabled = false;
      dom.agyAcpLoginBtn.textContent = tr("settings.providers.acpLogin");
    }
  });
  dom.agyAcpLogoutBtn.addEventListener("click", async () => {
    dom.agyAcpLogoutBtn.disabled = true;
    dom.agyAcpLog.hidden = false;
    dom.agyAcpLog.textContent = state.activeLang === "en" ? "Signing out from Antigravity ACP…" : "正在退出 Antigravity ACP 登录…";
    try {
      const res = await fetch("/api/agent/acp-auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "agy" }),
      });
      const data = await res.json();
      if (data.status) paintAcpAuthStatus(data.status);
      dom.agyAcpLog.textContent = data.ok
        ? (state.activeLang === "en" ? "Signed out." : "已退出 Antigravity 登录。")
        : `${data.error || "Logout failed"}`;
      delete state.providerModelsCache.agy;
    } catch (err) {
      dom.agyAcpLog.textContent = err.message;
    } finally {
      dom.agyAcpLogoutBtn.disabled = false;
    }
  });

  dom.settingEnterSend.addEventListener("change", () => {
    state.enterToSend = dom.settingEnterSend.checked;
    try { localStorage.setItem("colab-desk.enter-to-send", state.enterToSend ? "1" : "0"); } catch {}
    emit("composer:sync");
    scheduleStoreSync();
  });
  dom.settingTheme.addEventListener("change", () => applyTheme(dom.settingTheme.value, true));
  dom.settingApproval.addEventListener("change", () => {
    state.approvalMode = dom.settingApproval.value === "ask" ? "ask" : "auto";
    emit("composer:sync-approval", true);
  });
  dom.settingMode.addEventListener("change", () => emit("composer:set-mode", dom.settingMode.value));
  dom.settingKeepThought.addEventListener("change", () => {
    state.keepThoughtOpen = dom.settingKeepThought.checked;
    try { localStorage.setItem("colab-desk.keep-thought", state.keepThoughtOpen ? "1" : "0"); } catch {}
    scheduleStoreSync();
  });
  dom.settingNotifyComplete.addEventListener("change", () => {
    state.notifyOnComplete = dom.settingNotifyComplete.checked;
    scheduleStoreSync();
  });
  dom.settingCuAlert.addEventListener("change", () => {
    state.cuAlertThreshold = Math.max(0, Number(dom.settingCuAlert.value) || 0);
    state.cuAlertFired = false;
    scheduleStoreSync();
    checkCostAndIdleGuards();
  });
  dom.settingIdleAlert.addEventListener("change", () => {
    state.idleAlertMinutes = Math.max(0, Number(dom.settingIdleAlert.value) || 0);
    state.idleAlertedSession = "";
    scheduleStoreSync();
  });

  // Custom OpenAI-compatible API presets, multi-profile save & test
  dom.settingsModal.querySelectorAll("[data-api-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = API_PRESETS[btn.dataset.apiPreset];
      if (!preset) return;
      state.editingApiProfileId = null;
      dom.apiLabelInput.value = preset.label;
      dom.apiBaseUrlInput.value = preset.baseUrl;
      dom.apiModelInput.value = preset.model;
      dom.apiTestStatus.textContent = "";
    });
  });

  document.querySelector("#api-save-btn").addEventListener("click", async () => {
    const nextProf = {
      id: state.editingApiProfileId || `p-${Date.now().toString(36)}`,
      label: dom.apiLabelInput.value.trim() || "自定义 API",
      baseUrl: dom.apiBaseUrlInput.value.trim(),
      apiKey: dom.apiKeyInput.value.trim(),
      model: dom.apiModelInput.value.trim(),
    };
    state.apiConfig = { label: nextProf.label, baseUrl: nextProf.baseUrl, apiKey: nextProf.apiKey, model: nextProf.model };
    if (nextProf.baseUrl && nextProf.model) {
      const idx = state.apiProfiles.findIndex((p) => p.id === nextProf.id);
      if (idx >= 0) state.apiProfiles[idx] = nextProf;
      else state.apiProfiles.push(nextProf);
      state.editingApiProfileId = null;
    }
    flushStoreToDisk();
    for (const k of Object.keys(state.providerModelsCache)) {
      if (k === "api" || k.startsWith("api:")) delete state.providerModelsCache[k];
    }
    await initProviders();
    if (nextProf.baseUrl && nextProf.model) {
      const targetId = `api:${nextProf.id}`;
      dom.agentProviderSelect.value = targetId;
      try { localStorage.setItem("colab-desk.agent-provider", targetId); } catch {}
      await loadProviderModels(targetId);
      dom.apiTestStatus.textContent = state.activeLang === "en"
        ? `Saved "${nextProf.label}" and switched to it.`
        : `已保存「${nextProf.label}」并切换使用（可继续添加多个 API 档案）`;
    } else {
      dom.apiTestStatus.textContent = state.activeLang === "en"
        ? "Please enter both Base URL and Model name."
        : "请填写 Base URL 和模型名称后启用";
    }
    renderSettingsModal();
  });

  if (dom.apiFetchModelsBtn) {
    dom.apiFetchModelsBtn.addEventListener("click", async () => {
      const baseUrl = dom.apiBaseUrlInput.value.trim();
      if (!baseUrl) {
        dom.apiTestStatus.textContent = L("请先填写 Base URL", "Enter Base URL first");
        return;
      }
      dom.apiFetchModelsBtn.disabled = true;
      dom.apiTestStatus.textContent = L("正在拉取网关模型列表…", "Fetching /v1/models…");
      try {
        const res = await fetch("/api/agent/fetch-models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey: dom.apiKeyInput.value.trim(), model: dom.apiModelInput.value.trim() }),
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
          if (dom.apiModelsDatalist) {
            dom.apiModelsDatalist.replaceChildren();
            for (const m of data.models) {
              const opt = document.createElement("option");
              opt.value = m.value;
              dom.apiModelsDatalist.append(opt);
            }
          }
          if (!dom.apiModelInput.value.trim()) {
            dom.apiModelInput.value = data.models[0].value;
          }
          dom.apiTestStatus.textContent = L(
            `已拉取 ${data.models.length} 个模型（可在上方模型输入框下拉选择）`,
            `Fetched ${data.models.length} models (pick from the Model input list)`,
          );
        } else {
          dom.apiTestStatus.textContent = L(
            `拉取失败：${data.error || "网关未返回模型列表"}`,
            `Fetch failed: ${data.error || "no models returned"}`,
          );
        }
      } catch (err) {
        dom.apiTestStatus.textContent = `${L("拉取失败：", "Fetch failed: ")}${err?.message || String(err)}`;
      } finally {
        dom.apiFetchModelsBtn.disabled = false;
      }
    });
  }

  document.querySelector("#api-test-btn").addEventListener("click", async () => {
    const btn = document.querySelector("#api-test-btn");
    btn.disabled = true;
    dom.apiTestStatus.textContent = "正在测试连接…";
    try {
      const res = await fetch("/api/agent/test-api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: dom.apiBaseUrlInput.value.trim(),
          apiKey: dom.apiKeyInput.value.trim(),
          model: dom.apiModelInput.value.trim(),
        }),
      });
      const data = await res.json();
      dom.apiTestStatus.textContent = data.ok ? `连接成功（${data.model}）` : `连接失败：${data.error}`;
    } catch (err) {
      dom.apiTestStatus.textContent = `测试失败：${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // Colab CLI check, install & login
  document.querySelector("#env-recheck-btn").addEventListener("click", checkColabEnv);
  dom.settingsModal.querySelectorAll("[data-copy-cmd]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyCmd || "");
        const old = btn.textContent;
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = old; }, 1400);
      } catch {}
    });
  });

  document.querySelector("#env-install-uv-btn").addEventListener("click", () => triggerColabInstall("uv"));
  document.querySelector("#env-install-pip-btn").addEventListener("click", () => triggerColabInstall("pip"));

  document.querySelector("#env-login-btn").addEventListener("click", async () => {
    const btn = document.querySelector("#env-login-btn");
    const logEl = document.querySelector("#env-login-log");
    btn.disabled = true;
    btn.textContent = "等待浏览器完成登录…";
    logEl.hidden = false;
    logEl.textContent = "已触发 colab --auth=oauth2 sessions，请在弹出的浏览器窗口中完成 Google 登录授权…";
    try {
      const res = await fetch("/api/env/login", { method: "POST" });
      const data = await res.json();
      logEl.textContent = data.ok
        ? `登录成功！\n${data.output || ""}`.trim()
        : `登录未完成：${data.error || ""}\n${data.output || ""}`.trim();
      if (data.env) paintEnvCheck(data.env);
      if (data.ok) refreshSessions(state.selected);
    } catch (err) {
      logEl.textContent = `登录出错：${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = "浏览器 OAuth 登录";
    }
  });

  document.querySelector("#clear-local-usage-btn").addEventListener("click", () => {
    state.agentUsageStats = emptyAgentUsageStats();
    saveJsonStorage("colab-desk.agent-usage-stats", state.agentUsageStats);
    flushStoreToDisk();
    showToast(tr("toast.usageReset"));
  });

  document.querySelector("#clear-all-history").addEventListener("click", () => {
    for (const k of Object.keys(desk.bySession)) delete desk.bySession[k];
    state.chatThreads = [];
    state.activeThreadId = null;
    state.messageQueues.clear();
    state.pendingUnfinishedTasks.clear();
    persistDeskHistory();
    flushStoreToDisk();
    renderChatThreads();
    renderTranscript("");
    renderInspector();
    renderComposerQueue();
    closeDialog(dom.settingsModal);
    showToast(tr("toast.historyCleared"));
  });

  // Env vault & bootstrap controls
  dom.settingsModal.querySelectorAll("[data-env-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      dom.envKeyInput.value = btn.dataset.envPreset || "";
      dom.envValInput.value = btn.dataset.envVal || "";
      dom.envValInput.focus();
    });
  });
  document.querySelector("#env-var-add-btn").addEventListener("click", () => {
    const key = dom.envKeyInput.value.trim();
    const value = dom.envValInput.value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      showToast(L("变量名仅支持字母、数字与下划线", "Variable names may only contain letters, digits, and underscores"));
      return;
    }
    const idx = state.envVars.findIndex((x) => x.key === key);
    if (idx >= 0) state.envVars[idx] = { key, value };
    else state.envVars.push({ key, value });
    dom.envKeyInput.value = "";
    dom.envValInput.value = "";
    flushStoreToDisk();
    renderEnvVarsList();
    showToast(L(`已保存环境变量 ${key}`, `Saved variable ${key}`));
  });

  document.querySelector("#env-inject-now-btn").addEventListener("click", () => runBootstrapOnSession(state.selected, false));
  document.querySelector("#boot-run-now-btn").addEventListener("click", () => runBootstrapOnSession(state.selected, false));

  const syncBootstrapSettings = () => {
    state.bootstrapConfig = {
      autoMountDrive: !!dom.bootMountDrive.checked,
      enableHfTransfer: !!dom.bootHfTransfer.checked,
      hfCacheToDrive: !!dom.bootHfDriveCache.checked,
      autoInstallUv: !!dom.bootInstallUv.checked,
      autoInjectEnv: !!dom.bootInjectEnv.checked,
      customScript: dom.bootCustomScript.value || "",
    };
    scheduleStoreSync();
  };
  [dom.bootMountDrive, dom.bootHfTransfer, dom.bootHfDriveCache, dom.bootInstallUv, dom.bootInjectEnv]
    .forEach((el) => el.addEventListener("change", syncBootstrapSettings));
  dom.bootCustomScript.addEventListener("input", syncBootstrapSettings);

  dom.settingGpuPoll.addEventListener("change", () => {
    state.gpuAutoPoll = dom.settingGpuPoll.checked;
    scheduleStoreSync();
  });
  dom.settingDefaultHighMem.addEventListener("change", () => {
    state.defaultHighMem = dom.settingDefaultHighMem.checked;
    emit("session-create:sync-hardware");
    scheduleStoreSync();
  });
  dom.settingBusySendMode.addEventListener("change", () => {
    state.busySendMode = dom.settingBusySendMode.value === "steer" ? "steer" : "queue";
    emit("composer:sync-busy-mode", true);
  });

  // In-app Check for Updates
  document.querySelector("#check-updates-btn").addEventListener("click", async () => {
    const btn = document.querySelector("#check-updates-btn");
    btn.disabled = true;
    dom.updateStatusDesc.textContent = L("正在连接 GitHub 检查最新版本…", "Checking GitHub Releases…");
    try {
      const res = await fetch("/api/updates/check").then((r) => r.json());
      if (!res.ok) {
        dom.updateStatusDesc.textContent = L(`检查失败：${res.error}`, `Check failed: ${res.error}`);
      } else if (res.hasUpdate) {
        dom.updateStatusDesc.innerHTML = L(
          `发现新版本 <strong>v${escapeHtml(res.latestVersion)}</strong>（当前 v${escapeHtml(res.currentVersion)}）`,
          `New version available: <strong>v${escapeHtml(res.latestVersion)}</strong> (current v${escapeHtml(res.currentVersion)})`,
        );
        openExternalUrl(res.releaseUrl);
      } else {
        dom.updateStatusDesc.textContent = L(`已是最新版本 v${res.currentVersion}`, `You are up to date (v${res.currentVersion})`);
      }
    } catch (err) {
      dom.updateStatusDesc.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

import { record } from "/desk.mjs";
import { dom } from "./dom.js";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SESSION_MAX_HOURS,
  SINGLE_SHAPE,
  currentSessionObject,
  currentTranscriptKey,
  desk,
  ensureConnectedAt,
  state,
} from "./state.js";
import {
  L,
  autoGrowCode,
  formatDuration,
  hardwareKind,
  parseHardware,
  sendDesktopNotification,
  showToast,
  tr,
} from "./utils.js";
import { emit, on, registerAction } from "./events.js";
import { persistDeskHistory, scheduleStoreSync } from "./store.js";
import { ensureActiveThread, renderChatThreads, renderComposerQueue, setBusy } from "./threads.js";
import { renderTranscript } from "./transcript.js";

let guardActionHandler = null;

export function modalHardwareValue() {
  const checked = document.querySelector('input[name="hardware"]:checked');
  return checked ? checked.value : "cpu";
}

export function hardware() {
  const highMem = dom.highMemInput ? dom.highMemInput.checked : state.defaultHighMem;
  return parseHardware(modalHardwareValue(), highMem);
}

export function buildNewPreview() {
  const name = dom.sessionNameInput?.value.trim() || "<name>";
  const hw = hardware();
  const parts = ["colab", "new", "-s", name];
  if (hw.gpu) parts.push("--gpu", hw.gpu);
  if (hw.tpu) parts.push("--tpu", hw.tpu);
  if (hw.highMem) parts.push("--high-mem");
  return parts.join(" ");
}

export function syncHardwareChips() {
  const current = modalHardwareValue();
  document.querySelectorAll('input[name="hardware"]').forEach((input) => {
    input.parentElement.classList.toggle("is-selected", input.checked);
  });
  if (dom.highMemNote && dom.highMemInput) {
    dom.highMemNote.hidden = !(dom.highMemInput.checked && SINGLE_SHAPE.has(current));
  }
  if (dom.modalCmd) {
    dom.modalCmd.textContent = buildNewPreview();
  }
}

export function setSidebarCollapsed(collapsed, sync = true) {
  dom.app.classList.toggle("is-sidebar-collapsed", collapsed);
  dom.sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (collapsed) closeSessionMenu();
  try { localStorage.setItem("colab-desk.sidebar-collapsed", collapsed ? "1" : "0"); } catch {}
  if (sync) scheduleStoreSync();
}

export function toggleSidebar() {
  setSidebarCollapsed(!dom.app.classList.contains("is-sidebar-collapsed"));
}

export function syncRailToggleUi() {
  const collapsed = dom.app.classList.contains("is-rail-collapsed");
  if (dom.railToggle) {
    dom.railToggle.classList.toggle("is-active", !collapsed);
    dom.railToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    dom.railToggle.title = collapsed ? tr("ws.railToggleShow") : tr("ws.railToggleHide");
  }
  if (dom.settingRailOpen) dom.settingRailOpen.checked = !collapsed;
}

export function setRailCollapsed(collapsed, sync = true) {
  dom.app.classList.toggle("is-rail-collapsed", collapsed);
  if (collapsed) closeSplitMenu();
  syncRailToggleUi();
  try { localStorage.setItem("colab-desk.rail-collapsed", collapsed ? "1" : "0"); } catch {}
  if (sync) scheduleStoreSync();
}

export function toggleRail() {
  setRailCollapsed(!dom.app.classList.contains("is-rail-collapsed"));
}

export function closeSessionMenu() {
  if (!state.openMenuSession) return;
  state.openMenuSession = null;
  renderSessions();
}

export function closeSplitMenu() {
  dom.inspectorSplitMenu.hidden = true;
  dom.inspectorSplitCaret.setAttribute("aria-expanded", "false");
}

export function syncNavButtons() {
  dom.navBack.disabled = state.navIndex <= 0;
  dom.navForward.disabled = state.navIndex < 0 || state.navIndex >= state.navHistory.length - 1;
}

export function pushNav(name) {
  if (!name) return;
  if (state.navHistory[state.navIndex] === name) {
    syncNavButtons();
    return;
  }
  state.navHistory = state.navHistory.slice(0, state.navIndex + 1);
  state.navHistory.push(name);
  state.navIndex = state.navHistory.length - 1;
  syncNavButtons();
}

export function renderInspector() {
  const session = currentSessionObject();
  const hasSession = !!session;

  dom.inspectorHost.textContent = hasSession ? session.name : tr("rail.disconnected");
  if (dom.viewSwitchEl) dom.viewSwitchEl.hidden = !hasSession;
  if (!hasSession && (state.activeWorkspaceView === "terminal" || state.activeWorkspaceView === "split")) {
    emit("terminal:set-view", "chat");
  }
  dom.inspectorLs.disabled = !hasSession;
  dom.inspectorRestart.disabled = !hasSession;
  dom.inspectorStop.disabled = !hasSession;
  dom.inspectorLog.disabled = !hasSession;
  if (dom.gpuRefreshBtn) dom.gpuRefreshBtn.disabled = !hasSession;
  if (dom.inspectorSyncBtn) dom.inspectorSyncBtn.disabled = !hasSession;
  if (dom.inspectorBootstrapBtn) dom.inspectorBootstrapBtn.disabled = !hasSession;
  if (dom.tunnelOpenBtn) dom.tunnelOpenBtn.disabled = !hasSession;
  if (dom.tunnelPresetsWrap) {
    dom.tunnelPresetsWrap.querySelectorAll("button").forEach((b) => { b.disabled = !hasSession; });
  }
  dom.inspectorPrimaryLabel.textContent = hasSession ? tr("rail.menuUrl") : tr("rail.newSession");
  dom.welcomeNoSession.hidden = hasSession;

  if (hasSession) {
    const statusText = session.status || "IDLE";
    const isBusy = String(statusText).toUpperCase().includes("BUSY");
    dom.infoStatusDot.className = "status-dot " + (isBusy ? "is-busy" : "is-idle");
    dom.infoStatus.textContent = statusText;
    dom.infoHardware.textContent = session.variant && session.variant !== "DEFAULT"
      ? `${session.hardware} · ${session.variant}`
      : session.hardware;
    dom.infoHardware.className = "kv-value";
    dom.infoShape.textContent = session.shape || "Standard";
    dom.infoShape.className = "kv-value";
    dom.infoEndpoint.textContent = session.endpoint || "—";
    dom.infoEndpoint.dataset.full = session.endpoint || "";
    dom.infoLastExec.textContent = session.lastExecution || (state.activeLang === "en" ? "None yet" : "暂无执行");
    dom.infoLastExec.className = session.lastExecution ? "kv-value is-mono" : "kv-value is-muted";
    dom.infoLastExec.title = session.lastExecution || "";
    dom.infoFacts.textContent = `${session.name} · ${session.hardware}`;
  } else {
    dom.infoStatusDot.className = "status-dot is-offline";
    dom.infoStatus.textContent = tr("rail.statusOffline");
    dom.infoHardware.textContent = "—";
    dom.infoHardware.className = "kv-value is-muted";
    dom.infoShape.textContent = "—";
    dom.infoShape.className = "kv-value is-muted";
    dom.infoEndpoint.textContent = "—";
    dom.infoEndpoint.dataset.full = "";
    dom.infoLastExec.textContent = "—";
    dom.infoLastExec.className = "kv-value is-muted";
    dom.infoLastExec.title = "";
    dom.infoFacts.textContent = tr("rail.noSession");
  }

  if (state.usageInfo && state.usageInfo.balance !== null) {
    if (state.usageInfo.balance > state.maxSeenBalance) {
      state.maxSeenBalance = Math.ceil(state.usageInfo.balance / 100) * 100;
    }
    const pct = Math.min(100, Math.max(0, (state.usageInfo.balance / state.maxSeenBalance) * 100));
    dom.barBalance.style.width = `${pct.toFixed(1)}%`;
    dom.valBalance.textContent = `${state.usageInfo.balance.toFixed(1)} CU`;
    dom.valBalance.className = "meter-value";
  } else {
    dom.barBalance.style.width = "0%";
    dom.valBalance.textContent = "—";
    dom.valBalance.className = "meter-value is-muted";
  }

  if (state.usageInfo && state.usageInfo.ratePerHour !== null) {
    const rate = state.usageInfo.ratePerHour;
    const ratePct = rate <= 0 ? 0 : Math.min(100, Math.max(4, (rate / 15) * 100));
    dom.barRate.style.width = `${ratePct.toFixed(1)}%`;
    dom.valRate.textContent = `${rate.toFixed(2)} /hr`;
    dom.valRate.className = "meter-value";
  } else {
    dom.barRate.style.width = "0%";
    dom.valRate.textContent = "—";
    dom.valRate.className = "meter-value is-muted";
  }

  if (hasSession) {
    const startedAt = ensureConnectedAt(session);
    const elapsedMs = Date.now() - startedAt;
    const elapsedHours = elapsedMs / 3_600_000;
    const uptimePct = Math.min(100, Math.max(2, (elapsedHours / SESSION_MAX_HOURS) * 100));
    dom.barUptime.style.width = `${uptimePct.toFixed(1)}%`;
    dom.valUptime.textContent = formatDuration(elapsedMs);
    dom.valUptime.className = "meter-value";

    if (state.usageInfo && state.usageInfo.ratePerHour > 0 && state.usageInfo.balance !== null) {
      const spent = state.usageInfo.ratePerHour * elapsedHours;
      const leftHours = state.usageInfo.balance / state.usageInfo.ratePerHour;
      dom.labelEst.textContent = state.activeLang === "en" ? "Est. Used" : "本次约耗";
      dom.barEst.style.width = `${Math.min(100, Math.max(3, (spent / Math.max(state.usageInfo.balance, 1)) * 100)).toFixed(1)}%`;
      dom.valEst.textContent = `${spent.toFixed(2)} CU`;
      dom.valEst.title = state.activeLang === "en" ? `~${leftHours.toFixed(1)}h remaining` : `按当前速率预计可用 ${leftHours.toFixed(1)} 小时`;
      dom.valEst.className = "meter-value";
    } else {
      dom.labelEst.textContent = tr("rail.active");
      const active = state.usageInfo && state.usageInfo.activeAssignments !== null ? state.usageInfo.activeAssignments : state.sessions.length;
      dom.barEst.style.width = `${Math.min(100, (active / 5) * 100).toFixed(1)}%`;
      dom.valEst.textContent = `${active} / 5`;
      dom.valEst.className = "meter-value";
    }
  } else {
    dom.barUptime.style.width = "0%";
    dom.valUptime.textContent = "—";
    dom.valUptime.className = "meter-value is-muted";
    dom.labelEst.textContent = tr("rail.active");
    const active = state.usageInfo && state.usageInfo.activeAssignments !== null ? state.usageInfo.activeAssignments : 0;
    dom.barEst.style.width = `${Math.min(100, (active / 5) * 100).toFixed(1)}%`;
    dom.valEst.textContent = `${active} / 5`;
    dom.valEst.className = state.usageInfo ? "meter-value" : "meter-value is-muted";
  }

  if (state.usageInfo) {
    const active = state.usageInfo.activeAssignments ?? state.sessions.length;
    const leftTxt = state.usageInfo.ratePerHour > 0 && state.usageInfo.balance !== null
      ? ` · ~${(state.usageInfo.balance / state.usageInfo.ratePerHour).toFixed(1)}h`
      : "";
    dom.usageUpdated.textContent = `${tr("rail.activeCount", { count: active })}${leftTxt}`;
  } else {
    dom.usageUpdated.textContent = tr("rail.activeCount", { count: state.sessions.length });
  }

  const bucket = desk.bySession[state.selected || ""] || [];
  const count = bucket.length;
  dom.barActivity.style.width = `${Math.min(100, count * 5)}%`;
  dom.valActivity.textContent = tr("rail.historyCount", { count });
  dom.valActivity.className = count > 0 ? "meter-value" : "meter-value is-muted";
}

export function renderMiniSessions() {
  dom.miniSessionItems.replaceChildren();
  for (const session of state.sessions) {
    const kind = hardwareKind(session.hardware);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini-session-btn" + (session.name === state.selected ? " is-current" : "");
    btn.title = `${session.name} (${session.hardware})`;
    btn.setAttribute("aria-label", session.name);
    btn.textContent = session.name.slice(0, 2).toUpperCase();
    const dot = document.createElement("span");
    dot.className = `mini-dot pill-dot kind-${kind}`;
    btn.append(dot);
    btn.addEventListener("click", () => selectSession(session.name));
    dom.miniSessionItems.append(btn);
  }
}

export function renderSessions() {
  renderMiniSessions();
  const query = dom.filter.value.trim().toLowerCase();
  dom.sessionItems.replaceChildren();
  const visible = state.sessions.filter((session) =>
    session.name.toLowerCase().includes(query) ||
    String(session.hardware || "").toLowerCase().includes(query),
  );

  if (visible.length === 0) {
    const box = document.createElement("div");
    box.className = "empty-state";
    const note = document.createElement("div");
    note.textContent = state.sessions.length === 0 ? tr("sidebar.empty") : tr("sidebar.emptyFiltered");
    box.append(note);
    if (state.sessions.length === 0) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "empty-cta";
      btn.textContent = tr("sidebar.newSessionBtn");
      btn.addEventListener("click", () => emit("ui:open-new-session"));
      box.append(btn);
    }
    dom.sessionItems.append(box);
    return;
  }

  for (const session of visible) {
    ensureConnectedAt(session);
    const isCurrent = session.name === state.selected;
    const isMenuOpen = session.name === state.openMenuSession;
    const kind = hardwareKind(session.hardware);

    const item = document.createElement("div");
    item.className = "session-item" + (isCurrent ? " is-current" : "") + (isMenuOpen ? " is-menu-open" : "");

    const button = document.createElement("button");
    button.type = "button";
    button.className = isCurrent ? "session is-current" : "session";
    button.dataset.name = session.name;
    button.setAttribute("aria-current", isCurrent ? "true" : "false");

    const topRow = document.createElement("div");
    topRow.className = "session-row-top";

    const origin = document.createElement("span");
    origin.className = "session-origin";
    const avatar = document.createElement("span");
    avatar.className = `session-avatar kind-${kind}`;
    avatar.textContent = kind === "gpu" ? "G" : kind === "tpu" ? "T" : "C";
    const group = document.createElement("span");
    group.className = "session-group";
    group.textContent = session.variant ? `colab · ${session.variant}` : `colab · ${kind.toUpperCase()}`;
    origin.append(avatar, group);

    const status = document.createElement("span");
    const statusText = session.status || L("就绪", "Ready");
    status.className = "session-status" + (String(statusText).toUpperCase().includes("BUSY") ? " is-busy" : "");
    status.textContent = statusText;
    topRow.append(origin, status);

    const titleEl = document.createElement("span");
    titleEl.className = "session-title";
    titleEl.textContent = session.name;

    const bottomRow = document.createElement("div");
    bottomRow.className = "session-row-bottom";
    const branch = document.createElement("span");
    branch.className = "session-branch";
    branch.textContent = session.shape || session.endpoint || "runtime";

    const pill = document.createElement("span");
    pill.className = "session-pill";
    const dot = document.createElement("span");
    dot.className = `pill-dot kind-${kind}`;
    pill.append(dot, document.createTextNode(session.hardware || "CPU"));
    bottomRow.append(branch, pill);

    button.append(topRow, titleEl, bottomRow);
    button.addEventListener("click", () => {
      closeSessionMenu();
      selectSession(session.name);
    });

    const menuTrigger = document.createElement("button");
    menuTrigger.type = "button";
    menuTrigger.className = "session-menu-trigger";
    menuTrigger.setAttribute("aria-label", L(`${session.name} 菜单`, `${session.name} menu`));
    menuTrigger.setAttribute("aria-haspopup", "menu");
    menuTrigger.setAttribute("aria-expanded", isMenuOpen ? "true" : "false");
    menuTrigger.title = L("会话操作菜单", "Session actions");
    menuTrigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>';
    menuTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      state.openMenuSession = isMenuOpen ? null : session.name;
      renderSessions();
    });

    const menu = document.createElement("div");
    menu.className = "session-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = !isMenuOpen;
    menu.addEventListener("click", (event) => event.stopPropagation());

    const menuHead = document.createElement("div");
    menuHead.className = "session-menu-head";
    const menuTitle = document.createElement("span");
    menuTitle.className = "session-menu-title";
    menuTitle.textContent = session.name;
    const menuClose = document.createElement("button");
    menuClose.type = "button";
    menuClose.className = "session-menu-close";
    menuClose.setAttribute("aria-label", L("关闭会话菜单", "Close session menu"));
    menuClose.title = L("关闭菜单", "Close menu");
    menuClose.textContent = "×";
    menuClose.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSessionMenu();
    });
    menuHead.append(menuTitle, menuClose);
    menu.append(menuHead);

    const actions = [
      { type: "status", label: L("查看状态", "Status"), hint: "status" },
      { type: "restart-kernel", label: L("重启内核", "Restart Kernel"), hint: "restart" },
      { type: "url", label: L("获取链接", "Open URL"), hint: "url" },
      { type: "stop", label: L("停止会话", "Stop VM"), hint: "stop", danger: true },
    ];
    for (const act of actions) {
      const itemBtn = document.createElement("button");
      itemBtn.type = "button";
      itemBtn.className = "session-menu-action" + (act.danger ? " is-danger" : "");
      itemBtn.setAttribute("role", "menuitem");
      const labelSpan = document.createElement("span");
      labelSpan.textContent = act.label;
      const hintCode = document.createElement("code");
      hintCode.textContent = act.hint;
      itemBtn.append(labelSpan, hintCode);
      itemBtn.addEventListener("click", async () => {
        closeSessionMenu();
        selectSession(session.name);
        await callAction({ type: act.type, session: session.name }, `${act.type} ${session.name}`, session.name);
      });
      menu.append(itemBtn);
    }

    item.append(button, menuTrigger, menu);
    dom.sessionItems.append(item);
  }
}

export function mergeStatusIntoSessions(parsedList) {
  if (!Array.isArray(parsedList) || parsedList.length === 0) return;
  for (const detail of parsedList) {
    const idx = state.sessions.findIndex((item) => item.name === detail.name);
    if (idx !== -1) state.sessions[idx] = { ...state.sessions[idx], ...detail };
  }
}

export async function refreshStatusSilently(sessionName) {
  if (!sessionName) return;
  try {
    const res = await fetch(`/api/status?session=${encodeURIComponent(sessionName)}`);
    const data = await res.json();
    if (data.ok && data.state && data.state.sessions) {
      mergeStatusIntoSessions(data.state.sessions);
      const session = currentSessionObject();
      if (session && session.name === sessionName) {
        dom.meta.textContent = `${session.hardware}${session.status ? " · " + session.status : ""}${session.shape ? " · " + session.shape : ""}`;
      }
      renderSessions();
      renderInspector();
    }
  } catch {}
}

export async function refreshUsageSilently() {
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    if (data.ok && data.state && data.state.usage) {
      state.usageInfo = data.state.usage;
      renderInspector();
      checkCostAndIdleGuards();
    }
  } catch {}
}

export function selectSession(name, options = {}) {
  state.selected = name;
  state.lastActivityAt = Date.now();
  if (!options.skipHistory) pushNav(name);
  const session = currentSessionObject();
  dom.title.textContent = name;
  dom.crumbName.textContent = name;
  dom.meta.textContent = session
    ? `${session.hardware}${session.status ? " · " + session.status : ""}${session.shape ? " · " + session.shape : ""}`
    : "Selected session";
  renderSessions();
  renderChatThreads();
  renderTranscript(currentTranscriptKey());
  renderInspector();
  emit("cloud:render-tunnels");
  renderComposerQueue();
  if (!options.skipStatusFetch) {
    refreshStatusSilently(name);
    emit("cloud:refresh-gpu", true);
  }
}

export function appendResult(label, result, key) {
  const targetKey = ensureActiveThread(label);
  record(desk, targetKey, {
    kind: "cli",
    label,
    ok: !!result.ok,
    error: result.ok ? "" : result.error || "colab failed",
    text: result.stdout || "",
    argv: Array.isArray(result.argv) ? result.argv : [],
  });
  if (result.ok && result.state && result.state.usage) state.usageInfo = result.state.usage;
  if (result.ok && result.state && result.state.sessions && result.state.sessions.length) {
    mergeStatusIntoSessions(result.state.sessions);
  }
  persistDeskHistory();
  renderChatThreads();
  renderTranscript(targetKey);
  renderInspector();
}

export async function callAction(action, label, key) {
  setBusy(1);
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    const result = await response.json();
    appendResult(label, result, key);
    if (action.type === "new" || action.type === "stop" || action.type === "sessions" || (action.type === "run" && action.keep)) {
      await refreshSessions(action.type === "new" ? action.name : state.selected);
    } else if (action.type === "exec" || action.type === "ssh") {
      refreshStatusSilently(state.selected);
      refreshUsageSilently();
    }
    return result;
  } finally {
    setBusy(-1);
  }
}

export async function refreshSessions(prefer) {
  dom.refreshSidebar.classList.add("is-spinning");
  try {
    const response = await fetch("/api/sessions");
    const result = await response.json();
    if (!result.ok) {
      appendResult("sessions", result, state.selected || "");
      state.sessions = [];
    } else {
      state.sessions = result.state && result.state.sessions ? result.state.sessions : [];
    }
    if (prefer && state.sessions.some((item) => item.name === prefer)) state.selected = prefer;
    else if (!state.sessions.some((item) => item.name === state.selected)) state.selected = state.sessions[0] ? state.sessions[0].name : null;
    if (state.selected) {
      selectSession(state.selected);
    } else {
      dom.title.textContent = tr("ws.noSessionTitle");
      dom.crumbName.textContent = tr("ws.unselected");
      dom.meta.textContent = result.ok
        ? tr("ws.noSessionMeta")
        : result.error;
      renderSessions();
      renderChatThreads();
      renderTranscript(currentTranscriptKey());
      renderInspector();
    }
    refreshUsageSilently();
  } finally {
    dom.refreshSidebar.classList.remove("is-spinning");
  }
}

export async function runUrlAndCopy() {
  if (!state.selected) { emit("ui:open-new-session"); return; }
  const res = await callAction({ type: "url", session: state.selected }, `url ${state.selected}`, state.selected);
  if (res.ok && res.stdout) {
    const match = res.stdout.match(/https?:\/\/\S+/);
    if (match && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(match[0]);
        renderComposerQueue();
        showToast(tr("toast.urlCopied"));
      } catch {}
    }
  }
}

export function checkCostAndIdleGuards() {
  if (state.cuAlertThreshold > 0 && state.usageInfo && state.usageInfo.balance != null && state.usageInfo.balance < state.cuAlertThreshold && !state.cuAlertFired) {
    state.cuAlertFired = true;
    const msg = state.activeLang === "en"
      ? `Low Compute Units: ${state.usageInfo.balance.toFixed(1)} CU remaining (below ${state.cuAlertThreshold} CU threshold).`
      : `计算单元余额提醒：当前仅剩 ${state.usageInfo.balance.toFixed(1)} CU（低于 ${state.cuAlertThreshold} CU 警戒线）。`;
    dom.guardAlertText.textContent = msg;
    dom.guardAlertAction.hidden = true;
    dom.guardAlertBanner.hidden = false;
    sendDesktopNotification("Colab Desk — Low CU", msg);
  }

  const sess = currentSessionObject();
  if (state.idleAlertMinutes > 0 && sess && hardwareKind(sess.hardware) !== "cpu" && !state.activeAgentController) {
    const idleMin = Math.floor((Date.now() - state.lastActivityAt) / 60_000);
    if (idleMin >= state.idleAlertMinutes && state.idleAlertedSession !== sess.name) {
      state.idleAlertedSession = sess.name;
      const msg = state.activeLang === "en"
        ? `Session "${sess.name}" (${sess.hardware}) has been idle for ${idleMin} min. Stop it to save Compute Units?`
        : `付费会话「${sess.name}」(${sess.hardware}) 已连续空闲 ${idleMin} 分钟，是否停止释放以节省计算单元？`;
      dom.guardAlertText.textContent = msg;
      dom.guardAlertAction.textContent = state.activeLang === "en" ? "Stop VM" : "立即停止 VM";
      dom.guardAlertAction.hidden = false;
      guardActionHandler = () => callAction({ type: "stop", session: sess.name }, `stop ${sess.name}`, sess.name);
      dom.guardAlertBanner.hidden = false;
      sendDesktopNotification("Colab Desk — Idle GPU VM", msg);
    }
  }

  emit("guard:check", { session: sess, usage: state.usageInfo, lastActivityAt: state.lastActivityAt });
}

export function clampSidebarWidth(px) {
  const railW = dom.app.classList.contains("is-rail-collapsed") ? 0 : (window.innerWidth <= 980 ? 256 : 296);
  const maxAllowed = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - railW - 380));
  return Math.round(Math.min(maxAllowed, Math.max(MIN_SIDEBAR_WIDTH, px)));
}

export function applySidebarWidth(px, persist = true) {
  const clamped = clampSidebarWidth(px);
  dom.app.style.setProperty("--sidebar-width", `${clamped}px`);
  if (persist) {
    try { localStorage.setItem("colab-desk.sidebar-width", String(clamped)); } catch {}
    scheduleStoreSync();
  }
  return clamped;
}

export function initSessionsAndLayout() {
  registerAction("sessions:callAction", callAction);
  registerAction("sessions:refresh", refreshSessions);

  on("sessions:render-all", () => {
    renderSessions();
    renderInspector();
  });
  on("sessions:render-inspector", renderInspector);
  on("language:changed", () => {
    syncRailToggleUi();
    renderSessions();
    renderInspector();
    renderTranscript(currentTranscriptKey());
  });

  dom.sidebarToggle.addEventListener("click", () => setSidebarCollapsed(true));
  dom.sidebarOpen.addEventListener("click", () => setSidebarCollapsed(false));
  dom.railToggle.addEventListener("click", toggleRail);
  document.querySelector("#mini-refresh").addEventListener("click", () => refreshSessions(state.selected));
  dom.refreshSidebar.addEventListener("click", () => refreshSessions(state.selected));
  document.querySelector("#refresh").addEventListener("click", () => refreshSessions(state.selected));

  dom.navBack.addEventListener("click", () => {
    if (state.navIndex <= 0) return;
    state.navIndex -= 1;
    syncNavButtons();
    const target = state.navHistory[state.navIndex];
    if (state.sessions.some((s) => s.name === target)) selectSession(target, { skipHistory: true });
  });
  dom.navForward.addEventListener("click", () => {
    if (state.navIndex < 0 || state.navIndex >= state.navHistory.length - 1) return;
    state.navIndex += 1;
    syncNavButtons();
    const target = state.navHistory[state.navIndex];
    if (state.sessions.some((s) => s.name === target)) selectSession(target, { skipHistory: true });
  });

  // Inspector actions
  dom.inspectorPrimary.addEventListener("click", runUrlAndCopy);
  dom.inspectorSplitCaret.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = dom.inspectorSplitMenu.hidden;
    dom.inspectorSplitMenu.hidden = !opening;
    dom.inspectorSplitCaret.setAttribute("aria-expanded", opening ? "true" : "false");
  });
  dom.inspectorSplitMenu.addEventListener("click", (event) => event.stopPropagation());
  dom.inspectorSplitMenu.querySelectorAll("[data-inspector-cmd]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      closeSplitMenu();
      const type = btn.dataset.inspectorCmd;
      if (!state.selected) { emit("ui:open-new-session"); return; }
      if (type === "url") await runUrlAndCopy();
      else await callAction({ type, session: state.selected }, `${type} ${state.selected}`, state.selected);
    });
  });
  dom.inspectorLs.addEventListener("click", () => {
    if (!state.selected) return;
    emit("ui:open-files", "/content");
  });

  dom.guardAlertDismiss.addEventListener("click", () => { dom.guardAlertBanner.hidden = true; });
  dom.guardAlertAction.addEventListener("click", () => {
    dom.guardAlertBanner.hidden = true;
    if (guardActionHandler) guardActionHandler();
  });

  dom.inspectorQuickInstall.addEventListener("click", () => {
    emit("composer:set-mode", "agent");
    dom.code.value = tr("rail.installPrompt");
    autoGrowCode();
    dom.code.focus();
  });
  dom.inspectorRestart.addEventListener("click", () => {
    if (!state.selected) return;
    callAction({ type: "restart-kernel", session: state.selected }, `restart-kernel ${state.selected}`, state.selected);
  });
  dom.inspectorStop.addEventListener("click", () => {
    if (!state.selected) return;
    callAction({ type: "stop", session: state.selected }, `stop ${state.selected}`, state.selected);
  });
  dom.inspectorLog.addEventListener("click", () => {
    if (!state.selected) return;
    callAction({ type: "log", session: state.selected, lines: "20" }, `log ${state.selected}`, state.selected);
  });
  document.querySelector("#refresh-usage").addEventListener("click", async () => {
    await refreshUsageSilently();
    if (state.selected) await refreshStatusSilently(state.selected);
    showToast(tr("toast.usageUpdated"));
  });
  dom.infoEndpoint.addEventListener("click", async () => {
    const full = dom.infoEndpoint.dataset.full;
    if (!full) return;
    try {
      await navigator.clipboard.writeText(full);
      showToast(tr("toast.endpointCopied"));
    } catch {}
  });

  dom.filter.addEventListener("input", () => {
    renderSessions();
    renderChatThreads();
  });

  document.addEventListener("click", () => {
    if (state.openMenuSession) closeSessionMenu();
    if (!dom.inspectorSplitMenu.hidden) closeSplitMenu();
  });

  // Resizable left sidebar
  dom.sidebarResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dom.app.classList.contains("is-sidebar-collapsed")) return;
    event.preventDefault();
    dom.sidebarResizer.setPointerCapture(event.pointerId);
    dom.app.classList.add("is-resizing");
    let latest = applySidebarWidth(event.clientX, false);
    const onMove = (moveEvent) => { latest = applySidebarWidth(moveEvent.clientX, false); };
    const onUp = () => {
      dom.app.classList.remove("is-resizing");
      applySidebarWidth(latest, true);
      dom.sidebarResizer.removeEventListener("pointermove", onMove);
      dom.sidebarResizer.removeEventListener("pointerup", onUp);
      dom.sidebarResizer.removeEventListener("pointercancel", onUp);
    };
    dom.sidebarResizer.addEventListener("pointermove", onMove);
    dom.sidebarResizer.addEventListener("pointerup", onUp);
    dom.sidebarResizer.addEventListener("pointercancel", onUp);
  });

  dom.sidebarResizer.addEventListener("dblclick", () => applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, true));
  window.addEventListener("resize", () => {
    const current = parseFloat(getComputedStyle(dom.app).getPropertyValue("--sidebar-width")) || DEFAULT_SIDEBAR_WIDTH;
    applySidebarWidth(current, false);
  });
}

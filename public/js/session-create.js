import { applyNewResult, isRetryableColabError, summarizeColabError } from "/desk.mjs";
import { t } from "/i18n.mjs";
import { dom } from "./dom.js";
import { currentTranscriptKey, desk, state } from "./state.js";
import { sendDesktopNotification, showToast, tr } from "./utils.js";
import { emit, on } from "./events.js";
import { renderChatThreads, setBusy } from "./threads.js";
import { renderTranscript } from "./transcript.js";
import {
  buildNewPreview,
  closeSessionMenu,
  closeSplitMenu,
  hardware,
  refreshUsageSilently,
  renderInspector,
  renderSessions,
  selectSession,
  syncHardwareChips,
} from "./sessions.js";
import { mountModalTemplate } from "./templates/mount.js";
import { NEW_SESSION_MODAL_HTML } from "./templates/modals.js";

let sessionCreateInitialized = false;

export function paintNew(applied) {
  const stay = applied.view;
  if (stay && state.sessions.some((item) => item.name === stay)) {
    selectSession(stay);
    return;
  }
  state.selected = null;
  dom.title.textContent = tr("ws.noSessionTitle");
  dom.crumbName.textContent = tr("ws.unselected");
  renderSessions();
  renderChatThreads();
  renderTranscript(currentTranscriptKey());
  renderInspector();
}

export function clearAgentCreate() {
  if (!state.agentCreate) return;
  clearInterval(state.agentCreate.tickTimer);
  clearInterval(state.agentCreate.pollTimer);
  state.agentCreate = null;
  renderSnipeBanner();
}

export function trackAgentSessionCreate(toolCallId, spec) {
  if (state.bgSnipe && !state.bgSnipe.stopped) return;
  if (state.agentCreate && state.agentCreate.toolCallId === toolCallId) return;
  clearAgentCreate();
  const ac = {
    toolCallId: toolCallId || "",
    name: spec.name,
    hw: spec.hw,
    hwLabel: spec.hwLabel,
    startedAt: Date.now(),
    statusHint: state.activeLang === "en" ? "provisioning via Agent…" : "Agent 申请节点中…",
    failedRetryable: false,
    tickTimer: null,
    pollTimer: null,
  };
  state.agentCreate = ac;
  ac.tickTimer = setInterval(() => renderSnipeBanner(), 1000);
  ac.pollTimer = setInterval(async () => {
    if (state.agentCreate !== ac || ac.failedRetryable) return;
    try {
      const data = await fetch("/api/log-tail").then((r) => r.json());
      if (!data.ok || !Array.isArray(data.lines)) return;
      const tail = data.lines.slice(-6).join("\n");
      const retryMatch = [...tail.matchAll(/Assignment request failed; retrying in (\d+)s/g)].pop();
      if (retryMatch) {
        ac.statusHint = state.activeLang === "en"
          ? `503 · retrying in ${retryMatch[1]}s`
          : `503 繁忙 · ${retryMatch[1]}s 后重试`;
        renderSnipeBanner();
      }
    } catch {}
  }, 2200);
  renderSnipeBanner();
}

export async function resolveAgentSessionCreate(status, outputText = "") {
  const ac = state.agentCreate;
  if (!ac) return;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - ac.startedAt) / 1000));
  const looksFailed = status === "failed" || /ColabRequestError|Traceback|Service Unavailable|503\b|Error:/i.test(outputText);
  const listed = await fetch("/api/sessions").then((r) => r.json()).catch(() => ({ ok: false }));
  const nextSessions = listed.ok && listed.state && Array.isArray(listed.state.sessions)
    ? listed.state.sessions
    : null;
  if (nextSessions) {
    state.sessions = nextSessions;
    renderSessions();
  }
  const createdSess = nextSessions && nextSessions.find((s) => s.name === ac.name);

  if (createdSess || (!looksFailed && status === "completed")) {
    clearAgentCreate();
    const targetName = createdSess ? createdSess.name : ac.name;
    if (state.sessions.some((s) => s.name === targetName)) {
      selectSession(targetName);
    }
    refreshUsageSilently();
    const bc = state.bootstrapConfig;
    if (bc.autoMountDrive || bc.enableHfTransfer || bc.hfCacheToDrive || bc.autoInstallUv || (bc.autoInjectEnv && state.envVars.length > 0) || (bc.customScript || "").trim()) {
      emit("settings:bootstrap", { session: targetName, silent: true });
    }
    const isEn = state.activeLang === "en";
    const titleText = isEn ? "Colab GPU Ready!" : "🎉 抢到 Colab 节点啦！";
    const bodyText = isEn
      ? `${targetName} (${ac.hwLabel}) is online after ${elapsedSec}s.`
      : `${targetName} (${ac.hwLabel}) 已就绪，耗时 ${elapsedSec}s，已自动切换。`;
    sendDesktopNotification(titleText, bodyText, true);
    showToast(bodyText);
    return;
  }

  if (isRetryableColabError(outputText)) {
    clearInterval(ac.tickTimer);
    clearInterval(ac.pollTimer);
    ac.failedRetryable = true;
    ac.statusHint = state.activeLang === "en"
      ? "503 unavailable · click to keep sniping in background"
      : "暂时无空闲节点，可点击「转后台抢卡」持续自动重试";
    renderSnipeBanner();
    return;
  }

  clearAgentCreate();
}

export function stopCreateWatchers() {
  clearInterval(state.createPollTimer);
  clearInterval(state.createTickTimer);
  state.createPollTimer = null;
  state.createTickTimer = null;
}

export function abortOngoingCreate() {
  if (state.activeCreate && !state.activeCreate.handedOff) {
    state.activeCreate.controller.abort();
    state.activeCreate = null;
  }
  if (state.createController) {
    state.createController.abort();
    state.createController = null;
  }
  stopCreateWatchers();
}

export function renderSnipeBanner() {
  const isEn = state.activeLang === "en";
  if (state.bgSnipe && !state.bgSnipe.stopped) {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.bgSnipe.startedAt) / 1000));
    let detail = "";
    if (state.bgSnipe.cooldownSec > 0) {
      detail = isEn
        ? `retry #${state.bgSnipe.attempt + 1} in ${state.bgSnipe.cooldownSec}s`
        : `${state.bgSnipe.cooldownSec}s 后发起第 ${state.bgSnipe.attempt + 1} 轮`;
    } else {
      detail = state.bgSnipe.statusHint || (isEn ? `attempt #${state.bgSnipe.attempt}` : `第 ${state.bgSnipe.attempt} 轮申请中`);
    }
    dom.snipeBannerText.textContent = isEn
      ? `Background Sniping · ${state.bgSnipe.name} (${state.bgSnipe.hwLabel}) · ${elapsed}s · ${detail}`
      : `后台抢卡中 · ${state.bgSnipe.name} (${state.bgSnipe.hwLabel}) · 已等待 ${elapsed}s · ${detail}`;
    if (dom.snipeTakeoverBtn) dom.snipeTakeoverBtn.hidden = true;
    dom.snipeStopBtn.textContent = t(state.activeLang, "snipe.stop");
    dom.snipeBanner.hidden = false;
    return;
  }
  if (state.activeSnipeJob && (state.activeSnipeJob.status === "running" || state.activeSnipeJob.status === "paused")) {
    const job = state.activeSnipeJob;
    const elapsed = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
    const activeTarget = (job.targets || []).find((x) => x.active);
    const targetList = (job.targets || []).map((x) => x.label).join(" > ");
    const pausedTag = job.status === "paused" ? (isEn ? "Paused" : "已暂停") : (isEn ? "Sniping Queue" : "多规格抢卡中");
    const detail = activeTarget
      ? (isEn ? `trying ${activeTarget.label} (#${job.attempts})` : `尝试 ${activeTarget.label}（第 ${job.attempts} 次）`)
      : (job.lastError ? job.lastError.slice(0, 64) : (isEn ? `attempts: ${job.attempts}` : `已尝试 ${job.attempts} 次`));
    dom.snipeBannerText.textContent = `${pausedTag} · ${job.name} [${targetList}] · ${elapsed}s · ${detail}`;
    if (dom.snipeTakeoverBtn) dom.snipeTakeoverBtn.hidden = true;
    dom.snipeStopBtn.textContent = t(state.activeLang, "snipe.stop");
    dom.snipeBanner.hidden = false;
    return;
  }
  if (state.agentCreate) {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.agentCreate.startedAt) / 1000));
    if (state.agentCreate.failedRetryable) {
      dom.snipeBannerText.textContent = isEn
        ? `${state.agentCreate.name} (${state.agentCreate.hwLabel}) · ${state.agentCreate.statusHint}`
        : `申请 ${state.agentCreate.name} (${state.agentCreate.hwLabel}) 失败 · ${state.agentCreate.statusHint}`;
      dom.snipeStopBtn.textContent = isEn ? "Dismiss" : "关闭";
    } else {
      dom.snipeBannerText.textContent = isEn
        ? `Agent Creating · ${state.agentCreate.name} (${state.agentCreate.hwLabel}) · ${elapsed}s · ${state.agentCreate.statusHint}`
        : `Agent 创建中 · ${state.agentCreate.name} (${state.agentCreate.hwLabel}) · 已等待 ${elapsed}s · ${state.agentCreate.statusHint}`;
      dom.snipeStopBtn.textContent = isEn ? "Cancel" : "取消";
    }
    if (dom.snipeTakeoverBtn) dom.snipeTakeoverBtn.hidden = false;
    dom.snipeBanner.hidden = false;
    return;
  }
  dom.snipeBanner.hidden = true;
}

export function stopBgSnipe(silent = false) {
  if (!state.bgSnipe) return;
  const prev = state.bgSnipe;
  prev.stopped = true;
  state.bgSnipe = null;
  clearInterval(prev.tickTimer);
  clearInterval(prev.pollTimer);
  clearTimeout(prev.retryTimer);
  if (prev.controller) {
    try { prev.controller.abort(); } catch {}
  }
  dom.snipeBanner.hidden = true;
  if (!silent) {
    showToast(state.activeLang === "en" ? `Stopped background sniping for ${prev.name}` : `已停止后台抢卡（${prev.name}）`);
  }
}

export async function completeSessionCreate({ name, hwLabel, result, elapsedSec, fromBg }) {
  const listed = await fetch("/api/sessions").then((res) => res.json()).catch(() => ({ ok: false }));
  const names = listed.ok && listed.state && listed.state.sessions
    ? listed.state.sessions.map((item) => item.name)
    : state.sessions.map((item) => item.name);
  state.sessions = listed.ok && listed.state && listed.state.sessions ? listed.state.sessions : state.sessions;
  const cleanErr = result.ok ? "" : summarizeColabError(result.error || "colab failed", state.activeLang);
  paintNew(applyNewResult(desk, {
    current: state.selected || "",
    requestedName: name,
    ok: !!result.ok,
    entry: {
      kind: "cli",
      label: `new ${name}`,
      ok: !!result.ok,
      error: cleanErr,
      text: result.stdout || "",
      argv: Array.isArray(result.argv) ? result.argv : [],
    },
    sessionNames: names,
  }));
  if (result.ok) {
    if (dom.sessionNameInput) dom.sessionNameInput.value = "";
    refreshUsageSilently();
    const bc = state.bootstrapConfig;
    if (bc.autoMountDrive || bc.enableHfTransfer || bc.hfCacheToDrive || bc.autoInstallUv || (bc.autoInjectEnv && state.envVars.length > 0) || (bc.customScript || "").trim()) {
      emit("settings:bootstrap", { session: name, silent: true });
    }
    if (fromBg) {
      const isEn = state.activeLang === "en";
      const titleText = isEn ? "Colab GPU Ready!" : "🎉 抢到 Colab 节点啦！";
      const bodyText = isEn
        ? `${name} (${hwLabel}) is online after ${elapsedSec}s.`
        : `${name} (${hwLabel}) 已就绪，耗时 ${elapsedSec}s，已自动切换。`;
      sendDesktopNotification(titleText, bodyText, true);
      showToast(bodyText);
    }
  }
  return { cleanErr };
}

export async function handleBgSnipeAttemptResult(snipe, result, fetchErr) {
  if (snipe.stopped || state.bgSnipe !== snipe) return;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - snipe.startedAt) / 1000));
  if (!fetchErr && result && result.ok) {
    stopBgSnipe(true);
    await completeSessionCreate({ name: snipe.name, hwLabel: snipe.hwLabel, result, elapsedSec, fromBg: true });
    return;
  }
  const rawErr = fetchErr ? (fetchErr.message || String(fetchErr)) : (result && result.error) || "";
  if (fetchErr && fetchErr.name === "AbortError") return;

  if (isRetryableColabError(rawErr)) {
    snipe.controller = null;
    snipe.cooldownSec = 10;
    snipe.statusHint = "";
    renderSnipeBanner();
    const tickCooldown = () => {
      if (snipe.stopped || state.bgSnipe !== snipe) return;
      snipe.cooldownSec -= 1;
      renderSnipeBanner();
      if (snipe.cooldownSec <= 0) {
        launchBgSnipeRound(snipe);
      } else {
        snipe.retryTimer = setTimeout(tickCooldown, 1000);
      }
    };
    snipe.retryTimer = setTimeout(tickCooldown, 1000);
    return;
  }

  const friendly = summarizeColabError(rawErr, state.activeLang);
  stopBgSnipe(true);
  const isEn = state.activeLang === "en";
  sendDesktopNotification(
    isEn ? `Sniping stopped (${snipe.name})` : `后台抢卡已停止（${snipe.name}）`,
    friendly,
    true,
  );
  showToast(friendly);
}

export async function launchBgSnipeRound(snipe) {
  if (snipe.stopped || state.bgSnipe !== snipe) return;
  snipe.attempt += 1;
  snipe.cooldownSec = 0;
  snipe.statusHint = state.activeLang === "en" ? `attempt #${snipe.attempt}…` : `第 ${snipe.attempt} 轮申请中…`;
  const controller = new AbortController();
  snipe.controller = controller;
  renderSnipeBanner();
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "new", name: snipe.name, ...snipe.hw }),
      signal: controller.signal,
    });
    const result = await response.json();
    await handleBgSnipeAttemptResult(snipe, result, null);
  } catch (err) {
    await handleBgSnipeAttemptResult(snipe, null, err);
  }
}

export function startBgSnipe({ name, hw, hwLabel, existingController = null, existingStartedAt = null }) {
  clearAgentCreate();
  stopBgSnipe(true);
  const snipe = {
    name,
    hw,
    hwLabel,
    startedAt: existingStartedAt || Date.now(),
    attempt: existingController ? 1 : 0,
    controller: existingController,
    cooldownSec: 0,
    statusHint: existingController
      ? (state.activeLang === "en" ? "attempt #1 (in progress)…" : "第 1 轮申请中…")
      : "",
    stopped: false,
    tickTimer: null,
    pollTimer: null,
    retryTimer: null,
  };
  state.bgSnipe = snipe;
  snipe.tickTimer = setInterval(() => renderSnipeBanner(), 1000);
  snipe.pollTimer = setInterval(async () => {
    if (snipe.stopped || state.bgSnipe !== snipe || snipe.cooldownSec > 0) return;
    try {
      const data = await fetch("/api/log-tail").then((r) => r.json());
      if (!data.ok || !Array.isArray(data.lines)) return;
      const tail = data.lines.slice(-6).join("\n");
      const retryMatch = [...tail.matchAll(/Assignment request failed; retrying in (\d+)s/g)].pop();
      if (retryMatch) {
        snipe.statusHint = state.activeLang === "en"
          ? `attempt #${snipe.attempt} · 503 retry in ${retryMatch[1]}s`
          : `第 ${snipe.attempt} 轮 · 503 退避 ${retryMatch[1]}s 重试`;
        renderSnipeBanner();
      }
    } catch {}
  }, 2500);
  renderSnipeBanner();
  if (!existingController) {
    launchBgSnipeRound(snipe);
  }
  return snipe;
}

export function openNewSessionModal() {
  initSessionCreate();
  closeSessionMenu();
  closeSplitMenu();
  dom.modalError.hidden = true;
  dom.modalError.textContent = "";
  dom.modalStatus.hidden = true;
  dom.modalStatus.textContent = "";
  dom.modalStatus.className = "modal-status";
  dom.highMemInput.checked = state.defaultHighMem;
  syncHardwareChips();
  emit("session-create:modal-opened");
  if (typeof dom.modal.showModal === "function") {
    if (!dom.modal.open) dom.modal.showModal();
  } else {
    dom.modal.setAttribute("open", "");
  }
  requestAnimationFrame(() => {
    dom.sessionNameInput.focus();
    dom.sessionNameInput.select();
  });
}

export function closeNewSessionModal(keepOngoing = false) {
  if (keepOngoing !== true) abortOngoingCreate();
  if (typeof dom.modal.close === "function") {
    if (dom.modal.open) dom.modal.close();
  } else {
    dom.modal.removeAttribute("open");
  }
}

export function describeCreateLog(lines, hwLabel, elapsedSec) {
  const joined = lines.join("\n");
  const retryMatch = [...joined.matchAll(/Assignment request failed; retrying in (\d+)s/g)].pop();
  const has503 = /503 Service Unavailable|503\b/.test(joined);
  const has400 = /Response:\s*400\b/.test(joined);
  if (retryMatch) {
    return {
      warn: true,
      text: `Google Colab 返回 ${has503 ? "503（当前节点繁忙）" : "临时错误"}，${retryMatch[1]}s 后自动重试（已等待 ${elapsedSec}s）。可点「转后台抢卡」继续自动抢，抢到会发系统通知。`,
    };
  }
  if (has400) {
    return { warn: true, text: `Google Colab 返回 400（当前账号可能无该规格配额），等待 CLI 返回结果（${elapsedSec}s）…` };
  }
  return { warn: false, text: `正在向 Google Colab 申请 ${hwLabel} 节点（${elapsedSec}s）…` };
}

export function initSessionCreate() {
  if (sessionCreateInitialized) return;
  sessionCreateInitialized = true;
  mountModalTemplate("new-session-modal", NEW_SESSION_MODAL_HTML);
  on("language:changed", renderSnipeBanner);
  on("session-create:render-banner", renderSnipeBanner);
  on("session-create:sync-hardware", () => {
    if (dom.highMemInput) dom.highMemInput.checked = state.defaultHighMem;
    syncHardwareChips();
  });

  dom.bgSnipeBtn.addEventListener("click", () => {
    if (state.activeCreate && !state.activeCreate.handedOff) {
      const ref = state.activeCreate;
      ref.handedOff = true;
      ref.snipe = startBgSnipe({
        name: ref.name,
        hw: ref.hw,
        hwLabel: ref.hwLabel,
        existingController: ref.controller,
        existingStartedAt: ref.startedAt,
      });
      state.activeCreate = null;
      state.createController = null;
      stopCreateWatchers();
      dom.modalStatus.hidden = true;
      setBusy(-1);
      dom.startSessionBtn.disabled = false;
      dom.startSessionBtn.textContent = t(state.activeLang, "modal.newSession.start");
      closeNewSessionModal(true);
      showToast(state.activeLang === "en" ? `Moved ${ref.name} to background sniping` : `已转入后台抢卡（${ref.name}），抢到后将发系统通知`);
      return;
    }
    const name = dom.sessionNameInput.value.trim();
    if (!name) {
      dom.modalError.textContent = state.activeLang === "en" ? "Please enter a session name" : "请输入会话名称";
      dom.modalError.hidden = false;
      dom.sessionNameInput.focus();
      return;
    }
    const hw = hardware();
    const hwLabel = (hw.gpu || hw.tpu || "CPU") + (hw.highMem ? " + high-mem" : "");
    const queueCfg = state.snipeQueueConfig;
    const hasMultiQueue = queueCfg && ((Array.isArray(queueCfg.targets) && queueCfg.targets.length > 0) || queueCfg.recipeId);
    closeNewSessionModal(true);
    if (hasMultiQueue) {
      emit("recipes:start-snipe", {
        name,
        targets: queueCfg.targets && queueCfg.targets.length ? queueCfg.targets : [hw],
        intervalSec: queueCfg.intervalSec,
        maxAttempts: queueCfg.maxAttempts,
        timeoutSec: queueCfg.timeoutSec,
        recipeId: queueCfg.recipeId || null,
      });
      return;
    }
    startBgSnipe({ name, hw, hwLabel });
    showToast(state.activeLang === "en" ? `Background sniping started for ${name} (${hwLabel})` : `已开始后台抢卡：${name} (${hwLabel})，抢到后将发系统通知`);
  });

  dom.snipeTakeoverBtn.addEventListener("click", () => {
    if (!state.agentCreate) return;
    const { name, hw, hwLabel } = state.agentCreate;
    const wasRunning = !state.agentCreate.failedRetryable;
    clearAgentCreate();
    if (wasRunning && state.activeAgentController) {
      try { state.activeAgentController.abort(); } catch {}
    }
    startBgSnipe({ name, hw, hwLabel });
    showToast(state.activeLang === "en" ? `Moved ${name} (${hwLabel}) to background sniping` : `已转入后台抢卡：${name} (${hwLabel})，抢到后将发系统通知`);
  });

  dom.snipeStopBtn.addEventListener("click", () => {
    if (state.bgSnipe && !state.bgSnipe.stopped) {
      stopBgSnipe(false);
    } else if (state.activeSnipeJob && (state.activeSnipeJob.status === "running" || state.activeSnipeJob.status === "paused")) {
      emit("recipes:snipe-action", { id: state.activeSnipeJob.id, action: "cancel" });
    } else if (state.agentCreate) {
      const wasRunning = !state.agentCreate.failedRetryable;
      clearAgentCreate();
      if (wasRunning && state.activeAgentController) {
        try { state.activeAgentController.abort(); } catch {}
      }
    }
  });

  dom.modalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.createController) return;
    const name = dom.sessionNameInput.value.trim();
    if (!name) {
      dom.modalError.textContent = state.activeLang === "en" ? "Please enter a session name" : "请输入会话名称";
      dom.modalError.hidden = false;
      dom.sessionNameInput.focus();
      return;
    }
    dom.modalError.hidden = true;
    const hw = hardware();
    const hwLabel = (hw.gpu || hw.tpu || "CPU") + (hw.highMem ? " + high-mem" : "");
    const startedAt = Date.now();
    let latestLines = [];
    let baselineLogLine = "";
    try {
      const base = await fetch("/api/log-tail").then((r) => r.json());
      if (base.ok && Array.isArray(base.lines) && base.lines.length) {
        baselineLogLine = base.lines[base.lines.length - 1];
      }
    } catch {}

    const controller = new AbortController();
    state.createController = controller;
    const createRef = { name, hw, hwLabel, controller, startedAt, handedOff: false, snipe: null };
    state.activeCreate = createRef;
    dom.startSessionBtn.disabled = true;
    const paintProgress = () => {
      if (createRef.handedOff) return;
      const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      dom.startSessionBtn.textContent = `创建中 ${sec}s`;
      const info = describeCreateLog(latestLines, hwLabel, sec);
      dom.modalStatus.textContent = info.text;
      dom.modalStatus.className = info.warn ? "modal-status is-warn" : "modal-status";
      dom.modalStatus.hidden = false;
    };
    paintProgress();
    state.createTickTimer = setInterval(paintProgress, 1000);
    state.createPollTimer = setInterval(async () => {
      if (createRef.handedOff) return;
      try {
        const data = await fetch("/api/log-tail").then((r) => r.json());
        if (!data.ok || !Array.isArray(data.lines)) return;
        const idx = baselineLogLine ? data.lines.lastIndexOf(baselineLogLine) : -1;
        latestLines = idx >= 0 ? data.lines.slice(idx + 1) : data.lines.slice(-10);
        paintProgress();
      } catch {}
    }, 2000);

    setBusy(1);
    try {
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "new", name, ...hw }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (createRef.handedOff && createRef.snipe) {
        await handleBgSnipeAttemptResult(createRef.snipe, result, null);
        return;
      }
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const { cleanErr } = await completeSessionCreate({ name, hwLabel, result, elapsedSec, fromBg: false });
      if (result.ok) {
        const recipeId = state.snipeQueueConfig?.recipeId || null;
        if (recipeId) {
          emit("recipes:post-acquire", { session: name, recipeId });
        }
        closeNewSessionModal(true);
      } else {
        dom.modalError.textContent = cleanErr;
        dom.modalError.hidden = false;
      }
    } catch (err) {
      if (createRef.handedOff && createRef.snipe) {
        await handleBgSnipeAttemptResult(createRef.snipe, null, err);
        return;
      }
      if (err && err.name === "AbortError") {
        dom.modalStatus.hidden = true;
        dom.modalError.textContent = state.activeLang === "en" ? "Creation cancelled." : "已取消创建。";
        dom.modalError.hidden = false;
      } else {
        dom.modalError.textContent = summarizeColabError((err && err.message) || "network error", state.activeLang);
        dom.modalError.hidden = false;
      }
    } finally {
      if (!createRef.handedOff) {
        stopCreateWatchers();
        if (state.createController === controller) state.createController = null;
        if (state.activeCreate === createRef) state.activeCreate = null;
        dom.modalStatus.hidden = true;
        setBusy(-1);
        dom.startSessionBtn.disabled = false;
        dom.startSessionBtn.textContent = t(state.activeLang, "modal.newSession.start");
      }
    }
  });

  document.querySelector("#close-new-session").addEventListener("click", () => closeNewSessionModal(false));
  document.querySelector("#cancel-new-session").addEventListener("click", () => closeNewSessionModal(false));
  dom.modal.addEventListener("cancel", () => abortOngoingCreate());
  dom.modal.addEventListener("click", (event) => { if (event.target === dom.modal) closeNewSessionModal(); });
  dom.sessionNameInput.addEventListener("input", () => { dom.modalError.hidden = true; dom.modalCmd.textContent = buildNewPreview(); });
  document.querySelector("#hardware-picker").addEventListener("change", syncHardwareChips);
  emit("session-create:modal-mounted");
}

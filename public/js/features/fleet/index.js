const STRINGS = {
  "zh-CN": {
    "fleet.menuLabel": "多会话集群与广播",
    "fleet.cmdOpen": "打开多会话集群与广播 (Fleet)",
    "fleet.title": "Fleet — 多会话总览与广播",
    "fleet.refresh": "刷新",
    "fleet.close": "关闭",
    "fleet.selectAll": "全选",
    "fleet.clearSel": "清空选择",
    "fleet.selectedCount": "已选 {count} 个会话",
    "fleet.empty": "当前没有已连接的 Colab 会话。先在左侧新建或连接会话后即可在此并行管理。",
    "fleet.loading": "正在加载会话与 GPU 遥测…",
    "fleet.noGpu": "无 GPU 或遥测暂不可用",
    "fleet.gpuUtil": "GPU 利用率",
    "fleet.vram": "显存",
    "fleet.temp": "温度",
    "fleet.uptime": "已运行",
    "fleet.focus": "切换",
    "fleet.bulkStop": "停止所选",
    "fleet.bulkBootstrap": "初始化所选",
    "fleet.bulkPush": "推送文件夹到全部",
    "fleet.bulkConfirmStop": "确认停止所选的 {count} 个 Colab VM？未保存的数据将丢失。",
    "fleet.confirm": "确认执行",
    "fleet.cancel": "取消",
    "fleet.pushLocal": "本地目录路径",
    "fleet.pushRemote": "远程目标路径（可选）",
    "fleet.pushRun": "开始推送",
    "fleet.broadcastTitle": "并行广播命令",
    "fleet.modeSsh": "Shell (colab ssh)",
    "fleet.modeExec": "Python (colab exec)",
    "fleet.timeoutLabel": "单会话超时(秒)",
    "fleet.cmdPlaceholder": "输入要在所选会话并行执行的 Shell 命令或 Python 代码…",
    "fleet.runBroadcast": "广播执行",
    "fleet.cancelAll": "全部取消",
    "fleet.rerunFailed": "仅重跑失败项",
    "fleet.dangerWarn": "检测到高危命令 ({matches})，确认要在 {count} 个会话上执行吗？",
    "fleet.dangerConfirm": "确认高危执行",
    "fleet.needSelect": "请至少选择一个会话",
    "fleet.needCmd": "请输入要执行的命令或代码",
    "fleet.bulkDone": "批量操作完成：成功 {ok}/{total}",
    "fleet.status.queued": "排队中",
    "fleet.status.running": "运行中",
    "fleet.status.ok": "成功",
    "fleet.status.failed": "失败",
    "fleet.status.timeout": "超时",
    "fleet.status.cancelled": "已取消",
  },
  en: {
    "fleet.menuLabel": "Fleet & Broadcast",
    "fleet.cmdOpen": "Open Multi-Session Fleet & Broadcast",
    "fleet.title": "Fleet — Multi-Session & Broadcast",
    "fleet.refresh": "Refresh",
    "fleet.close": "Close",
    "fleet.selectAll": "Select all",
    "fleet.clearSel": "Clear",
    "fleet.selectedCount": "{count} selected",
    "fleet.empty": "No connected Colab sessions yet. Create or connect sessions from the sidebar to manage them side by side.",
    "fleet.loading": "Loading sessions & GPU telemetry…",
    "fleet.noGpu": "No GPU / telemetry unavailable",
    "fleet.gpuUtil": "GPU Util",
    "fleet.vram": "VRAM",
    "fleet.temp": "Temp",
    "fleet.uptime": "Elapsed",
    "fleet.focus": "Focus",
    "fleet.bulkStop": "Stop selected",
    "fleet.bulkBootstrap": "Bootstrap selected",
    "fleet.bulkPush": "Push folder to all",
    "fleet.bulkConfirmStop": "Stop {count} selected Colab VM(s)? Unsaved runtime state will be lost.",
    "fleet.confirm": "Confirm",
    "fleet.cancel": "Cancel",
    "fleet.pushLocal": "Local folder path",
    "fleet.pushRemote": "Remote destination (optional)",
    "fleet.pushRun": "Push to all",
    "fleet.broadcastTitle": "Broadcast Command",
    "fleet.modeSsh": "Shell (colab ssh)",
    "fleet.modeExec": "Python (colab exec)",
    "fleet.timeoutLabel": "Timeout (s)",
    "fleet.cmdPlaceholder": "Enter a shell command or Python snippet to run across selected sessions…",
    "fleet.runBroadcast": "Broadcast",
    "fleet.cancelAll": "Cancel all",
    "fleet.rerunFailed": "Re-run failed",
    "fleet.dangerWarn": "Dangerous command detected ({matches}). Confirm running on {count} session(s)?",
    "fleet.dangerConfirm": "Confirm & Run",
    "fleet.needSelect": "Select at least one session first",
    "fleet.needCmd": "Enter a command or snippet to broadcast",
    "fleet.bulkDone": "Bulk action finished: {ok}/{total} succeeded",
    "fleet.status.queued": "Queued",
    "fleet.status.running": "Running",
    "fleet.status.ok": "OK",
    "fleet.status.failed": "Failed",
    "fleet.status.timeout": "Timeout",
    "fleet.status.cancelled": "Cancelled",
  },
};

function fmt(template, vars = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export async function init(api) {
  api.registerStrings(STRINGS);

  const t = (key, vars) => fmt(api.tr(key), vars);
  const selected = new Set();
  const seenAt = new Map();

  let dialog = null;
  let sessionsData = [];
  let mode = "ssh";
  let activeJob = null;
  let pollTimer = null;
  let tickTimer = null;
  let fetching = false;
  let pendingDangerPayload = null;
  let pendingStopConfirm = false;

  // Refs populated lazily when modal is created
  let elCards = null;
  let elSelCount = null;
  let elOutputs = null;
  let elCmd = null;
  let elTimeout = null;
  let elDangerBox = null;
  let elDangerText = null;
  let elStopBox = null;
  let elStopText = null;
  let elPushBox = null;
  let elPushLocal = null;
  let elPushRemote = null;
  let btnRun = null;
  let btnCancel = null;
  let btnRerun = null;
  let btnBulkStop = null;
  let btnBulkBoot = null;
  let btnBulkPush = null;

  function focusSession(name) {
    const btn = document.querySelector(`.session-item[data-session="${CSS.escape(name)}"]`);
    if (btn) btn.click();
    api.emit("fleet:focus-session", { session: name });
    closeModal();
  }

  function getSessionStartMs(name) {
    const fromState = api.state?.sessionConnectedAt?.[name];
    if (Number.isFinite(fromState) && fromState > 0) return fromState;
    if (!seenAt.has(name)) seenAt.set(name, Date.now());
    return seenAt.get(name);
  }

  function syncSelectionUi() {
    if (!dialog) return;
    const count = selected.size;
    elSelCount.textContent = t("fleet.selectedCount", { count });
    const disabled = count === 0;
    btnBulkStop.disabled = disabled;
    btnBulkBoot.disabled = disabled;
    btnBulkPush.disabled = disabled;
  }

  function renderCards() {
    if (!elCards) return;
    elCards.replaceChildren();
    if (!sessionsData.length) {
      const empty = document.createElement("div");
      empty.className = "fleet-empty";
      empty.textContent = t("fleet.empty");
      elCards.append(empty);
      syncSelectionUi();
      return;
    }
    const now = Date.now();
    for (const sess of sessionsData) {
      const card = document.createElement("div");
      card.className = "fleet-card" + (selected.has(sess.name) ? " is-selected" : "");
      card.dataset.session = sess.name;

      const head = document.createElement("div");
      head.className = "fleet-card-head";

      const label = document.createElement("label");
      label.className = "fleet-card-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(sess.name);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(sess.name);
        else selected.delete(sess.name);
        card.classList.toggle("is-selected", cb.checked);
        syncSelectionUi();
      });
      const nameSpan = document.createElement("span");
      nameSpan.className = "fleet-card-name";
      nameSpan.textContent = sess.name;
      label.append(cb, nameSpan);

      const focusBtn = document.createElement("button");
      focusBtn.type = "button";
      focusBtn.className = "fleet-btn";
      focusBtn.textContent = t("fleet.focus");
      focusBtn.addEventListener("click", () => focusSession(sess.name));
      head.append(label, focusBtn);

      const chips = document.createElement("div");
      chips.className = "fleet-chips";
      const hwChip = document.createElement("span");
      hwChip.className = "fleet-chip is-hw";
      hwChip.textContent = sess.hardware || "VM";
      chips.append(hwChip);

      if (sess.status) {
        const stChip = document.createElement("span");
        stChip.className = "fleet-chip " + (/run|active|connected/i.test(sess.status) ? "is-ok" : "");
        stChip.textContent = sess.status;
        chips.append(stChip);
      }

      const upChip = document.createElement("span");
      upChip.className = "fleet-chip";
      upChip.dataset.uptimeFor = sess.name;
      upChip.textContent = `${t("fleet.uptime")}: ${formatElapsed(now - getSessionStartMs(sess.name))}`;
      chips.append(upChip);

      const metrics = document.createElement("div");
      metrics.className = "fleet-metrics";
      const gpus = sess.telemetry?.gpus || [];
      if (gpus.length > 0) {
        const g = gpus[0];
        const util = Math.max(0, Math.min(100, Number(g.utilPct) || 0));
        const memPct = g.memTotalMb > 0 ? Math.min(100, Math.round((g.memUsedMb / g.memTotalMb) * 100)) : 0;

        const r1 = document.createElement("div");
        r1.className = "fleet-metric-row";
        const r1L = document.createElement("span");
        r1L.textContent = `${t("fleet.gpuUtil")} (${g.name || sess.hardware || "GPU"})`;
        const r1R = document.createElement("span");
        r1R.textContent = `${util}%` + (g.tempC != null ? ` · ${g.tempC}°C` : "");
        r1.append(r1L, r1R);

        const b1 = document.createElement("div");
        b1.className = "fleet-bar";
        const b1f = document.createElement("div");
        b1f.className = "fleet-bar-fill";
        b1f.style.width = `${util}%`;
        b1.append(b1f);

        const r2 = document.createElement("div");
        r2.className = "fleet-metric-row";
        const r2L = document.createElement("span");
        r2L.textContent = t("fleet.vram");
        const r2R = document.createElement("span");
        r2R.textContent = `${Math.round(g.memUsedMb)} / ${Math.round(g.memTotalMb)} MB (${memPct}%)`;
        r2.append(r2L, r2R);

        const b2 = document.createElement("div");
        b2.className = "fleet-bar";
        const b2f = document.createElement("div");
        b2f.className = "fleet-bar-fill";
        b2f.style.width = `${memPct}%`;
        b2.append(b2f);

        metrics.append(r1, b1, r2, b2);
      } else {
        const noGpu = document.createElement("div");
        noGpu.className = "fleet-metric-row";
        noGpu.textContent = t("fleet.noGpu");
        metrics.append(noGpu);
      }

      card.append(head, chips, metrics);
      elCards.append(card);
    }
    syncSelectionUi();
  }

  function renderOutputs() {
    if (!elOutputs) return;
    elOutputs.replaceChildren();
    if (!activeJob) {
      btnCancel.disabled = true;
      btnRerun.disabled = true;
      return;
    }
    const entries = Object.entries(activeJob.sessions || {});
    const hasFailed = entries.some(([, s]) => ["failed", "timeout", "cancelled"].includes(s.status));
    btnCancel.disabled = !!activeJob.done;
    btnRerun.disabled = !activeJob.done || !hasFailed;

    for (const [name, rec] of entries) {
      const card = document.createElement("div");
      card.className = "fleet-out-card";
      card.dataset.outSession = name;

      const head = document.createElement("div");
      head.className = "fleet-out-head";
      const title = document.createElement("span");
      title.textContent = name;

      const chip = document.createElement("span");
      const cls = rec.status === "ok" ? "is-ok" : (rec.status === "running" || rec.status === "queued" ? "is-warn" : "is-err");
      chip.className = `fleet-chip ${cls}`;
      const statusText = t(`fleet.status.${rec.status}`) || rec.status;
      chip.textContent = rec.exitCode !== null && rec.exitCode !== undefined ? `${statusText} (${rec.exitCode})` : statusText;
      head.append(title, chip);

      const pre = document.createElement("pre");
      pre.className = "fleet-out-pre";
      pre.textContent = rec.output || rec.error || "";
      card.append(head, pre);
      elOutputs.append(card);
    }
  }

  async function refreshOverview(force = false) {
    if (fetching || !dialog?.open) return;
    fetching = true;
    try {
      const data = await api.fetchJson(`/api/fleet/overview?telemetry=1${force ? "&force=1" : ""}`);
      sessionsData = Array.isArray(data?.sessions) ? data.sessions : [];
      // Drop selections that no longer exist; auto-select all on first open if none selected
      const validNames = new Set(sessionsData.map((s) => s.name));
      for (const n of Array.from(selected)) {
        if (!validNames.has(n)) selected.delete(n);
      }
      if (selected.size === 0 && sessionsData.length > 0 && !activeJob) {
        for (const s of sessionsData) selected.add(s.name);
      }
      renderCards();
    } catch (err) {
      api.showToast(err?.message || "Failed to load fleet overview");
    } finally {
      fetching = false;
    }
  }

  function startPolling() {
    stopPolling();
    if (!dialog?.open || document.visibilityState !== "visible") return;
    pollTimer = setInterval(() => {
      if (dialog?.open && document.visibilityState === "visible") refreshOverview(false);
    }, 6000);
    tickTimer = setInterval(() => {
      if (!dialog?.open) return;
      const now = Date.now();
      for (const el of dialog.querySelectorAll("[data-uptime-for]")) {
        const name = el.dataset.uptimeFor;
        el.textContent = `${t("fleet.uptime")}: ${formatElapsed(now - getSessionStartMs(name))}`;
      }
    }, 1000);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  async function submitBroadcast(confirmDanger = false) {
    const names = Array.from(selected);
    const command = (elCmd.value || "").trim();
    if (!names.length) {
      api.showToast(t("fleet.needSelect"));
      return;
    }
    if (!command) {
      api.showToast(t("fleet.needCmd"));
      return;
    }
    const payload = {
      sessions: names,
      mode,
      command,
      timeout: Number(elTimeout.value) || 120,
      confirmDanger,
    };
    elDangerBox.hidden = true;
    pendingDangerPayload = null;
    try {
      const data = await api.fetchJson("/api/fleet/broadcast", { method: "POST", body: payload });
      if (data?.job) {
        activeJob = data.job;
        renderOutputs();
      }
    } catch (err) {
      if (err?.status === 409 && err?.data?.needsConfirm) {
        pendingDangerPayload = payload;
        const matches = (err.data.matches || []).join(", ");
        elDangerText.textContent = t("fleet.dangerWarn", { matches, count: names.length });
        elDangerBox.hidden = false;
      } else {
        api.showToast(err?.message || "Broadcast failed");
      }
    }
  }

  async function runBulkAction(action, extra = {}) {
    const names = Array.from(selected);
    if (!names.length) {
      api.showToast(t("fleet.needSelect"));
      return;
    }
    try {
      const res = await api.fetchJson("/api/fleet/bulk", {
        method: "POST",
        body: { action, sessions: names, ...extra },
      });
      const results = Array.isArray(res?.results) ? res.results : [];
      const okCount = results.filter((r) => r.ok).length;
      api.showToast(t("fleet.bulkDone", { ok: okCount, total: results.length }));
      if (action === "stop") {
        api.emit("sessions:refresh");
        refreshOverview(true);
      }
    } catch (err) {
      api.showToast(err?.message || "Bulk action failed");
    }
  }

  function ensureModal() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "fleet-modal";
    dialog.className = "wide-modal fleet-modal";

    const shell = document.createElement("div");
    shell.className = "fleet-shell";

    // Header
    const head = document.createElement("div");
    head.className = "fleet-head";
    const headLeft = document.createElement("div");
    headLeft.className = "fleet-head-left";
    const h3 = document.createElement("h3");
    h3.dataset.i18n = "fleet.title";
    h3.textContent = t("fleet.title");
    headLeft.append(h3);

    const headActions = document.createElement("div");
    headActions.className = "fleet-head-actions";
    const btnRefresh = document.createElement("button");
    btnRefresh.type = "button";
    btnRefresh.className = "fleet-btn";
    btnRefresh.dataset.i18n = "fleet.refresh";
    btnRefresh.textContent = t("fleet.refresh");
    btnRefresh.addEventListener("click", () => refreshOverview(true));

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "fleet-btn";
    btnClose.dataset.i18n = "fleet.close";
    btnClose.textContent = t("fleet.close");
    btnClose.addEventListener("click", () => closeModal());
    headActions.append(btnRefresh, btnClose);
    head.append(headLeft, headActions);

    // Body
    const body = document.createElement("div");
    body.className = "fleet-body";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "fleet-toolbar";

    const selBar = document.createElement("div");
    selBar.className = "fleet-select-bar";
    const btnAll = document.createElement("button");
    btnAll.type = "button";
    btnAll.className = "fleet-btn";
    btnAll.dataset.i18n = "fleet.selectAll";
    btnAll.textContent = t("fleet.selectAll");
    btnAll.addEventListener("click", () => {
      for (const s of sessionsData) selected.add(s.name);
      renderCards();
    });
    const btnClear = document.createElement("button");
    btnClear.type = "button";
    btnClear.className = "fleet-btn";
    btnClear.dataset.i18n = "fleet.clearSel";
    btnClear.textContent = t("fleet.clearSel");
    btnClear.addEventListener("click", () => {
      selected.clear();
      renderCards();
    });
    elSelCount = document.createElement("span");
    elSelCount.className = "fleet-chip";
    selBar.append(btnAll, btnClear, elSelCount);

    const bulkBar = document.createElement("div");
    bulkBar.className = "fleet-bulk-bar";
    btnBulkBoot = document.createElement("button");
    btnBulkBoot.type = "button";
    btnBulkBoot.className = "fleet-btn";
    btnBulkBoot.dataset.i18n = "fleet.bulkBootstrap";
    btnBulkBoot.textContent = t("fleet.bulkBootstrap");
    btnBulkBoot.addEventListener("click", () => runBulkAction("bootstrap"));

    btnBulkPush = document.createElement("button");
    btnBulkPush.type = "button";
    btnBulkPush.className = "fleet-btn";
    btnBulkPush.dataset.i18n = "fleet.bulkPush";
    btnBulkPush.textContent = t("fleet.bulkPush");
    btnBulkPush.addEventListener("click", () => {
      elPushBox.hidden = !elPushBox.hidden;
      if (!elPushBox.hidden && api.state?.syncConfig) {
        if (!elPushLocal.value && api.state.syncConfig.localDir) elPushLocal.value = api.state.syncConfig.localDir;
        if (!elPushRemote.value && api.state.syncConfig.remoteDir) elPushRemote.value = api.state.syncConfig.remoteDir;
      }
    });

    btnBulkStop = document.createElement("button");
    btnBulkStop.type = "button";
    btnBulkStop.className = "fleet-btn is-danger";
    btnBulkStop.dataset.i18n = "fleet.bulkStop";
    btnBulkStop.textContent = t("fleet.bulkStop");
    btnBulkStop.addEventListener("click", () => {
      if (!selected.size) return;
      pendingStopConfirm = true;
      elStopText.textContent = t("fleet.bulkConfirmStop", { count: selected.size });
      elStopBox.hidden = false;
    });
    bulkBar.append(btnBulkBoot, btnBulkPush, btnBulkStop);
    toolbar.append(selBar, bulkBar);

    // Stop confirmation box
    elStopBox = document.createElement("div");
    elStopBox.className = "fleet-confirm-box";
    elStopBox.hidden = true;
    elStopText = document.createElement("span");
    const stopBtns = document.createElement("div");
    stopBtns.className = "fleet-bc-right";
    const stopOk = document.createElement("button");
    stopOk.type = "button";
    stopOk.className = "fleet-btn is-danger";
    stopOk.textContent = t("fleet.confirm");
    stopOk.addEventListener("click", () => {
      elStopBox.hidden = true;
      if (pendingStopConfirm) {
        pendingStopConfirm = false;
        runBulkAction("stop", { confirm: true });
      }
    });
    const stopNo = document.createElement("button");
    stopNo.type = "button";
    stopNo.className = "fleet-btn";
    stopNo.textContent = t("fleet.cancel");
    stopNo.addEventListener("click", () => {
      pendingStopConfirm = false;
      elStopBox.hidden = true;
    });
    stopBtns.append(stopNo, stopOk);
    elStopBox.append(elStopText, stopBtns);

    // Push folder box
    elPushBox = document.createElement("div");
    elPushBox.className = "fleet-push-box";
    elPushBox.hidden = true;
    elPushLocal = document.createElement("input");
    elPushLocal.className = "fleet-input";
    elPushLocal.style.flex = "1";
    elPushLocal.placeholder = t("fleet.pushLocal");
    elPushRemote = document.createElement("input");
    elPushRemote.className = "fleet-input";
    elPushRemote.style.flex = "1";
    elPushRemote.placeholder = t("fleet.pushRemote");
    const pushGo = document.createElement("button");
    pushGo.type = "button";
    pushGo.className = "fleet-btn is-primary";
    pushGo.textContent = t("fleet.pushRun");
    pushGo.addEventListener("click", () => {
      const localDir = elPushLocal.value.trim();
      const remoteDir = elPushRemote.value.trim();
      if (!localDir) return;
      elPushBox.hidden = true;
      runBulkAction("push", { localDir, remoteDir });
    });
    elPushBox.append(elPushLocal, elPushRemote, pushGo);

    // Cards grid
    elCards = document.createElement("div");
    elCards.className = "fleet-cards";

    // Broadcast panel
    const panel = document.createElement("div");
    panel.className = "fleet-panel";
    const pHead = document.createElement("div");
    pHead.className = "fleet-panel-head";
    const pTitle = document.createElement("span");
    pTitle.className = "fleet-panel-title";
    pTitle.dataset.i18n = "fleet.broadcastTitle";
    pTitle.textContent = t("fleet.broadcastTitle");

    const modeTabs = document.createElement("div");
    modeTabs.className = "fleet-mode-tabs";
    const tabSsh = document.createElement("button");
    tabSsh.type = "button";
    tabSsh.className = "fleet-mode-tab is-active";
    tabSsh.textContent = t("fleet.modeSsh");
    const tabExec = document.createElement("button");
    tabExec.type = "button";
    tabExec.className = "fleet-mode-tab";
    tabExec.textContent = t("fleet.modeExec");
    tabSsh.addEventListener("click", () => {
      mode = "ssh";
      tabSsh.classList.add("is-active");
      tabExec.classList.remove("is-active");
    });
    tabExec.addEventListener("click", () => {
      mode = "exec";
      tabExec.classList.add("is-active");
      tabSsh.classList.remove("is-active");
    });
    modeTabs.append(tabSsh, tabExec);
    pHead.append(pTitle, modeTabs);

    elCmd = document.createElement("textarea");
    elCmd.className = "fleet-textarea";
    elCmd.placeholder = t("fleet.cmdPlaceholder");

    elDangerBox = document.createElement("div");
    elDangerBox.className = "fleet-confirm-box";
    elDangerBox.hidden = true;
    elDangerText = document.createElement("span");
    const dangerBtns = document.createElement("div");
    dangerBtns.className = "fleet-bc-right";
    const dangerNo = document.createElement("button");
    dangerNo.type = "button";
    dangerNo.className = "fleet-btn";
    dangerNo.textContent = t("fleet.cancel");
    dangerNo.addEventListener("click", () => {
      pendingDangerPayload = null;
      elDangerBox.hidden = true;
    });
    const dangerYes = document.createElement("button");
    dangerYes.type = "button";
    dangerYes.className = "fleet-btn is-danger";
    dangerYes.textContent = t("fleet.dangerConfirm");
    dangerYes.addEventListener("click", () => {
      if (pendingDangerPayload) submitBroadcast(true);
    });
    dangerBtns.append(dangerNo, dangerYes);
    elDangerBox.append(elDangerText, dangerBtns);

    const controls = document.createElement("div");
    controls.className = "fleet-bc-controls";
    const cLeft = document.createElement("div");
    cLeft.className = "fleet-bc-left";
    const toLabel = document.createElement("label");
    toLabel.style.fontSize = "12px";
    toLabel.style.color = "var(--muted)";
    toLabel.textContent = t("fleet.timeoutLabel");
    elTimeout = document.createElement("input");
    elTimeout.type = "number";
    elTimeout.min = "5";
    elTimeout.max = "3600";
    elTimeout.value = "120";
    elTimeout.className = "fleet-input";
    elTimeout.style.width = "74px";
    cLeft.append(toLabel, elTimeout);

    const cRight = document.createElement("div");
    cRight.className = "fleet-bc-right";
    btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "fleet-btn is-danger";
    btnCancel.textContent = t("fleet.cancelAll");
    btnCancel.disabled = true;
    btnCancel.addEventListener("click", async () => {
      if (!activeJob) return;
      try {
        const data = await api.fetchJson(`/api/fleet/broadcast/${activeJob.id}/cancel`, { method: "POST" });
        if (data?.job) {
          activeJob = data.job;
          renderOutputs();
        }
      } catch {}
    });

    btnRerun = document.createElement("button");
    btnRerun.type = "button";
    btnRerun.className = "fleet-btn";
    btnRerun.textContent = t("fleet.rerunFailed");
    btnRerun.disabled = true;
    btnRerun.addEventListener("click", async () => {
      if (!activeJob) return;
      try {
        const data = await api.fetchJson(`/api/fleet/broadcast/${activeJob.id}/rerun-failed`, { method: "POST", body: {} });
        if (data?.job) {
          activeJob = data.job;
          renderOutputs();
        }
      } catch (err) {
        api.showToast(err?.message || "Re-run failed");
      }
    });

    btnRun = document.createElement("button");
    btnRun.type = "button";
    btnRun.className = "fleet-btn is-primary";
    btnRun.textContent = t("fleet.runBroadcast");
    btnRun.addEventListener("click", () => submitBroadcast(false));
    cRight.append(btnCancel, btnRerun, btnRun);
    controls.append(cLeft, cRight);

    elOutputs = document.createElement("div");
    elOutputs.className = "fleet-outputs";

    panel.append(pHead, elCmd, elDangerBox, controls, elOutputs);
    body.append(toolbar, elStopBox, elPushBox, elCards, panel);
    shell.append(head, body);
    dialog.append(shell);

    dialog.addEventListener("close", () => stopPolling());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) closeModal();
    });
    document.body.append(dialog);
    return dialog;
  }

  function openModal() {
    ensureModal();
    if (!dialog.open) dialog.showModal();
    refreshOverview(false);
    startPolling();
  }

  function closeModal() {
    stopPolling();
    if (dialog?.open) dialog.close();
  }

  // Visibility-aware polling pause/resume
  document.addEventListener("visibilitychange", () => {
    if (!dialog?.open) return;
    if (document.visibilityState === "visible") {
      refreshOverview(false);
      startPolling();
    } else {
      stopPolling();
    }
  });

  // Live SSE streaming updates for broadcast jobs
  api.onServerEvent("fleet:output", (ev) => {
    if (!activeJob || !ev || ev.id !== activeJob.id) return;
    const rec = activeJob.sessions?.[ev.session];
    if (!rec) return;
    rec.output = (rec.output || "") + (ev.chunk || "");
    const pre = dialog?.querySelector(`.fleet-out-card[data-out-session="${CSS.escape(ev.session)}"] .fleet-out-pre`);
    if (pre) {
      pre.textContent = rec.output;
      pre.scrollTop = pre.scrollHeight;
    }
  });

  api.onServerEvent("fleet:status", (ev) => {
    if (!activeJob || !ev || ev.id !== activeJob.id) return;
    const rec = activeJob.sessions?.[ev.session];
    if (!rec) return;
    rec.status = ev.status;
    rec.exitCode = ev.exitCode;
    rec.error = ev.error;
    renderOutputs();
  });

  api.onServerEvent("fleet:done", (ev) => {
    if (!activeJob || !ev || ev.id !== activeJob.id) return;
    if (ev.job) activeJob = ev.job;
    else activeJob.done = true;
    renderOutputs();
  });

  // Mount in workspace-tools dropdown
  const menuBtn = document.createElement("button");
  menuBtn.id = "open-fleet-btn";
  menuBtn.className = "tools-dropdown-item";
  menuBtn.type = "button";
  menuBtn.setAttribute("role", "menuitem");
  menuBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
  const labelSpan = document.createElement("span");
  labelSpan.dataset.i18n = "fleet.menuLabel";
  labelSpan.textContent = t("fleet.menuLabel");
  menuBtn.append(labelSpan);
  menuBtn.addEventListener("click", () => {
    const menu = document.getElementById("tools-dropdown-menu");
    if (menu) menu.hidden = true;
    openModal();
  });
  api.mount("workspace-tools", menuBtn);

  // Command palette entry
  api.registerCommand({
    id: "fleet:open",
    title: () => api.tr("fleet.cmdOpen"),
    run: () => openModal(),
  });

  api.on("fleet:open", openModal);
  window.__colabDeskFleet = { open: openModal, close: closeModal };
}

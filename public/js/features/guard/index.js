// Session Guard frontend plugin: compact rail section, Settings tab, SSE updates,
// one-click rebuild reusing existing /api/action + /api/bootstrap + /api/sync/push endpoints.
import { GUARD_STRINGS } from "./strings.js";
import { renderCuChartSvg } from "./chart.js";

function hardwareConfigFrom(hardware = "") {
  const h = String(hardware || "").toUpperCase();
  for (const g of ["T4", "L4", "G4", "H100", "A100"]) {
    if (h.includes(g)) return { gpu: g };
  }
  if (/V5E1/.test(h)) return { tpu: "v5e1" };
  if (/V6E1/.test(h)) return { tpu: "v6e1" };
  return {};
}

function fmtMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export async function init(api) {
  api.registerStrings(GUARD_STRINGS);

  let snapshot = {
    settings: {
      heartbeatMinutes: 5,
      pollSeconds: 60,
      cuSampleMinutes: 5,
      maxReconnectAttempts: 5,
      reconnectBaseSeconds: 15,
      maxRuntimeHours: 12,
      idleTimeoutMinutes: 90,
      warnMinutes: 15,
      budgetCap: 0,
      hourlyCap: 0,
      autoDisconnect: false,
      autoDisconnectConfirmed: false,
    },
    sessions: [],
    cu: { balance: null, rate: null, spent: 0, budgetCap: 0, hourlyCap: 0, currentHourUsed: 0 },
    cuHistory: [],
  };

  let rebuilding = false;
  const rememberedSig = new Map();

  // ---- Rail Section ----
  const railEl = document.createElement("div");
  railEl.className = "inspector-section guard-rail";
  railEl.hidden = true;
  api.mount("rail", railEl);

  // ---- Settings Pane ----
  const paneEl = document.createElement("div");
  paneEl.className = "guard-settings";
  api.mount("settings-pane", {
    id: "guard",
    title: "guard.tabTitle",
    element: paneEl,
  });

  function findGuardSession(name) {
    if (!name || !Array.isArray(snapshot.sessions)) return null;
    return snapshot.sessions.find((s) => s.name === name) || null;
  }

  function findLostSession() {
    if (!Array.isArray(snapshot.sessions)) return null;
    const active = api.getSession();
    if (active) {
      const match = snapshot.sessions.find((s) => s.name === active.name && s.state === "lost" && s.hasLastConfig);
      if (match) return match;
    }
    return snapshot.sessions.find((s) => s.state === "lost" && s.hasLastConfig) || null;
  }

  async function rememberCurrentSession() {
    const sess = api.getSession();
    if (!sess || !sess.name) return;
    const st = api.state || {};
    const cfg = {
      ...hardwareConfigFrom(sess.hardware),
      highMem: /high/i.test(String(sess.shape || "")),
      ...(st.bootstrapConfig ? { bootstrapConfig: st.bootstrapConfig } : {}),
      ...(Array.isArray(st.envVars) && st.envVars.length ? { envVars: st.envVars } : {}),
      ...(st.syncDir ? { syncDir: st.syncDir } : {}),
    };
    const sig = JSON.stringify(cfg);
    if (rememberedSig.get(sess.name) === sig) return;
    rememberedSig.set(sess.name, sig);
    try {
      await api.fetchJson("/api/guard/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sess.name, config: cfg }),
      });
    } catch {}
  }

  async function rebuildSession(guardSess) {
    if (!guardSess || !guardSess.lastConfig || rebuilding) return;
    rebuilding = true;
    renderRail();
    api.showToast(api.tr("guard.rebuilding"));
    try {
      const cfg = guardSess.lastConfig;
      const launchEv = {
        sessionName: guardSess.name,
        config: {
          name: guardSess.name,
          ...(cfg.gpu ? { gpu: cfg.gpu } : {}),
          ...(cfg.tpu ? { tpu: cfg.tpu } : {}),
          ...(cfg.highMem ? { highMem: true } : {}),
          ...(cfg.bootstrapConfig ? { bootstrap: cfg.bootstrapConfig } : {}),
          ...(Array.isArray(cfg.envVars) && cfg.envVars.length ? { envVarNames: cfg.envVars.map((e) => e.key).filter(Boolean) } : {}),
          ...(cfg.syncDir ? { sync: typeof cfg.syncDir === "string" ? { enabled: true, localDir: cfg.syncDir, remoteDir: cfg.remoteSyncDir } : { enabled: true, ...cfg.syncDir } } : {}),
          ...(cfg.startupScript ? { startupScript: { enabled: true, code: cfg.startupScript } } : {}),
        },
        handled: false,
      };
      api.emit("recipes:launch", launchEv);
      if (launchEv.handled) {
        api.showToast(api.tr("guard.rebuildOk"));
        return;
      }

      const newRes = await api.fetchJson("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "new",
          name: guardSess.name,
          ...(cfg.gpu ? { gpu: cfg.gpu } : {}),
          ...(cfg.tpu ? { tpu: cfg.tpu } : {}),
          ...(cfg.highMem ? { highMem: true } : {}),
        }),
      });
      if (!newRes || !newRes.ok) {
        api.showToast(`${api.tr("guard.rebuildFail")}: ${(newRes && newRes.error) || "error"}`);
        return;
      }

      if (cfg.startupScript || (Array.isArray(cfg.envVars) && cfg.envVars.length) || cfg.bootstrapConfig) {
        await api.fetchJson("/api/bootstrap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: guardSess.name,
            envVars: cfg.envVars || [],
            config: { ...(cfg.bootstrapConfig || {}), ...(cfg.startupScript ? { startupScript: cfg.startupScript } : {}) },
          }),
        }).catch(() => {});
      }

      if (cfg.syncDir) {
        const localDir = typeof cfg.syncDir === "string" ? cfg.syncDir : cfg.syncDir.localDir;
        const remoteDir = typeof cfg.syncDir === "string" ? cfg.remoteSyncDir : cfg.syncDir.remoteDir;
        if (localDir) {
          await api.fetchJson("/api/sync/push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: guardSess.name, localDir, remoteDir }),
          }).catch(() => {});
        }
      }

      await api.fetchJson("/api/guard/poll", { method: "POST" }).catch(() => {});
      api.emit("sessions:render-all");
      api.showToast(api.tr("guard.rebuildOk"));
    } catch (err) {
      api.showToast(`${api.tr("guard.rebuildFail")}: ${(err && err.message) || "error"}`);
    } finally {
      rebuilding = false;
      renderRail();
    }
  }

  function renderRail() {
    const sess = api.getSession();
    const gs = sess ? findGuardSession(sess.name) : null;
    const lost = findLostSession();
    const history = Array.isArray(snapshot.cuHistory) ? snapshot.cuHistory : [];
    const cu = snapshot.cu || {};

    // Keep rail clean & lazy when no VM is connected, no lost VM, and no CU data
    if (!sess && !lost && history.length === 0) {
      railEl.hidden = true;
      return;
    }
    railEl.hidden = false;
    railEl.replaceChildren();

    // Header + status badge
    const head = document.createElement("div");
    head.className = "guard-rail-head";
    const title = document.createElement("span");
    title.className = "guard-rail-title";
    title.textContent = api.tr("guard.railTitle");

    const badge = document.createElement("span");
    badge.className = "guard-badge";
    if (gs && gs.state === "reconnecting") {
      badge.classList.add("is-warn");
      badge.textContent = `${api.tr("guard.statusReconnecting")} (${gs.attempts}/${snapshot.settings.maxReconnectAttempts})`;
    } else if ((gs && gs.state === "lost") || (!sess && lost)) {
      badge.classList.add("is-danger");
      badge.textContent = api.tr("guard.statusLost");
    } else if (sess) {
      badge.classList.add("is-ok");
      badge.textContent = api.tr("guard.statusOk");
    } else {
      badge.textContent = api.tr("guard.statusIdle");
    }
    head.append(title, badge);
    railEl.append(head);

    // VM-specific status (only when a session is active)
    if (sess) {
      const hbEnabled = Boolean(gs && gs.config && gs.config.heartbeat);
      const hbRow = document.createElement("div");
      hbRow.className = "guard-kv-row";
      const hbLabel = document.createElement("span");
      hbLabel.className = "guard-kv-label";
      hbLabel.textContent = api.tr("guard.heartbeat");

      const hbToggleWrap = document.createElement("label");
      hbToggleWrap.className = "s-toggle";
      const hbInput = document.createElement("input");
      hbInput.type = "checkbox";
      hbInput.checked = hbEnabled;
      hbInput.addEventListener("change", async () => {
        try {
          await api.fetchJson("/api/guard/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sess.name, heartbeat: hbInput.checked }),
          });
        } catch {}
      });
      const hbTrack = document.createElement("span");
      hbTrack.className = "s-toggle-track";
      hbToggleWrap.append(hbInput, hbTrack);
      hbRow.append(hbLabel, hbToggleWrap);
      railEl.append(hbRow);

      if (gs) {
        const elapsedRow = document.createElement("div");
        elapsedRow.className = "guard-kv-row";
        const elLabel = document.createElement("span");
        elLabel.className = "guard-kv-label";
        elLabel.textContent = api.tr("guard.runtime");
        const elVal = document.createElement("span");
        elVal.className = "guard-kv-val";
        const leftText = gs.remainingMinutes != null ? ` · ${api.tr("guard.remaining")} ${fmtMinutes(gs.remainingMinutes)}` : "";
        elVal.textContent = `${fmtMinutes(gs.elapsedMinutes)}${leftText}`;
        elapsedRow.append(elLabel, elVal);
        railEl.append(elapsedRow);
      }

      const actions = document.createElement("div");
      actions.className = "guard-actions-row";
      const pingBtn = document.createElement("button");
      pingBtn.type = "button";
      pingBtn.className = "guard-btn";
      pingBtn.textContent = gs && gs.heartbeatOk === false ? api.tr("guard.heartbeatFail") : api.tr("guard.pingNow");
      pingBtn.addEventListener("click", async () => {
        pingBtn.disabled = true;
        try {
          await api.fetchJson("/api/guard/heartbeat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sess.name }),
          });
        } catch {}
        pingBtn.disabled = false;
      });
      actions.append(pingBtn);
      railEl.append(actions);
    }

    // One-click rebuild button when a session is lost
    if (lost) {
      const rebuildBtn = document.createElement("button");
      rebuildBtn.type = "button";
      rebuildBtn.className = "guard-btn is-primary";
      rebuildBtn.disabled = rebuilding;
      rebuildBtn.textContent = `${api.tr("guard.rebuild")} (${lost.name})`;
      rebuildBtn.addEventListener("click", () => rebuildSession(lost));
      railEl.append(rebuildBtn);
    }

    // Hourly CU consumption chart
    const cuBox = document.createElement("div");
    cuBox.className = "guard-cu-box";
    const cuHead = document.createElement("div");
    cuHead.className = "guard-cu-head";
    const cuTitle = document.createElement("span");
    cuTitle.textContent = api.tr("guard.cuChartTitle");
    const sampleBtn = document.createElement("button");
    sampleBtn.type = "button";
    sampleBtn.className = "guard-btn";
    sampleBtn.textContent = api.tr("guard.sampleNow");
    sampleBtn.addEventListener("click", async () => {
      sampleBtn.disabled = true;
      try {
        const res = await api.fetchJson("/api/guard/sample-cu", { method: "POST" });
        if (res && res.history) {
          snapshot.cuHistory = res.history;
          snapshot.cu = res.summary || snapshot.cu;
          renderRail();
        }
      } catch {}
      sampleBtn.disabled = false;
    });
    cuHead.append(cuTitle, sampleBtn);
    cuBox.append(cuHead);

    const chartWrap = document.createElement("div");
    if (history.length > 0) {
      chartWrap.innerHTML = renderCuChartSvg(history, snapshot.settings.hourlyCap);
    } else {
      const empty = document.createElement("div");
      empty.className = "guard-cu-empty";
      empty.textContent = api.tr("guard.cuNoData");
      chartWrap.append(empty);
    }
    cuBox.append(chartWrap);

    const meta = document.createElement("div");
    meta.className = "guard-cu-meta";
    const spentText = `${api.tr("guard.cuSpent")}: ${(cu.spent || 0).toFixed(1)}${cu.budgetCap > 0 ? `/${cu.budgetCap}` : ""} CU`;
    const rateText = cu.rate != null ? `${cu.rate}/hr` : "—";
    const s1 = document.createElement("span");
    s1.textContent = spentText;
    const s2 = document.createElement("span");
    s2.textContent = rateText;
    meta.append(s1, s2);
    cuBox.append(meta);
    railEl.append(cuBox);
  }

  function renderSettings() {
    const s = snapshot.settings;
    paneEl.replaceChildren();

    const makeNumRow = (titleKey, descKey, id, val, step = "1", min = "0") => {
      const row = document.createElement("div");
      row.className = "s-row";
      const copy = document.createElement("div");
      copy.className = "s-copy";
      const t = document.createElement("span");
      t.className = "s-title";
      t.textContent = api.tr(titleKey);
      const d = document.createElement("span");
      d.className = "s-desc";
      d.textContent = api.tr(descKey);
      copy.append(t, d);
      const input = document.createElement("input");
      input.type = "number";
      input.className = "guard-num-input";
      input.id = id;
      input.step = step;
      input.min = min;
      input.value = String(val ?? 0);
      row.append(copy, input);
      return { row, input };
    };

    const makeGroup = (titleKey, rows) => {
      const group = document.createElement("div");
      group.className = "s-group";
      const h4 = document.createElement("h4");
      h4.className = "s-group-title";
      h4.textContent = api.tr(titleKey);
      const card = document.createElement("div");
      card.className = "s-card";
      for (const r of rows) card.append(r);
      group.append(h4, card);
      return group;
    };

    const hbInt = makeNumRow("guard.heartbeatInterval", "guard.heartbeatIntervalDesc", "guard-hb-min", s.heartbeatMinutes, "0.5", "0.5");
    const pollSec = makeNumRow("guard.pollInterval", "guard.pollIntervalDesc", "guard-poll-sec", s.pollSeconds, "5", "5");
    const maxRec = makeNumRow("guard.maxReconnect", "guard.maxReconnectDesc", "guard-max-rec", s.maxReconnectAttempts, "1", "0");
    const baseRec = makeNumRow("guard.reconnectBase", "guard.reconnectBaseDesc", "guard-rec-base", s.reconnectBaseSeconds, "1", "1");

    const maxRun = makeNumRow("guard.maxRuntime", "guard.maxRuntimeDesc", "guard-max-run", s.maxRuntimeHours, "0.5", "0");
    const idleMin = makeNumRow("guard.idleTimeout", "guard.idleTimeoutDesc", "guard-idle-min", s.idleTimeoutMinutes, "5", "0");
    const warnMin = makeNumRow("guard.warnBefore", "guard.warnBeforeDesc", "guard-warn-min", s.warnMinutes, "1", "0");

    const cuInt = makeNumRow("guard.cuSampleInterval", "guard.cuSampleIntervalDesc", "guard-cu-min", s.cuSampleMinutes, "1", "1");
    const budCap = makeNumRow("guard.budgetCap", "guard.budgetCapDesc", "guard-budget-cap", s.budgetCap, "1", "0");
    const hrCap = makeNumRow("guard.hourlyCap", "guard.hourlyCapDesc", "guard-hourly-cap", s.hourlyCap, "0.5", "0");

    // Auto-disconnect toggle + explicit confirmation checkbox
    const autoRow = document.createElement("div");
    autoRow.className = "s-row is-column";
    const autoTop = document.createElement("div");
    autoTop.style.display = "flex";
    autoTop.style.justifyContent = "space-between";
    autoTop.style.alignItems = "center";
    autoTop.style.width = "100%";

    const autoCopy = document.createElement("div");
    autoCopy.className = "s-copy";
    const autoT = document.createElement("span");
    autoT.className = "s-title";
    autoT.textContent = api.tr("guard.autoDisconnect");
    const autoD = document.createElement("span");
    autoD.className = "s-desc";
    autoD.textContent = api.tr("guard.autoDisconnectDesc");
    autoCopy.append(autoT, autoD);

    const autoToggle = document.createElement("label");
    autoToggle.className = "s-toggle";
    const autoInput = document.createElement("input");
    autoInput.type = "checkbox";
    autoInput.checked = Boolean(s.autoDisconnect);
    const autoTrack = document.createElement("span");
    autoTrack.className = "s-toggle-track";
    autoToggle.append(autoInput, autoTrack);
    autoTop.append(autoCopy, autoToggle);

    const confirmWrap = document.createElement("label");
    confirmWrap.className = "guard-confirm-row";
    confirmWrap.hidden = !autoInput.checked;
    const confirmInput = document.createElement("input");
    confirmInput.type = "checkbox";
    confirmInput.checked = Boolean(s.autoDisconnectConfirmed);
    const confirmText = document.createElement("span");
    confirmText.textContent = api.tr("guard.autoDisconnectConfirm");
    confirmWrap.append(confirmInput, confirmText);

    autoInput.addEventListener("change", () => {
      confirmWrap.hidden = !autoInput.checked;
      if (!autoInput.checked) confirmInput.checked = false;
    });
    autoRow.append(autoTop, confirmWrap);

    const saveBar = document.createElement("div");
    saveBar.className = "guard-save-bar";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "guard-btn is-primary";
    saveBtn.textContent = api.tr("guard.save");
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const res = await api.fetchJson("/api/guard/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            heartbeatMinutes: Number(hbInt.input.value),
            pollSeconds: Number(pollSec.input.value),
            maxReconnectAttempts: Number(maxRec.input.value),
            reconnectBaseSeconds: Number(baseRec.input.value),
            maxRuntimeHours: Number(maxRun.input.value),
            idleTimeoutMinutes: Number(idleMin.input.value),
            warnMinutes: Number(warnMin.input.value),
            cuSampleMinutes: Number(cuInt.input.value),
            budgetCap: Number(budCap.input.value),
            hourlyCap: Number(hrCap.input.value),
            autoDisconnect: autoInput.checked,
            autoDisconnectConfirmed: autoInput.checked && confirmInput.checked,
          }),
        });
        if (res && res.settings) snapshot.settings = res.settings;
        api.showToast(api.tr("guard.saved"));
        renderRail();
      } catch {}
      saveBtn.disabled = false;
    });
    saveBar.append(saveBtn);

    paneEl.append(
      makeGroup("guard.sectionKeepalive", [hbInt.row, pollSec.row, maxRec.row, baseRec.row]),
      makeGroup("guard.sectionRecycle", [maxRun.row, idleMin.row, warnMin.row]),
      makeGroup("guard.sectionBudget", [cuInt.row, budCap.row, hrCap.row, autoRow]),
      saveBar,
    );
  }

  // ---- Palette Commands ----
  api.registerCommand({
    id: "guard.toggleHeartbeat",
    title: () => api.tr("guard.cmdToggleHb"),
    run: async () => {
      const sess = api.getSession();
      if (!sess) return;
      const gs = findGuardSession(sess.name);
      const next = !(gs && gs.config && gs.config.heartbeat);
      await api.fetchJson("/api/guard/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sess.name, heartbeat: next }),
      }).catch(() => {});
    },
  });

  api.registerCommand({
    id: "guard.sampleCu",
    title: () => api.tr("guard.cmdSampleCu"),
    run: async () => {
      const res = await api.fetchJson("/api/guard/sample-cu", { method: "POST" }).catch(() => null);
      if (res && res.history) {
        snapshot.cuHistory = res.history;
        snapshot.cu = res.summary || snapshot.cu;
        renderRail();
      }
    },
  });

  api.registerCommand({
    id: "guard.rebuild",
    title: () => api.tr("guard.cmdRebuild"),
    run: async () => {
      const lost = findLostSession();
      if (lost) await rebuildSession(lost);
    },
  });

  // ---- Server & App Events ----
  api.onServerEvent("guard:state", (next) => {
    if (!next || typeof next !== "object") return;
    snapshot = { ...snapshot, ...next };
    renderRail();
    renderSettings();
  });

  api.onServerEvent("guard:notify", (payload) => {
    if (!payload) return;
    api.notifyNative({ title: payload.title || "Colab Desk", body: payload.body || "" });
    if (payload.body) api.showToast(payload.body);
  });

  api.on("sessions:render-all", () => {
    rememberCurrentSession();
    renderRail();
  });
  api.on("sessions:render-inspector", () => {
    rememberCurrentSession();
    renderRail();
  });
  api.on("guard:check", ({ session }) => {
    if (session && session.name) {
      api.fetchJson("/api/guard/activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: session.name }),
      }).catch(() => {});
    }
    renderRail();
  });
  api.on("language:changed", () => {
    renderRail();
    renderSettings();
  });

  // Initial lazy hydrate
  renderSettings();
  try {
    const initial = await api.fetchJson("/api/guard/state");
    if (initial && initial.ok) {
      snapshot = { ...snapshot, ...initial };
      renderRail();
      renderSettings();
    }
  } catch {}
}

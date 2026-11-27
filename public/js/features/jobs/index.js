import { JOBS_STRINGS } from "./strings.js";
import { createJobModals, fmtSec } from "./ui-modals.js";
import { createJobsSettingsPane } from "./ui-settings.js";

function playChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    setTimeout(() => ctx.close?.(), 500);
  } catch {}
}

export async function init(api) {
  api.registerStrings(JOBS_STRINGS);

  const jobsById = new Map();
  let tickTimer = null;

  async function submitJob(payload) {
    const session = payload?.session || api.getSession()?.name || "";
    if (!session) {
      api.showToast(api.tr("jobs.toastNoSession"));
      return { ok: false, error: api.tr("jobs.toastNoSession") };
    }
    const res = await api.fetchJson("/api/jobs/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        language: payload.language || "python",
        code: payload.code || "",
        title: payload.title || "",
      }),
    });
    if (res?.ok && res.job) {
      jobsById.set(res.job.id, res.job);
      renderRail();
      api.showToast(`${api.tr("jobs.toastSubmitted")}: ${res.job.title}`);
    } else if (res?.error) {
      api.showToast(res.error);
    }
    return res;
  }

  async function cancelJob(id) {
    const res = await api.fetchJson(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    if (res?.ok && res.job) {
      jobsById.set(res.job.id, res.job);
      renderRail();
      api.showToast(api.tr("jobs.toastCancelled"));
    }
    return res;
  }

  async function rerunJob(id) {
    const res = await api.fetchJson(`/api/jobs/${encodeURIComponent(id)}/rerun`, { method: "POST" });
    if (res?.ok && res.job) {
      jobsById.set(res.job.id, res.job);
      renderRail();
      api.showToast(api.tr("jobs.toastRerun"));
    }
    return res;
  }

  async function clearFinished() {
    const res = await api.fetchJson("/api/jobs/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res?.ok) {
      jobsById.clear();
      for (const j of res.jobs || []) jobsById.set(j.id, j);
      renderRail();
      api.showToast(api.tr("jobs.toastCleared"));
    }
  }

  const modals = createJobModals(api, {
    onSubmit: submitJob,
    onCancel: cancelJob,
    onRerun: rerunJob,
    getJobById: (id) => jobsById.get(id),
  });

  // Rail Section
  const railEl = document.createElement("div");
  railEl.id = "jobs-rail-section";
  railEl.className = "inspector-section jobs-rail-section";
  railEl.hidden = true;

  const head = document.createElement("div");
  head.className = "jobs-rail-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "jobs-rail-title-wrap";
  const titleEl = document.createElement("span");
  titleEl.className = "section-label jobs-rail-title";
  const countEl = document.createElement("span");
  countEl.className = "jobs-count-badge";
  countEl.hidden = true;
  titleWrap.append(titleEl, countEl);

  const headBtns = document.createElement("div");
  headBtns.className = "jobs-rail-actions";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "meter-refresh jobs-new-btn";
  newBtn.addEventListener("click", () => modals.openSubmitModal());
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "meter-refresh jobs-clear-btn";
  clearBtn.addEventListener("click", () => clearFinished());
  headBtns.append(newBtn, clearBtn);
  head.append(titleWrap, headBtns);

  const listEl = document.createElement("div");
  listEl.className = "jobs-list";

  railEl.append(head, listEl);
  api.mount("rail", railEl);

  function syncTicker(hasRunning) {
    if (hasRunning && !tickTimer) {
      tickTimer = setInterval(() => {
        for (const el of listEl.querySelectorAll("[data-job-elapsed]")) {
          const startedAt = Number(el.dataset.jobElapsed);
          if (Number.isFinite(startedAt)) {
            el.textContent = fmtSec((Date.now() - startedAt) / 1000);
          }
        }
      }, 1000);
    } else if (!hasRunning && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function renderRail() {
    const sess = api.getSession();
    const all = [...jobsById.values()].sort((a, b) => b.startedAt - a.startedAt);
    const visible = sess ? all.filter((j) => j.session === sess.name) : all;
    const runningCount = visible.filter((j) => j.status === "running").length;
    const finishedCount = visible.filter((j) => j.status !== "running").length;

    railEl.hidden = !sess && visible.length === 0;
    titleEl.textContent = api.tr("jobs.railTitle");
    newBtn.textContent = api.tr("jobs.newJob");
    newBtn.disabled = !sess;
    clearBtn.textContent = api.tr("jobs.clearDone");
    clearBtn.hidden = finishedCount === 0;

    countEl.textContent = String(runningCount);
    countEl.hidden = runningCount === 0;

    listEl.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jobs-empty";
      empty.textContent = api.tr("jobs.empty");
      listEl.append(empty);
    } else {
      for (const job of visible) {
        listEl.append(renderJobCard(job));
      }
    }
    syncTicker(runningCount > 0);
  }

  function renderJobCard(job) {
    const card = document.createElement("div");
    card.className = `jobs-card is-${job.status}`;
    card.dataset.jobId = job.id;

    const top = document.createElement("div");
    top.className = "jobs-card-top";
    const name = document.createElement("span");
    name.className = "jobs-card-title";
    name.textContent = job.title;
    name.title = job.title;

    const chip = document.createElement("span");
    chip.className = `jobs-chip is-${job.status}`;
    chip.textContent = api.tr(`jobs.status.${job.status}`) || job.status;
    top.append(name, chip);
    card.append(top);

    const pct = job.progress?.percent;
    if (pct != null || job.status === "running") {
      const bar = document.createElement("div");
      bar.className = "jobs-bar-track";
      const fill = document.createElement("div");
      fill.className = `jobs-bar-fill${pct == null ? " is-indeterminate" : ""}`;
      if (pct != null) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      bar.append(fill);
      card.append(bar);
    }

    const meta = document.createElement("div");
    meta.className = "jobs-card-meta";
    const elapsedSpan = document.createElement("span");
    if (job.status === "running") {
      elapsedSpan.dataset.jobElapsed = String(job.startedAt);
      elapsedSpan.textContent = fmtSec((Date.now() - job.startedAt) / 1000);
    } else {
      elapsedSpan.textContent = fmtSec(((job.endedAt || job.startedAt) - job.startedAt) / 1000);
    }
    meta.append(elapsedSpan);

    if (pct != null) {
      const pctSpan = document.createElement("span");
      pctSpan.textContent = job.progress.label && job.progress.label !== "tqdm" ? `${job.progress.label} (${pct}%)` : `${pct}%`;
      meta.append(pctSpan);
    }
    if (job.progress?.etaSec != null && job.status === "running") {
      const etaSpan = document.createElement("span");
      etaSpan.textContent = `${api.tr("jobs.eta")} ${fmtSec(job.progress.etaSec)}`;
      meta.append(etaSpan);
    } else if (job.progress?.rate && job.status === "running") {
      const rateSpan = document.createElement("span");
      rateSpan.textContent = job.progress.rate;
      meta.append(rateSpan);
    }
    card.append(meta);

    const acts = document.createElement("div");
    acts.className = "jobs-card-actions";

    const logBtn = document.createElement("button");
    logBtn.type = "button";
    logBtn.className = "jobs-mini-btn";
    logBtn.textContent = api.tr("jobs.action.log");
    logBtn.addEventListener("click", () => modals.openLogModal(job.id));
    acts.append(logBtn);

    if (job.status === "running") {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "jobs-mini-btn is-danger";
      cancelBtn.textContent = api.tr("jobs.action.cancel");
      cancelBtn.addEventListener("click", () => cancelJob(job.id));
      acts.append(cancelBtn);
    } else {
      const rerunBtn = document.createElement("button");
      rerunBtn.type = "button";
      rerunBtn.className = "jobs-mini-btn";
      rerunBtn.textContent = api.tr("jobs.action.rerun");
      rerunBtn.addEventListener("click", () => rerunJob(job.id));
      acts.append(rerunBtn);
    }
    card.append(acts);

    return card;
  }

  // Settings tab: Notifications & Webhooks
  const settingsPane = createJobsSettingsPane(api);
  api.mount("settings-pane", {
    id: "jobs-notifications",
    title: "jobs.settingsTab",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    element: settingsPane.element,
  });
  api.on("settings:mounted", () => settingsPane.ensureLoaded());
  settingsPane.ensureLoaded();

  // Command palette: Run as background job
  api.registerCommand({
    id: "jobs.runBackground",
    title: () => api.tr("jobs.cmdRunBg"),
    run: () => modals.openSubmitModal(),
  });

  // Cross-feature action hook: emit('jobs:submit', { session, language, code, title })
  api.on("jobs:submit", (payload) => {
    if (!payload) return;
    if (!payload.code) {
      modals.openSubmitModal(payload);
      return;
    }
    submitJob(payload).catch(() => {});
  });

  // React to session or language changes
  api.on("session:changed", () => renderRail());
  api.on("sessions:updated", () => renderRail());
  api.on("language:changed", () => {
    renderRail();
    settingsPane.refreshLabels();
  });

  // Live SSE updates from backend
  api.onServerEvent("jobs:update", (job) => {
    if (!job || !job.id) return;
    jobsById.set(job.id, job);
    renderRail();
    modals.onJobUpdated(job);
  });

  api.onServerEvent("jobs:notify", (ev) => {
    if (!ev) return;
    const title = ev.status === "succeeded" ? api.tr("jobs.notifySucceeded") : api.tr("jobs.notifyFailed");
    const body = `${ev.job || ""} (${ev.duration || "0s"}) · ${ev.session || ""}`.trim();
    api.showToast(`${title}: ${ev.job || ""}`);
    if (ev.native !== false) {
      api.notifyNative({ title, body });
    }
    if (ev.sound) {
      playChime();
    }
  });

  api.onServerEvent("jobs:webhook-error", (ev) => {
    if (!ev) return;
    api.showToast(`${api.tr("jobs.webhookErr")} (${ev.name || ev.id}): ${ev.error || ""}`);
  });

  // Initial lazy load of persisted jobs
  try {
    const res = await api.fetchJson("/api/jobs");
    if (res?.ok && Array.isArray(res.jobs)) {
      for (const j of res.jobs) jobsById.set(j.id, j);
    }
  } catch {}
  renderRail();
}

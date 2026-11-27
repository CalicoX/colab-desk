// Frontend feature plugin: GPU sniping priority queue + session recipes.
import { RECIPES_STRINGS } from "./strings.js";
import { accelToTarget, createRecipesModal, formatTargetLabel } from "./modal.js";

export async function init(api) {
  api.registerStrings(RECIPES_STRINGS);

  let recipes = [];
  let snipeJobs = [];
  let modalWired = false;
  let modalTargets = [];
  let selectedRecipeId = "";

  const modal = createRecipesModal(api, {
    onRefresh: refreshRecipes,
    onLaunch: launchFromRecipe,
  });

  // ── Data Fetching ──
  async function refreshRecipes() {
    try {
      const res = await api.fetchJson("/api/recipes");
      if (res?.ok && Array.isArray(res.recipes)) {
        recipes = res.recipes;
        modal.setRecipes(recipes);
        renderRail();
        populateNewSessionRecipePicker();
      }
    } catch {}
  }

  async function refreshSnipeJobs() {
    try {
      const res = await api.fetchJson("/api/recipes/snipe");
      if (res?.ok && Array.isArray(res.jobs)) {
        snipeJobs = res.jobs;
        syncBannerJob();
        renderRail();
      }
    } catch {}
  }

  function syncBannerJob() {
    const active = snipeJobs.find((j) => j.status === "running" || j.status === "paused") || null;
    api.state.activeSnipeJob = active;
    api.emit("session-create:render-banner");
  }

  function upsertSnipeJob(job) {
    if (!job || !job.id) return;
    const idx = snipeJobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) snipeJobs[idx] = job;
    else snipeJobs.unshift(job);
    syncBannerJob();
    renderRail();
  }

  // ── Launch & Snipe Actions ──
  async function launchFromRecipe(payload = {}) {
    api.showToast(api.tr("recipes.launchStarted"));
    try {
      const res = await api.fetchJson("/api/recipes/launch", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res?.ok) {
        api.showToast(`${api.tr("recipes.launchFailed")}: ${res?.error || ""}`);
        return res;
      }
      if (res.mode === "snipe" && res.job) {
        upsertSnipeJob(res.job);
        api.showToast(api.tr("recipes.snipeStartedToast"));
      }
      return res;
    } catch (err) {
      api.showToast(`${api.tr("recipes.launchFailed")}: ${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function startSnipeJob(spec) {
    try {
      const res = await api.fetchJson("/api/recipes/snipe", {
        method: "POST",
        body: JSON.stringify(spec),
      });
      if (res?.ok && res.job) {
        upsertSnipeJob(res.job);
        api.showToast(api.tr("recipes.snipeStartedToast"));
      } else {
        api.showToast(res?.error || api.tr("recipes.launchFailed"));
      }
    } catch (err) {
      api.showToast(err?.message || api.tr("recipes.launchFailed"));
    }
  }

  async function runSnipeAction(id, action) {
    try {
      if (action === "remove") {
        const res = await api.fetchJson(`/api/recipes/snipe/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (res?.ok) {
          snipeJobs = snipeJobs.filter((j) => j.id !== id);
          syncBannerJob();
          renderRail();
        }
        return;
      }
      const res = await api.fetchJson(`/api/recipes/snipe/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res?.ok && res.job) upsertSnipeJob(res.job);
    } catch {}
  }

  // ── Rail Mount ──
  const railEl = document.createElement("section");
  railEl.className = "recipes-rail-section";
  railEl.id = "recipes-rail-section";
  api.mount("rail", railEl);

  function statusLabel(status) {
    const map = {
      running: "recipes.statusRunning",
      paused: "recipes.statusPaused",
      succeeded: "recipes.statusSucceeded",
      failed: "recipes.statusFailed",
      cancelled: "recipes.statusCancelled",
      timeout: "recipes.statusTimeout",
    };
    return api.tr(map[status] || "recipes.statusRunning");
  }

  function renderRail() {
    railEl.innerHTML = "";
    const head = document.createElement("div");
    head.className = "recipes-rail-head";
    const title = document.createElement("span");
    title.className = "recipes-rail-title";
    title.textContent = api.tr("recipes.railTitle");
    const manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.className = "recipe-mini-btn";
    manageBtn.textContent = api.tr("recipes.railManage");
    manageBtn.addEventListener("click", () => modal.open());
    head.append(title, manageBtn);
    railEl.appendChild(head);

    // Active & recent snipe jobs
    for (const job of snipeJobs.slice(0, 4)) {
      const card = document.createElement("div");
      card.className = `recipes-snipe-card${job.status === "running" ? " is-running" : ""}`;

      const top = document.createElement("div");
      top.className = "recipes-snipe-top";
      const name = document.createElement("span");
      name.className = "recipes-snipe-name";
      name.textContent = job.name;
      const chip = document.createElement("span");
      chip.className = `recipes-status-chip is-${job.status}`;
      chip.textContent = statusLabel(job.status);
      top.append(name, chip);
      card.appendChild(top);

      const tList = document.createElement("div");
      tList.className = "recipes-snipe-targets";
      for (const t of job.targets || []) {
        const row = document.createElement("div");
        row.className = `recipes-snipe-target${t.active ? " is-active" : ""}${t.disabled ? " is-disabled" : ""}`;
        const lbl = document.createElement("span");
        lbl.textContent = `${t.active ? "● " : ""}${t.label}`;
        const att = document.createElement("span");
        att.textContent = `${t.attempts} ${api.tr("recipes.attempts")}`;
        row.append(lbl, att);
        tList.appendChild(row);
        if (t.lastError) {
          const errEl = document.createElement("div");
          errEl.className = "recipes-snipe-err";
          errEl.title = t.lastError;
          errEl.textContent = t.lastError;
          tList.appendChild(errEl);
        }
      }
      card.appendChild(tList);

      if (job.pipeline && Array.isArray(job.pipeline.steps) && job.pipeline.steps.length) {
        const pipeEl = document.createElement("div");
        pipeEl.className = "recipes-snipe-target";
        const hasErr = job.pipeline.steps.some((s) => s.status === "error");
        const running = job.pipeline.steps.some((s) => s.status === "running");
        pipeEl.textContent = running
          ? api.tr("recipes.pipelineRunning")
          : (hasErr ? api.tr("recipes.pipelineError") : api.tr("recipes.pipelineDone"));
        card.appendChild(pipeEl);
      }

      const actions = document.createElement("div");
      actions.className = "recipes-snipe-actions";
      if (job.status === "running") {
        actions.append(
          miniBtn(api.tr("recipes.pause"), () => runSnipeAction(job.id, "pause")),
          miniBtn(api.tr("recipes.cancel"), () => runSnipeAction(job.id, "cancel"), "is-danger"),
        );
      } else if (job.status === "paused") {
        actions.append(
          miniBtn(api.tr("recipes.resume"), () => runSnipeAction(job.id, "resume"), "is-primary"),
          miniBtn(api.tr("recipes.cancel"), () => runSnipeAction(job.id, "cancel"), "is-danger"),
        );
      } else {
        actions.append(
          miniBtn(api.tr("recipes.dismiss"), () => runSnipeAction(job.id, "remove")),
        );
      }
      card.appendChild(actions);
      railEl.appendChild(card);
    }

    // Quick-launch recipes
    if (recipes.length) {
      const qList = document.createElement("div");
      qList.className = "recipes-quick-list";
      for (const r of recipes.slice(0, 4)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "recipes-quick-item";
        const rName = document.createElement("span");
        rName.textContent = r.name;
        const rHw = document.createElement("span");
        rHw.className = "recipes-quick-hw";
        rHw.textContent = r.snipe?.targets?.length > 1
          ? r.snipe.targets.map((t) => t.gpu || t.tpu || "CPU").join(">")
          : formatTargetLabel(r.hardware);
        btn.append(rName, rHw);
        btn.addEventListener("click", () => launchFromRecipe({ recipeId: r.id }));
        qList.appendChild(btn);
      }
      railEl.appendChild(qList);
    } else if (!snipeJobs.length) {
      const empty = document.createElement("p");
      empty.className = "snipe-target-empty";
      empty.textContent = api.tr("recipes.railEmpty");
      railEl.appendChild(empty);
    }
  }

  // ── Workspace Tools Mount ──
  const toolBtn = document.createElement("button");
  toolBtn.type = "button";
  toolBtn.className = "tools-menu-item";
  toolBtn.id = "recipes-tool-btn";
  toolBtn.textContent = api.tr("recipes.toolLabel");
  toolBtn.addEventListener("click", () => modal.open());
  api.mount("workspace-tools", toolBtn);

  // ── ⌘K Palette Commands ──
  api.registerCommand({
    id: "recipes:manage",
    title: api.tr("recipes.cmdManage"),
    run: () => modal.open(),
  });
  api.registerCommand({
    id: "recipes:new-from-recipe",
    title: api.tr("recipes.cmdNewFromRecipe"),
    run: () => modal.open(),
  });
  api.registerCommand({
    id: "recipes:save-current",
    title: api.tr("recipes.cmdSaveCurrent"),
    run: () => openSaveCurrentDraft(),
  });

  function openSaveCurrentDraft() {
    const sess = api.getSession();
    const gpu = sess?.hardware && ["T4", "L4", "G4", "H100", "A100"].includes(sess.hardware) ? sess.hardware : null;
    const tpu = sess?.hardware && ["v5e1", "v6e1"].includes(sess.hardware) ? sess.hardware : null;
    const hw = { gpu, tpu, highMem: Boolean(api.state.defaultHighMem) && !tpu && gpu !== "L4" };
    modal.open({
      draft: {
        id: null,
        name: sess ? `${sess.name} Recipe` : "New Recipe",
        description: "",
        sessionNamePrefix: sess?.name || "train",
        hardware: hw,
        snipe: { enabled: false, targets: [hw], intervalSec: 10, maxIntervalSec: 120, maxAttempts: 0, timeoutSec: 0 },
        bootstrap: { ...(api.state.bootstrapConfig || {}) },
        envVarNames: (api.state.envVars || []).map((v) => v?.key).filter(Boolean),
        sync: {
          enabled: Boolean(api.state.syncConfig?.localDir),
          localDir: api.state.syncConfig?.localDir || "",
          remoteDir: api.state.syncConfig?.remoteDir || "/content/project",
        },
        startupScript: { enabled: false, title: "", runtime: "python", code: "", params: {}, background: false },
      },
    });
  }

  // ── New-Session Modal Integration (Recipe Picker + Priority Queue) ──
  function syncModalQueueState() {
    const intervalSec = Math.max(5, Number(document.querySelector("#snipe-interval-sec")?.value) || 10);
    const maxAttempts = Math.max(0, Number(document.querySelector("#snipe-max-attempts")?.value) || 0);
    const timeoutMin = Math.max(0, Number(document.querySelector("#snipe-timeout-min")?.value) || 0);
    api.state.snipeQueueConfig = {
      recipeId: selectedRecipeId || null,
      targets: modalTargets.map((t) => ({ ...t })),
      intervalSec,
      maxAttempts,
      timeoutSec: timeoutMin * 60,
    };
    const badge = document.querySelector("#snipe-queue-badge");
    if (badge) {
      badge.hidden = modalTargets.length === 0;
      badge.textContent = String(modalTargets.length);
    }
  }

  function renderModalTargetList() {
    const list = document.querySelector("#snipe-target-list");
    if (!list) return;
    list.innerHTML = "";
    if (!modalTargets.length) {
      const p = document.createElement("p");
      p.className = "snipe-target-empty";
      p.textContent = api.tr("recipes.emptyQueue");
      list.appendChild(p);
    } else {
      modalTargets.forEach((t, idx) => {
        const row = document.createElement("div");
        row.className = "snipe-target-row";
        row.setAttribute("role", "listitem");
        const rank = document.createElement("span");
        rank.className = "snipe-target-rank";
        rank.textContent = `${idx + 1}.`;
        const lbl = document.createElement("span");
        lbl.className = "snipe-target-label";
        lbl.textContent = formatTargetLabel(t);
        const btns = document.createElement("div");
        btns.className = "snipe-target-btns";
        btns.append(
          miniBtn("↑", () => {
            if (idx > 0) {
              [modalTargets[idx - 1], modalTargets[idx]] = [modalTargets[idx], modalTargets[idx - 1]];
              renderModalTargetList();
            }
          }, "", idx === 0),
          miniBtn("↓", () => {
            if (idx < modalTargets.length - 1) {
              [modalTargets[idx], modalTargets[idx + 1]] = [modalTargets[idx + 1], modalTargets[idx]];
              renderModalTargetList();
            }
          }, "", idx === modalTargets.length - 1),
          miniBtn("×", () => {
            modalTargets.splice(idx, 1);
            renderModalTargetList();
          }, "is-danger"),
        );
        row.append(rank, lbl, btns);
        list.appendChild(row);
      });
    }
    syncModalQueueState();
  }

  function populateNewSessionRecipePicker() {
    const sel = document.querySelector("#recipe-picker-select");
    if (!sel) return;
    const prev = selectedRecipeId;
    sel.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = api.tr("recipes.noneSelected");
    sel.appendChild(noneOpt);
    for (const r of recipes) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `${r.name} (${formatTargetLabel(r.hardware)})`;
      if (r.id === prev) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function applyRecipeToNewSessionModal(recipe) {
    const summaryEl = document.querySelector("#recipe-picker-summary");
    if (!recipe) {
      selectedRecipeId = "";
      if (summaryEl) {
        summaryEl.hidden = true;
        summaryEl.textContent = "";
      }
      modalTargets = [];
      renderModalTargetList();
      return;
    }
    selectedRecipeId = recipe.id;
    const nameInput = document.querySelector("#session-name");
    if (nameInput && !nameInput.value.trim() && recipe.sessionNamePrefix) {
      nameInput.value = `${recipe.sessionNamePrefix}-${Date.now().toString(36).slice(-4)}`;
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const hwVal = recipe.hardware?.gpu || recipe.hardware?.tpu || "cpu";
    const radio = document.querySelector(`input[name="hardware"][value="${hwVal}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const hmCb = document.querySelector("#high-mem");
    if (hmCb) {
      hmCb.checked = Boolean(recipe.hardware?.highMem);
      hmCb.dispatchEvent(new Event("change", { bubbles: true }));
    }
    modalTargets = (recipe.snipe?.targets || []).map((t) => ({ ...t }));
    const intEl = document.querySelector("#snipe-interval-sec");
    const maxEl = document.querySelector("#snipe-max-attempts");
    const toEl = document.querySelector("#snipe-timeout-min");
    if (intEl) intEl.value = String(recipe.snipe?.intervalSec || 10);
    if (maxEl) maxEl.value = String(recipe.snipe?.maxAttempts || 0);
    if (toEl) toEl.value = String(Math.round((recipe.snipe?.timeoutSec || 0) / 60));
    const sec = document.querySelector("#snipe-queue-section");
    if (sec && modalTargets.length > 1) sec.open = true;

    if (summaryEl) {
      const tags = [];
      if (recipe.envVarNames?.length) tags.push(`Env: ${recipe.envVarNames.join(", ")}`);
      if (recipe.sync?.enabled && recipe.sync?.localDir) tags.push(`Sync: ${recipe.sync.localDir}`);
      if (recipe.startupScript?.enabled) tags.push(`Script: ${recipe.startupScript.title || recipe.startupScript.runtime}`);
      summaryEl.textContent = tags.join(" · ") || recipe.description || "";
      summaryEl.hidden = !summaryEl.textContent;
    }
    renderModalTargetList();
  }

  function wireNewSessionModal() {
    if (modalWired) return;
    const picker = document.querySelector("#recipe-picker-select");
    if (!picker) return;
    modalWired = true;

    picker.addEventListener("change", () => {
      const found = recipes.find((r) => r.id === picker.value) || null;
      applyRecipeToNewSessionModal(found);
    });

    document.querySelector("#manage-recipes-btn")?.addEventListener("click", () => {
      modal.open({ recipeId: selectedRecipeId || undefined });
    });

    document.querySelector("#save-as-recipe-btn")?.addEventListener("click", () => {
      const nameVal = document.querySelector("#session-name")?.value.trim() || "";
      const hwRadio = document.querySelector('input[name="hardware"]:checked');
      const hwVal = hwRadio ? hwRadio.value : "cpu";
      const hm = Boolean(document.querySelector("#high-mem")?.checked);
      const hw = accelToTarget(hwVal, hm);
      syncModalQueueState();
      const q = api.state.snipeQueueConfig || {};
      modal.open({
        draft: {
          id: null,
          name: nameVal ? `${nameVal} Recipe` : "New Recipe",
          description: "",
          sessionNamePrefix: nameVal || "train",
          hardware: hw,
          snipe: {
            enabled: modalTargets.length > 1,
            targets: modalTargets.length ? modalTargets.map((t) => ({ ...t })) : [hw],
            intervalSec: q.intervalSec || 10,
            maxIntervalSec: 120,
            maxAttempts: q.maxAttempts || 0,
            timeoutSec: q.timeoutSec || 0,
          },
          bootstrap: { ...(api.state.bootstrapConfig || {}) },
          envVarNames: (api.state.envVars || []).map((v) => v?.key).filter(Boolean),
          sync: {
            enabled: Boolean(api.state.syncConfig?.localDir),
            localDir: api.state.syncConfig?.localDir || "",
            remoteDir: api.state.syncConfig?.remoteDir || "/content/project",
          },
          startupScript: { enabled: false, title: "", runtime: "python", code: "", params: {}, background: false },
        },
      });
    });

    document.querySelector("#snipe-add-target-btn")?.addEventListener("click", () => {
      const hwSel = document.querySelector("#snipe-add-hw");
      const hmCb = document.querySelector("#snipe-add-highmem");
      const target = accelToTarget(hwSel?.value || "A100", Boolean(hmCb?.checked));
      modalTargets.push(target);
      renderModalTargetList();
    });

    for (const sel of ["#snipe-interval-sec", "#snipe-max-attempts", "#snipe-timeout-min"]) {
      document.querySelector(sel)?.addEventListener("input", syncModalQueueState);
    }

    populateNewSessionRecipePicker();
    renderModalTargetList();
  }

  // ── Event Bus & SSE Subscriptions ──
  api.on("session-create:modal-mounted", wireNewSessionModal);
  api.on("session-create:modal-opened", () => {
    wireNewSessionModal();
    populateNewSessionRecipePicker();
    renderModalTargetList();
  });
  api.on("recipes:launch", (payload) => {
    if (payload && typeof payload === "object") payload.handled = true;
    return launchFromRecipe(payload);
  });
  api.on("recipes:start-snipe", (spec) => startSnipeJob(spec));
  api.on("recipes:snipe-action", ({ id, action }) => runSnipeAction(id, action));
  api.on("recipes:post-acquire", async ({ session, recipeId, recipe }) => {
    try {
      await api.fetchJson("/api/recipes/pipeline", {
        method: "POST",
        body: JSON.stringify({ session, recipeId, recipe }),
      });
    } catch {}
  });
  api.on("language:changed", () => {
    toolBtn.textContent = api.tr("recipes.toolLabel");
    renderRail();
    populateNewSessionRecipePicker();
    renderModalTargetList();
    modal.render();
  });

  api.onServerEvent("recipes:snipe", (snap) => upsertSnipeJob(snap));
  api.onServerEvent("recipes:acquired", async (ev) => {
    const body = `${ev.session} (${ev.label}) · ${ev.elapsedSec || 0}s`;
    api.notifyNative({ title: api.tr("recipes.acquiredTitle"), body });
    api.showToast(`${api.tr("recipes.acquiredTitle")} ${body}`);
    try {
      const listed = await api.fetchJson("/api/sessions");
      if (listed?.ok && listed.state?.sessions) {
        api.state.sessions = listed.state.sessions;
        api.emit("sessions:refresh");
      }
    } catch {}
  });
  api.onServerEvent("recipes:submit-job", (jobPayload) => {
    api.emit("jobs:submit", jobPayload);
  });
  api.onServerEvent("recipes:pipeline-done", (res) => {
    if (res?.ok) api.showToast(api.tr("recipes.pipelineDone"));
    else api.showToast(api.tr("recipes.pipelineError"));
  });

  // Initial lazy hydrate
  renderRail();
  wireNewSessionModal();
  refreshRecipes();
  refreshSnipeJobs();
}

function miniBtn(label, onClick, extraClass = "", disabled = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `recipe-mini-btn${extraClass ? ` ${extraClass}` : ""}`;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

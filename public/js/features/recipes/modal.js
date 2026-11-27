// Lazy-created Session Recipes Manager modal (CRUD, duplicate, import/export, launch).
const ACCEL_OPTIONS = [
  { value: "A100", label: "A100", gpu: "A100", tpu: null },
  { value: "H100", label: "H100", gpu: "H100", tpu: null },
  { value: "L4", label: "L4", gpu: "L4", tpu: null },
  { value: "G4", label: "G4", gpu: "G4", tpu: null },
  { value: "T4", label: "T4", gpu: "T4", tpu: null },
  { value: "v6e1", label: "v6e1 (TPU)", gpu: null, tpu: "v6e1" },
  { value: "v5e1", label: "v5e1 (TPU)", gpu: null, tpu: "v5e1" },
  { value: "cpu", label: "CPU", gpu: null, tpu: null },
];
const SINGLE_SHAPE = new Set(["L4", "v5e1", "v6e1"]);

export function accelToTarget(val, highMem) {
  const found = ACCEL_OPTIONS.find((o) => o.value === val) || ACCEL_OPTIONS[ACCEL_OPTIONS.length - 1];
  return { gpu: found.gpu, tpu: found.tpu, highMem: Boolean(highMem) && !SINGLE_SHAPE.has(val) };
}

export function formatTargetLabel(t) {
  if (!t) return "CPU";
  return (t.gpu || t.tpu || "CPU") + (t.highMem ? " + high-mem" : "");
}

function emptyDraft(state) {
  const bc = state?.bootstrapConfig || {};
  const sc = state?.syncConfig || {};
  return {
    id: null,
    name: "",
    description: "",
    sessionNamePrefix: "train",
    hardware: { gpu: "A100", tpu: null, highMem: true },
    snipe: {
      enabled: true,
      targets: [
        { gpu: "A100", tpu: null, highMem: true },
        { gpu: "L4", tpu: null, highMem: false },
        { gpu: "T4", tpu: null, highMem: true },
      ],
      intervalSec: 10,
      maxIntervalSec: 120,
      maxAttempts: 0,
      timeoutSec: 0,
    },
    bootstrap: {
      autoMountDrive: Boolean(bc.autoMountDrive),
      enableHfTransfer: bc.enableHfTransfer !== undefined ? Boolean(bc.enableHfTransfer) : true,
      hfCacheToDrive: Boolean(bc.hfCacheToDrive),
      autoInstallUv: Boolean(bc.autoInstallUv),
      autoInjectEnv: bc.autoInjectEnv !== undefined ? Boolean(bc.autoInjectEnv) : true,
      customScript: bc.customScript || "",
    },
    envVarNames: (state?.envVars || []).map((v) => v?.key).filter(Boolean),
    sync: {
      enabled: Boolean(sc.localDir),
      localDir: sc.localDir || "",
      remoteDir: sc.remoteDir || "/content/project",
    },
    startupScript: {
      enabled: false,
      title: "",
      runtime: "python",
      code: "",
      params: {},
      background: false,
    },
  };
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createRecipesModal(api, callbacks) {
  let dialog = null;
  let recipes = [];
  let selectedId = null;
  let draft = null;

  function tr(key) {
    return api.tr(key);
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "recipes-manager-modal";
    dialog.className = "recipes-modal";
    dialog.setAttribute("aria-labelledby", "recipes-modal-title");
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) close();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function syncDraftFromForm() {
    if (!dialog || !draft) return draft;
    const q = (sel) => dialog.querySelector(sel);
    const hwVal = q("#rcp-hw")?.value || "cpu";
    const hwHm = Boolean(q("#rcp-highmem")?.checked);
    draft.name = (q("#rcp-name")?.value || "").trim();
    draft.description = (q("#rcp-desc")?.value || "").trim();
    draft.sessionNamePrefix = (q("#rcp-prefix")?.value || "").trim();
    draft.hardware = accelToTarget(hwVal, hwHm);
    draft.snipe.enabled = Boolean(q("#rcp-snipe-enabled")?.checked);
    draft.snipe.intervalSec = Math.max(5, Number(q("#rcp-snipe-interval")?.value) || 10);
    draft.snipe.maxAttempts = Math.max(0, Number(q("#rcp-snipe-max")?.value) || 0);
    draft.snipe.timeoutSec = Math.max(0, Number(q("#rcp-snipe-timeout")?.value) || 0) * 60;
    draft.bootstrap = {
      autoMountDrive: Boolean(q("#rcp-boot-drive")?.checked),
      enableHfTransfer: Boolean(q("#rcp-boot-hf")?.checked),
      hfCacheToDrive: Boolean(q("#rcp-boot-hfcache")?.checked),
      autoInstallUv: Boolean(q("#rcp-boot-uv")?.checked),
      autoInjectEnv: Boolean(q("#rcp-boot-env")?.checked),
      customScript: q("#rcp-boot-custom")?.value || "",
    };
    draft.sync = {
      enabled: Boolean(q("#rcp-sync-enabled")?.checked),
      localDir: (q("#rcp-sync-local")?.value || "").trim(),
      remoteDir: (q("#rcp-sync-remote")?.value || "").trim() || "/content/project",
    };
    draft.startupScript = {
      ...draft.startupScript,
      enabled: Boolean(q("#rcp-script-enabled")?.checked),
      title: (q("#rcp-script-title")?.value || "").trim(),
      runtime: q("#rcp-script-runtime")?.value === "bash" ? "bash" : "python",
      background: Boolean(q("#rcp-script-bg")?.checked),
      code: q("#rcp-script-code")?.value || "",
    };
    return draft;
  }

  function render() {
    if (!dialog) return;
    dialog.innerHTML = "";

    const shell = document.createElement("div");
    shell.className = "recipes-modal-shell";

    // Header
    const head = document.createElement("div");
    head.className = "recipes-modal-head";
    const h3 = document.createElement("h3");
    h3.id = "recipes-modal-title";
    h3.textContent = tr("recipes.modalTitle");
    const toolbar = document.createElement("div");
    toolbar.className = "recipes-modal-toolbar";

    const newBtn = makeBtn(tr("recipes.newRecipe"), "recipe-mini-btn is-primary", () => {
      selectedId = null;
      draft = emptyDraft(api.state);
      render();
    });
    const importBtn = makeBtn(tr("recipes.import"), "recipe-mini-btn", () => triggerImport());
    const exportAllBtn = makeBtn(tr("recipes.exportAll"), "recipe-mini-btn", async () => {
      const res = await api.fetchJson("/api/recipes/export");
      if (res?.ok && res.bundle) {
        downloadJson("colab-desk-recipes.json", res.bundle);
        api.showToast(tr("recipes.exportedToast"));
      }
    });
    const closeBtn = makeBtn("✕", "icon-btn", () => close());
    closeBtn.setAttribute("aria-label", "Close");

    toolbar.append(newBtn, importBtn, exportAllBtn, closeBtn);
    head.append(h3, toolbar);

    // Body
    const body = document.createElement("div");
    body.className = "recipes-modal-body";

    // Sidebar list
    const sidebar = document.createElement("div");
    sidebar.className = "recipes-sidebar";
    if (!recipes.length) {
      const empty = document.createElement("p");
      empty.className = "snipe-target-empty";
      empty.textContent = tr("recipes.noRecipesYet");
      sidebar.appendChild(empty);
    } else {
      for (const r of recipes) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `recipes-list-btn${r.id === selectedId ? " is-active" : ""}`;
        const nameEl = document.createElement("strong");
        nameEl.textContent = r.name;
        const metaEl = document.createElement("span");
        metaEl.className = "recipes-list-meta";
        const targets = r.snipe?.targets?.length ? r.snipe.targets.map(formatTargetLabel).join(" > ") : formatTargetLabel(r.hardware);
        metaEl.textContent = targets;
        btn.append(nameEl, metaEl);
        btn.addEventListener("click", () => {
          selectedId = r.id;
          draft = structuredClone(r);
          render();
        });
        sidebar.appendChild(btn);
      }
    }

    // Editor pane
    const editor = document.createElement("div");
    editor.className = "recipes-editor";
    if (!draft) {
      const p = document.createElement("p");
      p.className = "snipe-target-empty";
      p.textContent = tr("recipes.selectOrCreate");
      editor.appendChild(p);
    } else {
      editor.appendChild(buildEditorContent());
    }

    body.append(sidebar, editor);
    shell.append(head, body);
    dialog.appendChild(shell);
  }

  function buildEditorContent() {
    const frag = document.createDocumentFragment();

    // Basic info + default HW
    const basic = section(tr("recipes.title"));
    const row1 = el("div", "recipes-row-2");
    row1.append(
      textField("rcp-name", tr("recipes.nameLabel"), draft.name, tr("recipes.namePlaceholder")),
      textField("rcp-prefix", tr("recipes.prefixLabel"), draft.sessionNamePrefix, tr("recipes.prefixPlaceholder")),
    );
    const row2 = el("div", "recipes-row-2");
    row2.append(
      textField("rcp-desc", tr("recipes.descLabel"), draft.description, tr("recipes.descPlaceholder")),
      buildHwField(),
    );
    basic.append(row1, row2);
    frag.appendChild(basic);

    // Snipe priority queue
    const snipeSec = section(tr("recipes.snipeQueueTitle"));
    snipeSec.appendChild(checkField("rcp-snipe-enabled", tr("recipes.snipeEnable"), draft.snipe.enabled));
    const listWrap = el("div", "snipe-target-list");
    (draft.snipe.targets || []).forEach((t, idx) => {
      const row = el("div", "snipe-target-row");
      row.append(
        textEl("span", "snipe-target-rank", `${idx + 1}.`),
        textEl("span", "snipe-target-label", formatTargetLabel(t)),
      );
      const btns = el("div", "snipe-target-btns");
      btns.append(
        makeBtn("↑", "recipe-mini-btn", () => {
          syncDraftFromForm();
          if (idx > 0) {
            const arr = draft.snipe.targets;
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            render();
          }
        }, idx === 0),
        makeBtn("↓", "recipe-mini-btn", () => {
          syncDraftFromForm();
          const arr = draft.snipe.targets;
          if (idx < arr.length - 1) {
            [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
            render();
          }
        }, idx === draft.snipe.targets.length - 1),
        makeBtn("×", "recipe-mini-btn is-danger", () => {
          syncDraftFromForm();
          draft.snipe.targets.splice(idx, 1);
          render();
        }),
      );
      row.appendChild(btns);
      listWrap.appendChild(row);
    });
    snipeSec.appendChild(listWrap);

    const addRow = el("div", "snipe-add-row");
    const addSel = document.createElement("select");
    addSel.className = "recipe-select";
    for (const o of ACCEL_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      addSel.appendChild(opt);
    }
    const hmLabel = el("label", "snipe-add-hm");
    const hmCb = document.createElement("input");
    hmCb.type = "checkbox";
    hmCb.checked = true;
    hmLabel.append(hmCb, textEl("span", "", tr("modal.newSession.highMemShort")));
    const addBtn = makeBtn(tr("recipes.addTarget"), "recipe-mini-btn", () => {
      syncDraftFromForm();
      draft.snipe.targets.push(accelToTarget(addSel.value, hmCb.checked));
      render();
    });
    addRow.append(addSel, hmLabel, addBtn);
    snipeSec.appendChild(addRow);

    const paramsGrid = el("div", "snipe-params-grid");
    paramsGrid.append(
      numField("rcp-snipe-interval", tr("recipes.intervalSec"), draft.snipe.intervalSec || 10, 5, 3600),
      numField("rcp-snipe-max", tr("recipes.maxAttempts"), draft.snipe.maxAttempts || 0, 0, 10000),
      numField("rcp-snipe-timeout", tr("recipes.timeoutMin"), Math.round((draft.snipe.timeoutSec || 0) / 60), 0, 10080),
    );
    snipeSec.appendChild(paramsGrid);
    frag.appendChild(snipeSec);

    // Bootstrap + Env Var Refs
    const bootSec = section(tr("recipes.bootTitle"));
    const checks = el("div", "recipes-checks");
    checks.append(
      checkField("rcp-boot-drive", tr("recipes.bootDrive"), draft.bootstrap.autoMountDrive),
      checkField("rcp-boot-hf", tr("recipes.bootHf"), draft.bootstrap.enableHfTransfer),
      checkField("rcp-boot-hfcache", tr("recipes.bootHfCache"), draft.bootstrap.hfCacheToDrive),
      checkField("rcp-boot-uv", tr("recipes.bootUv"), draft.bootstrap.autoInstallUv),
      checkField("rcp-boot-env", tr("recipes.bootEnv"), draft.bootstrap.autoInjectEnv),
    );
    bootSec.append(
      checks,
      textareaField("rcp-boot-custom", tr("recipes.bootCustom"), draft.bootstrap.customScript || ""),
    );
    frag.appendChild(bootSec);

    // Env var names only
    const envSec = section(tr("recipes.envTitle"));
    const chips = el("div", "recipes-env-chips");
    for (const key of draft.envVarNames || []) {
      const chip = el("span", "recipes-env-chip");
      chip.append(
        document.createTextNode(key),
        makeBtn("×", "", () => {
          syncDraftFromForm();
          draft.envVarNames = draft.envVarNames.filter((k) => k !== key);
          render();
        }),
      );
      chips.appendChild(chip);
    }
    const envAddRow = el("div", "snipe-add-row");
    const envInput = document.createElement("input");
    envInput.type = "text";
    envInput.placeholder = tr("recipes.envAddPlaceholder");
    envInput.className = "recipe-select";
    const envAddBtn = makeBtn(tr("recipes.addTarget"), "recipe-mini-btn", () => {
      const key = envInput.value.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
      syncDraftFromForm();
      if (!draft.envVarNames.includes(key)) draft.envVarNames.push(key);
      render();
    });
    envAddRow.append(envInput, envAddBtn);
    envSec.append(chips, envAddRow);
    frag.appendChild(envSec);

    // Sync
    const syncSec = section(tr("recipes.syncTitle"));
    syncSec.appendChild(checkField("rcp-sync-enabled", tr("recipes.syncEnable"), draft.sync.enabled));
    const syncRow = el("div", "recipes-row-2");
    syncRow.append(
      textField("rcp-sync-local", tr("recipes.syncLocal"), draft.sync.localDir || "", "~/projects/my-exp"),
      textField("rcp-sync-remote", tr("recipes.syncRemote"), draft.sync.remoteDir || "/content/project", "/content/project"),
    );
    syncSec.appendChild(syncRow);
    frag.appendChild(syncSec);

    // Startup Script
    const scriptSec = section(tr("recipes.scriptTitle"));
    scriptSec.appendChild(checkField("rcp-script-enabled", tr("recipes.scriptEnable"), draft.startupScript.enabled));
    const scriptRow = el("div", "recipes-row-2");
    scriptRow.append(
      textField("rcp-script-title", tr("recipes.scriptName"), draft.startupScript.title || "", "train.py"),
      selectField("rcp-script-runtime", tr("recipes.scriptRuntime"), [
        { value: "python", label: "Python" },
        { value: "bash", label: "Bash" },
      ], draft.startupScript.runtime || "python"),
    );
    scriptSec.append(
      scriptRow,
      checkField("rcp-script-bg", tr("recipes.scriptBackground"), draft.startupScript.background),
      textareaField("rcp-script-code", tr("recipes.scriptCode"), draft.startupScript.code || ""),
    );
    frag.appendChild(scriptSec);

    // Footer actions
    const foot = el("div", "recipes-editor-foot");
    const left = el("div", "recipes-editor-foot-group");
    const right = el("div", "recipes-editor-foot-group");

    left.append(
      makeBtn(tr("recipes.launchNow"), "recipe-mini-btn is-primary", async () => {
        const payload = syncDraftFromForm();
        close();
        await callbacks.onLaunch({ recipe: payload, recipeId: payload.id, snipe: false });
      }),
      makeBtn(tr("recipes.launchSnipe"), "recipe-mini-btn", async () => {
        const payload = syncDraftFromForm();
        close();
        await callbacks.onLaunch({ recipe: payload, recipeId: payload.id, snipe: true });
      }),
    );

    if (draft.id) {
      right.append(
        makeBtn(tr("recipes.duplicate"), "recipe-mini-btn", async () => {
          const res = await api.fetchJson(`/api/recipes/${encodeURIComponent(draft.id)}/duplicate`, { method: "POST", body: JSON.stringify({}) });
          if (res?.ok && res.recipe) {
            api.showToast(tr("recipes.duplicatedToast"));
            await callbacks.onRefresh();
            selectedId = res.recipe.id;
            draft = structuredClone(res.recipe);
            render();
          }
        }),
        makeBtn(tr("recipes.exportOne"), "recipe-mini-btn", async () => {
          const res = await api.fetchJson(`/api/recipes/${encodeURIComponent(draft.id)}/export`);
          if (res?.ok && res.bundle) {
            downloadJson(`recipe-${draft.name.replace(/[^a-z0-9_-]+/gi, "-") || "export"}.json`, res.bundle);
            api.showToast(tr("recipes.exportedToast"));
          }
        }),
        makeBtn(tr("recipes.delete"), "recipe-mini-btn is-danger", async () => {
          const res = await api.fetchJson(`/api/recipes/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
          if (res?.ok) {
            api.showToast(tr("recipes.deletedToast"));
            selectedId = null;
            draft = null;
            await callbacks.onRefresh();
            render();
          }
        }),
      );
    }

    right.append(
      makeBtn(tr("recipes.save"), "recipe-mini-btn is-primary", async () => {
        const payload = syncDraftFromForm();
        if (!payload.name) {
          dialog.querySelector("#rcp-name")?.focus();
          return;
        }
        const url = payload.id ? `/api/recipes/${encodeURIComponent(payload.id)}` : "/api/recipes";
        const method = payload.id ? "PUT" : "POST";
        const res = await api.fetchJson(url, { method, body: JSON.stringify(payload) });
        if (res?.ok && res.recipe) {
          api.showToast(tr("recipes.savedToast"));
          await callbacks.onRefresh();
          selectedId = res.recipe.id;
          draft = structuredClone(res.recipe);
          render();
        } else {
          api.showToast(res?.error || "Save failed");
        }
      }),
    );

    foot.append(left, right);
    frag.appendChild(foot);
    return frag;
  }

  function buildHwField() {
    const wrap = el("div", "recipes-field");
    wrap.appendChild(textEl("span", "", tr("recipes.hwLabel")));
    const row = el("div", "snipe-add-row");
    const sel = document.createElement("select");
    sel.id = "rcp-hw";
    const curVal = draft.hardware?.gpu || draft.hardware?.tpu || "cpu";
    for (const o of ACCEL_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === curVal) opt.selected = true;
      sel.appendChild(opt);
    }
    const hmLabel = el("label", "snipe-add-hm");
    const hmCb = document.createElement("input");
    hmCb.id = "rcp-highmem";
    hmCb.type = "checkbox";
    hmCb.checked = Boolean(draft.hardware?.highMem);
    hmLabel.append(hmCb, textEl("span", "", tr("modal.newSession.highMemShort")));
    row.append(sel, hmLabel);
    wrap.appendChild(row);
    return wrap;
  }

  function triggerImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const res = await api.fetchJson("/api/recipes/import", {
          method: "POST",
          body: JSON.stringify({ bundle: parsed }),
        });
        if (res?.ok) {
          api.showToast(`${tr("recipes.importedToast")} (${res.imported?.length || 0})`);
          await callbacks.onRefresh();
          if (res.imported?.[0]) {
            selectedId = res.imported[0].id;
            draft = structuredClone(res.imported[0]);
          }
          render();
        } else {
          api.showToast(res?.error || "Import failed");
        }
      } catch (err) {
        api.showToast(err?.message || "Invalid JSON");
      }
    });
    input.click();
  }

  function open(opts = {}) {
    ensureDialog();
    if (opts.draft) {
      selectedId = null;
      draft = structuredClone(opts.draft);
    } else if (opts.recipeId) {
      const found = recipes.find((r) => r.id === opts.recipeId);
      if (found) {
        selectedId = found.id;
        draft = structuredClone(found);
      }
    } else if (!draft && recipes.length) {
      selectedId = recipes[0].id;
      draft = structuredClone(recipes[0]);
    } else if (!draft) {
      draft = emptyDraft(api.state);
    }
    render();
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  function close() {
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  function setRecipes(next) {
    recipes = Array.isArray(next) ? next : [];
    if (dialog?.open) render();
  }

  return { open, close, setRecipes, render: () => { if (dialog?.open) render(); } };
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function textEl(tag, className, text) {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}
function section(title) {
  const sec = el("div", "recipes-section");
  sec.appendChild(textEl("h4", "", title));
  return sec;
}
function makeBtn(label, className, onClick, disabled = false) {
  const b = document.createElement("button");
  b.type = "button";
  if (className) b.className = className;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}
function textField(id, label, value, placeholder = "") {
  const wrap = el("label", "recipes-field");
  wrap.appendChild(textEl("span", "", label));
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.value = value || "";
  if (placeholder) input.placeholder = placeholder;
  wrap.appendChild(input);
  return wrap;
}
function numField(id, label, value, min, max) {
  const wrap = el("label", "recipes-field");
  wrap.appendChild(textEl("span", "", label));
  const input = document.createElement("input");
  input.id = id;
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value ?? 0);
  wrap.appendChild(input);
  return wrap;
}
function textareaField(id, label, value) {
  const wrap = el("label", "recipes-field");
  wrap.appendChild(textEl("span", "", label));
  const ta = document.createElement("textarea");
  ta.id = id;
  ta.value = value || "";
  wrap.appendChild(ta);
  return wrap;
}
function checkField(id, label, checked) {
  const wrap = el("label", "recipes-check");
  const cb = document.createElement("input");
  cb.id = id;
  cb.type = "checkbox";
  cb.checked = Boolean(checked);
  wrap.append(cb, textEl("span", "", label));
  return wrap;
}
function selectField(id, label, options, current) {
  const wrap = el("label", "recipes-field");
  wrap.appendChild(textEl("span", "", label));
  const sel = document.createElement("select");
  sel.id = id;
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
  wrap.appendChild(sel);
  return wrap;
}

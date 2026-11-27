import { dom } from "./dom.js";
import { saveJsonStorage, state } from "./state.js";
import { L, tr } from "./utils.js";
import { emit, on } from "./events.js";
import { scheduleStoreSync } from "./store.js";

/* ── Agent Provider, Model & Thinking Level Pickers ── */
export function getProviderDotClass(providerId) {
  if (providerId === "agy") return "p-agy";
  if (providerId === "grok") return "p-grok";
  if (providerId === "opencode") return "p-opencode";
  return "p-api";
}

export function syncAgentPickerLabel() {
  if (!dom.agentPickerProviderEl || !dom.agentPickerModelEl) return;
  const pid = dom.agentProviderSelect.value || "agy";
  const snap = state.providerListSnapshot.find((p) => p.id === pid);
  const selProvOpt = dom.agentProviderSelect.options[dom.agentProviderSelect.selectedIndex];
  const provName = snap?.label || selProvOpt?.textContent?.replace(/\s*\((?:未安装|Not installed)\)$/, "") || pid;
  const selModelOpt = dom.agentModelSelect.options[dom.agentModelSelect.selectedIndex];
  const modelName = selModelOpt?.textContent || dom.agentModelSelect.value || tr("composer.defaultModel");
  if (dom.agentPickerDot) {
    dom.agentPickerDot.className = `agent-picker-dot ${getProviderDotClass(pid)}`;
  }
  dom.agentPickerProviderEl.textContent = provName;
  dom.agentPickerModelEl.textContent = modelName;
  if (dom.agentPickerBtn) {
    dom.agentPickerBtn.title = `${provName} · ${modelName}`;
  }
}

export function syncThoughtPickerLabel() {
  if (!dom.thoughtPickerWrap || !dom.thoughtPickerLabel || !dom.agentThoughtSelect) return;
  const hasOptions = dom.agentThoughtSelect.options.length > 0;
  dom.thoughtPickerWrap.hidden = !hasOptions;
  if (!hasOptions) {
    closeThoughtPicker();
    return;
  }
  const sel = dom.agentThoughtSelect.options[dom.agentThoughtSelect.selectedIndex];
  dom.thoughtPickerLabel.textContent = sel?.textContent || dom.agentThoughtSelect.value || L("思考", "Think");
}

export function closeAgentPicker() {
  if (dom.agentPickerMenu) dom.agentPickerMenu.hidden = true;
  if (dom.agentPickerBtn) dom.agentPickerBtn.setAttribute("aria-expanded", "false");
}

export function closeThoughtPicker() {
  if (dom.thoughtPickerMenu) dom.thoughtPickerMenu.hidden = true;
  if (dom.thoughtPickerBtn) dom.thoughtPickerBtn.setAttribute("aria-expanded", "false");
}

export async function ensurePickerProviderModels(pid, force = false) {
  if (!force && state.providerModelsCache[pid] && !state.providerModelsCache[pid]._needsGatewayFetch) {
    return state.providerModelsCache[pid];
  }
  try {
    const res = await fetch(`/api/agent/models?provider=${encodeURIComponent(pid)}`);
    const data = await res.json();
    data._needsGatewayFetch = false;
    state.providerModelsCache[pid] = data;
    if (dom.agentProviderSelect.value === pid) {
      renderModelOptions(pid, data);
    }
    return data;
  } catch {
    if (state.providerModelsCache[pid]) state.providerModelsCache[pid]._needsGatewayFetch = false;
    return state.providerModelsCache[pid] || { models: [] };
  }
}

export function renderAgentModelsSubmenu(pid) {
  if (!dom.apModelsList) return;
  dom.apModelsList.replaceChildren();
  const snap = state.providerListSnapshot.find((p) => p.id === pid);
  const head = document.createElement("div");
  head.className = "ap-col-head";
  const headTitle = document.createElement("span");
  headTitle.style.overflow = "hidden";
  headTitle.style.textOverflow = "ellipsis";
  headTitle.textContent = snap ? `${snap.label}${snap.transport === "openai-compat" && snap.path ? ` · ${snap.path.replace(/^https?:\/\//, "")}` : ""}` : pid;
  head.append(headTitle);
  if (snap && snap.available !== false) {
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "ap-head-refresh";
    refreshBtn.title = L("刷新模型列表", "Refresh models");
    refreshBtn.textContent = "↻";
    refreshBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      refreshBtn.disabled = true;
      ensurePickerProviderModels(pid, true).then(() => {
        if (dom.agentPickerMenu && !dom.agentPickerMenu.hidden && state.hoveredPickerProviderId === pid) {
          renderAgentModelsSubmenu(pid);
        }
      });
    });
    head.append(refreshBtn);
  }
  dom.apModelsList.append(head);

  if (snap && snap.available === false) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "ap-empty";
    const msg = document.createElement("span");
    msg.textContent = snap.id === "api"
      ? L("尚未配置自定义 API 网关。", "No custom API gateway configured.")
      : L(`本机未检测到 ${snap.label} CLI。`, `${snap.label} CLI is not installed locally.`);
    const cfgBtn = document.createElement("button");
    cfgBtn.type = "button";
    cfgBtn.className = "s-btn";
    cfgBtn.style.alignSelf = "flex-start";
    cfgBtn.textContent = L("前往配置", "Configure");
    cfgBtn.addEventListener("click", () => {
      closeAgentPicker();
      emit("ui:open-settings", "providers");
    });
    emptyEl.append(msg, cfgBtn);
    dom.apModelsList.append(emptyEl);
    return;
  }

  const cached = state.providerModelsCache[pid];
  if (!cached) {
    const loading = document.createElement("div");
    loading.className = "ap-empty";
    loading.textContent = L("正在加载模型列表…", "Loading models…");
    dom.apModelsList.append(loading);
    ensurePickerProviderModels(pid, true).then(() => {
      if (dom.agentPickerMenu && !dom.agentPickerMenu.hidden && state.hoveredPickerProviderId === pid) {
        renderAgentModelsSubmenu(pid);
      }
    });
    return;
  }

  if (cached._needsGatewayFetch) {
    cached._needsGatewayFetch = false;
    ensurePickerProviderModels(pid, true).then(() => {
      if (dom.agentPickerMenu && !dom.agentPickerMenu.hidden && state.hoveredPickerProviderId === pid) {
        renderAgentModelsSubmenu(pid);
      }
    });
  }

  const models = Array.isArray(cached.models) ? cached.models : [];
  if (models.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "ap-empty";
    emptyEl.textContent = L("暂无可选模型（将使用默认模型）", "No model list (using default)");
    const useDef = document.createElement("button");
    useDef.type = "button";
    useDef.className = "ap-item";
    useDef.textContent = tr("composer.defaultModel");
    useDef.addEventListener("click", () => selectAgentProviderAndModel(pid, ""));
    dom.apModelsList.append(emptyEl, useDef);
    return;
  }

  const activePid = dom.agentProviderSelect.value;
  const activeModel = dom.agentModelSelect.value;
  for (const m of models) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isCurrent = activePid === pid && (activeModel === m.value || (!activeModel && m.value === (cached.current || models[0].value)));
    btn.className = `ap-item${isCurrent ? " is-selected" : ""}`;
    btn.setAttribute("role", "menuitemradio");
    btn.setAttribute("aria-checked", isCurrent ? "true" : "false");
    const check = document.createElement("span");
    check.className = "ap-item-check";
    check.textContent = isCurrent ? "✓" : "";
    const lbl = document.createElement("span");
    lbl.className = "ap-item-label";
    lbl.textContent = m.name || m.value;
    lbl.title = m.name && m.name !== m.value ? `${m.name} (${m.value})` : m.value;
    btn.append(check, lbl);
    btn.addEventListener("click", () => selectAgentProviderAndModel(pid, m.value));
    dom.apModelsList.append(btn);
  }
}

export function renderAgentPickerMenu() {
  if (!dom.apProvidersList) return;
  dom.apProvidersList.replaceChildren();
  const activePid = dom.agentProviderSelect.value || state.providerListSnapshot[0]?.id || "agy";
  if (!state.hoveredPickerProviderId || !state.providerListSnapshot.some((p) => p.id === state.hoveredPickerProviderId)) {
    state.hoveredPickerProviderId = activePid;
  }

  const head = document.createElement("div");
  head.className = "ap-col-head";
  head.textContent = L("引擎 / 网关", "Providers");
  dom.apProvidersList.append(head);

  for (const p of state.providerListSnapshot) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = p.id === activePid;
    const isHovered = p.id === state.hoveredPickerProviderId;
    btn.className = `ap-item${isActive ? " is-selected" : ""}${isHovered ? " is-hovered" : ""}${p.available === false ? " is-disabled" : ""}`;
    btn.dataset.providerId = p.id;
    const dot = document.createElement("span");
    dot.className = `agent-picker-dot ${getProviderDotClass(p.id)}`;
    const lbl = document.createElement("span");
    lbl.className = "ap-item-label";
    lbl.textContent = p.label;
    btn.append(dot, lbl);
    if (p.available === false) {
      const tag = document.createElement("span");
      tag.className = "ap-item-tag";
      tag.textContent = L("未安装", "Off");
      btn.append(tag);
    }
    const arrow = document.createElement("span");
    arrow.className = "ap-item-arrow";
    arrow.textContent = "›";
    btn.append(arrow);

    const activateHover = () => {
      state.hoveredPickerProviderId = p.id;
      for (const el of dom.apProvidersList.querySelectorAll(".ap-item")) {
        el.classList.toggle("is-hovered", el.dataset.providerId === p.id);
      }
      renderAgentModelsSubmenu(p.id);
    };
    btn.addEventListener("mouseenter", activateHover);
    btn.addEventListener("focus", activateHover);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      activateHover();
      const cached = state.providerModelsCache[p.id];
      if (p.available && cached && Array.isArray(cached.models) && cached.models.length === 1) {
        selectAgentProviderAndModel(p.id, cached.models[0].value);
      }
    });
    dom.apProvidersList.append(btn);
  }

  const div = document.createElement("div");
  div.className = "ap-divider";
  const manageBtn = document.createElement("button");
  manageBtn.type = "button";
  manageBtn.className = "ap-manage-btn";
  manageBtn.textContent = L("⚙ 管理引擎与 API 网关…", "⚙ Manage providers & API…");
  manageBtn.addEventListener("click", () => {
    closeAgentPicker();
    emit("ui:open-settings", "providers");
  });
  dom.apProvidersList.append(div, manageBtn);

  renderAgentModelsSubmenu(state.hoveredPickerProviderId);
}

export function selectAgentProviderAndModel(pid, modelValue) {
  dom.agentProviderSelect.value = pid;
  try { localStorage.setItem("colab-desk.agent-provider", pid); } catch {}
  if (modelValue) {
    state.savedModelsByProvider[pid] = modelValue;
    saveJsonStorage("colab-desk.agent-models", state.savedModelsByProvider);
  }
  if (state.providerModelsCache[pid]) {
    renderModelOptions(pid, state.providerModelsCache[pid]);
  } else {
    loadProviderModels(pid);
  }
  if (modelValue && Array.from(dom.agentModelSelect.options).some((o) => o.value === modelValue)) {
    dom.agentModelSelect.value = modelValue;
  }
  syncAgentPickerLabel();
  closeAgentPicker();
  scheduleStoreSync();
}

export function openAgentPicker() {
  closeThoughtPicker();
  state.hoveredPickerProviderId = dom.agentProviderSelect.value || state.providerListSnapshot[0]?.id || "agy";
  renderAgentPickerMenu();
  if (dom.agentPickerMenu) dom.agentPickerMenu.hidden = false;
  if (dom.agentPickerBtn) dom.agentPickerBtn.setAttribute("aria-expanded", "true");
}

export function renderThoughtPickerMenu() {
  if (!dom.thoughtPickerMenu || !dom.agentThoughtSelect) return;
  dom.thoughtPickerMenu.replaceChildren();
  const head = document.createElement("div");
  head.className = "ap-col-head";
  head.textContent = tr("composer.thoughtTitle");
  dom.thoughtPickerMenu.append(head);
  const curVal = dom.agentThoughtSelect.value;
  for (const opt of Array.from(dom.agentThoughtSelect.options)) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSel = opt.value === curVal;
    btn.className = `ap-item${isSel ? " is-selected" : ""}`;
    const check = document.createElement("span");
    check.className = "ap-item-check";
    check.textContent = isSel ? "✓" : "";
    const lbl = document.createElement("span");
    lbl.className = "ap-item-label";
    lbl.textContent = opt.textContent;
    btn.append(check, lbl);
    btn.addEventListener("click", () => {
      dom.agentThoughtSelect.value = opt.value;
      const pid = dom.agentProviderSelect.value;
      state.savedThoughtByProvider[pid] = opt.value;
      saveJsonStorage("colab-desk.agent-thoughts", state.savedThoughtByProvider);
      syncThoughtPickerLabel();
      closeThoughtPicker();
      scheduleStoreSync();
    });
    dom.thoughtPickerMenu.append(btn);
  }
}

export function openThoughtPicker() {
  closeAgentPicker();
  renderThoughtPickerMenu();
  if (dom.thoughtPickerMenu) dom.thoughtPickerMenu.hidden = false;
  if (dom.thoughtPickerBtn) dom.thoughtPickerBtn.setAttribute("aria-expanded", "true");
}

export function renderModelOptions(providerId, data) {
  dom.agentModelSelect.replaceChildren();
  const models = Array.isArray(data?.models) ? data.models : [];
  if (models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = data?.available === false ? tr("settings.providers.notInstalled") : tr("composer.defaultModel");
    dom.agentModelSelect.append(opt);
  } else {
    const preferred = state.savedModelsByProvider[providerId] || data.current || models[0].value;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.name || m.value;
      if (m.value === preferred) opt.selected = true;
      dom.agentModelSelect.append(opt);
    }
  }

  const tl = data?.thoughtLevels;
  if (dom.agentThoughtSelect) {
    dom.agentThoughtSelect.replaceChildren();
    if (tl && Array.isArray(tl.options) && tl.options.length > 0) {
      const prefT = state.savedThoughtByProvider[providerId] || tl.current || tl.options[0].value;
      for (const optDef of tl.options) {
        const opt = document.createElement("option");
        opt.value = optDef.value;
        opt.textContent = optDef.name || optDef.value;
        if (optDef.value === prefT) opt.selected = true;
        dom.agentThoughtSelect.append(opt);
      }
    }
    dom.agentThoughtSelect.hidden = true;
  }
  syncAgentPickerLabel();
  syncThoughtPickerLabel();
}

export async function loadProviderModels(providerId) {
  if (state.providerModelsCache[providerId]) {
    renderModelOptions(providerId, state.providerModelsCache[providerId]);
    return;
  }
  dom.agentModelSelect.replaceChildren();
  const loadingOpt = document.createElement("option");
  loadingOpt.value = "";
  loadingOpt.textContent = L("加载模型…", "Loading…");
  dom.agentModelSelect.append(loadingOpt);
  syncAgentPickerLabel();
  try {
    const res = await fetch(`/api/agent/models?provider=${encodeURIComponent(providerId)}`);
    const data = await res.json();
    state.providerModelsCache[providerId] = data;
    if (dom.agentProviderSelect.value === providerId) {
      renderModelOptions(providerId, data);
    }
  } catch {
    if (dom.agentProviderSelect.value === providerId) {
      renderModelOptions(providerId, { models: [] });
    }
  }
}

export async function initProviders() {
  try {
    const res = await fetch("/api/agent/providers");
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.providers)) return;
    state.providerListSnapshot = data.providers;
    const savedProvider = localStorage.getItem("colab-desk.agent-provider") || "agy";
    dom.agentProviderSelect.replaceChildren();
    let chosen = null;
    for (const p of data.providers) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.available ? p.label : `${p.label} (${tr("settings.providers.notInstalled")})`;
      if (p.id === savedProvider && p.available) chosen = p.id;
      dom.agentProviderSelect.append(opt);
      if (p.models && p.models.length > 0) {
        state.providerModelsCache[p.id] = {
          available: p.available,
          current: p.defaultModel,
          models: p.models,
          thoughtLevels: p.thoughtLevels || null,
          _needsGatewayFetch: p.transport === "openai-compat",
        };
      }
    }
    if (!chosen) {
      const firstAvail = data.providers.find((p) => p.available);
      chosen = firstAvail ? firstAvail.id : data.providers[0]?.id || "agy";
    }
    dom.agentProviderSelect.value = chosen;
    syncAgentPickerLabel();
    loadProviderModels(chosen);
  } catch {}
}

export function initAgentPickers() {
  dom.agentProviderSelect.addEventListener("change", () => {
    const pid = dom.agentProviderSelect.value;
    try { localStorage.setItem("colab-desk.agent-provider", pid); } catch {}
    loadProviderModels(pid);
    scheduleStoreSync();
  });
  dom.agentModelSelect.addEventListener("change", () => {
    const pid = dom.agentProviderSelect.value;
    state.savedModelsByProvider[pid] = dom.agentModelSelect.value;
    saveJsonStorage("colab-desk.agent-models", state.savedModelsByProvider);
    scheduleStoreSync();
  });
  dom.agentThoughtSelect.addEventListener("change", () => {
    const pid = dom.agentProviderSelect.value;
    state.savedThoughtByProvider[pid] = dom.agentThoughtSelect.value;
    saveJsonStorage("colab-desk.agent-thoughts", state.savedThoughtByProvider);
    syncThoughtPickerLabel();
    scheduleStoreSync();
  });

  if (dom.agentPickerBtn) {
    dom.agentPickerBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (dom.agentPickerMenu && !dom.agentPickerMenu.hidden) closeAgentPicker();
      else openAgentPicker();
    });
  }
  if (dom.thoughtPickerBtn) {
    dom.thoughtPickerBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (dom.thoughtPickerMenu && !dom.thoughtPickerMenu.hidden) closeThoughtPicker();
      else openThoughtPicker();
    });
  }
  document.addEventListener("click", (ev) => {
    if (dom.agentPickerWrap && !dom.agentPickerWrap.contains(ev.target)) closeAgentPicker();
    if (dom.thoughtPickerWrap && !dom.thoughtPickerWrap.contains(ev.target)) closeThoughtPicker();
  });
  on("language:changed", () => {
    for (const opt of Array.from(dom.agentProviderSelect.options)) {
      const snap = state.providerListSnapshot.find((p) => p.id === opt.value);
      if (snap) {
        opt.textContent = snap.available ? snap.label : `${snap.label} (${tr("settings.providers.notInstalled")})`;
      }
    }
    const curPid = dom.agentProviderSelect.value;
    if (curPid && state.providerModelsCache[curPid]) {
      renderModelOptions(curPid, state.providerModelsCache[curPid]);
    } else {
      syncAgentPickerLabel();
      syncThoughtPickerLabel();
    }
    if (dom.agentPickerMenu && !dom.agentPickerMenu.hidden) renderAgentPickerMenu();
    if (dom.thoughtPickerMenu && !dom.thoughtPickerMenu.hidden) renderThoughtPickerMenu();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeAgentPicker();
      closeThoughtPicker();
    }
  });
}

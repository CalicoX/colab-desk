import { buildContextHandoffPrompt, parseColabNewSpec, record } from "/desk.mjs";
import { dom } from "./dom.js";
import { currentSessionObject, desk, saveJsonStorage, state } from "./state.js";
import {
  L,
  formatFileSize,
  isImageAttachment,
  openImageLightbox,
  sendDesktopNotification,
  showToast,
  tr,
} from "./utils.js";
import { persistDeskHistory, scheduleStoreSync } from "./store.js";
import { recordAgentUsage } from "./usage.js";
import { openSettings } from "./settings.js";
import { setComposerMode } from "./composer.js";
import {
  buildSteerContinuationPrompt,
  ensureActiveThread,
  getSessionQueue,
  renderChatThreads,
  renderComposerQueue,
  syncSendButton,
} from "./threads.js";
import {
  enqueueThoughtChunk,
  flushThoughtStream,
  renderTranscript,
  updateThoughtMetaInPlace,
} from "./transcript.js";
import { refreshSessions, renderInspector } from "./sessions.js";
import { resolveAgentSessionCreate, trackAgentSessionCreate } from "./session-create.js";

/* ── Agent Providers, Models & Streaming Chat ── */
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
  const provName = snap?.label || selProvOpt?.textContent?.replace(/\s*\(未安装\)$/, "") || pid;
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
      openSettings("providers");
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
      // For single-model custom API profiles, clicking once also selects immediately if already hovered
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
    openSettings("providers");
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
      opt.textContent = p.available ? p.label : `${p.label} (未安装)`;
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

export function renderStagedFiles() {
  dom.stagedFilesBox.replaceChildren();
  dom.stagedFilesBox.classList.toggle("show", state.stagedFiles.length > 0);
  state.stagedFiles.forEach((file, idx) => {
    const isImg = isImageAttachment(file);
    const previewSrc = file.previewUrl || (isImg && file.path ? `/api/image?path=${encodeURIComponent(file.path)}` : "");
    if (isImg && previewSrc) {
      const card = document.createElement("div");
      card.className = "staged-img-card";
      card.title = `${file.name}${file.size ? ` (${formatFileSize(file.size)})` : ""}`;
      const img = document.createElement("img");
      img.className = "staged-img-thumb";
      img.src = previewSrc;
      img.alt = file.name;
      img.addEventListener("click", () => openImageLightbox(previewSrc, file.name));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "staged-img-remove";
      remove.setAttribute("aria-label", L(`移除 ${file.name}`, `Remove ${file.name}`));
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.stagedFiles.splice(idx, 1);
        renderStagedFiles();
        syncSendButton();
      });
      card.append(img, remove);
      dom.stagedFilesBox.append(card);
      return;
    }
    const chip = document.createElement("span");
    chip.className = "staged-chip";
    const label = document.createElement("span");
    label.textContent = `📎 ${file.name}`;
    chip.append(label);
    if (file.size) {
      const sz = document.createElement("span");
      sz.className = "staged-chip-size";
      sz.textContent = formatFileSize(file.size);
      chip.append(sz);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", L(`移除 ${file.name}`, `Remove ${file.name}`));
    remove.addEventListener("click", () => {
      state.stagedFiles.splice(idx, 1);
      renderStagedFiles();
      syncSendButton();
    });
    chip.append(remove);
    dom.stagedFilesBox.append(chip);
  });
}

export async function normalizePastedImageFile(file, fallbackIndex = 1) {
  const rawType = String(file?.type || "").toLowerCase();
  let name = String(file?.name || "").trim();
  const extByMime = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
  };
  if (rawType === "image/tiff" || /\.tiff?$/i.test(name)) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (pngBlob) {
        const pngName = name ? name.replace(/\.tiff?$/i, ".png") : `image${fallbackIndex > 1 ? `-${fallbackIndex}` : ""}.png`;
        return new File([pngBlob], pngName, { type: "image/png" });
      }
    } catch {}
  }
  if (!name || name === "blob") {
    const ext = extByMime[rawType] || "png";
    name = `image${fallbackIndex > 1 ? `-${fallbackIndex}` : ""}.${ext}`;
  }
  if (name !== file.name) {
    return new File([file], name, { type: file.type || "image/png" });
  }
  return file;
}

export async function stageLocalFiles(fileList) {
  let idx = 0;
  for (const rawFile of Array.from(fileList || [])) {
    idx += 1;
    try {
      const file = isImageAttachment(rawFile)
        ? await normalizePastedImageFile(rawFile, state.stagedFiles.length + idx)
        : rawFile;
      const mimeParam = file.type ? `&mime=${encodeURIComponent(file.type)}` : "";
      const res = await fetch(`/api/stage-file?name=${encodeURIComponent(file.name || "image.png")}${mimeParam}`, {
        method: "POST",
        body: file,
      });
      const data = await res.json();
      if (data.ok) {
        state.stagedFiles.push({
          name: data.name,
          path: data.path,
          size: data.size,
          mimeType: data.mimeType || file.type || "",
          isImage: Boolean(data.isImage || isImageAttachment(file)),
          previewUrl: data.previewUrl || (data.isImage ? `/api/image?path=${encodeURIComponent(data.path)}` : null),
        });
        renderStagedFiles();
        syncSendButton();
        showToast(
          data.isImage
            ? L(`已粘贴图片 ${data.name} (${formatFileSize(data.size)})`, `Attached image ${data.name} (${formatFileSize(data.size)})`)
            : L(`已附加 ${data.name}，发送消息即可让 Agent 上传处理`, `Attached ${data.name}. Send a message to upload and process it.`),
        );
      } else {
        showToast(L(`附加失败：${data.error || "未知错误"}`, `Attach failed: ${data.error || "Unknown error"}`));
      }
    } catch (err) {
      showToast(L(`附加失败：${err.message}`, `Attach failed: ${err.message}`));
    }
  }
}

export function handleComposerPaste(event) {
  const cd = event.clipboardData;
  const extracted = [];
  if (cd && cd.items && cd.items.length) {
    for (const item of Array.from(cd.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) extracted.push(f);
      }
    }
  }
  if (extracted.length === 0 && cd && cd.files && cd.files.length) {
    for (const f of Array.from(cd.files)) extracted.push(f);
  }
  const plainText = cd ? String(cd.getData("text/plain") || "") : "";
  const trimmed = plainText.trim();
  if (extracted.length > 0) {
    const isOnlyFilename = !trimmed || extracted.some((f) => f.name && f.name === trimmed);
    if (isOnlyFilename) event.preventDefault();
    setComposerMode("agent");
    stageLocalFiles(extracted);
    return true;
  }
  const looksLikeImageFilename = Boolean(trimmed) && !/\r|\n/.test(trimmed) && /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic)$/i.test(trimmed);
  if ((!trimmed || looksLikeImageFilename) && window.webkit?.messageHandlers?.clipboardImage) {
    event.preventDefault();
    window.webkit.messageHandlers.clipboardImage.postMessage({});
    return true;
  }
  return false;
}

export async function sendAgentMessage(promptText, overrideFiles = null, overrideApiPrompt = null) {
  const text = String(promptText || "").trim();
  if (!text || state.activeAgentController) return;
  let promptForApi = String(overrideApiPrompt || text);

  const key = ensureActiveThread(text);
  const threadObj = state.chatThreads.find((tItem) => tItem.id === key);
  const provider = dom.agentProviderSelect.value || "agy";
  const providerLabel = dom.agentProviderSelect.selectedOptions[0]?.textContent?.replace(/\s*\((?:未安装|Not installed)\)/, "") || provider;
  const model = dom.agentModelSelect.value || "";
  const nextModelLabel = model ? `${providerLabel} · ${model}` : providerLabel;
  const priorEntries = Array.isArray(desk.bySession[key]) ? desk.bySession[key] : [];
  if (threadObj && priorEntries.length > 0) {
    const prevProvider = threadObj.lastProvider || "";
    const prevModel = threadObj.lastModel || "";
    const switchedProvider = Boolean(prevProvider && prevProvider !== provider);
    const switchedModel = Boolean(prevModel && model && prevModel !== model);
    if (switchedProvider || switchedModel) {
      const prevLabel = threadObj.lastModelLabel || prevModel || prevProvider;
      promptForApi = buildContextHandoffPrompt(priorEntries, promptForApi, prevLabel, nextModelLabel, state.activeLang);
      showToast(L(
        `已自动交接对话上下文（${prevLabel} → ${nextModelLabel}）`,
        `Handed off context (${prevLabel} → ${nextModelLabel})`,
      ));
    }
  }
  if (threadObj) {
    threadObj.lastProvider = provider;
    threadObj.lastModel = model;
    threadObj.lastModelLabel = nextModelLabel;
    threadObj.updatedAt = Date.now();
  }
  const attached = Array.isArray(overrideFiles) ? overrideFiles.slice() : state.stagedFiles.slice();
  if (!Array.isArray(overrideFiles)) {
    state.stagedFiles = [];
    renderStagedFiles();
  }

  const turnStartedAt = Date.now();
  const entry = {
    kind: "agent",
    label: text,
    files: attached,
    provider,
    providerName: providerLabel,
    model: model || tr("composer.defaultModel"),
    ok: true,
    streaming: true,
    thought: "",
    thoughtTokens: 0,
    thinkSec: 0,
    thoughtOpen: undefined,
    tools: [],
    permissions: [],
    text: "",
    error: "",
  };
  record(desk, key, entry);
  renderTranscript(key);
  renderInspector();

  const controller = new AbortController();
  state.activeAgentController = controller;
  state.activeAgentTurnContext = { key, prompt: text };
  syncSendButton();
  renderChatThreads();

  let renderScheduled = false;
  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if ((desk.view || "") === key) renderTranscript(key);
    });
  };

  const thinkTimer = setInterval(() => {
    if (entry.streaming && !entry.text) {
      entry.thinkSec = Number(((Date.now() - turnStartedAt) / 1000).toFixed(1));
      if ((desk.view || "") === key && !updateThoughtMetaInPlace(entry)) {
        scheduleRender();
      }
    }
  }, 200);

  state.lastActivityAt = Date.now();
  state.idleAlertedSession = "";
  try {
    const thoughtLevel = dom.thoughtPickerWrap && !dom.thoughtPickerWrap.hidden && dom.agentThoughtSelect ? dom.agentThoughtSelect.value : "";
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        model,
        thoughtLevel,
        approvalMode: state.approvalMode,
        prompt: promptForApi,
        chatThreadId: key,
        colabSession: state.selected,
        sessionInfo: currentSessionObject(),
        files: attached,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      entry.ok = false;
      entry.error = errData.error || `HTTP ${res.status}`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawTool = false;
    let lastCtxUsed = null;
    let lastCtxSize = null;
    let recordedUsage = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (ev.type === "meta") {
          if (ev.model) entry.model = ev.model;
          if (ev.providerName) entry.providerName = ev.providerName;
        } else if (ev.type === "text") {
          if (!entry.text) {
            flushThoughtStream(entry);
            entry.thinkSec = Number(((Date.now() - turnStartedAt) / 1000).toFixed(1));
            if (entry.thoughtOpen === undefined) entry.thoughtOpen = state.keepThoughtOpen;
          }
          entry.text += ev.text || "";
        } else if (ev.type === "thought") {
          const delta = ev.text || "";
          entry.thought += delta;
          entry.thinkSec = Number(((Date.now() - turnStartedAt) / 1000).toFixed(1));
          if ((desk.view || "") === key && enqueueThoughtChunk(entry, delta)) {
            continue;
          }
        } else if (ev.type === "usage") {
          if (ev.used != null) lastCtxUsed = ev.used;
          if (ev.size != null) lastCtxSize = ev.size;
        } else if (ev.type === "tool_call") {
          sawTool = true;
          const existing = entry.tools.find((tItem) => tItem.toolCallId === ev.toolCallId);
          if (existing) {
            Object.assign(existing, ev);
          } else {
            entry.tools.push({
              toolCallId: ev.toolCallId,
              title: ev.title,
              status: ev.status || "in_progress",
              input: ev.input || "",
              output: "",
            });
          }
          const newSpec = parseColabNewSpec(ev.input) || parseColabNewSpec(ev.title);
          if (newSpec && ev.status !== "completed" && ev.status !== "failed") {
            trackAgentSessionCreate(ev.toolCallId, newSpec);
          }
        } else if (ev.type === "tool_update") {
          const target =
            entry.tools.find((tItem) => tItem.toolCallId && tItem.toolCallId === ev.toolCallId) ||
            entry.tools[entry.tools.length - 1];
          if (target) {
            if (ev.title) target.title = ev.title;
            if (ev.status) target.status = ev.status;
            if (ev.output) target.output = target.output ? `${target.output}\n${ev.output}` : ev.output;
            if (!state.agentCreate) {
              const lateSpec = parseColabNewSpec(target.input) || parseColabNewSpec(target.title);
              if (lateSpec && target.status !== "completed" && target.status !== "failed") {
                trackAgentSessionCreate(target.toolCallId, lateSpec);
              }
            }
            if (state.agentCreate && (!state.agentCreate.toolCallId || state.agentCreate.toolCallId === target.toolCallId)) {
              if (target.status === "completed" || target.status === "failed") {
                resolveAgentSessionCreate(target.status, target.output || ev.output || "");
              }
            }
          }
        } else if (ev.type === "permission_request") {
          entry.permissions.push(ev);
        } else if (ev.type === "done") {
          const u = ev.usage;
          const tTok = u?.thoughtTokens ?? u?.reasoning_tokens ?? 0;
          if (tTok > 0) entry.thoughtTokens = tTok;
          if (!recordedUsage) {
            recordedUsage = true;
            recordAgentUsage(entry.provider, entry.providerName, u, ev.costUsd, lastCtxUsed, lastCtxSize);
          }
        } else if (ev.type === "error") {
          entry.ok = false;
          entry.error = ev.error || "Agent 执行出错";
          if (ev.authRequired) entry.authRequired = true;
        }
        scheduleRender();
      }
    }

    if (sawTool) {
      await refreshSessions(state.selected);
      if (state.agentCreate && !state.agentCreate.failedRetryable) {
        const found = state.sessions.some((s) => s.name === state.agentCreate.name);
        await resolveAgentSessionCreate(found ? "completed" : "failed", entry.error || entry.text || "");
      }
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      const abortNote = state.stopReasonKind === "steer"
        ? (state.activeLang === "en" ? "*(Redirected via Steer)*" : "*（已中断并转向新指令）*")
        : (state.activeLang === "en" ? "*(Stopped)*" : "*（已手动停止）*");
      entry.text = entry.text ? `${entry.text}\n\n${abortNote}` : abortNote;
    } else {
      entry.ok = false;
      entry.error = (err && err.message) || "连接 Agent 失败";
    }
  } finally {
    clearInterval(thinkTimer);
    flushThoughtStream(entry);
    entry.streaming = false;
    entry.permissions = [];
    for (const tItem of entry.tools) {
      if (tItem.status === "in_progress") tItem.status = "completed";
    }
    const nextSteer = state.pendingSteerItem;
    const wasManualStop = state.stopReasonKind === "stop";
    const wasSteerAbort = state.stopReasonKind === "steer";
    state.pendingSteerItem = null;
    state.stopReasonKind = null;
    if (state.activeAgentController === controller) state.activeAgentController = null;
    if (state.activeAgentTurnContext && state.activeAgentTurnContext.prompt === text) state.activeAgentTurnContext = null;
    if (!wasSteerAbort && !wasManualStop) {
      state.pendingUnfinishedTasks.delete(key);
    } else if (wasManualStop) {
      const prevList = state.pendingUnfinishedTasks.get(key) || [];
      prevList.push(text);
      state.pendingUnfinishedTasks.set(key, prevList);
    }
    state.lastActivityAt = Date.now();
    const elapsedMs = Date.now() - turnStartedAt;
    if (!nextSteer && (elapsedMs >= 8000 || !document.hasFocus())) {
      if (!entry.ok && entry.error) {
        sendDesktopNotification(
          L("Colab Desk — 任务异常", "Colab Desk — Task Error"),
          entry.error.slice(0, 120),
        );
      } else if (entry.text) {
        sendDesktopNotification(
          L("Colab Desk — 任务已完成", "Colab Desk — Task Completed"),
          `${state.selected || "Colab"} · ${entry.text.replace(/\s+/g, " ").slice(0, 100)}`,
        );
      }
    }
    syncSendButton();
    persistDeskHistory();
    renderTranscript(key);
    renderInspector();
    renderComposerQueue();

    if (nextSteer) {
      const unfinished = state.pendingUnfinishedTasks.get(nextSteer.key) || [];
      const wrappedPrompt = buildSteerContinuationPrompt(nextSteer.promptText, unfinished);
      setTimeout(() => sendAgentMessage(nextSteer.promptText, nextSteer.files, wrappedPrompt), 0);
    } else if (!wasManualStop) {
      const q = getSessionQueue(key);
      if (q.length > 0 && (state.selected || "") === key) {
        const nextItem = q.shift();
        renderComposerQueue();
        setTimeout(() => sendAgentMessage(nextItem.promptText, nextItem.files), 0);
      }
    }
  }
}

export function initAgentControls() {
  // Native macOS WKWebView clipboard / file staging bridges
  window.__onNativeStagedFiles = (items) => {
    try {
      const list = Array.isArray(items) ? items : (items ? [items] : []);
      let added = 0;
      let lastItem = null;
      for (const data of list) {
        if (!data || !data.path) continue;
        const isImg = Boolean(data.isImage || isImageAttachment(data));
        const rec = {
          name: data.name || "image.png",
          path: data.path,
          size: Number(data.size) || 0,
          mimeType: data.mimeType || (isImg ? "image/png" : "application/octet-stream"),
          isImage: isImg,
          previewUrl: data.previewUrl || (isImg ? `/api/image?path=${encodeURIComponent(data.path)}` : null),
        };
        state.stagedFiles.push(rec);
        added += 1;
        lastItem = rec;
      }
      if (added === 0) return;
      setComposerMode("agent");
      renderStagedFiles();
      syncSendButton();
      dom.code.focus();
      if (added === 1 && lastItem) {
        showToast(L(
          `已粘贴图片 ${lastItem.name} (${formatFileSize(lastItem.size)})`,
          `Attached image ${lastItem.name} (${formatFileSize(lastItem.size)})`,
        ));
      } else {
        showToast(L(`已粘贴 ${added} 张图片`, `Attached ${added} images`));
      }
    } catch {}
  };

  window.__onNativeClipboardImages = (items) => {
    try {
      const list = Array.isArray(items) ? items : (items ? [items] : []);
      const files = [];
      for (const payload of list) {
        if (!payload || !payload.base64) continue;
        const bin = atob(payload.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const mime = payload.mimeType || "image/png";
        files.push(new File([bytes], payload.name || "image.png", { type: mime }));
      }
      if (files.length === 0) return;
      setComposerMode("agent");
      stageLocalFiles(files);
      dom.code.focus();
    } catch {}
  };
  window.__onNativeClipboardImage = (payload) => window.__onNativeClipboardImages([payload]);

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
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeAgentPicker();
      closeThoughtPicker();
    }
  });

  dom.attachFileBtn.addEventListener("click", () => dom.attachFileInput.click());
  dom.attachFileInput.addEventListener("change", () => {
    if (dom.attachFileInput.files && dom.attachFileInput.files.length) {
      stageLocalFiles(dom.attachFileInput.files);
      dom.attachFileInput.value = "";
    }
  });

  // Paste images / files directly into composer (⌘V)
  dom.code.addEventListener("paste", (event) => {
    handleComposerPaste(event);
  });
  document.addEventListener("paste", (event) => {
    if (event.target === dom.code) return;
    if (document.querySelector("dialog[open]")) return;
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || (event.target && event.target.isContentEditable)) return;
    if (state.composerMode === "notebook" || dom.composer.hidden) return;
    handleComposerPaste(event);
  });

  // Drag & drop files onto composer
  dom.composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    dom.composer.classList.add("is-dragover");
  });
  dom.composer.addEventListener("dragleave", () => dom.composer.classList.remove("is-dragover"));
  dom.composer.addEventListener("drop", (event) => {
    event.preventDefault();
    dom.composer.classList.remove("is-dragover");
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      setComposerMode("agent");
      stageLocalFiles(event.dataTransfer.files);
    }
  });

  // Starter prompt cards
  document.querySelectorAll("[data-starter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setComposerMode("agent");
      sendAgentMessage(btn.dataset.starter);
    });
  });
}

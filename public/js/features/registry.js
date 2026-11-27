import { TRANSLATIONS, registerTranslations } from "/i18n.mjs";
import { dom } from "../dom.js";
import { emit, on, registerAction } from "../events.js";
import { SETTINGS_TABS, currentSessionObject, state } from "../state.js";
import { applyI18nToTree, sendDesktopNotification, showToast, tr } from "../utils.js";

const registeredCommands = new Map();
const pendingSettingsPanes = [];
const serverEventListeners = new Map(); // type -> Set<cb>
let settingsModuleRef = null;
let eventSource = null;
let reconnectTimer = null;
let initialized = false;

registerAction("features:get-commands", () => Array.from(registeredCommands.values()));

on("settings:mounted", (mod) => {
  settingsModuleRef = mod;
  flushSettingsPanes();
});

function ensureEventSource() {
  if (typeof EventSource === "undefined") return;
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    eventSource = new EventSource("/api/events");
    eventSource.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed.type !== "string") return;
      dispatchServerEvent(parsed.type, parsed.payload, parsed);
    };
    eventSource.onerror = () => {
      if (eventSource && eventSource.readyState === EventSource.CLOSED) {
        eventSource = null;
        if (!reconnectTimer && serverEventListeners.size > 0) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            ensureEventSource();
          }, 2500);
        }
      }
    };
  } catch {}
}

function dispatchServerEvent(type, payload, raw) {
  for (const key of [type, "*"]) {
    const set = serverEventListeners.get(key);
    if (!set) continue;
    for (const cb of Array.from(set)) {
      try {
        cb(payload, raw);
      } catch (err) {
        console.error(`[features] server event handler "${type}" failed:`, err);
      }
    }
  }
}

export function onServerEvent(type, cb) {
  if (!type || typeof cb !== "function") return () => {};
  if (!serverEventListeners.has(type)) serverEventListeners.set(type, new Set());
  serverEventListeners.get(type).add(cb);
  ensureEventSource();
  return () => {
    const set = serverEventListeners.get(type);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) serverEventListeners.delete(type);
  };
}

function registerSettingsTabTitle(id, title) {
  const tabKey = `settings.tab.${id}`;
  if (title && typeof title === "object") {
    registerTranslations({
      "zh-CN": { [tabKey]: title["zh-CN"] || title.en || id },
      en: { [tabKey]: title.en || title["zh-CN"] || id },
    });
    return { i18nKey: tabKey, fallback: title["zh-CN"] || title.en || id };
  }
  const str = String(title || id);
  const zhVal = TRANSLATIONS["zh-CN"]?.[str];
  const enVal = TRANSLATIONS.en?.[str];
  if (zhVal !== undefined || enVal !== undefined) {
    registerTranslations({
      "zh-CN": { [tabKey]: zhVal ?? enVal ?? str },
      en: { [tabKey]: enVal ?? zhVal ?? str },
    });
    return { i18nKey: str, fallback: zhVal ?? enVal ?? str };
  }
  registerTranslations({
    "zh-CN": { [tabKey]: str },
    en: { [tabKey]: str },
  });
  return { i18nKey: tabKey, fallback: str };
}

function mountSettingsPaneNow(spec) {
  const modal = dom.settingsModal;
  if (!modal) return false;
  const sidebar = modal.querySelector(".settings-sidebar");
  const scroll = modal.querySelector(".settings-scroll");
  if (!sidebar || !scroll) return false;
  if (sidebar.querySelector(`[data-settings-tab="${spec.id}"]`)) return true;

  const { i18nKey, fallback } = registerSettingsTabTitle(spec.id, spec.title);
  SETTINGS_TABS.add(spec.id);

  const btn = document.createElement("button");
  btn.className = "settings-nav-btn";
  btn.type = "button";
  btn.dataset.settingsTab = spec.id;
  btn.innerHTML = spec.icon || `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>`;
  const label = document.createElement("span");
  label.dataset.i18n = i18nKey;
  label.textContent = tr(i18nKey) || fallback;
  btn.append(label);

  btn.addEventListener("click", () => {
    if (dom.settingsSearchInput) dom.settingsSearchInput.value = "";
    if (settingsModuleRef?.filterSettingsRows) settingsModuleRef.filterSettingsRows("");
    if (settingsModuleRef?.selectSettingsTab) {
      settingsModuleRef.selectSettingsTab(spec.id);
    } else {
      state.activeSettingsTab = spec.id;
      modal.querySelectorAll("[data-settings-tab]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.settingsTab === spec.id);
      });
      modal.querySelectorAll("[data-settings-pane]").forEach((p) => {
        p.classList.toggle("is-active", p.dataset.settingsPane === spec.id);
      });
      if (dom.settingsCrumbTab) dom.settingsCrumbTab.textContent = tr(`settings.tab.${spec.id}`);
    }
  });

  const aboutBtn = sidebar.querySelector('[data-settings-tab="about"]');
  if (aboutBtn) sidebar.insertBefore(btn, aboutBtn);
  else sidebar.append(btn);

  const section = document.createElement("section");
  section.className = "settings-pane";
  section.dataset.settingsPane = spec.id;
  if (spec.element instanceof Node) section.append(spec.element);
  scroll.append(section);
  applyI18nToTree(section);
  return true;
}

function flushSettingsPanes() {
  for (let i = pendingSettingsPanes.length - 1; i >= 0; i -= 1) {
    if (mountSettingsPaneNow(pendingSettingsPanes[i])) {
      pendingSettingsPanes.splice(i, 1);
    }
  }
}

function mountInto(point, target) {
  if (point === "workspace-tools") {
    const container = dom.toolsDropdownMenu || document.querySelector("#tools-dropdown-menu");
    if (container && target instanceof Node) {
      container.append(target);
      applyI18nToTree(target);
      return true;
    }
    return false;
  }
  if (point === "rail") {
    const container = document.querySelector("#rail");
    if (container && target instanceof Node) {
      container.append(target);
      applyI18nToTree(target);
      return true;
    }
    return false;
  }
  if (point === "sidebar-footer") {
    const container = document.querySelector(".sidebar-foot-left") || document.querySelector(".sidebar-foot");
    if (container && target instanceof Node) {
      container.append(target);
      applyI18nToTree(target);
      return true;
    }
    return false;
  }
  if (point === "settings-pane") {
    if (!target || typeof target !== "object" || !target.id) return false;
    SETTINGS_TABS.add(target.id);
    registerSettingsTabTitle(target.id, target.title);
    if (!mountSettingsPaneNow(target)) {
      pendingSettingsPanes.push(target);
    }
    return true;
  }
  console.warn(`[features] unknown mount point: ${point}`);
  return false;
}

async function fetchJson(url, opts = {}) {
  const init = { ...opts };
  const headers = new Headers(init.headers || {});
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body === "object" &&
    !(init.body instanceof FormData) &&
    !(init.body instanceof Blob) &&
    !(init.body instanceof ArrayBuffer) &&
    !(init.body instanceof URLSearchParams)
  ) {
    init.body = JSON.stringify(init.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  init.headers = headers;
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: res.ok, raw: text };
    }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function createFeatureApi() {
  return {
    state,
    getSession: () => currentSessionObject(),
    tr,
    registerStrings(bundles) {
      registerTranslations(bundles);
      if (typeof document !== "undefined") applyI18nToTree(document);
    },
    mount: mountInto,
    registerCommand(cmd) {
      if (!cmd || !cmd.id || typeof cmd.run !== "function") return;
      registeredCommands.set(cmd.id, cmd);
    },
    onServerEvent,
    fetchJson,
    showToast,
    notifyNative({ title = "", body = "" } = {}) {
      sendDesktopNotification(String(title), String(body), true);
    },
    on,
    emit,
  };
}

function linkFeatureStyle(href) {
  if (typeof document === "undefined" || !href) return;
  if (document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.featureStyle = "1";
  document.head.append(link);
}

export async function initFeatureRegistry() {
  if (initialized) return;
  initialized = true;

  let manifest;
  try {
    manifest = await fetchJson("/api/features");
  } catch (err) {
    console.error("[features] failed to fetch /api/features:", err);
    return;
  }

  for (const href of Array.isArray(manifest?.styles) ? manifest.styles : []) {
    try {
      linkFeatureStyle(href);
    } catch (err) {
      console.error(`[features] failed to link stylesheet ${href}:`, err);
    }
  }

  const api = createFeatureApi();
  for (const url of Array.isArray(manifest?.frontend) ? manifest.frontend : []) {
    try {
      const mod = await import(url);
      if (typeof mod?.init === "function") {
        await mod.init(api);
      }
    } catch (err) {
      console.error(`[features] failed to initialize ${url}:`, err);
    }
  }
}

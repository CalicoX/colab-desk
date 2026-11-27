import { resolveLanguage } from "/i18n.mjs";
import { dom } from "./dom.js";
import { SKINS, currentTranscriptKey, state } from "./state.js";
import { showToast, tr } from "./utils.js";
import { scheduleStoreSync } from "./store.js";
import { syncTerminalTheme } from "./terminal.js";
import { renderUsageModal } from "./usage.js";
import { syncApprovalToggle, syncBusyModeToggle, syncComposer } from "./composer.js";
import { renderComposerQueue, renderChatThreads, syncSendButton } from "./threads.js";
import { renderInspector, renderSessions, syncRailToggleUi } from "./sessions.js";
import { renderSnipeBanner } from "./session-create.js";
import { renderGpuTelemetry, renderRunnerSidebar, renderTunnels } from "./cloud-tools.js";
import { renderTranscript } from "./transcript.js";
import { paintAcpAuthStatus, paintEnvCheck, renderSettingsModal } from "./settings.js";

const systemLightMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

export function renderSkinGrid() {
  if (!dom.skinPickerGrid) return;
  dom.skinPickerGrid.replaceChildren();
  for (const s of SKINS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `skin-card${state.skinPref === s.id ? " is-active" : ""}`;
    card.dataset.skinId = s.id;
    card.title = state.activeLang === "en" ? s.en : s.zh;
    const sw = document.createElement("span");
    sw.className = "skin-swatches";
    for (const c of s.swatches) {
      const dot = document.createElement("span");
      dot.className = "skin-swatch";
      dot.style.background = c;
      sw.append(dot);
    }
    const nm = document.createElement("span");
    nm.className = "skin-name";
    nm.textContent = state.activeLang === "en" ? s.en : s.zh;
    card.append(sw, nm);
    card.addEventListener("click", () => {
      applySkin(s.id, true);
      showToast(state.activeLang === "en" ? `Skin: ${s.en}` : `已切换皮肤：${s.zh}`);
    });
    dom.skinPickerGrid.append(card);
  }
}

export function applySkin(nextSkin = state.skinPref, persist = false) {
  const valid = SKINS.some((s) => s.id === nextSkin) ? nextSkin : "amethyst";
  state.skinPref = valid;
  if (valid === "amethyst") delete document.documentElement.dataset.skin;
  else document.documentElement.dataset.skin = valid;
  if (valid === "paper") {
    syncTerminalTheme("light");
  } else {
    syncTerminalTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }
  renderSkinGrid();
  if (persist) {
    try { localStorage.setItem("colab-desk.skin", state.skinPref); } catch {}
    scheduleStoreSync();
  }
}

export function applyTheme(pref = state.themePref, persist = false) {
  state.themePref = pref === "light" || pref === "dark" || pref === "system" ? pref : "dark";
  const resolved = state.themePref === "system"
    ? (systemLightMq && systemLightMq.matches ? "light" : "dark")
    : state.themePref;
  document.documentElement.dataset.theme = resolved;
  if (dom.settingTheme) dom.settingTheme.value = state.themePref;
  syncTerminalTheme(resolved);
  if (window.webkit?.messageHandlers?.setTheme) {
    try { window.webkit.messageHandlers.setTheme.postMessage(state.themePref); } catch {}
  }
  if (persist) {
    try { localStorage.setItem("colab-desk.theme", state.themePref); } catch {}
    scheduleStoreSync();
  }
}

export function applyLanguage(pref = state.languagePref, persist = false) {
  state.languagePref = pref === "en" || pref === "zh-CN" ? pref : "auto";
  const sysLang = navigator.language || navigator.languages?.[0] || "en";
  state.activeLang = resolveLanguage(state.languagePref, sysLang);
  document.documentElement.lang = state.activeLang === "en" ? "en" : "zh-CN";
  const detectedLabel = resolveLanguage("auto", sysLang) === "en" ? "English" : "简体中文";
  if (dom.optLangAuto) dom.optLangAuto.textContent = tr("settings.general.langAuto", { detected: detectedLabel });
  if (dom.settingLanguage) dom.settingLanguage.value = state.languagePref;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = tr(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", tr(el.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", tr(el.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-i18n-label]").forEach((el) => {
    el.setAttribute("label", tr(el.dataset.i18nLabel));
  });
  document.querySelectorAll("[data-starter-key]").forEach((btn) => {
    btn.dataset.starter = tr(btn.dataset.starterKey);
  });

  if (dom.settingsCrumbTab) dom.settingsCrumbTab.textContent = tr(`settings.tab.${state.activeSettingsTab}`);
  syncRailToggleUi();
  if (!state.selected) {
    dom.title.textContent = tr("ws.noSessionTitle");
    dom.crumbName.textContent = tr("ws.unselected");
    dom.meta.textContent = tr("ws.noSessionMeta");
  }
  syncBusyModeToggle(false);
  syncApprovalToggle(false);
  syncSendButton();
  renderComposerQueue();
  renderSessions();
  renderChatThreads();
  renderSkinGrid();
  renderInspector();
  renderGpuTelemetry(state.latestGpuInfo);
  renderTunnels();
  renderTranscript(currentTranscriptKey());
  renderSnipeBanner();
  renderRunnerSidebar();
  if (dom.usageModal && dom.usageModal.open) renderUsageModal();
  syncComposer();
  if (state.latestEnvCheck) paintEnvCheck(state.latestEnvCheck);
  if (state.latestAcpAuth) paintAcpAuthStatus(state.latestAcpAuth);
  if (dom.settingsModal && dom.settingsModal.open) renderSettingsModal();

  if (persist) {
    try { localStorage.setItem("colab-desk.language", state.languagePref); } catch {}
    scheduleStoreSync();
  }
}

export function initThemeAndSkin() {
  if (systemLightMq && typeof systemLightMq.addEventListener === "function") {
    systemLightMq.addEventListener("change", () => {
      if (state.themePref === "system") applyTheme("system", false);
    });
  }

  if (dom.quickSkinBtn) {
    dom.quickSkinBtn.addEventListener("click", () => {
      const idx = SKINS.findIndex((s) => s.id === state.skinPref);
      const next = SKINS[(idx + 1) % SKINS.length];
      applySkin(next.id, true);
      showToast(state.activeLang === "en" ? `Skin: ${next.en}` : `已切换皮肤：${next.zh}`);
    });
  }
}

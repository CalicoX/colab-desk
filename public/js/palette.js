import { closeDialog, dom, openDialog } from "./dom.js";
import { state } from "./state.js";
import { L, escapeHtml, tr } from "./utils.js";
import { callRegistered, emit } from "./events.js";
import { applyLanguage, applyTheme } from "./theme.js";
import { selectSession, toggleRail, toggleSidebar } from "./sessions.js";
import { mountModalTemplate } from "./templates/mount.js";
import { CMD_PALETTE_MODAL_HTML } from "./templates/modals.js";

/* ── Command Palette Modal (⌘K, lazily loaded) ── */
let paletteItems = [];
let paletteIdx = 0;
let paletteInitialized = false;

export function buildPaletteCommands() {
  const cmds = [
    { label: L("新建 Colab 会话", "New Colab Session"), kbd: "⌘N", run: () => emit("ui:open-new-session") },
    { label: L("参数化直连脚本运行器（不经过 Agent）", "Direct Script Runner (No Agent)"), kbd: "", run: () => emit("ui:open-runner") },
    { label: L("云端文件与媒体画廊", "Cloud Files & Media Gallery"), kbd: "", run: () => state.selected && emit("ui:open-files", "/content") },
    { label: L("本地 ↔ 云端目录同步", "Local ↔ Cloud Folder Sync"), kbd: "", run: () => emit("ui:open-sync") },
    { label: L("常用任务模板", "Prompt Templates"), kbd: "", run: () => emit("ui:open-templates") },
    { label: L("切换视图：对话", "View: Chat"), kbd: "", run: () => emit("terminal:set-view", "chat") },
    { label: L("切换视图：对话 + 终端分屏", "View: Split (Chat + Terminal)"), kbd: "", run: () => emit("terminal:set-view", "split") },
    { label: L("切换视图：全屏终端", "View: Terminal"), kbd: "⌘J", run: () => emit("terminal:set-view", "terminal") },
    { label: L("对当前 VM 执行初始化", "Bootstrap Current VM"), kbd: "", run: () => emit("settings:bootstrap", { session: state.selected, silent: false }) },
    { label: L("导出 Jupyter Notebook (.ipynb)", "Export Jupyter Notebook (.ipynb)"), kbd: "", run: () => emit("cloud:export", "ipynb") },
    { label: L("导出 Markdown (.md)", "Export Markdown (.md)"), kbd: "", run: () => emit("cloud:export", "md") },
    { label: L("收起 / 展开左侧栏", "Toggle Sidebar"), kbd: "⌘B", run: toggleSidebar },
    { label: L("收起 / 展开右侧面板", "Toggle Inspector"), kbd: "⌘.", run: toggleRail },
    { label: L("外观：深色主题", "Theme: Dark"), kbd: "", run: () => applyTheme("dark", true) },
    { label: L("外观：浅色主题", "Theme: Light"), kbd: "", run: () => applyTheme("light", true) },
    { label: L("外观：跟随系统", "Theme: System"), kbd: "", run: () => applyTheme("system", true) },
    { label: L("语言：简体中文", "Language: 简体中文"), kbd: "", run: () => applyLanguage("zh-CN", true) },
    { label: L("语言：English", "Language: English"), kbd: "", run: () => applyLanguage("en", true) },
    { label: L("打开设置", "Open Settings"), kbd: "", run: () => emit("ui:open-settings", "general") },
    { label: L("打开环境变量保险箱与初始化", "Open Env Vault & Bootstrap"), kbd: "", run: () => emit("ui:open-settings", "colab") },
  ];
  const extraCommands = callRegistered("features:get-commands") || [];
  for (const cmd of extraCommands) {
    if (!cmd || typeof cmd.run !== "function") continue;
    let label = "";
    if (typeof cmd.title === "function") {
      label = String(cmd.title() || "");
    } else if (cmd.title && typeof cmd.title === "object") {
      label = String(state.activeLang === "en" ? (cmd.title.en || cmd.title["zh-CN"] || "") : (cmd.title["zh-CN"] || cmd.title.en || ""));
    } else if (typeof cmd.title === "string" && cmd.title) {
      const translated = tr(cmd.title);
      label = translated || cmd.title;
    } else {
      label = String(cmd.id || "");
    }
    if (!label) continue;
    cmds.push({ label, kbd: cmd.kbd || "", run: cmd.run });
  }
  for (const s of state.sessions) {
    cmds.unshift({ label: L(`切换会话：${s.name} (${s.hardware})`, `Switch Session: ${s.name} (${s.hardware})`), kbd: "VM", run: () => selectSession(s.name) });
  }
  return cmds;
}

export function renderPaletteList() {
  const q = dom.cmdPaletteInput.value.trim().toLowerCase();
  paletteItems = buildPaletteCommands().filter((c) => !q || c.label.toLowerCase().includes(q));
  if (paletteIdx >= paletteItems.length) paletteIdx = 0;
  dom.cmdPaletteListEl.replaceChildren();
  paletteItems.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item" + (i === paletteIdx ? " is-active" : "");
    btn.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="palette-kbd">${escapeHtml(item.kbd)}</span>`;
    btn.addEventListener("click", () => {
      closeDialog(dom.cmdPaletteModal);
      item.run();
    });
    dom.cmdPaletteListEl.append(btn);
  });
}

export function openCommandPalette() {
  initPalette();
  dom.cmdPaletteInput.value = "";
  paletteIdx = 0;
  renderPaletteList();
  openDialog(dom.cmdPaletteModal);
  dom.cmdPaletteInput.focus();
}

export function initPalette() {
  if (paletteInitialized) return;
  paletteInitialized = true;
  mountModalTemplate("cmd-palette-modal", CMD_PALETTE_MODAL_HTML);
  dom.cmdPaletteModal.addEventListener("click", (e) => { if (e.target === dom.cmdPaletteModal) closeDialog(dom.cmdPaletteModal); });
  dom.cmdPaletteInput.addEventListener("input", () => { paletteIdx = 0; renderPaletteList(); });
  dom.cmdPaletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteIdx = (paletteIdx + 1) % Math.max(1, paletteItems.length);
      renderPaletteList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteIdx = (paletteIdx - 1 + Math.max(1, paletteItems.length)) % Math.max(1, paletteItems.length);
      renderPaletteList();
    } else if (e.key === "Enter" && paletteItems[paletteIdx]) {
      e.preventDefault();
      const chosen = paletteItems[paletteIdx];
      closeDialog(dom.cmdPaletteModal);
      chosen.run();
    }
  });
}

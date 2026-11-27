import { closeDialog, dom, openDialog } from "./dom.js";
import { state } from "./state.js";
import { L, escapeHtml } from "./utils.js";
import { applyLanguage, applyTheme } from "./theme.js";
import { openSettings, runBootstrapOnSession } from "./settings.js";
import { undoLastDeletedThread } from "./threads.js";
import { closeSessionMenu, closeSplitMenu, selectSession, toggleRail, toggleSidebar } from "./sessions.js";
import { openNewSessionModal } from "./session-create.js";
import { openFilesModal } from "./files.js";
import {
  exportCurrentSession,
  openRunnerModal,
  openSyncModal,
  renderTemplatesModal,
} from "./cloud-tools.js";
import { setWorkspaceView, toggleTerminalView } from "./terminal.js";

/* ── Command Palette (⌘K) ── */
let paletteItems = [];
let paletteIdx = 0;

export function buildPaletteCommands() {
  const cmds = [
    { label: L("新建 Colab 会话", "New Colab Session"), kbd: "⌘N", run: openNewSessionModal },
    { label: L("参数化直连脚本运行器（不经过 Agent）", "Direct Script Runner (No Agent)"), kbd: "", run: openRunnerModal },
    { label: L("云端文件与媒体画廊", "Cloud Files & Media Gallery"), kbd: "", run: () => state.selected && openFilesModal("/content") },
    { label: L("本地 ↔ 云端目录同步", "Local ↔ Cloud Folder Sync"), kbd: "", run: openSyncModal },
    { label: L("常用任务模板", "Prompt Templates"), kbd: "", run: () => { renderTemplatesModal(); openDialog(dom.templatesModal); } },
    { label: L("切换视图：对话", "View: Chat"), kbd: "", run: () => setWorkspaceView("chat") },
    { label: L("切换视图：对话 + 终端分屏", "View: Split (Chat + Terminal)"), kbd: "", run: () => setWorkspaceView("split") },
    { label: L("切换视图：全屏终端", "View: Terminal"), kbd: "⌘J", run: () => setWorkspaceView("terminal") },
    { label: L("对当前 VM 执行初始化", "Bootstrap Current VM"), kbd: "", run: () => runBootstrapOnSession(state.selected, false) },
    { label: L("导出 Jupyter Notebook (.ipynb)", "Export Jupyter Notebook (.ipynb)"), kbd: "", run: () => exportCurrentSession("ipynb") },
    { label: L("导出 Markdown (.md)", "Export Markdown (.md)"), kbd: "", run: () => exportCurrentSession("md") },
    { label: L("收起 / 展开左侧栏", "Toggle Sidebar"), kbd: "⌘B", run: toggleSidebar },
    { label: L("收起 / 展开右侧面板", "Toggle Inspector"), kbd: "⌘.", run: toggleRail },
    { label: L("外观：深色主题", "Theme: Dark"), kbd: "", run: () => applyTheme("dark", true) },
    { label: L("外观：浅色主题", "Theme: Light"), kbd: "", run: () => applyTheme("light", true) },
    { label: L("外观：跟随系统", "Theme: System"), kbd: "", run: () => applyTheme("system", true) },
    { label: L("语言：简体中文", "Language: 简体中文"), kbd: "", run: () => applyLanguage("zh-CN", true) },
    { label: L("语言：English", "Language: English"), kbd: "", run: () => applyLanguage("en", true) },
    { label: L("打开设置", "Open Settings"), kbd: "", run: () => openSettings("general") },
    { label: L("打开环境变量保险箱与初始化", "Open Env Vault & Bootstrap"), kbd: "", run: () => openSettings("colab") },
  ];
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
  dom.cmdPaletteInput.value = "";
  paletteIdx = 0;
  renderPaletteList();
  openDialog(dom.cmdPaletteModal);
  dom.cmdPaletteInput.focus();
}

// Universal floating tooltip for every icon button (instant, clamped, no native delay)
export function initUniversalIconTooltips() {
  const tip = document.createElement("div");
  tip.id = "ui-tooltip";
  tip.className = "ui-tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  const ICON_BTN_SEL = "button.icon-btn, button.attach-btn, button.send, button.sidebar-foot-btn, button.split-caret, button.nb-run-btn, button.nb-mini-btn, button.chat-thread-act, button.ap-head-refresh, button.queue-item-btn, button.session-menu-btn, button.skin-card, button[data-tooltip]";
  let activeBtn = null;
  let showTimer = null;

  function getTipLabel(el) {
    if (!el) return "";
    if (el.hasAttribute("title") && el.getAttribute("title")) {
      el.dataset.tooltip = el.getAttribute("title");
      el.removeAttribute("title");
    }
    return (el.dataset.tooltip || el.getAttribute("aria-label") || "").trim();
  }

  function hideTip() {
    clearTimeout(showTimer);
    showTimer = null;
    activeBtn = null;
    tip.classList.remove("is-visible");
  }

  function positionTip(target) {
    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const margin = 8;
    let top = rect.top - tipRect.height - 8;
    if (top < margin) top = rect.bottom + 8;
    let left = rect.left + (rect.width - tipRect.width) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  }

  function showFor(target) {
    const label = getTipLabel(target);
    if (!label) return;
    activeBtn = target;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (activeBtn !== target || !document.body.contains(target)) return;
      tip.textContent = getTipLabel(target) || label;
      tip.style.left = "-9999px";
      tip.style.top = "-9999px";
      tip.classList.add("is-visible");
      positionTip(target);
    }, 160);
  }

  document.addEventListener("pointerover", (ev) => {
    const btn = ev.target?.closest?.(ICON_BTN_SEL);
    if (!btn) return;
    if (btn === activeBtn) return;
    showFor(btn);
  });
  document.addEventListener("pointerout", (ev) => {
    if (!activeBtn) return;
    const related = ev.relatedTarget;
    if (related && activeBtn.contains(related)) return;
    hideTip();
  });
  document.addEventListener("focusin", (ev) => {
    const btn = ev.target?.closest?.(ICON_BTN_SEL);
    if (btn) showFor(btn);
  });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("pointerdown", hideTip, true);
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
}

export function initPaletteAndShortcuts() {
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.openMenuSession) closeSessionMenu();
      if (!dom.inspectorSplitMenu.hidden) closeSplitMenu();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleSidebar();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ".") {
      event.preventDefault();
      toggleRail();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
      event.preventDefault();
      toggleTerminalView();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openCommandPalette();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      openNewSessionModal();
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable) return;
      if (state.undoToastEl && !state.undoToastEl.hidden && state.deletedThreadStack.length > 0) {
        event.preventDefault();
        undoLastDeletedThread();
      }
    }
  });

  window.addEventListener("colab-toggle-sidebar", toggleSidebar);
  window.addEventListener("colab-toggle-rail", toggleRail);
  window.addEventListener("colab-toggle-terminal", toggleTerminalView);
  window.addEventListener("colab-new-session", openNewSessionModal);
  window.addEventListener("colab-open-palette", openCommandPalette);
  document.querySelector("#open-cmd-palette-kbd").addEventListener("click", openCommandPalette);

  // macOS native window drag & double-click fill-screen zoom
  document.querySelectorAll("[data-drag-region]").forEach((region) => {
    region.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, input, select, textarea, a")) return;
      if (event.detail >= 2) {
        event.preventDefault();
        if (window.webkit?.messageHandlers?.windowZoom) {
          window.webkit.messageHandlers.windowZoom.postMessage("toggle");
        }
        return;
      }
      if (window.webkit?.messageHandlers?.windowDrag) {
        window.webkit.messageHandlers.windowDrag.postMessage("drag");
      }
    });
  });

  initUniversalIconTooltips();
}

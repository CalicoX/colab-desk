import { dom } from "./dom.js";
import { state } from "./state.js";
import { emit } from "./events.js";
import { undoLastDeletedThread } from "./threads.js";
import { closeSessionMenu, closeSplitMenu, toggleRail, toggleSidebar } from "./sessions.js";

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

/**
 * Registers global keyboard shortcuts, macOS Swift CustomEvent bridges,
 * window drag/zoom regions, and universal floating tooltips at startup.
 */
export function initGlobalShortcutsAndBridges() {
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
      emit("terminal:toggle");
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      emit("ui:open-palette");
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      emit("ui:open-new-session");
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

  // macOS Swift menu / shortcut bridges (dispatched from macos/ColabDesk.swift)
  window.addEventListener("colab-toggle-sidebar", toggleSidebar);
  window.addEventListener("colab-toggle-rail", toggleRail);
  window.addEventListener("colab-toggle-terminal", () => emit("terminal:toggle"));
  window.addEventListener("colab-new-session", () => emit("ui:open-new-session"));
  window.addEventListener("colab-open-palette", () => emit("ui:open-palette"));

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

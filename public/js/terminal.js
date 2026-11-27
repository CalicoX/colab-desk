import { dom } from "./dom.js";
import { currentSessionObject, state } from "./state.js";
import { showToast } from "./utils.js";
import { emit, on } from "./events.js";

/* ── Interactive PTY Terminal (xterm.js + WebSocket) ── */
let xtermInst = null;
let xtermFit = null;
let termWs = null;
let termResizeObs = null;

export function getTerminalThemePalette(mode) {
  if (mode === "light") {
    return {
      background: "#fafafa",
      foreground: "#1b1929",
      cursor: "#5b4ed6",
      selectionBackground: "rgba(91, 78, 214, 0.22)",
      black: "#1b1929",
      red: "#d93848",
      green: "#1f8f4e",
      yellow: "#b67410",
      blue: "#4263eb",
      magenta: "#8c4ee6",
      cyan: "#0e8a9c",
      white: "#d5d3e0",
      brightBlack: "#74718a",
      brightRed: "#e04c5a",
      brightGreen: "#28a65c",
      brightYellow: "#d18a19",
      brightBlue: "#5c7cfa",
      brightMagenta: "#a066f0",
      brightCyan: "#15aabf",
      brightWhite: "#ffffff",
    };
  }
  return {
    background: "#100e16",
    foreground: "#eeedf6",
    cursor: "#a89bf8",
    selectionBackground: "rgba(130, 115, 245, 0.32)",
    black: "#1a1824",
    red: "#ff6370",
    green: "#7fd49c",
    yellow: "#f0b860",
    blue: "#7ea6ff",
    magenta: "#c28bff",
    cyan: "#70d6e6",
    white: "#e2e0ee",
    brightBlack: "#706d86",
    brightRed: "#ff828d",
    brightGreen: "#9ee5b6",
    brightYellow: "#f6cf8a",
    brightBlue: "#a0beff",
    brightMagenta: "#d5adff",
    brightCyan: "#96e5f0",
    brightWhite: "#ffffff",
  };
}

export function syncTerminalTheme(resolvedMode) {
  if (!xtermInst) return;
  const mode = resolvedMode || document.documentElement.dataset.theme || "dark";
  xtermInst.options.theme = getTerminalThemePalette(mode);
}

export function encodeUtf8Base64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function decodeBase64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function ensureXtermInstance() {
  if (xtermInst || typeof window.Terminal !== "function") return;
  const mode = document.documentElement.dataset.theme || "dark";
  xtermInst = new window.Terminal({
    cursorBlink: true,
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.32,
    scrollback: 5000,
    theme: getTerminalThemePalette(mode),
  });
  if (window.FitAddon && typeof window.FitAddon.FitAddon === "function") {
    xtermFit = new window.FitAddon.FitAddon();
    xtermInst.loadAddon(xtermFit);
  }
  xtermInst.attachCustomKeyEventHandler((ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ["j", "k", "b", ".", "n"].includes(ev.key.toLowerCase())) {
      return false; // Let app-level shortcuts handle view/panel/palette toggles
    }
    return true;
  });
  xtermInst.open(dom.termCanvasEl);
  xtermInst.onData((data) => {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ t: "i", d: encodeUtf8Base64(data) }));
    }
  });
  xtermInst.onResize(({ cols, rows }) => {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ t: "r", c: cols, r: rows }));
    }
  });
  if (typeof ResizeObserver === "function") {
    termResizeObs = new ResizeObserver(() => fitActiveTerminal());
    termResizeObs.observe(dom.termCanvasEl);
  }
}

export function fitActiveTerminal() {
  if (!xtermInst || !xtermFit || (state.activeWorkspaceView !== "terminal" && state.activeWorkspaceView !== "split") || dom.termCanvasEl.hidden) return;
  try {
    xtermFit.fit();
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ t: "r", c: xtermInst.cols, r: xtermInst.rows }));
    }
  } catch {}
}

export function renderTermTabs() {
  const hasAlive = state.termList.some((item) => item.alive);
  if (dom.termLiveDot) dom.termLiveDot.hidden = !hasAlive;
  if (!dom.termTabsEl) return;
  dom.termTabsEl.replaceChildren();
  for (const item of state.termList) {
    const tab = document.createElement("div");
    tab.className = "term-tab" + (item.id === state.activeTermId ? " is-active" : "");
    const dot = document.createElement("span");
    dot.className = "term-tab-dot" + (item.alive ? "" : " is-dead");
    const lbl = document.createElement("span");
    lbl.textContent = item.title;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "term-tab-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await closeTerminalTab(item.id);
    });
    tab.append(dot, lbl, closeBtn);
    tab.addEventListener("click", () => attachTerminalTab(item.id));
    dom.termTabsEl.append(tab);
  }
  const hasActive = Boolean(state.activeTermId && state.termList.some((x) => x.id === state.activeTermId));
  dom.termEmptyEl.hidden = hasActive;
  dom.termCanvasEl.hidden = !hasActive;
}

export function disconnectTermWs() {
  if (termWs) {
    try { termWs.onclose = null; termWs.onmessage = null; termWs.close(); } catch {}
    termWs = null;
  }
}

export function attachTerminalTab(termId) {
  const rec = state.termList.find((x) => x.id === termId);
  if (!rec) {
    state.activeTermId = null;
    disconnectTermWs();
    renderTermTabs();
    return;
  }
  state.activeTermId = termId;
  renderTermTabs();
  ensureXtermInstance();
  if (!xtermInst) return;
  disconnectTermWs();
  xtermInst.reset();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/terminal/ws?id=${encodeURIComponent(termId)}`);
  termWs = ws;
  ws.onopen = () => {
    requestAnimationFrame(() => {
      fitActiveTerminal();
      xtermInst.focus();
    });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === "o" && typeof msg.d === "string") {
      xtermInst.write(decodeBase64Bytes(msg.d));
    } else if (msg.t === "x") {
      rec.alive = false;
      rec.exitCode = msg.code ?? 0;
      xtermInst.write(`\r\n\x1b[90m[process exited with code ${rec.exitCode}]\x1b[0m\r\n`);
      renderTermTabs();
    }
  };
  ws.onclose = () => {
    if (termWs === ws) termWs = null;
  };
}

export async function createTerminalTab() {
  const sess = currentSessionObject();
  if (!sess) {
    showToast(state.activeLang === "en" ? "Connect to a Colab VM first" : "请先连接一台 Colab 虚拟机");
    return;
  }
  const cols = xtermInst?.cols || 100;
  const rows = xtermInst?.rows || 30;
  try {
    const res = await fetch("/api/terminal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sess.name, cols, rows }),
    });
    const data = await res.json();
    if (!data.ok || !data.terminal) {
      showToast(data.error || "Failed to start terminal");
      return;
    }
    state.termList.push(data.terminal);
    attachTerminalTab(data.terminal.id);
  } catch (err) {
    showToast(err.message);
  }
}

export async function closeTerminalTab(termId) {
  try {
    await fetch(`/api/terminal/${encodeURIComponent(termId)}`, { method: "DELETE" });
  } catch {}
  state.termList = state.termList.filter((x) => x.id !== termId);
  if (state.activeTermId === termId) {
    disconnectTermWs();
    if (state.termList.length > 0) {
      attachTerminalTab(state.termList[state.termList.length - 1].id);
    } else {
      state.activeTermId = null;
      renderTermTabs();
    }
  } else {
    renderTermTabs();
  }
}

export function setWorkspaceView(nextView) {
  const hasSession = Boolean(currentSessionObject());
  const wantsTerm = nextView === "terminal" || nextView === "split";
  if (wantsTerm && !hasSession) {
    state.activeWorkspaceView = "chat";
  } else {
    state.activeWorkspaceView = nextView === "terminal" ? "terminal" : nextView === "split" ? "split" : "chat";
  }
  const isTerm = state.activeWorkspaceView === "terminal";
  const isSplit = state.activeWorkspaceView === "split";
  const isChat = state.activeWorkspaceView === "chat";
  dom.workspaceEl.classList.toggle("is-terminal-view", isTerm);
  dom.workspaceEl.classList.toggle("is-split-view", isSplit);
  dom.viewChatBtn.classList.toggle("is-active", isChat);
  dom.viewChatBtn.setAttribute("aria-selected", isChat ? "true" : "false");
  if (dom.viewSplitBtn) {
    dom.viewSplitBtn.classList.toggle("is-active", isSplit);
    dom.viewSplitBtn.setAttribute("aria-selected", isSplit ? "true" : "false");
  }
  dom.viewTermBtn.classList.toggle("is-active", isTerm);
  dom.viewTermBtn.setAttribute("aria-selected", isTerm ? "true" : "false");
  if (isTerm || isSplit) {
    const forCurrent = state.termList.find((tItem) => tItem.session === state.selected && tItem.alive);
    if (forCurrent) {
      if (state.activeTermId !== forCurrent.id) attachTerminalTab(forCurrent.id);
      requestAnimationFrame(() => {
        fitActiveTerminal();
        if (isTerm) xtermInst?.focus();
      });
    } else {
      createTerminalTab();
    }
  } else {
    dom.code.focus();
  }
}

export function toggleTerminalView() {
  if (!currentSessionObject()) {
    if (state.activeWorkspaceView !== "chat") setWorkspaceView("chat");
    return;
  }
  setWorkspaceView(state.activeWorkspaceView === "chat" ? "terminal" : "chat");
}

export function grabTerminalTail(maxLines = 50) {
  if (!xtermInst || !xtermInst.buffer?.active) return "";
  const buf = xtermInst.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - maxLines);
  const lines = [];
  for (let i = start; i < total; i += 1) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n").trim();
}

export function initTerminal() {
  on("theme:changed", (mode) => syncTerminalTheme(mode));
  if (dom.termSendAgentBtn) {
    dom.termSendAgentBtn.addEventListener("click", () => {
      const tail = grabTerminalTail(50);
      if (!tail) {
        showToast(state.activeLang === "en" ? "Terminal output is empty" : "终端当前没有可发送的输出");
        return;
      }
      if (state.activeWorkspaceView === "terminal") setWorkspaceView("split");
      emit("composer:set-mode", "agent");
      const prompt = state.activeLang === "en"
        ? `Please inspect this terminal output from Colab VM \`${state.selected || ""}\` and help diagnose or fix any error:\n\n\`\`\`text\n${tail}\n\`\`\``
        : `帮我排查当前 Colab 终端（\`${state.selected || ""}\`）的这段输出/报错，并给出修复方案：\n\n\`\`\`text\n${tail}\n\`\`\``;
      emit("agent:send", { promptText: prompt });
    });
  }
  dom.termNewColabBtn.addEventListener("click", () => createTerminalTab());
  document.querySelector("#term-empty-colab").addEventListener("click", () => createTerminalTab());
  dom.termClearBtn.addEventListener("click", () => { if (xtermInst) xtermInst.clear(); });
  dom.termReconnectBtn.addEventListener("click", async () => {
    const current = state.termList.find((x) => x.id === state.activeTermId);
    if (current) await closeTerminalTab(current.id);
    if (currentSessionObject()) createTerminalTab();
  });
}

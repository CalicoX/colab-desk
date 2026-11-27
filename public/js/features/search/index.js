const STRINGS = {
  "zh-CN": {
    "search.menuLabel": "全局搜索 (⌘⇧F)",
    "search.cmdOpen": "全局搜索日志与输出 (Search Everywhere)",
    "search.placeholder": "搜索对话记录、终端滚动输出、Notebook / Runner 与任务日志…",
    "search.scope.all": "全部",
    "search.scope.chat": "对话",
    "search.scope.terminal": "终端",
    "search.scope.notebook": "Notebook / Runner",
    "search.scope.jobs": "后台任务",
    "search.allSessions": "所有会话",
    "search.reindex": "重建索引",
    "search.reindexed": "已索引 {count} 条记录",
    "search.empty": "没有找到匹配结果",
    "search.hint": "↑↓ 选择 · Enter 跳转 · Esc 关闭",
    "search.count": "共 {total} 条匹配（索引 {indexed} 条）",
    "search.jumped": "已跳转到 {target}",
  },
  en: {
    "search.menuLabel": "Search Everywhere (⌘⇧F)",
    "search.cmdOpen": "Search Everywhere (Logs, Chat, Outputs)",
    "search.placeholder": "Search chat transcripts, terminal scrollback, notebook/runner outputs & job logs…",
    "search.scope.all": "All",
    "search.scope.chat": "Chat",
    "search.scope.terminal": "Terminal",
    "search.scope.notebook": "Notebook / Runner",
    "search.scope.jobs": "Jobs",
    "search.allSessions": "All sessions",
    "search.reindex": "Reindex",
    "search.reindexed": "Indexed {count} items",
    "search.empty": "No matching results found",
    "search.hint": "↑↓ navigate · Enter jump · Esc close",
    "search.count": "{total} matches ({indexed} indexed)",
    "search.jumped": "Jumped to {target}",
  },
};

const SCOPES = ["all", "chat", "terminal", "notebook", "jobs"];

function fmt(template, vars = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function renderHighlightedSnippet(container, snippet, highlights) {
  const text = String(snippet || "");
  if (!Array.isArray(highlights) || highlights.length === 0) {
    container.textContent = text;
    return;
  }
  let cursor = 0;
  for (const h of highlights) {
    const start = Math.max(cursor, Math.min(text.length, Number(h.start) || 0));
    const end = Math.max(start, Math.min(text.length, Number(h.end) || start));
    if (start > cursor) container.append(document.createTextNode(text.slice(cursor, start)));
    if (end > start) {
      const mark = document.createElement("mark");
      mark.className = "search-hl";
      mark.textContent = text.slice(start, end);
      container.append(mark);
    }
    cursor = end;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

export async function init(api) {
  api.registerStrings(STRINGS);
  const t = (key, vars) => fmt(api.tr(key), vars);

  let dialog = null;
  let elInput = null;
  let elResults = null;
  let elCount = null;
  let elSessionSelect = null;
  let scopeButtons = new Map();

  let currentScope = "all";
  let currentSession = "";
  let results = [];
  let activeIdx = 0;
  let debounceTimer = null;
  let reqSeq = 0;

  function syncSessionDropdown() {
    if (!elSessionSelect) return;
    const prev = currentSession;
    elSessionSelect.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = t("search.allSessions");
    elSessionSelect.append(allOpt);
    const sessions = Array.isArray(api.state?.sessions) ? api.state.sessions : [];
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.name;
      opt.textContent = s.name;
      elSessionSelect.append(opt);
    }
    elSessionSelect.value = sessions.some((s) => s.name === prev) ? prev : "";
    currentSession = elSessionSelect.value;
  }

  function jumpToResult(item) {
    if (!item) return;
    const target = item.target || {};
    closeModal();

    if (target.session) {
      const sessBtn = document.querySelector(`.session-item[data-session="${CSS.escape(target.session)}"]`);
      if (sessBtn) sessBtn.click();
    }

    if (target.type === "thread" && target.threadId) {
      api.emit("search:open-thread", { threadId: target.threadId, entryIndex: target.entryIndex });
      if (typeof window.__colabDeskAgentx?.jumpToThreadMessage === "function") {
        window.__colabDeskAgentx.jumpToThreadMessage(target.threadId, target.entryIndex);
      } else {
        const el = document.querySelector(`.chat-thread-item[data-thread-id="${CSS.escape(target.threadId)}"]`);
        if (el) el.click();
      }
      api.emit("search:jump", { scope: item.scope, target });
      return;
    }

    if (target.type === "terminal") {
      api.emit("terminal:toggle");
      if (target.terminalId) {
        setTimeout(() => {
          const tab = document.querySelector(`.term-tab[data-term-id="${CSS.escape(target.terminalId)}"]`);
          if (tab) tab.click();
        }, 60);
      }
      api.emit("search:jump", { scope: item.scope, target });
      return;
    }

    api.emit("search:jump", { scope: item.scope, target });
    api.showToast(t("search.jumped", { target: item.title || target.session || item.scope }));
  }

  function renderResults(total = 0, indexedDocs = 0) {
    if (!elResults) return;
    elResults.replaceChildren();
    elCount.textContent = t("search.count", { total, indexed: indexedDocs });

    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = t("search.empty");
      elResults.append(empty);
      return;
    }

    activeIdx = Math.max(0, Math.min(activeIdx, results.length - 1));
    results.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item" + (idx === activeIdx ? " is-active" : "");
      btn.dataset.idx = String(idx);

      const head = document.createElement("div");
      head.className = "search-item-head";

      const left = document.createElement("div");
      left.className = "search-item-left";
      const badge = document.createElement("span");
      badge.className = `search-badge is-${item.scope || "chat"}`;
      badge.textContent = t(`search.scope.${item.scope}`) || item.scope;
      const title = document.createElement("span");
      title.className = "search-item-title";
      title.textContent = item.title || item.id;
      left.append(badge, title);

      const meta = document.createElement("span");
      meta.className = "search-item-meta";
      meta.textContent = [item.session, formatTime(item.timestamp)].filter(Boolean).join(" · ");
      head.append(left, meta);

      const snip = document.createElement("div");
      snip.className = "search-snippet";
      renderHighlightedSnippet(snip, item.snippet, item.highlights);

      btn.append(head, snip);
      btn.addEventListener("mouseenter", () => {
        activeIdx = idx;
        updateActiveHighlight();
      });
      btn.addEventListener("click", () => jumpToResult(item));
      elResults.append(btn);
    });
  }

  function updateActiveHighlight() {
    if (!elResults) return;
    const nodes = elResults.querySelectorAll(".search-item");
    nodes.forEach((node, i) => {
      const on = i === activeIdx;
      node.classList.toggle("is-active", on);
      if (on) node.scrollIntoView({ block: "nearest" });
    });
  }

  async function runQuery() {
    const seq = ++reqSeq;
    const params = new URLSearchParams();
    params.set("q", elInput?.value || "");
    params.set("scope", currentScope);
    if (currentSession) params.set("session", currentSession);
    params.set("limit", "40");
    try {
      const data = await api.fetchJson(`/api/search?${params.toString()}`);
      if (seq !== reqSeq) return;
      results = Array.isArray(data?.results) ? data.results : [];
      activeIdx = 0;
      renderResults(data?.total || 0, data?.indexedDocs || 0);
    } catch {
      if (seq !== reqSeq) return;
      results = [];
      renderResults(0, 0);
    }
  }

  function scheduleQuery() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runQuery, 120);
  }

  function ensureModal() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "search-modal";
    dialog.className = "wide-modal search-modal";

    const shell = document.createElement("div");
    shell.className = "search-shell";

    // Input row
    const inputRow = document.createElement("div");
    inputRow.className = "search-input-row";
    inputRow.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    elInput = document.createElement("input");
    elInput.type = "search";
    elInput.className = "search-query-input";
    elInput.placeholder = t("search.placeholder");
    elInput.addEventListener("input", scheduleQuery);
    elInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (results.length) {
          activeIdx = (activeIdx + 1) % results.length;
          updateActiveHighlight();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (results.length) {
          activeIdx = (activeIdx - 1 + results.length) % results.length;
          updateActiveHighlight();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[activeIdx]) jumpToResult(results[activeIdx]);
      }
    });
    const kbd = document.createElement("span");
    kbd.className = "search-kbd";
    kbd.textContent = "ESC";
    inputRow.append(elInput, kbd);

    // Filter bar
    const filters = document.createElement("div");
    filters.className = "search-filters";
    const scopesEl = document.createElement("div");
    scopesEl.className = "search-scopes";
    for (const sc of SCOPES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "search-scope-btn" + (sc === currentScope ? " is-active" : "");
      b.dataset.scope = sc;
      b.dataset.i18n = `search.scope.${sc}`;
      b.textContent = t(`search.scope.${sc}`);
      b.addEventListener("click", () => {
        currentScope = sc;
        for (const [k, btn] of scopeButtons.entries()) btn.classList.toggle("is-active", k === sc);
        runQuery();
      });
      scopeButtons.set(sc, b);
      scopesEl.append(b);
    }

    const filterRight = document.createElement("div");
    filterRight.className = "search-filter-right";
    elSessionSelect = document.createElement("select");
    elSessionSelect.className = "search-session-select";
    elSessionSelect.addEventListener("change", () => {
      currentSession = elSessionSelect.value;
      runQuery();
    });

    const btnReindex = document.createElement("button");
    btnReindex.type = "button";
    btnReindex.className = "search-scope-btn";
    btnReindex.dataset.i18n = "search.reindex";
    btnReindex.textContent = t("search.reindex");
    btnReindex.addEventListener("click", async () => {
      try {
        const res = await api.fetchJson("/api/search/reindex", { method: "POST" });
        api.showToast(t("search.reindexed", { count: res?.totalDocs || 0 }));
        runQuery();
      } catch {}
    });
    filterRight.append(elSessionSelect, btnReindex);
    filters.append(scopesEl, filterRight);

    // Results
    elResults = document.createElement("div");
    elResults.className = "search-results";

    // Footer
    const foot = document.createElement("div");
    foot.className = "search-foot";
    elCount = document.createElement("span");
    const hint = document.createElement("span");
    hint.dataset.i18n = "search.hint";
    hint.textContent = t("search.hint");
    foot.append(elCount, hint);

    shell.append(inputRow, filters, elResults, foot);
    dialog.append(shell);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) closeModal();
    });
    document.body.append(dialog);
    return dialog;
  }

  function openModal() {
    ensureModal();
    syncSessionDropdown();
    if (!dialog.open) dialog.showModal();
    elInput.focus();
    elInput.select();
    runQuery();
  }

  function closeModal() {
    if (dialog?.open) dialog.close();
  }

  // Global shortcut: Cmd+Shift+F / Ctrl+Shift+F
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      if (dialog?.open) closeModal();
      else openModal();
    }
  });

  // Mount quick entry in workspace-tools dropdown
  const menuBtn = document.createElement("button");
  menuBtn.id = "open-search-btn";
  menuBtn.className = "tools-dropdown-item";
  menuBtn.type = "button";
  menuBtn.setAttribute("role", "menuitem");
  menuBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  const labelSpan = document.createElement("span");
  labelSpan.dataset.i18n = "search.menuLabel";
  labelSpan.textContent = t("search.menuLabel");
  menuBtn.append(labelSpan);
  menuBtn.addEventListener("click", () => {
    const menu = document.getElementById("tools-dropdown-menu");
    if (menu) menu.hidden = true;
    openModal();
  });
  api.mount("workspace-tools", menuBtn);

  // Command palette entry
  api.registerCommand({
    id: "search:open",
    title: () => api.tr("search.cmdOpen"),
    kbd: "⌘⇧F",
    run: () => openModal(),
  });

  api.on("search:open", openModal);
  window.__colabDeskSearch = { open: openModal, close: closeModal };
}

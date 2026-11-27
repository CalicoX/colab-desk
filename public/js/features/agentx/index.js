import { dom } from "../../dom.js";
import { currentTranscriptKey, desk, state } from "../../state.js";
import { jumpToThreadMessage, renderChatThreads } from "../../threads.js";
import { searchWithinEntries } from "./search-index.js";
import { AGENTX_STRINGS } from "./strings.js";

function parseKeyValueLines(raw, sep = "=") {
  const out = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function formatKeyValueLines(obj = {}, sep = "=") {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}${sep === ":" ? ": " : "="}${v}`)
    .join("\n");
}

function tplLabel(tpl, lang) {
  if (!tpl) return "";
  return lang === "en" ? (tpl.nameEn || tpl.name) : (tpl.name || tpl.nameEn);
}

function tplDesc(tpl, lang) {
  if (!tpl) return "";
  return lang === "en" ? (tpl.descriptionEn || tpl.description || "") : (tpl.description || tpl.descriptionEn || "");
}

function tplContent(tpl, lang) {
  if (!tpl) return "";
  return lang === "en" ? (tpl.contentEn || tpl.content || "") : (tpl.content || tpl.contentEn || "");
}

export async function init(api) {
  api.registerStrings(AGENTX_STRINGS);
  const t = (key, vars) => {
    let s = api.tr(key);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    }
    return s;
  };
  const lang = () => (state.activeLang === "en" ? "en" : "zh-CN");

  let mcpServers = [];
  let templates = [];
  let editingServerId = null;
  let editingTemplateId = null;

  state.agentxThreadTemplates = state.agentxThreadTemplates || {};
  state.agentxSearchFilters = state.agentxSearchFilters || { provider: "", sinceMs: 0 };

  function currentScopeKey() {
    return state.activeThreadId || state.selected || "";
  }

  function currentAssignedTemplateId() {
    const scope = currentScopeKey();
    if (state.activeThreadId && state.agentxThreadTemplates[state.activeThreadId]) {
      return state.agentxThreadTemplates[state.activeThreadId];
    }
    if (!state.activeThreadId && state.agentxPendingTemplateId) {
      return state.agentxPendingTemplateId;
    }
    if (scope && state.agentxThreadTemplates[scope]) return state.agentxThreadTemplates[scope];
    return "";
  }

  async function refreshMcp() {
    try {
      const data = await api.fetchJson("/api/agentx/mcp/servers");
      if (data?.ok && Array.isArray(data.servers)) mcpServers = data.servers;
    } catch {}
    renderMcpPane();
  }

  async function refreshTemplates() {
    try {
      const data = await api.fetchJson("/api/agentx/templates");
      if (data?.ok) {
        templates = Array.isArray(data.templates) ? data.templates : [];
        state.agentxThreadTemplates = data.assignments || {};
      }
    } catch {}
    renderTemplatesPane();
    syncTemplatePickerLabel();
  }

  async function assignTemplateToCurrent(templateId) {
    const tid = String(templateId || "");
    const scope = state.activeThreadId || "";
    if (!scope) {
      state.agentxPendingTemplateId = tid;
      syncTemplatePickerLabel();
      renderTemplatesPane();
      const tpl = templates.find((x) => x.id === tid);
      api.showToast(tpl ? t("agentx.tpl.appliedToast", { name: tplLabel(tpl, lang()) }) : t("agentx.tpl.clearedToast"));
      return;
    }
    try {
      const res = await api.fetchJson("/api/agentx/templates/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeKey: scope, templateId: tid }),
      });
      if (res?.ok) {
        state.agentxThreadTemplates = res.assignments || state.agentxThreadTemplates;
        syncTemplatePickerLabel();
        renderTemplatesPane();
        const tpl = templates.find((x) => x.id === tid);
        api.showToast(tpl ? t("agentx.tpl.appliedToast", { name: tplLabel(tpl, lang()) }) : t("agentx.tpl.clearedToast"));
      }
    } catch {}
  }

  // ── 1. Settings Tab: MCP & Tools ──
  const mcpPane = document.createElement("div");
  mcpPane.className = "agentx-pane";

  function renderMcpPane() {
    mcpPane.replaceChildren();

    const head = document.createElement("div");
    head.className = "agentx-head";
    const h3 = document.createElement("h3");
    h3.textContent = t("agentx.mcp.heading");
    const sub = document.createElement("p");
    sub.className = "agentx-sub";
    sub.textContent = t("agentx.mcp.subtitle");
    head.append(h3, sub);

    const warn = document.createElement("div");
    warn.className = "agentx-warn";
    const wTitle = document.createElement("strong");
    wTitle.textContent = `⚠ ${t("agentx.mcp.warningTitle")}`;
    const wBody = document.createElement("p");
    wBody.textContent = t("agentx.mcp.warningBody");
    warn.append(wTitle, wBody);

    const listWrap = document.createElement("div");
    listWrap.className = "agentx-list";
    if (!mcpServers.length) {
      const empty = document.createElement("div");
      empty.className = "agentx-empty";
      empty.textContent = t("agentx.mcp.empty");
      listWrap.append(empty);
    } else {
      for (const srv of mcpServers) {
        const card = document.createElement("div");
        card.className = "agentx-card";

        const top = document.createElement("div");
        top.className = "agentx-card-top";

        const info = document.createElement("div");
        info.className = "agentx-card-info";
        const nameLine = document.createElement("div");
        nameLine.className = "agentx-card-title";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = srv.name;
        const typeBadge = document.createElement("span");
        typeBadge.className = "agentx-badge";
        typeBadge.textContent = srv.type.toUpperCase();
        const statusBadge = document.createElement("span");
        statusBadge.className = `agentx-status is-${srv.status || "disabled"}`;
        const statusKey =
          srv.status === "connected" ? "agentx.mcp.statusConnected"
            : srv.status === "error" ? "agentx.mcp.statusError"
              : srv.status === "idle" ? "agentx.mcp.statusIdle"
                : "agentx.mcp.statusDisabled";
        statusBadge.textContent = t(statusKey);
        nameLine.append(nameSpan, typeBadge, statusBadge);

        const targetLine = document.createElement("div");
        targetLine.className = "agentx-card-meta";
        targetLine.textContent = srv.type === "http"
          ? srv.url
          : [srv.command, ...(srv.args || [])].join(" ");
        info.append(nameLine, targetLine);

        if (srv.error) {
          const errEl = document.createElement("div");
          errEl.className = "agentx-card-error";
          errEl.textContent = srv.error;
          info.append(errEl);
        }
        if (Array.isArray(srv.tools) && srv.tools.length > 0) {
          const toolsEl = document.createElement("div");
          toolsEl.className = "agentx-tools-chips";
          const cnt = document.createElement("span");
          cnt.className = "agentx-badge";
          cnt.textContent = t("agentx.mcp.toolsCount", { count: srv.tools.length });
          toolsEl.append(cnt);
          for (const tool of srv.tools.slice(0, 8)) {
            const chip = document.createElement("span");
            chip.className = "agentx-tool-chip";
            chip.textContent = tool.name;
            chip.title = tool.description || tool.name;
            toolsEl.append(chip);
          }
          info.append(toolsEl);
        }

        const acts = document.createElement("div");
        acts.className = "agentx-card-actions";

        const toggleLbl = document.createElement("label");
        toggleLbl.className = "agentx-toggle";
        const toggleChk = document.createElement("input");
        toggleChk.type = "checkbox";
        toggleChk.checked = Boolean(srv.enabled);
        toggleChk.addEventListener("change", async () => {
          await api.fetchJson(`/api/agentx/mcp/servers/${encodeURIComponent(srv.id)}/toggle`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: toggleChk.checked }),
          });
          await refreshMcp();
        });
        const toggleTxt = document.createElement("span");
        toggleTxt.textContent = srv.enabled ? t("agentx.mcp.enabled") : t("agentx.mcp.disabled");
        toggleLbl.append(toggleChk, toggleTxt);

        const testBtn = document.createElement("button");
        testBtn.type = "button";
        testBtn.className = "s-btn";
        testBtn.textContent = t("agentx.mcp.test");
        testBtn.addEventListener("click", async () => {
          testBtn.disabled = true;
          testBtn.textContent = t("agentx.mcp.testing");
          try {
            const res = await api.fetchJson(`/api/agentx/mcp/servers/${encodeURIComponent(srv.id)}/test`, { method: "POST" });
            if (res?.ok) api.showToast(t("agentx.mcp.testOk", { count: (res.tools || []).length }));
            else api.showToast(t("agentx.mcp.testFail", { error: res?.error || "error" }));
          } catch (err) {
            api.showToast(t("agentx.mcp.testFail", { error: err.message }));
          }
          await refreshMcp();
        });

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "s-btn";
        editBtn.textContent = t("agentx.mcp.edit");
        editBtn.addEventListener("click", () => {
          editingServerId = srv.id;
          renderMcpPane();
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "s-btn is-danger";
        delBtn.textContent = t("agentx.mcp.delete");
        delBtn.addEventListener("click", async () => {
          await api.fetchJson(`/api/agentx/mcp/servers/${encodeURIComponent(srv.id)}`, { method: "DELETE" });
          if (editingServerId === srv.id) editingServerId = null;
          api.showToast(t("agentx.mcp.deletedToast"));
          await refreshMcp();
        });

        acts.append(toggleLbl, testBtn, editBtn, delBtn);
        top.append(info, acts);
        card.append(top);
        listWrap.append(card);
      }
    }

    // Add / Edit form
    const editing = editingServerId ? mcpServers.find((s) => s.id === editingServerId) : null;
    const form = document.createElement("form");
    form.className = "agentx-form";
    const fh = document.createElement("h4");
    fh.textContent = t("agentx.mcp.addHeading");

    const row1 = document.createElement("div");
    row1.className = "agentx-form-row";
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "agentx-input";
    nameIn.required = true;
    nameIn.placeholder = t("agentx.mcp.namePlaceholder");
    nameIn.value = editing?.name || "";

    const typeSel = document.createElement("select");
    typeSel.className = "agentx-select";
    const optStdio = document.createElement("option");
    optStdio.value = "stdio";
    optStdio.textContent = t("agentx.mcp.transportStdio");
    const optHttp = document.createElement("option");
    optHttp.value = "http";
    optHttp.textContent = t("agentx.mcp.transportHttp");
    typeSel.append(optStdio, optHttp);
    typeSel.value = editing?.type || "stdio";

    row1.append(
      wrapField(t("agentx.mcp.name"), nameIn),
      wrapField(t("agentx.mcp.transport"), typeSel),
    );

    const stdioBox = document.createElement("div");
    stdioBox.className = "agentx-form-group";
    const cmdIn = document.createElement("input");
    cmdIn.type = "text";
    cmdIn.className = "agentx-input";
    cmdIn.placeholder = t("agentx.mcp.commandPlaceholder");
    cmdIn.value = editing?.command || "";
    const argsIn = document.createElement("textarea");
    argsIn.className = "agentx-textarea";
    argsIn.rows = 2;
    argsIn.placeholder = t("agentx.mcp.argsPlaceholder");
    argsIn.value = Array.isArray(editing?.args) ? editing.args.join("\n") : "";
    const envIn = document.createElement("textarea");
    envIn.className = "agentx-textarea";
    envIn.rows = 2;
    envIn.placeholder = "API_KEY=...";
    envIn.value = formatKeyValueLines(editing?.env, "=");
    stdioBox.append(
      wrapField(t("agentx.mcp.command"), cmdIn),
      wrapField(t("agentx.mcp.args"), argsIn),
      wrapField(t("agentx.mcp.env"), envIn),
    );

    const httpBox = document.createElement("div");
    httpBox.className = "agentx-form-group";
    const urlIn = document.createElement("input");
    urlIn.type = "url";
    urlIn.className = "agentx-input";
    urlIn.placeholder = t("agentx.mcp.urlPlaceholder");
    urlIn.value = editing?.url || "";
    const hdrIn = document.createElement("textarea");
    hdrIn.className = "agentx-textarea";
    hdrIn.rows = 2;
    hdrIn.placeholder = "Authorization: Bearer ...";
    hdrIn.value = formatKeyValueLines(editing?.headers, ":");
    httpBox.append(
      wrapField(t("agentx.mcp.url"), urlIn),
      wrapField(t("agentx.mcp.headers"), hdrIn),
    );

    const syncTransport = () => {
      const isHttp = typeSel.value === "http";
      stdioBox.hidden = isHttp;
      httpBox.hidden = !isHttp;
    };
    typeSel.addEventListener("change", syncTransport);
    syncTransport();

    const enLbl = document.createElement("label");
    enLbl.className = "agentx-check";
    const enChk = document.createElement("input");
    enChk.type = "checkbox";
    enChk.checked = editing ? Boolean(editing.enabled) : false;
    const enSpan = document.createElement("span");
    enSpan.textContent = t("agentx.mcp.enableOnSave");
    enLbl.append(enChk, enSpan);

    const formActs = document.createElement("div");
    formActs.className = "agentx-form-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "s-btn is-primary";
    saveBtn.textContent = t("agentx.mcp.save");
    formActs.append(saveBtn);
    if (editing) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "s-btn";
      cancelBtn.textContent = t("agentx.mcp.cancelEdit");
      cancelBtn.addEventListener("click", () => {
        editingServerId = null;
        renderMcpPane();
      });
      formActs.append(cancelBtn);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const isHttp = typeSel.value === "http";
      const payload = {
        name: nameIn.value.trim(),
        type: typeSel.value,
        enabled: enChk.checked,
      };
      if (isHttp) {
        payload.url = urlIn.value.trim();
        payload.headers = parseKeyValueLines(hdrIn.value, ":");
      } else {
        payload.command = cmdIn.value.trim();
        payload.args = argsIn.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        payload.env = parseKeyValueLines(envIn.value, "=");
      }
      const endpoint = editing
        ? `/api/agentx/mcp/servers/${encodeURIComponent(editing.id)}`
        : "/api/agentx/mcp/servers";
      const res = await api.fetchJson(endpoint, {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res?.ok) {
        api.showToast(res?.error || "Error");
        return;
      }
      editingServerId = null;
      api.showToast(t("agentx.mcp.savedToast"));
      await refreshMcp();
    });

    form.append(fh, row1, stdioBox, httpBox, enLbl, formActs);
    mcpPane.append(head, warn, listWrap, form);
  }

  api.mount("settings-pane", {
    id: "agentx-mcp",
    title: { "zh-CN": AGENTX_STRINGS["zh-CN"]["agentx.mcp.tabTitle"], en: AGENTX_STRINGS.en["agentx.mcp.tabTitle"] },
    element: mcpPane,
  });

  // ── 2. Settings Tab: Prompt Templates ──
  const tplPane = document.createElement("div");
  tplPane.className = "agentx-pane";

  function renderTemplatesPane() {
    tplPane.replaceChildren();
    const curLang = lang();
    const activeId = currentAssignedTemplateId();

    const head = document.createElement("div");
    head.className = "agentx-head";
    const h3 = document.createElement("h3");
    h3.textContent = t("agentx.tpl.heading");
    const sub = document.createElement("p");
    sub.className = "agentx-sub";
    sub.textContent = t("agentx.tpl.subtitle");
    head.append(h3, sub);

    const listWrap = document.createElement("div");
    listWrap.className = "agentx-list";
    for (const tpl of templates) {
      const card = document.createElement("div");
      card.className = `agentx-card${tpl.id === activeId ? " is-active" : ""}`;

      const top = document.createElement("div");
      top.className = "agentx-card-top";
      const info = document.createElement("div");
      info.className = "agentx-card-info";

      const titleLine = document.createElement("div");
      titleLine.className = "agentx-card-title";
      const nm = document.createElement("span");
      nm.textContent = tplLabel(tpl, curLang);
      const badge = document.createElement("span");
      badge.className = "agentx-badge";
      badge.textContent = tpl.builtin ? t("agentx.tpl.builtinBadge") : t("agentx.tpl.customBadge");
      titleLine.append(nm, badge);
      if (tpl.id === activeId) {
        const actBadge = document.createElement("span");
        actBadge.className = "agentx-status is-connected";
        actBadge.textContent = t("agentx.tpl.activeBadge");
        titleLine.append(actBadge);
      }

      const descEl = document.createElement("div");
      descEl.className = "agentx-card-meta";
      descEl.textContent = tplDesc(tpl, curLang) || tplContent(tpl, curLang).slice(0, 110);
      info.append(titleLine, descEl);

      const acts = document.createElement("div");
      acts.className = "agentx-card-actions";
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = `s-btn${tpl.id === activeId ? " is-primary" : ""}`;
      useBtn.textContent = tpl.id === activeId ? t("agentx.tpl.activeBadge") : t("agentx.tpl.useHere");
      useBtn.addEventListener("click", () => assignTemplateToCurrent(tpl.id === activeId ? "" : tpl.id));
      acts.append(useBtn);

      if (tpl.builtin) {
        const dupBtn = document.createElement("button");
        dupBtn.type = "button";
        dupBtn.className = "s-btn";
        dupBtn.textContent = t("agentx.tpl.duplicate");
        dupBtn.addEventListener("click", async () => {
          const res = await api.fetchJson("/api/agentx/templates", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: `${tplLabel(tpl, curLang)} (Copy)`,
              description: tplDesc(tpl, curLang),
              content: tplContent(tpl, curLang),
            }),
          });
          if (res?.ok) {
            api.showToast(t("agentx.tpl.savedToast"));
            await refreshTemplates();
          }
        });
        acts.append(dupBtn);
      } else {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "s-btn";
        editBtn.textContent = t("agentx.tpl.edit");
        editBtn.addEventListener("click", () => {
          editingTemplateId = tpl.id;
          renderTemplatesPane();
        });
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "s-btn is-danger";
        delBtn.textContent = t("agentx.tpl.delete");
        delBtn.addEventListener("click", async () => {
          await api.fetchJson(`/api/agentx/templates/${encodeURIComponent(tpl.id)}`, { method: "DELETE" });
          if (editingTemplateId === tpl.id) editingTemplateId = null;
          api.showToast(t("agentx.tpl.deletedToast"));
          await refreshTemplates();
        });
        acts.append(editBtn, delBtn);
      }

      top.append(info, acts);
      card.append(top);
      listWrap.append(card);
    }

    const editing = editingTemplateId ? templates.find((x) => x.id === editingTemplateId && !x.builtin) : null;
    const form = document.createElement("form");
    form.className = "agentx-form";
    const fh = document.createElement("h4");
    fh.textContent = t("agentx.tpl.formHeading");

    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "agentx-input";
    nameIn.required = true;
    nameIn.placeholder = t("agentx.tpl.namePlaceholder");
    nameIn.value = editing ? tplLabel(editing, curLang) : "";

    const descIn = document.createElement("input");
    descIn.type = "text";
    descIn.className = "agentx-input";
    descIn.placeholder = t("agentx.tpl.descPlaceholder");
    descIn.value = editing ? tplDesc(editing, curLang) : "";

    const bodyIn = document.createElement("textarea");
    bodyIn.className = "agentx-textarea";
    bodyIn.rows = 4;
    bodyIn.required = true;
    bodyIn.placeholder = t("agentx.tpl.contentPlaceholder");
    bodyIn.value = editing ? tplContent(editing, curLang) : "";

    const formActs = document.createElement("div");
    formActs.className = "agentx-form-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "s-btn is-primary";
    saveBtn.textContent = t("agentx.tpl.save");
    formActs.append(saveBtn);
    if (editing) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "s-btn";
      cancelBtn.textContent = t("agentx.tpl.cancelEdit");
      cancelBtn.addEventListener("click", () => {
        editingTemplateId = null;
        renderTemplatesPane();
      });
      formActs.append(cancelBtn);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        name: nameIn.value.trim(),
        description: descIn.value.trim(),
        content: bodyIn.value.trim(),
      };
      const endpoint = editing
        ? `/api/agentx/templates/${encodeURIComponent(editing.id)}`
        : "/api/agentx/templates";
      const res = await api.fetchJson(endpoint, {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res?.ok) {
        api.showToast(res?.error || "Error");
        return;
      }
      editingTemplateId = null;
      api.showToast(t("agentx.tpl.savedToast"));
      await refreshTemplates();
    });

    form.append(
      fh,
      wrapField(t("agentx.tpl.name"), nameIn),
      wrapField(t("agentx.tpl.desc"), descIn),
      wrapField(t("agentx.tpl.content"), bodyIn),
      formActs,
    );
    tplPane.append(head, listWrap, form);
  }

  api.mount("settings-pane", {
    id: "agentx-templates",
    title: { "zh-CN": AGENTX_STRINGS["zh-CN"]["agentx.tpl.tabTitle"], en: AGENTX_STRINGS.en["agentx.tpl.tabTitle"] },
    element: tplPane,
  });

  // ── 3. Composer Template Picker ──
  let tplPickerBtn = null;
  let tplPickerMenu = null;
  function mountComposerTemplatePicker() {
    if (!dom.agentControls || document.getElementById("agentx-tpl-picker-wrap")) return;
    const wrap = document.createElement("div");
    wrap.id = "agentx-tpl-picker-wrap";
    wrap.className = "agentx-tpl-picker-wrap";

    const btn = document.createElement("button");
    btn.id = "agentx-tpl-picker-btn";
    btn.type = "button";
    btn.className = "pill-toggle agentx-tpl-btn";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.title = t("agentx.tpl.pickerTitle");
    tplPickerBtn = btn;

    const menu = document.createElement("div");
    menu.id = "agentx-tpl-picker-menu";
    menu.className = "agentx-tpl-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    tplPickerMenu = menu;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      if (willOpen) renderTemplatePickerMenu();
      menu.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) {
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });

    wrap.append(btn, menu);
    const anchor = dom.attachFileBtn;
    if (anchor && anchor.parentElement === dom.agentControls) {
      dom.agentControls.insertBefore(wrap, anchor);
    } else {
      dom.agentControls.append(wrap);
    }
    syncTemplatePickerLabel();
  }

  function syncTemplatePickerLabel() {
    if (!tplPickerBtn) return;
    const curLang = lang();
    const tid = currentAssignedTemplateId();
    const tpl = templates.find((x) => x.id === tid);
    tplPickerBtn.textContent = tpl ? `✦ ${tplLabel(tpl, curLang)}` : `✦ ${t("agentx.tpl.tabTitle")}`;
    tplPickerBtn.classList.toggle("is-active", Boolean(tpl));
    tplPickerBtn.title = t("agentx.tpl.pickerTitle");
  }

  function renderTemplatePickerMenu() {
    if (!tplPickerMenu) return;
    tplPickerMenu.replaceChildren();
    const curLang = lang();
    const activeId = currentAssignedTemplateId();

    const addItem = (label, isSel, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ap-item${isSel ? " is-selected" : ""}`;
      const chk = document.createElement("span");
      chk.className = "ap-item-check";
      chk.textContent = isSel ? "✓" : "";
      const lbl = document.createElement("span");
      lbl.className = "ap-item-label";
      lbl.textContent = label;
      b.append(chk, lbl);
      b.addEventListener("click", () => {
        tplPickerMenu.hidden = true;
        tplPickerBtn?.setAttribute("aria-expanded", "false");
        onClick();
      });
      tplPickerMenu.append(b);
    };

    addItem(t("agentx.tpl.none"), !activeId, () => assignTemplateToCurrent(""));
    for (const tpl of templates) {
      addItem(tplLabel(tpl, curLang), tpl.id === activeId, () => assignTemplateToCurrent(tpl.id));
    }
    const div = document.createElement("div");
    div.className = "ap-divider";
    const manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.className = "ap-manage-btn";
    manageBtn.textContent = `⚙ ${t("agentx.tpl.manage")}`;
    manageBtn.addEventListener("click", () => {
      tplPickerMenu.hidden = true;
      api.emit("ui:open-settings", "agentx-templates");
    });
    tplPickerMenu.append(div, manageBtn);
  }

  // ── 4. Sidebar Full-Text Search Filters (Compact Icon + Multi-level Popover) ──
  let filterBar = null;
  let filterBtn = null;
  let filterBadgeEl = null;
  let filterMenu = null;
  let filterLastMeta = { total: 0, hasFilter: false };
  let selectedDateRangeMs = 0;

  function mountSidebarSearchFilters() {
    if (!dom.chatThreadsListEl || document.getElementById("agentx-filter-btn")) return;

    const chatsHead = dom.newChatThreadBtn?.closest(".sidebar-section-head")
      || dom.chatThreadsListEl.previousElementSibling;

    const btn = document.createElement("button");
    btn.id = "agentx-filter-btn";
    btn.type = "button";
    btn.className = "agentx-filter-icon-btn";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.title = t("agentx.search.filterToggle");
    btn.setAttribute("aria-label", t("agentx.search.filterToggle"));
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;
    const badge = document.createElement("span");
    badge.id = "agentx-filter-badge";
    badge.className = "agentx-filter-badge";
    badge.hidden = true;
    btn.append(badge);
    filterBtn = btn;
    filterBadgeEl = badge;

    if (chatsHead && dom.newChatThreadBtn && chatsHead.contains(dom.newChatThreadBtn)) {
      const actions = document.createElement("div");
      actions.className = "agentx-chats-head-actions";
      chatsHead.insertBefore(actions, dom.newChatThreadBtn);
      actions.append(btn, dom.newChatThreadBtn);
    } else if (chatsHead) {
      chatsHead.append(btn);
    }

    // Compact active-filter pill strip (hidden when no filter/search active)
    const bar = document.createElement("div");
    bar.id = "agentx-sidebar-filters";
    bar.className = "agentx-sidebar-filters";
    bar.hidden = true;
    filterBar = bar;
    dom.chatThreadsListEl.parentElement.insertBefore(bar, dom.chatThreadsListEl);

    // Floating multi-level popover menu (mounted on body to avoid sidebar overflow clipping)
    const menu = document.createElement("div");
    menu.id = "agentx-filter-menu";
    menu.className = "agentx-filter-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    document.body.append(menu);
    filterMenu = menu;

    const providerOptions = () => [
      ["", t("agentx.search.providerAll")],
      ["agy", "AGY"],
      ["grok", "Grok"],
      ["opencode", "OpenCode"],
      ["api", t("agentx.search.providerApi")],
    ];
    const dateOptions = () => [
      ["0", t("agentx.search.dateAll")],
      ["86400000", t("agentx.search.date24h")],
      ["604800000", t("agentx.search.date7d")],
      ["2592000000", t("agentx.search.date30d")],
    ];

    const activeFilterCount = () => (state.agentxSearchFilters.provider ? 1 : 0) + (selectedDateRangeMs > 0 ? 1 : 0);

    const providerLabel = (val) => providerOptions().find(([v]) => v === val)?.[1] || t("agentx.search.providerAll");
    const dateLabel = (ms) => dateOptions().find(([v]) => Number(v) === Number(ms))?.[1] || t("agentx.search.dateAll");

    const closeFilterMenu = () => {
      if (!filterMenu || filterMenu.hidden) return;
      filterMenu.hidden = true;
      filterBtn?.setAttribute("aria-expanded", "false");
    };

    const positionFilterMenu = () => {
      if (!filterBtn || !filterMenu) return;
      const rect = filterBtn.getBoundingClientRect();
      const menuW = Math.max(filterMenu.offsetWidth || 200, 196);
      let left = rect.left;
      if (left + menuW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - menuW - 8);
      if (left < 8) left = 8;
      let top = rect.bottom + 5;
      const menuH = filterMenu.offsetHeight || 120;
      if (top + menuH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - menuH - 5);
      }
      filterMenu.style.left = `${Math.round(left)}px`;
      filterMenu.style.top = `${Math.round(top)}px`;
      // Check whether level-2 submenus have room to fly out to the right
      const flipLeft = (left + menuW + 170) > window.innerWidth - 8;
      filterMenu.classList.toggle("is-flip-left", flipLeft);
    };

    const syncFilterUi = () => {
      const count = activeFilterCount();
      if (filterBtn) {
        filterBtn.classList.toggle("is-active", count > 0);
        filterBtn.title = t("agentx.search.filterToggle");
        filterBtn.setAttribute("aria-label", t("agentx.search.filterToggle"));
      }
      if (filterBadgeEl) {
        filterBadgeEl.textContent = count > 0 ? String(count) : "";
        filterBadgeEl.hidden = count === 0;
      }

      const hasText = Boolean(dom.filter?.value?.trim());
      const showStrip = count > 0 || hasText;
      if (filterBar) {
        filterBar.hidden = !showStrip;
        filterBar.replaceChildren();
        if (showStrip) {
          if (state.agentxSearchFilters.provider) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "agentx-filter-chip";
            chip.textContent = `${providerLabel(state.agentxSearchFilters.provider)} ×`;
            chip.addEventListener("click", () => {
              state.agentxSearchFilters = { ...state.agentxSearchFilters, provider: "" };
              applyAndRefresh();
            });
            filterBar.append(chip);
          }
          if (selectedDateRangeMs > 0) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "agentx-filter-chip";
            chip.textContent = `${dateLabel(selectedDateRangeMs)} ×`;
            chip.addEventListener("click", () => {
              selectedDateRangeMs = 0;
              state.agentxSearchFilters = { ...state.agentxSearchFilters, sinceMs: 0 };
              applyAndRefresh();
            });
            filterBar.append(chip);
          }
          const meta = document.createElement("span");
          meta.className = "agentx-filter-meta";
          meta.textContent = filterLastMeta.hasFilter
            ? t("agentx.search.matchesCount", { count: filterLastMeta.total || 0 })
            : "";
          filterBar.append(meta);

          const clearBtn = document.createElement("button");
          clearBtn.id = "agentx-filter-clear-btn";
          clearBtn.type = "button";
          clearBtn.className = "agentx-filter-clear-x";
          clearBtn.textContent = "×";
          clearBtn.title = t("agentx.search.clearFilters");
          clearBtn.setAttribute("aria-label", t("agentx.search.clearFilters"));
          clearBtn.addEventListener("click", clearAllFilters);
          filterBar.append(clearBtn);
        }
      }
    };

    const applyAndRefresh = () => {
      state.agentxSearchFilters = {
        provider: state.agentxSearchFilters.provider || "",
        sinceMs: selectedDateRangeMs > 0 ? Date.now() - selectedDateRangeMs : 0,
      };
      renderChatThreads(true);
      syncFilterUi();
    };

    const clearAllFilters = () => {
      selectedDateRangeMs = 0;
      if (dom.filter) dom.filter.value = "";
      state.agentxSearchFilters = { provider: "", sinceMs: 0 };
      closeFilterMenu();
      renderChatThreads(true);
      syncFilterUi();
    };

    const renderFilterMenu = () => {
      if (!filterMenu) return;
      filterMenu.replaceChildren();
      const curProv = state.agentxSearchFilters.provider || "";
      const curDate = String(selectedDateRangeMs || 0);
      const categories = [];

      const buildCategory = (groupId, titleText, currentText, isCustom, options, activeVal, onSelect) => {
        const cat = document.createElement("div");
        cat.className = "agentx-fm-cat";
        cat.dataset.filterGroup = groupId;

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "agentx-fm-row";
        trigger.setAttribute("role", "menuitem");
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");

        const lbl = document.createElement("span");
        lbl.className = "agentx-fm-label";
        lbl.textContent = titleText;

        const val = document.createElement("span");
        val.className = `agentx-fm-val${isCustom ? " is-active" : ""}`;
        val.textContent = currentText;

        const chev = document.createElement("span");
        chev.className = "agentx-fm-chev";
        chev.textContent = "▸";

        trigger.append(lbl, val, chev);

        const sub = document.createElement("div");
        sub.className = "agentx-fm-submenu";
        sub.setAttribute("role", "menu");
        sub.hidden = true;

        for (const [optVal, optLabel] of options) {
          const isSel = optVal === activeVal;
          const item = document.createElement("button");
          item.type = "button";
          item.className = `agentx-fm-opt${isSel ? " is-selected" : ""}`;
          item.setAttribute("role", "menuitemradio");
          item.setAttribute("aria-checked", String(isSel));
          item.dataset[groupId === "provider" ? "filterProvider" : "filterDate"] = optVal;

          const chk = document.createElement("span");
          chk.className = "agentx-fm-check";
          chk.textContent = isSel ? "✓" : "";
          const txt = document.createElement("span");
          txt.textContent = optLabel;
          item.append(chk, txt);

          item.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onSelect(optVal);
            closeFilterMenu();
          });
          sub.append(item);
        }

        const setSubOpen = (open) => {
          for (const other of categories) {
            if (other.cat !== cat) {
              other.cat.classList.remove("is-sub-open");
              other.sub.hidden = true;
              other.trigger.setAttribute("aria-expanded", "false");
            }
          }
          cat.classList.toggle("is-sub-open", open);
          sub.hidden = !open;
          trigger.setAttribute("aria-expanded", String(open));
        };

        cat.addEventListener("mouseenter", () => setSubOpen(true));
        trigger.addEventListener("click", (ev) => {
          ev.stopPropagation();
          setSubOpen(sub.hidden);
        });

        categories.push({ cat, sub, trigger });
        cat.append(trigger, sub);
        return cat;
      };

      filterMenu.append(
        buildCategory(
          "provider",
          t("agentx.search.filterProvider"),
          providerLabel(curProv),
          Boolean(curProv),
          providerOptions(),
          curProv,
          (val) => {
            state.agentxSearchFilters = { ...state.agentxSearchFilters, provider: val };
            applyAndRefresh();
          },
        ),
        buildCategory(
          "date",
          t("agentx.search.filterDate"),
          dateLabel(selectedDateRangeMs),
          selectedDateRangeMs > 0,
          dateOptions(),
          curDate,
          (val) => {
            selectedDateRangeMs = Number(val || 0);
            applyAndRefresh();
          },
        ),
      );

      if (activeFilterCount() > 0 || dom.filter?.value?.trim()) {
        const div = document.createElement("div");
        div.className = "agentx-fm-divider";
        const foot = document.createElement("div");
        foot.className = "agentx-fm-foot";
        const clearItem = document.createElement("button");
        clearItem.type = "button";
        clearItem.className = "agentx-fm-clear";
        clearItem.setAttribute("role", "menuitem");
        clearItem.textContent = t("agentx.search.clearFilters");
        clearItem.addEventListener("click", (ev) => {
          ev.stopPropagation();
          clearAllFilters();
        });
        foot.append(clearItem);
        if (filterLastMeta.hasFilter) {
          const cnt = document.createElement("span");
          cnt.className = "agentx-fm-count";
          cnt.textContent = t("agentx.search.matchesCount", { count: filterLastMeta.total || 0 });
          foot.append(cnt);
        }
        filterMenu.append(div, foot);
      }
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = filterMenu.hidden;
      if (willOpen) {
        renderFilterMenu();
        filterMenu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        positionFilterMenu();
      } else {
        closeFilterMenu();
      }
    });

    document.addEventListener("click", (e) => {
      if (!filterMenu.hidden && !filterMenu.contains(e.target) && !btn.contains(e.target)) {
        closeFilterMenu();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !filterMenu.hidden) {
        e.stopPropagation();
        closeFilterMenu();
        btn.focus();
      }
    });
    window.addEventListener("resize", () => {
      if (!filterMenu.hidden) positionFilterMenu();
    });
    dom.chatThreadsListEl.closest(".session-list")?.addEventListener("scroll", () => {
      if (!filterMenu.hidden) closeFilterMenu();
    });

    if (dom.filter) {
      dom.filter.addEventListener("input", () => {
        renderChatThreads(true);
        syncFilterUi();
      });
    }

    api.on("threads:search-meta", ({ total, hasFilter } = {}) => {
      filterLastMeta = { total: total || 0, hasFilter: Boolean(hasFilter) };
      syncFilterUi();
    });
    api.on("language:changed", () => {
      syncFilterUi();
      if (!filterMenu.hidden) renderFilterMenu();
    });
    syncFilterUi();
  }

  // ── 5. In-Thread Search Bar (⌘F) ──
  let findBar = null;
  let findInput = null;
  let findCountEl = null;
  let findHits = [];
  let findCursor = -1;

  function ensureFindBar() {
    if (findBar) return findBar;
    const chatPane = dom.transcript?.parentElement;
    if (!chatPane) return null;

    const bar = document.createElement("div");
    bar.id = "agentx-find-bar";
    bar.className = "agentx-find-bar";
    bar.hidden = true;

    const inp = document.createElement("input");
    inp.type = "search";
    inp.className = "agentx-find-input";
    inp.placeholder = t("agentx.search.inThreadPlaceholder");
    findInput = inp;

    const cnt = document.createElement("span");
    cnt.className = "agentx-find-count";
    findCountEl = cnt;

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "agentx-mini-btn";
    prevBtn.textContent = "↑";
    prevBtn.title = t("agentx.search.prev");

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "agentx-mini-btn";
    nextBtn.textContent = "↓";
    nextBtn.title = t("agentx.search.next");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "agentx-mini-btn";
    closeBtn.textContent = "×";
    closeBtn.title = t("agentx.search.close");

    const runFind = (step = 0) => {
      const key = currentTranscriptKey();
      const entries = Array.isArray(desk.bySession[key]) ? desk.bySession[key] : [];
      findHits = searchWithinEntries(entries, inp.value);
      if (!findHits.length) {
        findCursor = -1;
        cnt.textContent = inp.value.trim() ? "0 / 0" : "";
        return;
      }
      if (step === 0) findCursor = 0;
      else findCursor = (findCursor + step + findHits.length) % findHits.length;
      cnt.textContent = `${findCursor + 1} / ${findHits.length}`;
      const hit = findHits[findCursor];
      if (state.activeThreadId) {
        jumpToThreadMessage(state.activeThreadId, hit.entryIndex);
      } else if (dom.transcript) {
        const el = dom.transcript.querySelectorAll(".entry")[hit.entryIndex];
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };

    inp.addEventListener("input", () => runFind(0));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFindBar();
      }
    });
    prevBtn.addEventListener("click", () => runFind(-1));
    nextBtn.addEventListener("click", () => runFind(1));
    closeBtn.addEventListener("click", () => closeFindBar());

    bar.append(inp, cnt, prevBtn, nextBtn, closeBtn);
    chatPane.insertBefore(bar, dom.transcript);
    findBar = bar;
    return bar;
  }

  function openFindBar() {
    const bar = ensureFindBar();
    if (!bar) return;
    bar.hidden = false;
    if (findInput) {
      findInput.placeholder = t("agentx.search.inThreadPlaceholder");
      findInput.focus();
      findInput.select();
    }
  }

  function closeFindBar() {
    if (findBar) findBar.hidden = true;
    findHits = [];
    findCursor = -1;
  }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      const inDialog = Boolean(document.querySelector("dialog[open]"));
      const inTerminal = Boolean(document.activeElement?.closest(".xterm"));
      if (inDialog || inTerminal) return;
      e.preventDefault();
      openFindBar();
    }
  });

  // ── 6. Register ⌘K Commands ──
  api.registerCommand({
    id: "agentx.findInThread",
    title: { "zh-CN": AGENTX_STRINGS["zh-CN"]["agentx.search.cmdFindInThread"], en: AGENTX_STRINGS.en["agentx.search.cmdFindInThread"] },
    run: () => openFindBar(),
  });
  api.registerCommand({
    id: "agentx.openMcp",
    title: { "zh-CN": AGENTX_STRINGS["zh-CN"]["agentx.search.cmdOpenMcp"], en: AGENTX_STRINGS.en["agentx.search.cmdOpenMcp"] },
    run: () => api.emit("ui:open-settings", "agentx-mcp"),
  });
  api.registerCommand({
    id: "agentx.openTemplates",
    title: { "zh-CN": AGENTX_STRINGS["zh-CN"]["agentx.search.cmdOpenTemplates"], en: AGENTX_STRINGS.en["agentx.search.cmdOpenTemplates"] },
    run: () => api.emit("ui:open-settings", "agentx-templates"),
  });

  // ── 7. Wire events & initial lazy load ──
  mountComposerTemplatePicker();
  mountSidebarSearchFilters();

  api.on("threads:opened", () => {
    syncTemplatePickerLabel();
    renderTemplatesPane();
    closeFindBar();
  });
  api.on("language:changed", () => {
    renderMcpPane();
    renderTemplatesPane();
    syncTemplatePickerLabel();
    if (findInput) findInput.placeholder = t("agentx.search.inThreadPlaceholder");
  });

  await Promise.all([refreshMcp(), refreshTemplates()]);
}

function wrapField(labelText, inputEl) {
  const wrap = document.createElement("label");
  wrap.className = "agentx-field";
  const lbl = document.createElement("span");
  lbl.className = "agentx-field-label";
  lbl.textContent = labelText;
  wrap.append(lbl, inputEl);
  return wrap;
}

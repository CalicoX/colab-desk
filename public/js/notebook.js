import { dom } from "./dom.js";
import { loadJsonStorage, saveJsonStorage, state } from "./state.js";
import { L, escapeHtml, showToast, tr } from "./utils.js";
import { emit, on } from "./events.js";
import { renderMarkdownInto } from "./markdown.js";

/* ── Native Colab Notebook Workbench ── */
export const AUTO_COLLAPSE_LINES = 24;

export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatStartTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function buildExecutionMetadata(cell) {
  const started = cell?.startedAt ? new Date(cell.startedAt) : null;
  if (!started || Number.isNaN(started.getTime())) return {};
  const ex = { "iopub.execute_input": started.toISOString() };
  if (typeof cell.durationMs === "number" && Number.isFinite(cell.durationMs)) {
    const end = new Date(started.getTime() + cell.durationMs).toISOString();
    ex["shell.execute_reply"] = end;
    ex["iopub.status.idle"] = end;
  }
  return { execution: ex };
}

function readExecutionMetadata(meta) {
  const ex = meta && typeof meta === "object" ? meta.execution : null;
  if (!ex || typeof ex !== "object") return { startedAt: null, durationMs: null };
  const start = Date.parse(ex["iopub.execute_input"] || ex["shell.execute_input"] || "");
  if (Number.isNaN(start)) return { startedAt: null, durationMs: null };
  const end = Date.parse(ex["shell.execute_reply"] || ex["iopub.status.idle"] || "");
  return {
    startedAt: new Date(start).toISOString(),
    durationMs: Number.isNaN(end) ? null : Math.max(0, end - start),
  };
}

export function defaultNotebookState() {
  return {
    name: "untitled.ipynb",
    remotePath: "",
    execCounter: 0,
    cells: [
      {
        id: "nb-cell-intro",
        type: "markdown",
        source: "## Colab Desk Notebook\n使用官方 `colab exec` 持久内核：变量与显存跨单元格保留。按 `Shift+Enter` 运行当前格并跳到下一格。",
        executionCount: null,
        stdout: "",
        stderr: "",
        images: [],
        ok: true,
        durationMs: null,
        startedAt: null,
        outCollapsed: false,
        outExpandedLong: false,
        editingMd: false,
      },
      {
        id: "nb-cell-gpu",
        type: "code",
        source: "import sys, platform\nprint('Python:', sys.version.split()[0], platform.machine())\ntry:\n    import torch\n    print('CUDA:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')\nexcept Exception as e:\n    print('torch not installed:', e)",
        executionCount: null,
        stdout: "",
        stderr: "",
        images: [],
        ok: true,
        durationMs: null,
        startedAt: null,
        outCollapsed: false,
        outExpandedLong: false,
      },
    ],
  };
}

let notebookState = loadJsonStorage("colab-desk.notebook-v1", null) || defaultNotebookState();
if (!notebookState || !Array.isArray(notebookState.cells) || notebookState.cells.length === 0) {
  notebookState = defaultNotebookState();
}
const nbRunningCells = new Set();
const nbRunningStarts = new Map();
let nbTimerId = null;
let nbAiEditingCellId = null;
let lastSavedIpynb = null;

export function serializeCellsToIpynb(cells = notebookState.cells, metadata = {}) {
  const split = (s) => (s ? String(s).split("\n").map((l, i, a) => (i < a.length - 1 ? `${l}\n` : l)) : []);
  const nbCells = (Array.isArray(cells) ? cells : []).map((c) => {
    if (c.type === "markdown") {
      return { cell_type: "markdown", metadata: {}, source: split(c.source || "") };
    }
    const outputs = [];
    if (c.stdout) outputs.push({ output_type: "stream", name: "stdout", text: split(c.stdout) });
    if (c.stderr) outputs.push({ output_type: "stream", name: "stderr", text: split(c.stderr) });
    for (const img of c.images || []) {
      const m = String(img?.dataUrl || "").match(/^data:(image\/(?:png|jpeg));base64,(.+)$/i);
      if (m) outputs.push({ output_type: "display_data", data: { [m[1].toLowerCase()]: m[2] }, metadata: {} });
    }
    return {
      cell_type: "code",
      execution_count: typeof c.executionCount === "number" ? c.executionCount : null,
      metadata: buildExecutionMetadata(c),
      source: split(c.source || ""),
      outputs,
    };
  });
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
      ...metadata,
    },
    cells: nbCells,
  };
}

lastSavedIpynb = serializeCellsToIpynb(notebookState.cells);

export function getNotebookSnapshot() {
  return {
    name: notebookState.name || "untitled.ipynb",
    remotePath: notebookState.remotePath || "",
    cells: notebookState.cells,
    ipynb: serializeCellsToIpynb(notebookState.cells),
    lastSaved: lastSavedIpynb,
  };
}

export function markNotebookSaved(ipynbObj = null) {
  lastSavedIpynb = ipynbObj || serializeCellsToIpynb(notebookState.cells);
}

export function getTotalNotebookRuntimeMs() {
  let total = 0;
  for (const c of notebookState.cells) {
    if (c.type !== "code") continue;
    if (nbRunningStarts.has(c.id)) {
      total += Math.max(0, Date.now() - nbRunningStarts.get(c.id));
    } else if (typeof c.durationMs === "number" && Number.isFinite(c.durationMs)) {
      total += c.durationMs;
    }
  }
  return total;
}

function updateRuntimeIndicators() {
  const now = Date.now();
  for (const [cellId, startedMs] of nbRunningStarts.entries()) {
    const el = dom.nbCellsEl?.querySelector(`[data-running-timer="${cellId}"]`);
    if (el) el.textContent = formatDuration(Math.max(0, now - startedMs));
  }
  const badge = document.querySelector("#nb-total-runtime");
  if (badge) {
    const total = getTotalNotebookRuntimeMs();
    const isAnyRunning = nbRunningCells.size > 0;
    badge.classList.toggle("is-running", isAnyRunning);
    badge.hidden = total <= 0 && !isAnyRunning;
    badge.textContent = `⏱ ${formatDuration(total) || "0.0s"}`;
    badge.title = L("Notebook 累计运行耗时", "Total notebook runtime");
  }
}

function syncNbTimer() {
  if (nbRunningCells.size > 0 && !nbTimerId) {
    nbTimerId = setInterval(updateRuntimeIndicators, 200);
  } else if (nbRunningCells.size === 0 && nbTimerId) {
    clearInterval(nbTimerId);
    nbTimerId = null;
  }
  updateRuntimeIndicators();
}

export function persistNotebookState() {
  const compact = {
    name: notebookState.name || "untitled.ipynb",
    remotePath: notebookState.remotePath || "",
    execCounter: notebookState.execCounter || 0,
    cells: notebookState.cells.map((c) => ({
      id: c.id,
      type: c.type,
      source: c.source || "",
      executionCount: c.executionCount ?? null,
      stdout: String(c.stdout || "").slice(0, 24_000),
      stderr: String(c.stderr || "").slice(0, 12_000),
      images: Array.isArray(c.images) ? c.images.slice(0, 3) : [],
      ok: c.ok !== false,
      durationMs: c.durationMs ?? null,
      startedAt: c.startedAt ?? null,
      outCollapsed: !!c.outCollapsed,
      outExpandedLong: !!c.outExpandedLong,
    })),
  };
  saveJsonStorage("colab-desk.notebook-v1", compact);
}

export function autoResizeNbTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(54, el.scrollHeight)}px`;
}

export function addNotebookCell(type = "code", source = "", atIndex = null) {
  const cell = {
    id: `nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: type === "markdown" ? "markdown" : "code",
    source: String(source || ""),
    executionCount: null,
    stdout: "",
    stderr: "",
    images: [],
    ok: true,
    durationMs: null,
    startedAt: null,
    outCollapsed: false,
    outExpandedLong: false,
    editingMd: type === "markdown",
  };
  if (typeof atIndex === "number" && atIndex >= 0 && atIndex <= notebookState.cells.length) {
    notebookState.cells.splice(atIndex, 0, cell);
  } else {
    notebookState.cells.push(cell);
  }
  persistNotebookState();
  renderNotebook();
  const targetTa = dom.nbCellsEl?.querySelector(`[data-cell-id="${cell.id}"] textarea.nb-editor`);
  if (targetTa) targetTa.focus();
  return cell;
}

export function moveNotebookCell(idx, delta) {
  const next = idx + delta;
  if (next < 0 || next >= notebookState.cells.length) return;
  const [item] = notebookState.cells.splice(idx, 1);
  notebookState.cells.splice(next, 0, item);
  persistNotebookState();
  renderNotebook();
}

export function deleteNotebookCell(idx) {
  if (notebookState.cells.length <= 1) {
    const c = notebookState.cells[0];
    c.source = "";
    c.stdout = "";
    c.stderr = "";
    c.images = [];
    c.executionCount = null;
    c.durationMs = null;
    c.startedAt = null;
    c.outCollapsed = false;
    c.outExpandedLong = false;
  } else {
    notebookState.cells.splice(idx, 1);
  }
  persistNotebookState();
  renderNotebook();
}

export async function runNotebookCell(idx, advance = false) {
  const cell = notebookState.cells[idx];
  if (!cell) return;
  if (cell.type === "markdown") {
    cell.editingMd = false;
    persistNotebookState();
    renderNotebook();
    if (advance) {
      if (idx + 1 < notebookState.cells.length) {
        const nextId = notebookState.cells[idx + 1].id;
        dom.nbCellsEl?.querySelector(`[data-cell-id="${nextId}"] textarea.nb-editor`)?.focus();
      } else {
        addNotebookCell("code", "");
      }
    }
    return;
  }
  if (!state.selected) {
    showToast(L("请先连接一台 Colab 虚拟机再运行单元格", "Connect to a Colab VM first"));
    return;
  }
  const startMs = Date.now();
  cell.startedAt = new Date(startMs).toISOString();
  nbRunningCells.add(cell.id);
  nbRunningStarts.set(cell.id, startMs);
  renderNotebook();
  syncNbTimer();
  try {
    const res = await fetch("/api/notebook/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected, code: cell.source || "", timeout: 300 }),
    });
    const data = await res.json();
    notebookState.execCounter = (notebookState.execCounter || 0) + 1;
    cell.executionCount = notebookState.execCounter;
    cell.ok = !!data.ok;
    cell.stdout = data.stdout || "";
    cell.stderr = data.error || data.stderr || "";
    cell.images = Array.isArray(data.images) ? data.images : [];
    cell.durationMs = typeof data.durationMs === "number" ? data.durationMs : Math.max(0, Date.now() - startMs);
    cell.outCollapsed = false;
    cell.outExpandedLong = false;
  } catch (err) {
    cell.ok = false;
    cell.stderr = err?.message || String(err);
    cell.durationMs = Math.max(0, Date.now() - startMs);
  } finally {
    nbRunningCells.delete(cell.id);
    nbRunningStarts.delete(cell.id);
    persistNotebookState();
    renderNotebook();
    syncNbTimer();
    if (dom.nbVarsDrawer && !dom.nbVarsDrawer.hidden) inspectNotebookVars();
  }
  if (advance) {
    if (idx + 1 < notebookState.cells.length) {
      const nextId = notebookState.cells[idx + 1].id;
      dom.nbCellsEl?.querySelector(`[data-cell-id="${nextId}"] textarea.nb-editor`)?.focus();
    } else {
      addNotebookCell("code", "");
    }
  }
}

export async function runAllNotebookCells(restartFirst = false) {
  if (!state.selected) {
    showToast(L("请先连接一台 Colab 虚拟机", "Connect to a Colab VM first"));
    return;
  }
  if (restartFirst) {
    showToast(L("正在重启云端内核…", "Restarting remote kernel…"));
    await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "restart-kernel", session: state.selected }),
    }).catch(() => {});
    notebookState.execCounter = 0;
  }
  for (let i = 0; i < notebookState.cells.length; i += 1) {
    const c = notebookState.cells[i];
    if (c.type === "code" && (c.source || "").trim()) {
      await runNotebookCell(i, false);
      if (!c.ok) break;
    }
  }
}

export function clearCellOutput(idx) {
  const c = notebookState.cells[idx];
  if (!c) return;
  c.executionCount = null;
  c.stdout = "";
  c.stderr = "";
  c.images = [];
  c.ok = true;
  c.durationMs = null;
  c.startedAt = null;
  c.outCollapsed = false;
  c.outExpandedLong = false;
  persistNotebookState();
  renderNotebook();
}

export function clearNotebookOutputs() {
  for (const c of notebookState.cells) {
    c.executionCount = null;
    c.stdout = "";
    c.stderr = "";
    c.images = [];
    c.ok = true;
    c.durationMs = null;
    c.startedAt = null;
    c.outCollapsed = false;
    c.outExpandedLong = false;
  }
  notebookState.execCounter = 0;
  persistNotebookState();
  renderNotebook();
}

export function setAllOutputsCollapsed(collapsed) {
  let changed = 0;
  for (const c of notebookState.cells) {
    if (c.type === "code" && (c.stdout || c.stderr || (c.images && c.images.length > 0))) {
      c.outCollapsed = !!collapsed;
      if (!collapsed) c.outExpandedLong = true;
      changed += 1;
    }
  }
  persistNotebookState();
  renderNotebook();
  if (changed > 0) {
    showToast(collapsed
      ? L(`已折叠 ${changed} 个单元格输出`, `Collapsed ${changed} outputs`)
      : L(`已展开 ${changed} 个单元格输出`, `Expanded ${changed} outputs`));
  }
}

export async function inspectNotebookVars() {
  if (!dom.nbVarsBody) return;
  if (!state.selected) {
    dom.nbVarsBody.innerHTML = `<span class="s-desc">${escapeHtml(L("未连接 Colab 虚拟机", "No active Colab VM"))}</span>`;
    return;
  }
  dom.nbVarsBody.innerHTML = `<span class="s-desc">${escapeHtml(L("正在检查内核变量…", "Inspecting kernel variables…"))}</span>`;
  try {
    const res = await fetch("/api/notebook/vars", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected }),
    });
    const data = await res.json();
    const vars = Array.isArray(data.variables) ? data.variables : [];
    if (!data.ok) {
      dom.nbVarsBody.innerHTML = `<span class="s-desc">${escapeHtml(data.error || "Inspect failed")}</span>`;
      return;
    }
    if (vars.length === 0) {
      dom.nbVarsBody.innerHTML = `<span class="s-desc">${escapeHtml(tr("nb.varsEmpty"))}</span>`;
      return;
    }
    const table = document.createElement("table");
    table.className = "nb-vars-table";
    table.innerHTML = `<thead><tr><th>${L("变量名", "Name")}</th><th>${L("类型", "Type")}</th><th>${L("维度 / 大小", "Shape")}</th><th>${L("值预览", "Preview")}</th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    for (const v of vars) {
      const trEl = document.createElement("tr");
      trEl.innerHTML = `<td class="v-name">${escapeHtml(v.name)}</td><td class="v-type">${escapeHtml(v.type)}</td><td class="v-shape">${escapeHtml(v.shape || "—")}</td><td class="v-val" title="${escapeHtml(v.preview || "")}">${escapeHtml(v.preview || "")}</td>`;
      tbody.append(trEl);
    }
    dom.nbVarsBody.replaceChildren(table);
  } catch (err) {
    dom.nbVarsBody.innerHTML = `<span class="s-desc">${escapeHtml(err?.message || String(err))}</span>`;
  }
}

export function fixNotebookCellWithAgent(idx) {
  const cell = notebookState.cells[idx];
  if (!cell) return;
  const promptText = state.activeLang === "en"
    ? `Please fix this Notebook cell #${idx + 1} error and provide the corrected Python code:\n\n\`\`\`python\n${cell.source}\n\`\`\`\n\nError output:\n\`\`\`\n${cell.stderr}\n\`\`\``
    : `请帮我修复 Notebook 第 ${idx + 1} 个单元格的报错，并给出修正后的 Python 代码：\n\n\`\`\`python\n${cell.source}\n\`\`\`\n\n报错信息：\n\`\`\`\n${cell.stderr}\n\`\`\``;
  emit("composer:set-mode", "agent");
  emit("agent:send", { promptText });
}

export async function runCellAiEdit(idx, instruction, inputEl, goBtn) {
  const cell = notebookState.cells[idx];
  if (!cell || !instruction.trim()) return;
  goBtn.disabled = true;
  goBtn.textContent = L("生成中…", "Working…");
  const provider = dom.agentProviderSelect.value || "agy";
  const model = dom.agentModelSelect.value || "";
  const prompt = [
    `You are editing a single ${cell.type === "markdown" ? "Markdown" : "Python"} notebook cell.`,
    `Return ONLY the updated cell content inside a single fenced code block (\`\`\`${cell.type === "markdown" ? "markdown" : "python"} ... \`\`\`), with no extra explanation.`,
    cell.source ? `Current cell content:\n\`\`\`\n${cell.source}\n\`\`\`` : "The cell is currently empty.",
    `Instruction: ${instruction.trim()}`,
  ].join("\n\n");
  try {
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        model,
        approvalMode: "ask",
        prompt,
        chatThreadId: `nb-inline-${cell.id}`,
        colabSession: state.selected,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let reply = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "text") reply += ev.text || "";
          if (ev.type === "error") throw new Error(ev.error);
        } catch (e) {
          if (e instanceof Error && e.message && !e.message.includes("JSON")) throw e;
        }
      }
    }
    const fenced = reply.match(/```(?:python|py|markdown|md)?\s*\n([\s\S]*?)```/i);
    const updated = (fenced ? fenced[1] : reply).trim();
    if (updated) {
      cell.source = updated;
      nbAiEditingCellId = null;
      persistNotebookState();
      renderNotebook();
      showToast(L("已用 AI 更新单元格内容", "Updated cell with AI"));
    } else {
      showToast(L("AI 未返回可应用的改写内容", "AI returned empty content"));
    }
  } catch (err) {
    showToast(`${L("AI 改写失败：", "AI edit failed: ")}${err?.message || String(err)}`);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = L("应用", "Apply");
  }
}

export function exportLocalIpynb() {
  const ipynbObj = serializeCellsToIpynb(notebookState.cells);
  const content = JSON.stringify(ipynbObj, null, 2);
  markNotebookSaved(ipynbObj);
  const fname = (notebookState.name || "untitled.ipynb").endsWith(".ipynb") ? notebookState.name : `${notebookState.name}.ipynb`;
  const blob = new Blob([content], { type: "application/x-ipynb+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(L(`已导出 ${fname}`, `Exported ${fname}`));
}

export async function openCloudIpynb(presetPath = "") {
  if (!state.selected) {
    showToast(L("请先连接一台 Colab 虚拟机", "Connect to a Colab VM first"));
    return;
  }
  const remotePath = presetPath || window.prompt(
    L("输入云端 .ipynb 文件路径（例如 /content/demo.ipynb 或 /content/drive/MyDrive/train.ipynb）：", "Enter cloud .ipynb path (e.g. /content/demo.ipynb):"),
    notebookState.remotePath || "/content/notebook.ipynb",
  );
  if (!remotePath || !remotePath.trim()) return;
  showToast(L("正在从云端读取 Notebook…", "Loading cloud notebook…"));
  try {
    const res = await fetch("/api/notebook/cloud-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected, remotePath: remotePath.trim() }),
    });
    const data = await res.json();
    if (!data.ok || !data.notebook) {
      showToast(`${L("打开失败：", "Open failed: ")}${data.error || "Unknown error"}`);
      return;
    }
    notebookState = {
      name: data.name || "notebook.ipynb",
      remotePath: data.remotePath || remotePath.trim(),
      execCounter: 0,
      cells: data.notebook.cells.map((c) => ({ ...c, outCollapsed: false, outExpandedLong: false })),
    };
    markNotebookSaved();
    persistNotebookState();
    renderNotebook();
    emit("composer:set-mode", "notebook");
    showToast(L(`已打开云端 ${notebookState.name}`, `Opened ${notebookState.name}`));
  } catch (err) {
    showToast(`${L("打开失败：", "Open failed: ")}${err?.message || String(err)}`);
  }
}

export async function saveCloudIpynb() {
  if (!state.selected) {
    showToast(L("请先连接一台 Colab 虚拟机", "Connect to a Colab VM first"));
    return;
  }
  const defaultName = (notebookState.name || "untitled.ipynb").endsWith(".ipynb") ? notebookState.name : `${notebookState.name}.ipynb`;
  const remotePath = window.prompt(
    L("保存到云端路径（支持 /content 或 /content/drive/MyDrive）：", "Save to cloud path (e.g. /content/notebook.ipynb):"),
    notebookState.remotePath || `/content/${defaultName}`,
  );
  if (!remotePath || !remotePath.trim()) return;
  showToast(L("正在保存到云端…", "Saving notebook to cloud…"));
  try {
    const res = await fetch("/api/notebook/cloud-save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected, remotePath: remotePath.trim(), cells: notebookState.cells }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(`${L("保存失败：", "Save failed: ")}${data.error || "Unknown error"}`);
      return;
    }
    notebookState.remotePath = remotePath.trim();
    notebookState.name = remotePath.trim().split("/").pop() || defaultName;
    markNotebookSaved();
    persistNotebookState();
    if (dom.nbTitleInput) dom.nbTitleInput.value = notebookState.name;
    showToast(L(`已保存到 ${notebookState.remotePath}`, `Saved to ${notebookState.remotePath}`));
  } catch (err) {
    showToast(`${L("保存失败：", "Save failed: ")}${err?.message || String(err)}`);
  }
}

export function parseLocalIpynbObject(parsed, fileName) {
  const rawCells = Array.isArray(parsed?.cells) ? parsed.cells : [];
  const joinSrc = (s) => (typeof s === "string" ? s : Array.isArray(s) ? s.join("") : "");
  const cells = rawCells.map((cell, idx) => {
    const type = cell?.cell_type === "markdown" ? "markdown" : "code";
    const stdoutParts = [];
    const stderrParts = [];
    const images = [];
    for (const out of cell?.outputs || []) {
      if (out?.output_type === "stream") {
        const text = joinSrc(out.text);
        if (out.name === "stderr") stderrParts.push(text);
        else stdoutParts.push(text);
      } else if (out?.output_type === "error") {
        stderrParts.push(Array.isArray(out.traceback) ? out.traceback.join("\n").replace(/\x1b\[[0-9;]*m/g, "") : `${out.ename || "Error"}: ${out.evalue || ""}`);
      } else if (out?.output_type === "display_data" || out?.output_type === "execute_result") {
        const d = out.data || {};
        if (d["image/png"]) images.push({ dataUrl: `data:image/png;base64,${joinSrc(d["image/png"]).replace(/\s+/g, "")}` });
        else if (d["image/jpeg"]) images.push({ dataUrl: `data:image/jpeg;base64,${joinSrc(d["image/jpeg"]).replace(/\s+/g, "")}` });
        else if (d["text/plain"]) stdoutParts.push(joinSrc(d["text/plain"]));
      }
    }
    const timing = readExecutionMetadata(cell?.metadata);
    return {
      id: String(cell?.id || `nb-${Date.now().toString(36)}-${idx}`),
      type,
      source: joinSrc(cell?.source),
      executionCount: typeof cell?.execution_count === "number" ? cell.execution_count : null,
      stdout: stdoutParts.join(""),
      stderr: stderrParts.join("\n").trim(),
      images,
      ok: stderrParts.length === 0,
      durationMs: timing.durationMs,
      startedAt: timing.startedAt,
      outCollapsed: false,
      outExpandedLong: false,
      editingMd: false,
    };
  });
  notebookState = {
    name: fileName || "notebook.ipynb",
    remotePath: "",
    execCounter: 0,
    cells: cells.length > 0 ? cells : defaultNotebookState().cells,
  };
  markNotebookSaved(parsed);
  persistNotebookState();
  renderNotebook();
  showToast(L(`已加载 ${notebookState.name}（${notebookState.cells.length} 个单元格）`, `Loaded ${notebookState.name} (${notebookState.cells.length} cells)`));
}

function renderCellOutput(cell, idx) {
  const out = document.createElement("div");
  out.className = `nb-output${cell.outCollapsed ? " is-collapsed" : ""}`;

  const stdoutLines = cell.stdout ? cell.stdout.split("\n") : [];
  const stderrLines = cell.stderr ? cell.stderr.split("\n") : [];
  const totalLines = stdoutLines.length + stderrLines.length;
  const imgCount = Array.isArray(cell.images) ? cell.images.length : 0;

  const outHead = document.createElement("div");
  outHead.className = "nb-out-head";
  const toggleOutBtn = document.createElement("button");
  toggleOutBtn.type = "button";
  toggleOutBtn.className = "nb-out-toggle";
  toggleOutBtn.setAttribute("aria-expanded", String(!cell.outCollapsed));
  const summaryParts = [];
  if (totalLines > 0) summaryParts.push(L(`${totalLines} 行`, `${totalLines} lines`));
  if (imgCount > 0) summaryParts.push(L(`${imgCount} 张图`, `${imgCount} fig`));
  if (cell.stderr) summaryParts.push(L("含错误", "error"));
  toggleOutBtn.textContent = `${cell.outCollapsed ? "▸" : "▾"} ${L("输出", "Output")}${summaryParts.length ? ` · ${summaryParts.join(" · ")}` : ""}`;
  toggleOutBtn.addEventListener("click", () => {
    cell.outCollapsed = !cell.outCollapsed;
    persistNotebookState();
    renderNotebook();
  });

  const clearOneBtn = document.createElement("button");
  clearOneBtn.type = "button";
  clearOneBtn.className = "nb-mini-btn";
  clearOneBtn.title = L("清空此格输出", "Clear this cell output");
  clearOneBtn.textContent = L("清空", "Clear");
  clearOneBtn.addEventListener("click", () => clearCellOutput(idx));

  outHead.append(toggleOutBtn, clearOneBtn);
  out.append(outHead);

  if (cell.outCollapsed) return out;

  const isLongStdout = stdoutLines.length > AUTO_COLLAPSE_LINES && !cell.outExpandedLong;
  if (cell.stdout) {
    const pre = document.createElement("pre");
    pre.className = `nb-stdout${isLongStdout ? " is-truncated" : ""}`;
    pre.textContent = isLongStdout ? stdoutLines.slice(0, AUTO_COLLAPSE_LINES).join("\n") : cell.stdout;
    out.append(pre);
    if (stdoutLines.length > AUTO_COLLAPSE_LINES) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "nb-show-more-btn";
      const hiddenCount = stdoutLines.length - AUTO_COLLAPSE_LINES;
      moreBtn.textContent = isLongStdout
        ? L(`展开剩余 ${hiddenCount} 行…`, `Show ${hiddenCount} more lines…`)
        : L("收起长输出", "Show less");
      moreBtn.addEventListener("click", () => {
        cell.outExpandedLong = !cell.outExpandedLong;
        persistNotebookState();
        renderNotebook();
      });
      out.append(moreBtn);
    }
  }

  if (imgCount > 0) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "nb-out-images";
    for (const im of cell.images) {
      if (!im?.dataUrl) continue;
      const imgEl = document.createElement("img");
      imgEl.src = im.dataUrl;
      imgEl.alt = "Cell output figure";
      imgWrap.append(imgEl);
    }
    out.append(imgWrap);
  }

  if (cell.stderr) {
    const isLongErr = stderrLines.length > AUTO_COLLAPSE_LINES && !cell.outExpandedLong;
    const errPre = document.createElement("pre");
    errPre.className = `nb-stderr${isLongErr ? " is-truncated" : ""}`;
    errPre.textContent = isLongErr ? stderrLines.slice(0, AUTO_COLLAPSE_LINES).join("\n") : cell.stderr;
    out.append(errPre);
    if (stderrLines.length > AUTO_COLLAPSE_LINES && !cell.stdout) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "nb-show-more-btn";
      const hiddenCount = stderrLines.length - AUTO_COLLAPSE_LINES;
      moreBtn.textContent = isLongErr
        ? L(`展开剩余 ${hiddenCount} 行报错…`, `Show ${hiddenCount} more error lines…`)
        : L("收起报错输出", "Show less");
      moreBtn.addEventListener("click", () => {
        cell.outExpandedLong = !cell.outExpandedLong;
        persistNotebookState();
        renderNotebook();
      });
      out.append(moreBtn);
    }
    const foot = document.createElement("div");
    foot.className = "nb-out-foot";
    const fixBtn = document.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "nb-fix-btn";
    fixBtn.textContent = tr("nb.fixWithAgent");
    fixBtn.addEventListener("click", () => fixNotebookCellWithAgent(idx));
    foot.append(fixBtn);
    out.append(foot);
  }

  return out;
}

export function renderNotebook() {
  if (!dom.nbCellsEl) return;
  if (dom.nbTitleInput && document.activeElement !== dom.nbTitleInput) {
    dom.nbTitleInput.value = notebookState.name || "untitled.ipynb";
  }
  dom.nbCellsEl.replaceChildren();
  notebookState.cells.forEach((cell, idx) => {
    const isRunning = nbRunningCells.has(cell.id);
    const card = document.createElement("div");
    card.className = `nb-cell${isRunning ? " is-running" : ""}${cell.ok === false ? " is-error" : ""}`;
    card.dataset.cellId = cell.id;

    const gutter = document.createElement("div");
    gutter.className = "nb-gutter";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = `nb-run-btn${isRunning ? " is-running" : ""}`;
    runBtn.title = tr("nb.runCell");
    runBtn.textContent = isRunning ? "⋯" : cell.type === "markdown" ? "✓" : "▶";
    runBtn.disabled = isRunning;
    runBtn.addEventListener("click", () => runNotebookCell(idx, false));
    const execLbl = document.createElement("span");
    execLbl.className = "nb-exec-count";
    execLbl.textContent = cell.type === "markdown"
      ? "MD"
      : isRunning
        ? "[*]"
        : cell.executionCount != null
          ? `[${cell.executionCount}]`
          : "[ ]";
    gutter.append(runBtn, execLbl);
    if (isRunning) {
      const live = document.createElement("span");
      live.className = "nb-exec-timer is-running";
      live.dataset.runningTimer = cell.id;
      const elapsed = Math.max(0, Date.now() - (nbRunningStarts.get(cell.id) || Date.now()));
      live.textContent = formatDuration(elapsed) || "0.0s";
      gutter.append(live);
    } else if (cell.durationMs != null) {
      const dur = document.createElement("span");
      dur.className = "nb-exec-timer";
      dur.textContent = formatDuration(cell.durationMs);
      if (cell.startedAt) dur.title = `${L("上次运行：", "Last run: ")}${cell.startedAt}`;
      gutter.append(dur);
    }

    const main = document.createElement("div");
    main.className = "nb-cell-main";

    const head = document.createElement("div");
    head.className = "nb-cell-head";
    const headLeft = document.createElement("div");
    headLeft.className = "nb-cell-head-left";
    const kindSpan = document.createElement("span");
    kindSpan.className = "nb-cell-kind";
    kindSpan.textContent = `${cell.type === "markdown" ? "Markdown" : "Python"} · #${idx + 1}`;
    headLeft.append(kindSpan);
    if (cell.type === "code" && (cell.durationMs != null || cell.startedAt || isRunning)) {
      const metaSpan = document.createElement("span");
      metaSpan.className = `nb-cell-timing${isRunning ? " is-running" : ""}`;
      if (isRunning) {
        metaSpan.textContent = L("运行中…", "Running…");
      } else {
        const parts = [];
        if (cell.durationMs != null) parts.push(formatDuration(cell.durationMs));
        const startedTxt = formatStartTime(cell.startedAt);
        if (startedTxt) parts.push(`@ ${startedTxt}`);
        if (cell.executionCount != null) parts.push(`#${cell.executionCount}`);
        metaSpan.textContent = parts.join(" · ");
        if (cell.startedAt) metaSpan.title = cell.startedAt;
      }
      headLeft.append(metaSpan);
    }

    const actions = document.createElement("div");
    actions.className = "nb-cell-actions";

    const aiBtn = document.createElement("button");
    aiBtn.type = "button";
    aiBtn.className = "nb-mini-btn is-ai";
    aiBtn.title = L("使用 AI 生成或改写此单元格", "Generate or edit cell with AI");
    aiBtn.textContent = tr("nb.aiEdit");
    aiBtn.addEventListener("click", () => {
      nbAiEditingCellId = nbAiEditingCellId === cell.id ? null : cell.id;
      renderNotebook();
      if (nbAiEditingCellId === cell.id) {
        dom.nbCellsEl.querySelector(`[data-cell-id="${cell.id}"] .nb-ai-bar input`)?.focus();
      }
    });

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "nb-mini-btn";
    toggleBtn.title = cell.type === "markdown" ? L("转为 Python 代码单元格", "Convert to Code cell") : L("转为 Markdown 笔记单元格", "Convert to Markdown cell");
    toggleBtn.textContent = cell.type === "markdown" ? "→ Code" : "→ MD";
    toggleBtn.addEventListener("click", () => {
      cell.type = cell.type === "markdown" ? "code" : "markdown";
      cell.editingMd = cell.type === "markdown";
      persistNotebookState();
      renderNotebook();
    });

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "nb-mini-btn";
    upBtn.title = L("上移单元格", "Move cell up");
    upBtn.textContent = "↑";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => moveNotebookCell(idx, -1));

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "nb-mini-btn";
    downBtn.title = L("下移单元格", "Move cell down");
    downBtn.textContent = "↓";
    downBtn.disabled = idx === notebookState.cells.length - 1;
    downBtn.addEventListener("click", () => moveNotebookCell(idx, 1));

    const addBelowBtn = document.createElement("button");
    addBelowBtn.type = "button";
    addBelowBtn.className = "nb-mini-btn";
    addBelowBtn.textContent = "+";
    addBelowBtn.title = L("在下方插入代码格", "Insert code cell below");
    addBelowBtn.addEventListener("click", () => addNotebookCell("code", "", idx + 1));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "nb-mini-btn is-danger";
    delBtn.textContent = "✕";
    delBtn.title = L("删除单元格", "Delete cell");
    delBtn.addEventListener("click", () => deleteNotebookCell(idx));

    actions.append(aiBtn, toggleBtn, upBtn, downBtn, addBelowBtn, delBtn);
    head.append(headLeft, actions);
    main.append(head);

    if (cell.type === "markdown" && !cell.editingMd) {
      const preview = document.createElement("div");
      preview.className = "nb-md-preview agent-prose";
      if (cell.source && cell.source.trim()) {
        renderMarkdownInto(preview, cell.source);
      }
      preview.addEventListener("dblclick", () => {
        cell.editingMd = true;
        renderNotebook();
        dom.nbCellsEl.querySelector(`[data-cell-id="${cell.id}"] textarea.nb-editor`)?.focus();
      });
      main.append(preview);
    } else {
      const ta = document.createElement("textarea");
      ta.className = "nb-editor";
      ta.spellcheck = false;
      ta.value = cell.source || "";
      ta.placeholder = cell.type === "markdown"
        ? L("输入 Markdown 笔记（Shift+Enter 渲染预览）…", "Write Markdown (Shift+Enter to preview)…")
        : L("# 输入 Python 代码（Shift+Enter 运行并跳转下一格，⌘Enter 原地运行）", "# Write Python (Shift+Enter to run & advance, ⌘Enter to run)");
      ta.addEventListener("input", () => {
        cell.source = ta.value;
        autoResizeNbTextarea(ta);
        persistNotebookState();
      });
      ta.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          runNotebookCell(idx, true);
          return;
        }
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
          ev.preventDefault();
          runNotebookCell(idx, false);
          return;
        }
        if (ev.key === "Tab") {
          ev.preventDefault();
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          ta.value = `${ta.value.slice(0, start)}  ${ta.value.slice(end)}`;
          ta.selectionStart = ta.selectionEnd = start + 2;
          cell.source = ta.value;
          persistNotebookState();
        }
      });
      if (cell.type === "markdown") {
        ta.addEventListener("blur", () => {
          cell.editingMd = false;
          persistNotebookState();
          renderNotebook();
        });
      }
      main.append(ta);
      requestAnimationFrame(() => autoResizeNbTextarea(ta));
    }

    if (nbAiEditingCellId === cell.id) {
      const aiBar = document.createElement("div");
      aiBar.className = "nb-ai-bar";
      const aiInput = document.createElement("input");
      aiInput.type = "text";
      aiInput.placeholder = L("告诉 AI 如何生成或改写这一格（如：加上 tqdm 进度条 / 用 matplotlib 画柱状图）…", "Tell AI how to generate or edit this cell…");
      const aiGo = document.createElement("button");
      aiGo.type = "button";
      aiGo.className = "nb-btn is-primary";
      aiGo.textContent = L("应用", "Apply");
      const aiCancel = document.createElement("button");
      aiCancel.type = "button";
      aiCancel.className = "nb-btn";
      aiCancel.textContent = L("取消", "Cancel");
      aiGo.addEventListener("click", () => runCellAiEdit(idx, aiInput.value, aiInput, aiGo));
      aiInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.isComposing) {
          ev.preventDefault();
          runCellAiEdit(idx, aiInput.value, aiInput, aiGo);
        } else if (ev.key === "Escape") {
          nbAiEditingCellId = null;
          renderNotebook();
        }
      });
      aiCancel.addEventListener("click", () => {
        nbAiEditingCellId = null;
        renderNotebook();
      });
      aiBar.append(aiInput, aiGo, aiCancel);
      main.append(aiBar);
    }

    if (cell.type === "code" && (cell.stdout || cell.stderr || (cell.images && cell.images.length > 0))) {
      main.append(renderCellOutput(cell, idx));
    }

    card.append(gutter, main);
    dom.nbCellsEl.append(card);
  });
  updateRuntimeIndicators();
}

function mountToolbarExtras() {
  const toolbar = document.querySelector("#notebook-view .nb-toolbar");
  if (!toolbar || toolbar.querySelector("#nb-collapse-all")) return;

  const collapseBtn = document.createElement("button");
  collapseBtn.id = "nb-collapse-all";
  collapseBtn.type = "button";
  collapseBtn.className = "nb-btn";
  collapseBtn.addEventListener("click", () => setAllOutputsCollapsed(true));

  const expandBtn = document.createElement("button");
  expandBtn.id = "nb-expand-all";
  expandBtn.type = "button";
  expandBtn.className = "nb-btn";
  expandBtn.addEventListener("click", () => setAllOutputsCollapsed(false));

  const runtimePill = document.createElement("span");
  runtimePill.id = "nb-total-runtime";
  runtimePill.className = "nb-runtime-pill";
  runtimePill.hidden = true;

  const clearBtn = toolbar.querySelector("#nb-clear-outputs");
  if (clearBtn && clearBtn.nextSibling) {
    toolbar.insertBefore(collapseBtn, clearBtn.nextSibling);
    toolbar.insertBefore(expandBtn, collapseBtn.nextSibling);
  } else {
    toolbar.append(collapseBtn, expandBtn);
  }
  toolbar.append(runtimePill);

  const syncLabels = () => {
    collapseBtn.textContent = L("折叠全部", "Collapse all");
    collapseBtn.title = L("折叠所有单元格输出", "Collapse all cell outputs");
    expandBtn.textContent = L("展开全部", "Expand all");
    expandBtn.title = L("展开所有单元格输出", "Expand all cell outputs");
    updateRuntimeIndicators();
  };
  syncLabels();
  on("language:changed", syncLabels);
}

export function initNotebook() {
  mountToolbarExtras();
  on("language:changed", () => {
    if (state.composerMode === "notebook") renderNotebook();
  });
  if (dom.nbTitleInput) {
    dom.nbTitleInput.addEventListener("change", () => {
      notebookState.name = dom.nbTitleInput.value.trim() || "untitled.ipynb";
      persistNotebookState();
    });
  }
  document.querySelector("#nb-add-code")?.addEventListener("click", () => addNotebookCell("code", ""));
  document.querySelector("#nb-add-md")?.addEventListener("click", () => addNotebookCell("markdown", ""));
  document.querySelector("#nb-bottom-code")?.addEventListener("click", () => addNotebookCell("code", ""));
  document.querySelector("#nb-bottom-md")?.addEventListener("click", () => addNotebookCell("markdown", ""));
  document.querySelector("#nb-run-all")?.addEventListener("click", () => runAllNotebookCells(false));
  document.querySelector("#nb-restart-run-all")?.addEventListener("click", () => runAllNotebookCells(true));
  document.querySelector("#nb-clear-outputs")?.addEventListener("click", () => clearNotebookOutputs());
  document.querySelector("#nb-open-local")?.addEventListener("click", () => dom.nbOpenFileInput?.click());
  document.querySelector("#nb-open-cloud")?.addEventListener("click", () => openCloudIpynb());
  document.querySelector("#nb-save-local")?.addEventListener("click", () => exportLocalIpynb());
  document.querySelector("#nb-save-cloud")?.addEventListener("click", () => saveCloudIpynb());
  document.querySelector("#nb-vars-refresh")?.addEventListener("click", () => inspectNotebookVars());
  if (dom.nbVarsToggle) {
    dom.nbVarsToggle.addEventListener("click", () => {
      if (!dom.nbVarsDrawer) return;
      const willOpen = dom.nbVarsDrawer.hidden;
      dom.nbVarsDrawer.hidden = !willOpen;
      dom.nbVarsToggle.classList.toggle("is-active", willOpen);
      if (willOpen) inspectNotebookVars();
    });
  }
  if (dom.nbOpenFileInput) {
    dom.nbOpenFileInput.addEventListener("change", async () => {
      const file = dom.nbOpenFileInput.files?.[0];
      dom.nbOpenFileInput.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        parseLocalIpynbObject(JSON.parse(text), file.name);
      } catch (err) {
        showToast(`${L("无法解析 .ipynb：", "Invalid .ipynb: ")}${err?.message || String(err)}`);
      }
    });
  }
}

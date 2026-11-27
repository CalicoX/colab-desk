// Notebook Enhancements frontend plugin (`notebookx`):
// - .ipynb Diff Modal (Current vs Last Saved, Current vs Cloud, Two local .ipynb files, Current vs Git HEAD)
//   with Unified & Side-by-Side modes, optional outputs diff toggle, ignore metadata toggle.
// - Local Git Linkage drawer inside Notebook view (branch/status, save+stage+commit, diff vs HEAD).
let notebookModPromise = null;
function loadNotebookMod() {
  if (!notebookModPromise) notebookModPromise = import("../../notebook.js");
  return notebookModPromise;
}

const STRINGS = {
  "zh-CN": {
    "notebookx.diffBtn": "对比 Diff",
    "notebookx.diffTitle": "Notebook 对比 (Diff)",
    "notebookx.diffMode": "对比来源",
    "notebookx.modeLastSaved": "当前 vs 上次保存",
    "notebookx.modeCloud": "当前 vs 云端 .ipynb",
    "notebookx.modeFiles": "两个本地 .ipynb 文件",
    "notebookx.modeGitHead": "当前 vs Git HEAD",
    "notebookx.viewUnified": "统一视图",
    "notebookx.viewSplit": "左右对比",
    "notebookx.includeOutputs": "包含输出",
    "notebookx.ignoreMeta": "忽略元数据/计数",
    "notebookx.runDiff": "开始对比",
    "notebookx.pickFileA": "选择文件 A",
    "notebookx.pickFileB": "选择文件 B",
    "notebookx.cloudPath": "云端路径（如 /content/demo.ipynb）",
    "notebookx.identical": "两个 Notebook 完全一致",
    "notebookx.summary": "新增 {added} · 删除 {removed} · 修改 {changed} · 未变 {same}",
    "notebookx.statusAdded": "新增",
    "notebookx.statusRemoved": "删除",
    "notebookx.statusChanged": "修改",
    "notebookx.statusSame": "未变",
    "notebookx.outputsDiff": "输出差异",
    "notebookx.metaDiff": "元数据差异",
    "notebookx.gitBtn": "Git",
    "notebookx.gitTitle": "本地 Git 联动",
    "notebookx.gitDirPlaceholder": "本地 Git 仓库路径（默认使用同步目录）",
    "notebookx.gitRefresh": "刷新状态",
    "notebookx.gitBranch": "分支",
    "notebookx.gitClean": "工作区干净",
    "notebookx.gitDirty": "{n} 个变更",
    "notebookx.gitNotRepo": "该目录不是 Git 仓库",
    "notebookx.gitFilePlaceholder": "仓库内相对路径（如 notebooks/demo.ipynb）",
    "notebookx.gitMsgPlaceholder": "提交说明（Commit message）…",
    "notebookx.gitCommitBtn": "保存并提交",
    "notebookx.gitDiffHeadBtn": "对比 HEAD",
    "notebookx.gitNote": "仅执行本地 git status / add / commit / show，不推送远程。",
    "notebookx.cmdDiff": "Notebook: 打开 .ipynb Diff 对比",
    "notebookx.cmdGit": "Notebook: 切换本地 Git 联动面板",
    "notebookx.close": "关闭",
    "notebookx.needVm": "请先连接一台 Colab 虚拟机以读取云端文件",
    "notebookx.needFiles": "请先选择两个 .ipynb 文件",
    "notebookx.needDir": "请先填写本地 Git 仓库目录路径",
    "notebookx.needMsg": "请输入提交说明",
    "notebookx.committed": "已提交：{commit}",
    "notebookx.noChanges": "无内容变更，未生成新提交",
  },
  en: {
    "notebookx.diffBtn": "Diff",
    "notebookx.diffTitle": "Notebook Diff",
    "notebookx.diffMode": "Compare",
    "notebookx.modeLastSaved": "Current vs Last Saved",
    "notebookx.modeCloud": "Current vs Cloud .ipynb",
    "notebookx.modeFiles": "Two Local .ipynb Files",
    "notebookx.modeGitHead": "Current vs Git HEAD",
    "notebookx.viewUnified": "Unified",
    "notebookx.viewSplit": "Side-by-Side",
    "notebookx.includeOutputs": "Include outputs",
    "notebookx.ignoreMeta": "Ignore metadata/count",
    "notebookx.runDiff": "Compare",
    "notebookx.pickFileA": "Pick File A",
    "notebookx.pickFileB": "Pick File B",
    "notebookx.cloudPath": "Cloud path (e.g. /content/demo.ipynb)",
    "notebookx.identical": "Notebooks are identical",
    "notebookx.summary": "+{added} added · -{removed} removed · ~{changed} changed · {same} unchanged",
    "notebookx.statusAdded": "Added",
    "notebookx.statusRemoved": "Removed",
    "notebookx.statusChanged": "Changed",
    "notebookx.statusSame": "Unchanged",
    "notebookx.outputsDiff": "Outputs diff",
    "notebookx.metaDiff": "Metadata diff",
    "notebookx.gitBtn": "Git",
    "notebookx.gitTitle": "Local Git Linkage",
    "notebookx.gitDirPlaceholder": "Local Git repo path (defaults to sync folder)",
    "notebookx.gitRefresh": "Refresh",
    "notebookx.gitBranch": "Branch",
    "notebookx.gitClean": "Clean",
    "notebookx.gitDirty": "{n} changed",
    "notebookx.gitNotRepo": "Directory is not a Git repository",
    "notebookx.gitFilePlaceholder": "Relative .ipynb path (e.g. notebooks/demo.ipynb)",
    "notebookx.gitMsgPlaceholder": "Commit message…",
    "notebookx.gitCommitBtn": "Save & Commit",
    "notebookx.gitDiffHeadBtn": "Diff vs HEAD",
    "notebookx.gitNote": "Local git status/add/commit/show only — never pushes.",
    "notebookx.cmdDiff": "Notebook: Open .ipynb Diff",
    "notebookx.cmdGit": "Notebook: Toggle Local Git Panel",
    "notebookx.close": "Close",
    "notebookx.needVm": "Connect to a Colab VM first to read cloud files",
    "notebookx.needFiles": "Select both .ipynb files first",
    "notebookx.needDir": "Enter a local Git repository directory first",
    "notebookx.needMsg": "Enter a commit message",
    "notebookx.committed": "Committed: {commit}",
    "notebookx.noChanges": "No changes to commit",
  },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmt(tpl, vars = {}) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

function renderDiffOpsUnified(ops) {
  const pre = document.createElement("div");
  pre.className = "nbx-diff-unified";
  for (const op of ops || []) {
    const row = document.createElement("div");
    row.className = `nbx-dline is-${op.type}`;
    const sig = document.createElement("span");
    sig.className = "nbx-dsig";
    sig.textContent = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
    const txt = document.createElement("span");
    txt.className = "nbx-dtxt";
    txt.textContent = op.text ?? "";
    row.append(sig, txt);
    pre.append(row);
  }
  return pre;
}

function renderDiffOpsSplit(ops) {
  const wrap = document.createElement("div");
  wrap.className = "nbx-diff-split";
  const left = [];
  const right = [];
  let i = 0;
  const list = ops || [];
  while (i < list.length) {
    if (list[i].type === "eq") {
      left.push({ type: "eq", text: list[i].text });
      right.push({ type: "eq", text: list[i].text });
      i += 1;
    } else {
      const dels = [];
      const adds = [];
      while (i < list.length && list[i].type !== "eq") {
        if (list[i].type === "del") dels.push(list[i].text);
        else adds.push(list[i].text);
        i += 1;
      }
      const len = Math.max(dels.length, adds.length);
      for (let k = 0; k < len; k += 1) {
        left.push(k < dels.length ? { type: "del", text: dels[k] } : { type: "pad", text: "" });
        right.push(k < adds.length ? { type: "add", text: adds[k] } : { type: "pad", text: "" });
      }
    }
  }
  for (let r = 0; r < left.length; r += 1) {
    const row = document.createElement("div");
    row.className = "nbx-split-row";
    const lCell = document.createElement("div");
    lCell.className = `nbx-split-cell is-${left[r].type}`;
    lCell.textContent = left[r].text;
    const rCell = document.createElement("div");
    rCell.className = `nbx-split-cell is-${right[r].type}`;
    rCell.textContent = right[r].text;
    row.append(lCell, rCell);
    wrap.append(row);
  }
  return wrap;
}

export async function init(api) {
  api.registerStrings(STRINGS);
  const t = (k, vars) => fmt(api.tr(k), vars);

  let diffModal = null;
  let gitDrawer = null;
  let lastDiffData = null;
  let viewMode = "unified"; // "unified" | "split"
  let fileAJson = null;
  let fileBJson = null;
  let gitRepoDir = api.state?.syncConfig?.localDir || "";

  const ensureGitDrawer = () => {
    if (gitDrawer) return gitDrawer;
    const nbView = document.querySelector("#notebook-view");
    const nbScroll = document.querySelector("#nb-scroll");
    if (!nbView || !nbScroll) return null;

    gitDrawer = document.createElement("div");
    gitDrawer.id = "nbx-git-drawer";
    gitDrawer.className = "nbx-git-drawer";
    gitDrawer.hidden = true;
    gitDrawer.innerHTML = `
      <div class="nbx-git-head">
        <div class="nbx-git-title-row">
          <strong data-nbx="gitTitle"></strong>
          <span id="nbx-git-badge" class="nbx-git-badge"></span>
        </div>
        <button id="nbx-git-close" type="button" class="nb-mini-btn">✕</button>
      </div>
      <div class="nbx-git-row">
        <input id="nbx-git-dir" class="nbx-input" type="text" />
        <button id="nbx-git-refresh" type="button" class="nb-btn"></button>
      </div>
      <div id="nbx-git-status-line" class="nbx-git-status"></div>
      <div class="nbx-git-row">
        <input id="nbx-git-file" class="nbx-input nbx-input-file" type="text" />
        <input id="nbx-git-msg" class="nbx-input" type="text" />
        <button id="nbx-git-commit" type="button" class="nb-btn is-primary"></button>
        <button id="nbx-git-diff-head" type="button" class="nb-btn"></button>
      </div>
      <div class="nbx-git-note" data-nbx="gitNote"></div>
    `;
    nbView.insertBefore(gitDrawer, nbScroll);

    const dirInput = gitDrawer.querySelector("#nbx-git-dir");
    const fileInput = gitDrawer.querySelector("#nbx-git-file");
    const msgInput = gitDrawer.querySelector("#nbx-git-msg");
    const statusEl = gitDrawer.querySelector("#nbx-git-status-line");
    const badgeEl = gitDrawer.querySelector("#nbx-git-badge");

    const syncGitLabels = () => {
      gitDrawer.querySelector('[data-nbx="gitTitle"]').textContent = t("notebookx.gitTitle");
      gitDrawer.querySelector('[data-nbx="gitNote"]').textContent = t("notebookx.gitNote");
      dirInput.placeholder = t("notebookx.gitDirPlaceholder");
      fileInput.placeholder = t("notebookx.gitFilePlaceholder");
      msgInput.placeholder = t("notebookx.gitMsgPlaceholder");
      gitDrawer.querySelector("#nbx-git-refresh").textContent = t("notebookx.gitRefresh");
      gitDrawer.querySelector("#nbx-git-commit").textContent = t("notebookx.gitCommitBtn");
      gitDrawer.querySelector("#nbx-git-diff-head").textContent = t("notebookx.gitDiffHeadBtn");
    };
    syncGitLabels();
    api.on("language:changed", syncGitLabels);

    const refreshGitStatus = async () => {
      const dir = dirInput.value.trim() || api.state?.syncConfig?.localDir || gitRepoDir || "";
      if (dir && !dirInput.value.trim()) dirInput.value = dir;
      if (!fileInput.value.trim()) {
        const { getNotebookSnapshot } = await loadNotebookMod();
        const snap = getNotebookSnapshot();
        fileInput.value = snap.name.endsWith(".ipynb") ? snap.name : `${snap.name}.ipynb`;
      }
      if (!dir) {
        badgeEl.textContent = "";
        statusEl.textContent = t("notebookx.needDir");
        return;
      }
      gitRepoDir = dir;
      try {
        const res = await api.fetchJson("/api/notebookx/git/status", {
          method: "POST",
          body: { dir },
        });
        if (!res.ok) {
          badgeEl.textContent = "";
          statusEl.textContent = res.error || "Git error";
          return;
        }
        if (!res.isRepo) {
          badgeEl.textContent = "";
          statusEl.textContent = t("notebookx.gitNotRepo");
          return;
        }
        badgeEl.textContent = `${t("notebookx.gitBranch")}: ${res.branch || "HEAD"}`;
        const summary = res.clean
          ? t("notebookx.gitClean")
          : t("notebookx.gitDirty", { n: res.files.length });
        const preview = res.files.slice(0, 6).map((f) => `${f.code.trim()} ${f.path}`).join("  ·  ");
        statusEl.textContent = preview ? `${summary} — ${preview}` : summary;
      } catch (err) {
        statusEl.textContent = err?.message || String(err);
      }
    };

    gitDrawer.querySelector("#nbx-git-close").addEventListener("click", () => {
      gitDrawer.hidden = true;
      document.querySelector("#nbx-git-toggle")?.classList.remove("is-active");
    });
    gitDrawer.querySelector("#nbx-git-refresh").addEventListener("click", refreshGitStatus);
    gitDrawer.querySelector("#nbx-git-commit").addEventListener("click", async () => {
      const dir = dirInput.value.trim();
      const file = fileInput.value.trim();
      const message = msgInput.value.trim();
      if (!dir) { api.showToast(t("notebookx.needDir")); return; }
      if (!message) { api.showToast(t("notebookx.needMsg")); return; }
      const { getNotebookSnapshot, markNotebookSaved } = await loadNotebookMod();
      const snap = getNotebookSnapshot();
      try {
        const res = await api.fetchJson("/api/notebookx/git/commit", {
          method: "POST",
          body: { dir, file: file || snap.name, cells: snap.cells, message },
        });
        if (!res.ok) { api.showToast(res.error || "Commit failed"); return; }
        if (res.committed) {
          markNotebookSaved();
          msgInput.value = "";
          api.showToast(t("notebookx.committed", { commit: res.commit || "" }));
        } else {
          api.showToast(t("notebookx.noChanges"));
        }
        refreshGitStatus();
      } catch (err) {
        api.showToast(err?.message || String(err));
      }
    });
    gitDrawer.querySelector("#nbx-git-diff-head").addEventListener("click", () => {
      openDiffModal("git-head", { dir: dirInput.value.trim(), file: fileInput.value.trim() });
    });

    gitDrawer._refresh = refreshGitStatus;
    return gitDrawer;
  };

  const renderDiffBody = (bodyEl, summaryEl, data) => {
    bodyEl.replaceChildren();
    if (!data || !data.ok) {
      summaryEl.textContent = data?.error || "";
      return;
    }
    const s = data.summary || {};
    summaryEl.textContent = s.identical
      ? t("notebookx.identical")
      : t("notebookx.summary", { added: s.added || 0, removed: s.removed || 0, changed: s.changed || 0, same: s.same || 0 });

    const statusLabel = {
      added: t("notebookx.statusAdded"),
      removed: t("notebookx.statusRemoved"),
      changed: t("notebookx.statusChanged"),
      same: t("notebookx.statusSame"),
    };

    for (const c of data.cells || []) {
      const card = document.createElement("div");
      card.className = `nbx-diff-cell is-${c.status}`;
      const head = document.createElement("div");
      head.className = "nbx-diff-cell-head";
      const idxTxt = `${c.aIndex != null ? `#${c.aIndex + 1}` : "—"} → ${c.bIndex != null ? `#${c.bIndex + 1}` : "—"}`;
      head.innerHTML = `<span class="nbx-diff-badge is-${esc(c.status)}">${esc(statusLabel[c.status] || c.status)}</span><span class="nbx-diff-meta">${esc(c.type.toUpperCase())} · ${esc(idxTxt)}</span>`;
      card.append(head);

      const renderer = viewMode === "split" ? renderDiffOpsSplit : renderDiffOpsUnified;
      card.append(renderer(c.sourceDiff));

      if (Array.isArray(c.outputsDiff) && c.outputsDiff.some((o) => o.type !== "eq")) {
        const sub = document.createElement("div");
        sub.className = "nbx-diff-subhead";
        sub.textContent = t("notebookx.outputsDiff");
        card.append(sub, renderer(c.outputsDiff));
      }
      if (Array.isArray(c.metaDiff) && c.metaDiff.some((o) => o.type !== "eq")) {
        const sub = document.createElement("div");
        sub.className = "nbx-diff-subhead";
        sub.textContent = t("notebookx.metaDiff");
        card.append(sub, renderer(c.metaDiff));
      }
      bodyEl.append(card);
    }
  };

  const ensureDiffModal = () => {
    if (diffModal) return diffModal;
    diffModal = document.createElement("div");
    diffModal.id = "nbx-diff-modal";
    diffModal.className = "nbx-modal-backdrop";
    diffModal.hidden = true;
    diffModal.innerHTML = `
      <div class="nbx-modal" role="dialog" aria-modal="true" aria-labelledby="nbx-diff-title">
        <div class="nbx-modal-head">
          <h3 id="nbx-diff-title"></h3>
          <button id="nbx-diff-close" type="button" class="nb-mini-btn">✕</button>
        </div>
        <div class="nbx-diff-controls">
          <select id="nbx-diff-mode" class="nbx-select">
            <option value="last-saved"></option>
            <option value="cloud"></option>
            <option value="files"></option>
            <option value="git-head"></option>
          </select>
          <div class="nbx-seg">
            <button id="nbx-view-unified" type="button" class="nb-btn is-active"></button>
            <button id="nbx-view-split" type="button" class="nb-btn"></button>
          </div>
          <label class="nbx-check"><input id="nbx-opt-outputs" type="checkbox" /><span></span></label>
          <label class="nbx-check"><input id="nbx-opt-ignore-meta" type="checkbox" checked /><span></span></label>
          <button id="nbx-run-diff" type="button" class="nb-btn is-primary"></button>
        </div>
        <div id="nbx-diff-extra" class="nbx-diff-extra">
          <input id="nbx-cloud-path" class="nbx-input" type="text" hidden />
          <div id="nbx-files-row" class="nbx-files-row" hidden>
            <label class="nb-btn"><span id="nbx-lbl-file-a"></span><input id="nbx-file-a" type="file" accept=".ipynb,application/json" hidden /></label>
            <label class="nb-btn"><span id="nbx-lbl-file-b"></span><input id="nbx-file-b" type="file" accept=".ipynb,application/json" hidden /></label>
          </div>
          <div id="nbx-git-diff-row" class="nbx-files-row" hidden>
            <input id="nbx-diff-git-dir" class="nbx-input" type="text" />
            <input id="nbx-diff-git-file" class="nbx-input nbx-input-file" type="text" />
          </div>
        </div>
        <div id="nbx-diff-summary" class="nbx-diff-summary"></div>
        <div id="nbx-diff-body" class="nbx-diff-body"></div>
      </div>
    `;
    document.body.append(diffModal);

    const modeSel = diffModal.querySelector("#nbx-diff-mode");
    const cloudInput = diffModal.querySelector("#nbx-cloud-path");
    const filesRow = diffModal.querySelector("#nbx-files-row");
    const gitRow = diffModal.querySelector("#nbx-git-diff-row");
    const gitDirIn = diffModal.querySelector("#nbx-diff-git-dir");
    const gitFileIn = diffModal.querySelector("#nbx-diff-git-file");
    const summaryEl = diffModal.querySelector("#nbx-diff-summary");
    const bodyEl = diffModal.querySelector("#nbx-diff-body");
    const unifiedBtn = diffModal.querySelector("#nbx-view-unified");
    const splitBtn = diffModal.querySelector("#nbx-view-split");
    const optOutputs = diffModal.querySelector("#nbx-opt-outputs");
    const optIgnoreMeta = diffModal.querySelector("#nbx-opt-ignore-meta");

    const syncDiffLabels = () => {
      diffModal.querySelector("#nbx-diff-title").textContent = t("notebookx.diffTitle");
      modeSel.options[0].textContent = t("notebookx.modeLastSaved");
      modeSel.options[1].textContent = t("notebookx.modeCloud");
      modeSel.options[2].textContent = t("notebookx.modeFiles");
      modeSel.options[3].textContent = t("notebookx.modeGitHead");
      unifiedBtn.textContent = t("notebookx.viewUnified");
      splitBtn.textContent = t("notebookx.viewSplit");
      diffModal.querySelector("#nbx-opt-outputs + span").textContent = t("notebookx.includeOutputs");
      diffModal.querySelector("#nbx-opt-ignore-meta + span").textContent = t("notebookx.ignoreMeta");
      diffModal.querySelector("#nbx-run-diff").textContent = t("notebookx.runDiff");
      cloudInput.placeholder = t("notebookx.cloudPath");
      diffModal.querySelector("#nbx-lbl-file-a").textContent = t("notebookx.pickFileA");
      diffModal.querySelector("#nbx-lbl-file-b").textContent = t("notebookx.pickFileB");
      gitDirIn.placeholder = t("notebookx.gitDirPlaceholder");
      gitFileIn.placeholder = t("notebookx.gitFilePlaceholder");
      if (lastDiffData) renderDiffBody(bodyEl, summaryEl, lastDiffData);
    };
    syncDiffLabels();
    api.on("language:changed", syncDiffLabels);

    const syncModeVisibility = () => {
      const m = modeSel.value;
      cloudInput.hidden = m !== "cloud";
      filesRow.hidden = m !== "files";
      gitRow.hidden = m !== "git-head";
    };
    modeSel.addEventListener("change", syncModeVisibility);

    diffModal.querySelector("#nbx-file-a").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try { fileAJson = JSON.parse(await f.text()); diffModal.querySelector("#nbx-lbl-file-a").textContent = f.name; }
      catch (err) { api.showToast(err.message); }
    });
    diffModal.querySelector("#nbx-file-b").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try { fileBJson = JSON.parse(await f.text()); diffModal.querySelector("#nbx-lbl-file-b").textContent = f.name; }
      catch (err) { api.showToast(err.message); }
    });

    unifiedBtn.addEventListener("click", () => {
      viewMode = "unified";
      unifiedBtn.classList.add("is-active");
      splitBtn.classList.remove("is-active");
      if (lastDiffData) renderDiffBody(bodyEl, summaryEl, lastDiffData);
    });
    splitBtn.addEventListener("click", () => {
      viewMode = "split";
      splitBtn.classList.add("is-active");
      unifiedBtn.classList.remove("is-active");
      if (lastDiffData) renderDiffBody(bodyEl, summaryEl, lastDiffData);
    });

    const runDiff = async () => {
      const m = modeSel.value;
      const { getNotebookSnapshot } = await loadNotebookMod();
      const snap = getNotebookSnapshot();
      const includeOutputs = optOutputs.checked;
      const ignoreMetadata = optIgnoreMeta.checked;
      summaryEl.textContent = "…";
      bodyEl.replaceChildren();
      try {
        let res;
        if (m === "git-head") {
          const dir = gitDirIn.value.trim();
          const file = gitFileIn.value.trim() || snap.name;
          if (!dir) { summaryEl.textContent = t("notebookx.needDir"); return; }
          res = await api.fetchJson("/api/notebookx/git/diff-head", {
            method: "POST",
            body: { dir, file, cells: snap.cells, includeOutputs, ignoreMetadata },
          });
        } else {
          let sideA;
          let sideB;
          if (m === "last-saved") {
            sideA = { ipynb: snap.lastSaved };
            sideB = { ipynb: snap.ipynb };
          } else if (m === "cloud") {
            const session = api.getSession?.();
            if (!session) { summaryEl.textContent = t("notebookx.needVm"); return; }
            const rp = cloudInput.value.trim() || snap.remotePath;
            if (!rp) { summaryEl.textContent = t("notebookx.cloudPath"); return; }
            sideA = { session: typeof session === "string" ? session : session.name, remotePath: rp };
            sideB = { ipynb: snap.ipynb };
          } else {
            if (!fileAJson || !fileBJson) { summaryEl.textContent = t("notebookx.needFiles"); return; }
            sideA = { ipynb: fileAJson };
            sideB = { ipynb: fileBJson };
          }
          res = await api.fetchJson("/api/notebookx/diff", {
            method: "POST",
            body: { a: sideA, b: sideB, includeOutputs, ignoreMetadata },
          });
        }
        lastDiffData = res;
        renderDiffBody(bodyEl, summaryEl, res);
      } catch (err) {
        summaryEl.textContent = err?.message || String(err);
      }
    };

    diffModal.querySelector("#nbx-run-diff").addEventListener("click", runDiff);
    diffModal.querySelector("#nbx-diff-close").addEventListener("click", () => { diffModal.hidden = true; });
    diffModal.addEventListener("click", (e) => { if (e.target === diffModal) diffModal.hidden = true; });

    diffModal._open = async (presetMode = "last-saved", opts = {}) => {
      const { getNotebookSnapshot } = await loadNotebookMod();
      const snap = getNotebookSnapshot();
      modeSel.value = presetMode;
      if (!cloudInput.value && snap.remotePath) cloudInput.value = snap.remotePath;
      if (opts.dir) gitDirIn.value = opts.dir;
      else if (!gitDirIn.value) gitDirIn.value = gitRepoDir || api.state?.syncConfig?.localDir || "";
      if (opts.file) gitFileIn.value = opts.file;
      else if (!gitFileIn.value) gitFileIn.value = snap.name;
      syncModeVisibility();
      diffModal.hidden = false;
      if (presetMode === "last-saved" || (presetMode === "git-head" && gitDirIn.value.trim())) runDiff();
    };
    return diffModal;
  };

  const openDiffModal = (presetMode = "last-saved", opts = {}) => {
    const m = ensureDiffModal();
    m?._open(presetMode, opts);
  };

  const toggleGitDrawer = () => {
    const d = ensureGitDrawer();
    if (!d) return;
    d.hidden = !d.hidden;
    document.querySelector("#nbx-git-toggle")?.classList.toggle("is-active", !d.hidden);
    if (!d.hidden) d._refresh();
  };

  // Mount Diff and Git buttons into the Notebook toolbar
  const toolbar = document.querySelector("#notebook-view .nb-toolbar");
  if (toolbar && !toolbar.querySelector("#nbx-diff-btn")) {
    const sep = document.createElement("span");
    sep.className = "nb-tb-sep";

    const diffBtn = document.createElement("button");
    diffBtn.id = "nbx-diff-btn";
    diffBtn.type = "button";
    diffBtn.className = "nb-btn";
    diffBtn.addEventListener("click", () => openDiffModal("last-saved"));

    const gitBtn = document.createElement("button");
    gitBtn.id = "nbx-git-toggle";
    gitBtn.type = "button";
    gitBtn.className = "nb-btn";
    gitBtn.addEventListener("click", toggleGitDrawer);

    const syncBtnLabels = () => {
      diffBtn.textContent = t("notebookx.diffBtn");
      gitBtn.textContent = t("notebookx.gitBtn");
    };
    syncBtnLabels();
    api.on("language:changed", syncBtnLabels);

    const runtimePill = toolbar.querySelector("#nb-total-runtime");
    if (runtimePill) {
      toolbar.insertBefore(sep, runtimePill);
      toolbar.insertBefore(diffBtn, runtimePill);
      toolbar.insertBefore(gitBtn, runtimePill);
    } else {
      toolbar.append(sep, diffBtn, gitBtn);
    }
  }

  // Register ⌘K palette commands
  if (typeof api.registerCommand === "function") {
    api.registerCommand({
      id: "notebookx.diff",
      title: t("notebookx.cmdDiff"),
      run: () => {
        api.emit?.("composer:set-mode", "notebook");
        openDiffModal("last-saved");
      },
    });
    api.registerCommand({
      id: "notebookx.git",
      title: t("notebookx.cmdGit"),
      run: () => {
        api.emit?.("composer:set-mode", "notebook");
        toggleGitDrawer();
      },
    });
  }
}

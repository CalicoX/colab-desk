import { closeDialog, dom, openDialog } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml, formatFileSize, showToast, tr } from "./utils.js";
import { callRegistered, emit } from "./events.js";
import { mountModalTemplate } from "./templates/mount.js";
import { FILES_MODAL_HTML } from "./templates/modals.js";

/* ── Cloud File Explorer ── */
export function updateFilesBatchBar() {
  const n = state.selectedRemotePaths.size;
  if (dom.filesBatchDlBtn) {
    dom.filesBatchDlBtn.hidden = n === 0;
    dom.filesBatchDlBtn.textContent = `${tr("files.batchDownload")} (${n})`;
  }
  if (dom.filesCopyDriveBtn) {
    dom.filesCopyDriveBtn.hidden = n === 0;
    dom.filesCopyDriveBtn.textContent = `${tr("files.copyDrive")} (${n})`;
  }
}

export function renderRemoteEntries(entries, parentPath) {
  dom.filesListEl.replaceChildren();
  if (dom.filesModeListBtn) dom.filesModeListBtn.classList.toggle("is-primary", state.filesViewMode === "list");
  if (dom.filesModeGalleryBtn) dom.filesModeGalleryBtn.classList.toggle("is-primary", state.filesViewMode === "gallery");
  updateFilesBatchBar();

  if (parentPath && parentPath !== state.currentRemoteDir) {
    const up = document.createElement("div");
    up.className = "file-row";
    up.innerHTML = '<span>↩</span><span class="file-row-name">..</span>';
    up.addEventListener("click", () => loadRemoteDir(parentPath));
    dom.filesListEl.append(up);
  }

  if (!entries.length) {
    const emptyP = document.createElement("p");
    emptyP.className = "s-desc";
    emptyP.textContent = tr("files.empty");
    dom.filesListEl.append(emptyP);
    return;
  }

  const isMedia = (name) => /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)$/i.test(name);
  const isVideo = (name) => /\.(mp4|webm|mov|m4v)$/i.test(name);

  if (state.filesViewMode === "gallery") {
    const grid = document.createElement("div");
    grid.className = "files-gallery-grid";
    const dirs = entries.filter((e) => e.isDir);
    const media = entries.filter((e) => !e.isDir && isMedia(e.name));
    for (const d of dirs) {
      const tile = document.createElement("div");
      tile.className = "gallery-tile";
      tile.innerHTML = `<div class="gallery-thumb" style="font-size:28px;">📁</div><div class="gallery-caption">${escapeHtml(d.name)}</div>`;
      tile.addEventListener("click", () => loadRemoteDir(d.path));
      grid.append(tile);
    }
    for (const item of media) {
      const tile = document.createElement("div");
      tile.className = "gallery-tile";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "gallery-check";
      chk.checked = state.selectedRemotePaths.has(item.path);
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        if (chk.checked) state.selectedRemotePaths.add(item.path);
        else state.selectedRemotePaths.delete(item.path);
        updateFilesBatchBar();
      });
      const thumb = document.createElement("div");
      thumb.className = "gallery-thumb";
      const mediaUrl = `/api/files/media?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(item.path)}`;
      if (isVideo(item.name)) {
        thumb.innerHTML = '<span style="font-size:28px;">🎬</span>';
      } else {
        const img = document.createElement("img");
        img.src = mediaUrl;
        img.loading = "lazy";
        img.alt = item.name;
        thumb.append(img);
      }
      const cap = document.createElement("div");
      cap.className = "gallery-caption";
      cap.textContent = item.name;
      cap.title = item.name;
      tile.append(chk, thumb, cap);
      tile.addEventListener("click", () => {
        grid.querySelectorAll(".gallery-tile.is-active").forEach((n) => n.classList.remove("is-active"));
        tile.classList.add("is-active");
        previewRemote(item);
      });
      grid.append(tile);
    }
    if (dirs.length === 0 && media.length === 0) {
      const emptyP = document.createElement("p");
      emptyP.className = "s-desc";
      emptyP.textContent = state.activeLang === "en" ? "No images or videos in this folder." : "当前目录暂无图片或视频，可切换回「列表」视图查看全部文件。";
      dom.filesListEl.append(emptyP);
    } else {
      dom.filesListEl.append(grid);
    }
    return;
  }

  for (const item of entries) {
    const row = document.createElement("div");
    row.className = "file-row";
    if (!item.isDir) {
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = state.selectedRemotePaths.has(item.path);
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        if (chk.checked) state.selectedRemotePaths.add(item.path);
        else state.selectedRemotePaths.delete(item.path);
        updateFilesBatchBar();
      });
      row.append(chk);
    }
    const icon = document.createElement("span");
    icon.textContent = item.isDir ? "📁" : isVideo(item.name) ? "🎬" : /\.(png|jpe?g|webp|gif)$/i.test(item.name) ? "🖼" : /\.(py|ipynb|js|ts|sh|json|yaml|yml|md|csv)$/i.test(item.name) ? "📄" : "📦";
    const nameEl = document.createElement("span");
    nameEl.className = "file-row-name";
    nameEl.textContent = item.name;
    nameEl.title = item.path;
    const sizeEl = document.createElement("span");
    sizeEl.className = "file-row-size";
    sizeEl.textContent = item.isDir ? "" : formatFileSize(item.size);
    row.append(icon, nameEl, sizeEl);

    if (!item.isDir) {
      const acts = document.createElement("div");
      acts.className = "file-row-actions";
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "s-btn";
      dlBtn.style.padding = "2px 6px";
      dlBtn.textContent = "↓";
      dlBtn.title = tr("files.download");
      dlBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = document.createElement("a");
        a.href = `/api/files/download?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(item.path)}`;
        a.download = item.name;
        a.click();
      });
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "s-btn is-danger";
      rmBtn.style.padding = "2px 6px";
      rmBtn.textContent = "×";
      rmBtn.title = tr("files.delete");
      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        dom.filesStatusNote.textContent = state.activeLang === "en" ? "Deleting…" : "正在删除…";
        const r = await fetch(`/api/files?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(item.path)}`, { method: "DELETE" });
        const j = await r.json();
        if (j.ok) loadRemoteDir(state.currentRemoteDir);
        else dom.filesStatusNote.textContent = j.error || "Delete failed";
      });
      acts.append(dlBtn, rmBtn);
      row.append(acts);
    }

    row.addEventListener("click", () => {
      if (item.isDir) {
        loadRemoteDir(item.path);
      } else {
        dom.filesListEl.querySelectorAll(".file-row.is-active").forEach((n) => n.classList.remove("is-active"));
        row.classList.add("is-active");
        previewRemote(item);
      }
    });
    dom.filesListEl.append(row);
  }
}

export async function loadRemoteDir(dir = "/content") {
  if (!state.selected) return;
  state.currentRemoteDir = dir || "/content";
  state.selectedRemotePaths.clear();
  dom.filesCurrentPathEl.textContent = state.currentRemoteDir;
  dom.filesStatusNote.textContent = state.activeLang === "en" ? "Loading…" : "正在加载目录…";
  dom.filesListEl.replaceChildren();
  try {
    const res = await fetch(`/api/files?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(state.currentRemoteDir)}`);
    const data = await res.json();
    dom.filesStatusNote.textContent = data.ok
      ? (state.activeLang === "en" ? `${data.entries.length} items` : `共 ${data.entries.length} 项`)
      : (data.error || "Failed");
    if (dom.filesMountDriveBtn) dom.filesMountDriveBtn.hidden = !!data.driveMounted;
    if (!data.ok) {
      const p = document.createElement("p");
      p.className = "s-desc";
      p.textContent = data.error || "Unable to list directory";
      dom.filesListEl.append(p);
      return;
    }
    state.currentRemoteDir = data.path || state.currentRemoteDir;
    dom.filesCurrentPathEl.textContent = state.currentRemoteDir;
    state.lastListedEntries = data.entries || [];
    state.lastParentPath = data.parent || null;
    renderRemoteEntries(state.lastListedEntries, state.lastParentPath);
  } catch (err) {
    dom.filesStatusNote.textContent = err.message;
  }
}

export async function previewRemote(item) {
  dom.filesPreviewEl.replaceChildren();
  const head = document.createElement("div");
  head.className = "rail-mini-head";
  const titleEl = document.createElement("span");
  titleEl.className = "s-title";
  titleEl.textContent = item.name;
  const acts = document.createElement("div");
  acts.className = "s-actions";
  const askBtn = document.createElement("button");
  askBtn.type = "button";
  askBtn.className = "s-btn is-primary";
  askBtn.textContent = tr("files.askAgent");
  askBtn.addEventListener("click", () => {
    closeDialog(dom.filesModal);
    emit("composer:set-mode", "agent");
    const prompt = state.activeLang === "en"
      ? `Inspect and analyze the remote file \`${item.path}\` on the current Colab session.`
      : `帮我查看并分析当前 Colab 会话中的云端文件 \`${item.path}\`。`;
    emit("agent:send", { promptText: prompt });
  });
  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "s-btn";
  dlBtn.textContent = tr("files.download");
  dlBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `/api/files/download?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(item.path)}`;
    a.download = item.name;
    a.click();
  });
  acts.append(askBtn, dlBtn);
  head.append(titleEl, acts);
  const loading = document.createElement("p");
  loading.className = "s-desc";
  loading.textContent = state.activeLang === "en" ? "Loading preview…" : "正在读取预览…";
  dom.filesPreviewEl.append(head, loading);

  try {
    const res = await fetch(`/api/files/preview?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(item.path)}`);
    const data = await res.json();
    loading.remove();
    if (!data.ok) {
      const errP = document.createElement("p");
      errP.className = "s-desc";
      errP.textContent = data.error || "Preview unavailable";
      dom.filesPreviewEl.append(errP);
      return;
    }
    if (data.kind === "image" && data.url) {
      const img = document.createElement("img");
      img.className = "files-preview-img";
      img.src = data.url;
      img.alt = item.name;
      dom.filesPreviewEl.append(img);
    } else if (data.kind === "video" && data.url) {
      const vid = document.createElement("video");
      vid.className = "files-preview-video";
      vid.src = data.url;
      vid.controls = true;
      vid.playsInline = true;
      dom.filesPreviewEl.append(vid);
    } else if (data.kind === "text") {
      const pre = document.createElement("pre");
      pre.className = "files-preview-pre";
      pre.textContent = data.content || "";
      dom.filesPreviewEl.append(pre);
    } else {
      const p = document.createElement("p");
      p.className = "s-desc";
      p.textContent = state.activeLang === "en"
        ? `Binary file (${formatFileSize(data.size)}). Click Download or Analyze with Agent.`
        : `二进制文件（${formatFileSize(data.size)}），可点击下载或让 Agent 分析。`;
      dom.filesPreviewEl.append(p);
    }
  } catch (err) {
    loading.textContent = err.message;
  }
}

export async function uploadToRemote(fileList) {
  if (!state.selected || !fileList || !fileList.length) return;
  for (const file of Array.from(fileList)) {
    dom.filesStatusNote.textContent = state.activeLang === "en" ? `Uploading ${file.name}…` : `正在上传 ${file.name}…`;
    const res = await fetch(`/api/files/upload?session=${encodeURIComponent(state.selected)}&dir=${encodeURIComponent(state.currentRemoteDir)}&name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    const data = await res.json();
    if (!data.ok) {
      dom.filesStatusNote.textContent = data.error || "Upload failed";
      return;
    }
  }
  await loadRemoteDir(state.currentRemoteDir);
}

export function openFilesModal(dir = "/content") {
  initFiles();
  openDialog(dom.filesModal);
  loadRemoteDir(dir);
}

let filesInitialized = false;

export function initFiles() {
  if (filesInitialized) return;
  filesInitialized = true;
  mountModalTemplate("files-modal", FILES_MODAL_HTML);
  document.querySelector("#close-files-modal").addEventListener("click", () => closeDialog(dom.filesModal));
  dom.filesModal.addEventListener("click", (e) => { if (e.target === dom.filesModal) closeDialog(dom.filesModal); });
  document.querySelector("#files-go-content").addEventListener("click", () => loadRemoteDir("/content"));
  document.querySelector("#files-go-drive").addEventListener("click", () => loadRemoteDir("/content/drive/MyDrive"));
  document.querySelector("#files-refresh-btn").addEventListener("click", () => loadRemoteDir(state.currentRemoteDir));
  dom.filesModeListBtn.addEventListener("click", () => {
    state.filesViewMode = "list";
    renderRemoteEntries(state.lastListedEntries, state.lastParentPath);
  });
  dom.filesModeGalleryBtn.addEventListener("click", () => {
    state.filesViewMode = "gallery";
    renderRemoteEntries(state.lastListedEntries, state.lastParentPath);
  });
  dom.filesBatchDlBtn.addEventListener("click", () => {
    for (const p of state.selectedRemotePaths) {
      const a = document.createElement("a");
      a.href = `/api/files/download?session=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(p)}`;
      a.download = p.split("/").pop() || "file";
      a.click();
    }
    showToast(state.activeLang === "en" ? `Downloading ${state.selectedRemotePaths.size} files…` : `正在批量下载 ${state.selectedRemotePaths.size} 个文件…`);
  });
  dom.filesCopyDriveBtn.addEventListener("click", async () => {
    if (!state.selected || state.selectedRemotePaths.size === 0) return;
    dom.filesStatusNote.textContent = state.activeLang === "en" ? "Copying to Google Drive…" : "正在复制到 Google Drive…";
    const res = await fetch("/api/files/copy-to-drive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected, paths: Array.from(state.selectedRemotePaths) }),
    }).then((r) => r.json());
    dom.filesStatusNote.textContent = res.ok
      ? (state.activeLang === "en" ? "Saved to Drive/ColabDesk_Exports" : "已保存到 Drive/ColabDesk_Exports")
      : (res.error || "Copy failed");
  });
  document.querySelector("#files-upload-btn").addEventListener("click", () => dom.filesUploadInput.click());
  dom.filesUploadInput.addEventListener("change", () => {
    if (dom.filesUploadInput.files?.length) {
      uploadToRemote(dom.filesUploadInput.files);
      dom.filesUploadInput.value = "";
    }
  });
  dom.filesListEl.addEventListener("dragover", (e) => { e.preventDefault(); dom.filesListEl.classList.add("is-dragover"); });
  dom.filesListEl.addEventListener("dragleave", () => dom.filesListEl.classList.remove("is-dragover"));
  dom.filesListEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dom.filesListEl.classList.remove("is-dragover");
    if (e.dataTransfer?.files?.length) uploadToRemote(e.dataTransfer.files);
  });
  dom.filesMountDriveBtn.addEventListener("click", async () => {
    if (!state.selected) return;
    dom.filesMountDriveBtn.disabled = true;
    dom.filesStatusNote.textContent = state.activeLang === "en" ? "Mounting Google Drive…" : "正在挂载 Google Drive…";
    await callRegistered("sessions:callAction", { type: "drivemount", session: state.selected }, `drivemount ${state.selected}`, state.selected);
    dom.filesMountDriveBtn.disabled = false;
    loadRemoteDir("/content/drive/MyDrive");
  });
}

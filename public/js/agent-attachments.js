import { dom } from "./dom.js";
import { state } from "./state.js";
import {
  L,
  formatFileSize,
  isImageAttachment,
  openImageLightbox,
  showToast,
} from "./utils.js";
import { emit } from "./events.js";

/* ── Composer File & Image Staging, Paste & Drag-Drop ── */
export function renderStagedFiles() {
  dom.stagedFilesBox.replaceChildren();
  dom.stagedFilesBox.classList.toggle("show", state.stagedFiles.length > 0);
  state.stagedFiles.forEach((file, idx) => {
    const isImg = isImageAttachment(file);
    const previewSrc = file.previewUrl || (isImg && file.path ? `/api/image?path=${encodeURIComponent(file.path)}` : "");
    if (isImg && previewSrc) {
      const card = document.createElement("div");
      card.className = "staged-img-card";
      card.title = `${file.name}${file.size ? ` (${formatFileSize(file.size)})` : ""}`;
      const img = document.createElement("img");
      img.className = "staged-img-thumb";
      img.src = previewSrc;
      img.alt = file.name;
      img.addEventListener("click", () => openImageLightbox(previewSrc, file.name));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "staged-img-remove";
      remove.setAttribute("aria-label", L(`移除 ${file.name}`, `Remove ${file.name}`));
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>';
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.stagedFiles.splice(idx, 1);
        renderStagedFiles();
        emit("composer:sync-send");
      });
      card.append(img, remove);
      dom.stagedFilesBox.append(card);
      return;
    }
    const chip = document.createElement("span");
    chip.className = "staged-chip";
    const label = document.createElement("span");
    label.textContent = `📎 ${file.name}`;
    chip.append(label);
    if (file.size) {
      const sz = document.createElement("span");
      sz.className = "staged-chip-size";
      sz.textContent = formatFileSize(file.size);
      chip.append(sz);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", L(`移除 ${file.name}`, `Remove ${file.name}`));
    remove.addEventListener("click", () => {
      state.stagedFiles.splice(idx, 1);
      renderStagedFiles();
      emit("composer:sync-send");
    });
    chip.append(remove);
    dom.stagedFilesBox.append(chip);
  });
}

export async function normalizePastedImageFile(file, fallbackIndex = 1) {
  const rawType = String(file?.type || "").toLowerCase();
  let name = String(file?.name || "").trim();
  const extByMime = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
  };
  if (rawType === "image/tiff" || /\.tiff?$/i.test(name)) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (pngBlob) {
        const pngName = name ? name.replace(/\.tiff?$/i, ".png") : `image${fallbackIndex > 1 ? `-${fallbackIndex}` : ""}.png`;
        return new File([pngBlob], pngName, { type: "image/png" });
      }
    } catch {}
  }
  if (!name || name === "blob") {
    const ext = extByMime[rawType] || "png";
    name = `image${fallbackIndex > 1 ? `-${fallbackIndex}` : ""}.${ext}`;
  }
  if (name !== file.name) {
    return new File([file], name, { type: file.type || "image/png" });
  }
  return file;
}

export async function stageLocalFiles(fileList) {
  let idx = 0;
  for (const rawFile of Array.from(fileList || [])) {
    idx += 1;
    try {
      const file = isImageAttachment(rawFile)
        ? await normalizePastedImageFile(rawFile, state.stagedFiles.length + idx)
        : rawFile;
      const mimeParam = file.type ? `&mime=${encodeURIComponent(file.type)}` : "";
      const res = await fetch(`/api/stage-file?name=${encodeURIComponent(file.name || "image.png")}${mimeParam}`, {
        method: "POST",
        body: file,
      });
      const data = await res.json();
      if (data.ok) {
        state.stagedFiles.push({
          name: data.name,
          path: data.path,
          size: data.size,
          mimeType: data.mimeType || file.type || "",
          isImage: Boolean(data.isImage || isImageAttachment(file)),
          previewUrl: data.previewUrl || (data.isImage ? `/api/image?path=${encodeURIComponent(data.path)}` : null),
        });
        renderStagedFiles();
        emit("composer:sync-send");
        showToast(
          data.isImage
            ? L(`已粘贴图片 ${data.name} (${formatFileSize(data.size)})`, `Attached image ${data.name} (${formatFileSize(data.size)})`)
            : L(`已附加 ${data.name}，发送消息即可让 Agent 上传处理`, `Attached ${data.name}. Send a message to upload and process it.`),
        );
      } else {
        showToast(L(`附加失败：${data.error || "未知错误"}`, `Attach failed: ${data.error || "Unknown error"}`));
      }
    } catch (err) {
      showToast(L(`附加失败：${err.message}`, `Attach failed: ${err.message}`));
    }
  }
}

export function handleComposerPaste(event) {
  const cd = event.clipboardData;
  const extracted = [];
  if (cd && cd.items && cd.items.length) {
    for (const item of Array.from(cd.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) extracted.push(f);
      }
    }
  }
  if (extracted.length === 0 && cd && cd.files && cd.files.length) {
    for (const f of Array.from(cd.files)) extracted.push(f);
  }
  const plainText = cd ? String(cd.getData("text/plain") || "") : "";
  const trimmed = plainText.trim();
  if (extracted.length > 0) {
    const isOnlyFilename = !trimmed || extracted.some((f) => f.name && f.name === trimmed);
    if (isOnlyFilename) event.preventDefault();
    emit("composer:set-mode", "agent");
    stageLocalFiles(extracted);
    return true;
  }
  const looksLikeImageFilename = Boolean(trimmed) && !/\r|\n/.test(trimmed) && /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic)$/i.test(trimmed);
  if ((!trimmed || looksLikeImageFilename) && window.webkit?.messageHandlers?.clipboardImage) {
    event.preventDefault();
    window.webkit.messageHandlers.clipboardImage.postMessage({});
    return true;
  }
  return false;
}

export function initAgentAttachments() {
  dom.attachFileBtn.addEventListener("click", () => dom.attachFileInput.click());
  dom.attachFileInput.addEventListener("change", () => {
    if (dom.attachFileInput.files && dom.attachFileInput.files.length) {
      stageLocalFiles(dom.attachFileInput.files);
      dom.attachFileInput.value = "";
    }
  });

  // Paste images / files directly into composer (⌘V)
  dom.code.addEventListener("paste", (event) => {
    handleComposerPaste(event);
  });
  document.addEventListener("paste", (event) => {
    if (event.target === dom.code) return;
    if (document.querySelector("dialog[open]")) return;
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || (event.target && event.target.isContentEditable)) return;
    if (state.composerMode === "notebook" || dom.composer.hidden) return;
    handleComposerPaste(event);
  });

  // Drag & drop files onto composer
  dom.composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    dom.composer.classList.add("is-dragover");
  });
  dom.composer.addEventListener("dragleave", () => dom.composer.classList.remove("is-dragover"));
  dom.composer.addEventListener("drop", (event) => {
    event.preventDefault();
    dom.composer.classList.remove("is-dragover");
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      emit("composer:set-mode", "agent");
      stageLocalFiles(event.dataTransfer.files);
    }
  });
}

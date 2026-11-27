import { dom } from "./dom.js";
import { state } from "./state.js";
import { L, formatFileSize, isImageAttachment, showToast } from "./utils.js";
import { emit } from "./events.js";
import { renderStagedFiles, stageLocalFiles } from "./agent-attachments.js";

/**
 * Registers macOS WKWebView native clipboard & file staging bridges immediately at startup
 * (invoked by macos/ColabDesk.swift via evaluateJavaScript).
 */
export function initAgentNativeBridge() {
  window.__onNativeStagedFiles = (items) => {
    try {
      const list = Array.isArray(items) ? items : (items ? [items] : []);
      let added = 0;
      let lastItem = null;
      for (const data of list) {
        if (!data || !data.path) continue;
        const isImg = Boolean(data.isImage || isImageAttachment(data));
        const rec = {
          name: data.name || "image.png",
          path: data.path,
          size: Number(data.size) || 0,
          mimeType: data.mimeType || (isImg ? "image/png" : "application/octet-stream"),
          isImage: isImg,
          previewUrl: data.previewUrl || (isImg ? `/api/image?path=${encodeURIComponent(data.path)}` : null),
        };
        state.stagedFiles.push(rec);
        added += 1;
        lastItem = rec;
      }
      if (added === 0) return;
      emit("composer:set-mode", "agent");
      renderStagedFiles();
      emit("composer:sync-send");
      dom.code.focus();
      if (added === 1 && lastItem) {
        showToast(L(
          `已粘贴图片 ${lastItem.name} (${formatFileSize(lastItem.size)})`,
          `Attached image ${lastItem.name} (${formatFileSize(lastItem.size)})`,
        ));
      } else {
        showToast(L(`已粘贴 ${added} 张图片`, `Attached ${added} images`));
      }
    } catch {}
  };

  window.__onNativeClipboardImages = (items) => {
    try {
      const list = Array.isArray(items) ? items : (items ? [items] : []);
      const files = [];
      for (const payload of list) {
        if (!payload || !payload.base64) continue;
        const bin = atob(payload.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const mime = payload.mimeType || "image/png";
        files.push(new File([bytes], payload.name || "image.png", { type: mime }));
      }
      if (files.length === 0) return;
      emit("composer:set-mode", "agent");
      stageLocalFiles(files);
      dom.code.focus();
    } catch {}
  };

  window.__onNativeClipboardImage = (payload) => window.__onNativeClipboardImages([payload]);
}

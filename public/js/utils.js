import { t } from "/i18n.mjs";
import { dom } from "./dom.js";
import { GPUS, TPUS, state } from "./state.js";

export function tr(key, vars) {
  return t(state.activeLang, key, vars);
}

export function L(zh, en) {
  return state.activeLang === "en" ? en : zh;
}

export function applyI18nToTree(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = tr(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", tr(el.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", tr(el.dataset.i18nTitle));
  });
  root.querySelectorAll("[data-i18n-label]").forEach((el) => {
    el.setAttribute("label", tr(el.dataset.i18nLabel));
  });
  root.querySelectorAll("[data-starter-key]").forEach((btn) => {
    btn.dataset.starter = tr(btn.dataset.starterKey);
  });
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatCompactNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function formatResetCountdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return L("即将重置", "Resets soon");
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;
  if (days > 0) return L(`${days}天${hours}小时后重置`, `Resets in ${days}d ${hours}h`);
  if (hours > 0) return L(`${hours}小时${remMins}分后重置`, `Resets in ${hours}h ${remMins}m`);
  return L(`${remMins}分钟后重置`, `Resets in ${remMins}m`);
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatFileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

export function hardwareKind(hw) {
  const upper = String(hw || "CPU").toUpperCase();
  if (upper.includes("TPU") || upper.startsWith("V5") || upper.startsWith("V6")) return "tpu";
  if (upper === "CPU") return "cpu";
  return "gpu";
}

export function parseHardware(value, highMem) {
  return {
    gpu: GPUS.has(value) ? value : undefined,
    tpu: TPUS.has(value) ? value : undefined,
    highMem: !!highMem,
  };
}

export function showToast(message) {
  dom.inspectorToast.textContent = message;
  dom.inspectorToast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    dom.inspectorToast.hidden = true;
  }, 2800);
}

export function autoGrowCode() {
  dom.code.style.height = "52px";
  dom.code.style.height = `${Math.min(180, Math.max(52, dom.code.scrollHeight))}px`;
}

export function sendDesktopNotification(titleText, bodyText, force = false) {
  if (!force && !state.notifyOnComplete) return;
  if (window.webkit?.messageHandlers?.notify) {
    try {
      window.webkit.messageHandlers.notify.postMessage({ title: titleText, body: bodyText });
      return;
    } catch {}
  }
  if (typeof Notification !== "undefined") {
    if (Notification.permission === "granted") {
      try { new Notification(titleText, { body: bodyText }); } catch {}
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") {
          try { new Notification(titleText, { body: bodyText }); } catch {}
        }
      }).catch(() => {});
    }
  }
}

export function openExternalUrl(url) {
  if (!url) return;
  if (window.webkit?.messageHandlers?.openExternal) {
    try {
      window.webkit.messageHandlers.openExternal.postMessage(url);
      return;
    } catch {}
  }
  window.open(url, "_blank", "noopener");
}

export function makeMiniSvg(pathMarkup, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  svg.innerHTML = pathMarkup;
  return svg;
}

export function isImageAttachment(file) {
  if (!file) return false;
  if (file.isImage) return true;
  const mime = String(file.mimeType || file.type || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  const target = String(file.name || file.path || "").toLowerCase();
  return /\.(?:png|jpe?g|webp|gif|bmp)$/.test(target);
}

export function openImageLightbox(src, alt = "image") {
  if (!src) return;
  const overlay = document.createElement("div");
  overlay.className = "img-lightbox";
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt || "image";
  overlay.append(img);
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") close();
  };
  overlay.addEventListener("click", close);
  window.addEventListener("keydown", onKey);
  document.body.append(overlay);
}

// 3D Dotted Sphere Orb (inspired by libraries.dev/orbs)
const ORB_POINTS = (() => {
  const pts = [];
  const rings = 9;
  for (let i = 1; i < rings; i++) {
    const phi = (Math.PI * i) / rings;
    const y = Math.cos(phi);
    const ringR = Math.sin(phi);
    const cols = Math.max(6, Math.round(18 * ringR));
    for (let j = 0; j < cols; j++) {
      const theta = (2 * Math.PI * j) / cols;
      pts.push([ringR * Math.cos(theta), y, ringR * Math.sin(theta)]);
    }
  }
  pts.push([0, 1, 0], [0, -1, 0]);
  return pts;
})();
const animatedOrbs = new Set();
let orbRafId = 0;

export function drawDottedOrb(canvas, angle) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const radius = w * 0.42;
  const cosY = Math.cos(angle);
  const sinY = Math.sin(angle);
  const tiltX = 0.34;
  const cosX = Math.cos(tiltX);
  const sinX = Math.sin(tiltX);
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const rgb = isLight ? "46, 42, 68" : "228, 226, 240";
  const baseDot = Math.max(1.15, w * 0.036);

  for (let i = 0; i < ORB_POINTS.length; i++) {
    const [px, py, pz] = ORB_POINTS[i];
    const rx = px * cosY - pz * sinY;
    const rz1 = px * sinY + pz * cosY;
    const ry = py * cosX - rz1 * sinX;
    const rz = py * sinX + rz1 * cosX;
    const depth = (rz + 1) * 0.5;
    const persp = 1.0 / (2.55 - rz * 0.55);
    const sx = cx + rx * radius * persp * 2.25;
    const sy = cy + ry * radius * persp * 2.25;
    const dotR = baseDot * (0.45 + 0.62 * depth);
    const alpha = 0.14 + 0.84 * Math.pow(depth, 1.35);
    ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function stepAnimatedOrbs(ts) {
  for (const canvas of Array.from(animatedOrbs)) {
    if (!canvas.isConnected) {
      animatedOrbs.delete(canvas);
      continue;
    }
    drawDottedOrb(canvas, (ts || 0) * 0.0014);
  }
  if (animatedOrbs.size > 0) {
    orbRafId = requestAnimationFrame(stepAnimatedOrbs);
  } else {
    orbRafId = 0;
  }
}

export function createDottedOrb(size = 20, animated = false) {
  const canvas = document.createElement("canvas");
  canvas.className = "thought-orb";
  const dpr = Math.min(2, window.devicePixelRatio || 2);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  drawDottedOrb(canvas, animated ? performance.now() * 0.0014 : 0.42);
  if (animated) {
    animatedOrbs.add(canvas);
    if (!orbRafId) orbRafId = requestAnimationFrame(stepAnimatedOrbs);
  }
  return canvas;
}

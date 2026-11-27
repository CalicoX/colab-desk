import { dom } from "./dom.js";
import { currentSessionObject, desk, state } from "./state.js";
import { L, escapeHtml, hardwareKind, openExternalUrl, showToast, tr } from "./utils.js";
import { on } from "./events.js";

/* ── Inspector Right Rail: Live GPU Telemetry, Port Tunnels & Session Export ── */
export function renderGpuTelemetry(info) {
  state.latestGpuInfo = info;
  if (!dom.gpuTelemetryBody) return;
  dom.gpuTelemetryBody.replaceChildren();
  if (dom.gpuProcsBody) dom.gpuProcsBody.replaceChildren();
  if (dom.detectedPortsBox) {
    dom.detectedPortsBox.replaceChildren();
    dom.detectedPortsBox.hidden = true;
  }

  if (state.selected && info && Array.isArray(info.listeningPorts) && info.listeningPorts.length > 0 && dom.detectedPortsBox) {
    const knownNames = { 8188: "ComfyUI", 7860: "Gradio", 8888: "Jupyter", 11434: "Ollama", 8000: "vLLM", 6006: "TB" };
    for (const port of info.listeningPorts) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "detected-port-chip";
      const lbl = knownNames[port] ? `${knownNames[port]} :${port}` : `:${port}`;
      chip.textContent = `● ${lbl} ↗`;
      chip.title = state.activeLang === "en"
        ? `Auto-detected port ${port} — click to open ${state.activeTunnelMode === "cloudflared" ? "Cloudflare Quick Tunnel" : "SSH tunnel"}`
        : `检测到已监听端口 ${port}，点击一键建立${state.activeTunnelMode === "cloudflared" ? " CF 公网隧道" : "本地 SSH 转发"}并打开`;
      chip.addEventListener("click", async () => {
        const tun = await openTunnel(port, knownNames[port] || `:${port}`);
        if (tun && tun.url) openExternalUrl(tun.url);
      });
      dom.detectedPortsBox.append(chip);
    }
    dom.detectedPortsBox.hidden = false;
  }

  if (!state.selected || !info || !info.available || !Array.isArray(info.gpus) || !info.gpus.length) {
    const span = document.createElement("span");
    span.className = "kv-value is-muted";
    span.style.textAlign = "left";
    span.dataset.i18n = "rail.gpuNone";
    span.textContent = tr("rail.gpuNone");
    dom.gpuTelemetryBody.append(span);
    return;
  }
  for (const g of info.gpus) {
    const usedGb = (g.memUsedMb / 1024).toFixed(1);
    const totalGb = (g.memTotalMb / 1024).toFixed(1);
    const vramPct = Math.min(100, Math.round((g.memUsedMb / Math.max(g.memTotalMb, 1)) * 100));
    const nameRow = document.createElement("div");
    nameRow.className = "meter-foot";
    nameRow.innerHTML = `<span>${escapeHtml(g.name)}</span><span>${g.tempC != null ? `${g.tempC}°C` : ""}</span>`;
    const vramRow = document.createElement("div");
    vramRow.className = "meter-row";
    vramRow.innerHTML = `<span class="meter-label">VRAM</span><div class="meter-track"><div class="meter-fill ${vramPct >= 88 ? "is-low" : vramPct >= 65 ? "is-warn" : "is-ok"}" style="width:${vramPct}%"></div></div><span class="meter-value">${usedGb}/${totalGb}G</span>`;
    const utilRow = document.createElement("div");
    utilRow.className = "meter-row";
    utilRow.innerHTML = `<span class="meter-label">GPU</span><div class="meter-track"><div class="meter-fill is-accent" style="width:${Math.min(100, g.utilPct)}%"></div></div><span class="meter-value">${g.utilPct}%</span>`;
    dom.gpuTelemetryBody.append(nameRow, vramRow, utilRow);
  }

  if (dom.gpuProcsBody && Array.isArray(info.processes) && info.processes.length > 0) {
    for (const proc of info.processes) {
      const row = document.createElement("div");
      row.className = "gpu-proc-row";
      const nameEl = document.createElement("span");
      nameEl.className = "gpu-proc-name";
      nameEl.textContent = `${proc.name} (${proc.pid})`;
      const memEl = document.createElement("span");
      memEl.className = "gpu-proc-mem";
      memEl.textContent = `${proc.memMb}M`;
      const killBtn = document.createElement("button");
      killBtn.type = "button";
      killBtn.className = "s-btn is-danger";
      killBtn.style.padding = "1px 6px";
      killBtn.style.fontSize = "11px";
      killBtn.textContent = L("终止", "Kill");
      killBtn.addEventListener("click", async () => {
        killBtn.disabled = true;
        await fetch("/api/gpu/kill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: state.selected, pid: proc.pid }),
        });
        showToast(L(`已终止进程 PID ${proc.pid}`, `Killed PID ${proc.pid}`));
        setTimeout(() => refreshGpuTelemetry(false), 800);
      });
      row.append(nameEl, memEl, killBtn);
      dom.gpuProcsBody.append(row);
    }
  }
}

export async function refreshGpuTelemetry(silent = false) {
  const sess = currentSessionObject();
  if (!sess || hardwareKind(sess.hardware) !== "gpu") {
    renderGpuTelemetry({ available: false, gpus: [] });
    return;
  }
  if (!silent && dom.gpuRefreshBtn) dom.gpuRefreshBtn.disabled = true;
  try {
    const res = await fetch(`/api/gpu?session=${encodeURIComponent(sess.name)}`);
    const data = await res.json();
    renderGpuTelemetry(data);
  } catch {}
  finally {
    if (dom.gpuRefreshBtn) dom.gpuRefreshBtn.disabled = !currentSessionObject();
  }
}

export function syncTunnelModeUi() {
  if (dom.tunnelModeCfBtn) dom.tunnelModeCfBtn.classList.toggle("is-active", state.activeTunnelMode === "cloudflared");
  if (dom.tunnelModeSshBtn) dom.tunnelModeSshBtn.classList.toggle("is-active", state.activeTunnelMode === "ssh");
  if (state.latestGpuInfo) renderGpuTelemetry(state.latestGpuInfo);
}

export function renderTunnels() {
  if (!dom.tunnelListEl) return;
  dom.tunnelListEl.replaceChildren();
  const visible = state.activeTunnels.filter((tItem) => !state.selected || tItem.session === state.selected);
  if (!visible.length) {
    const p = document.createElement("span");
    p.className = "kv-value is-muted";
    p.style.textAlign = "left";
    p.textContent = tr("rail.tunnelsEmpty");
    dom.tunnelListEl.append(p);
    return;
  }
  for (const tun of visible) {
    const isCf = tun.mode === "cloudflared";
    const row = document.createElement("div");
    row.className = "tunnel-item";
    const badge = document.createElement("span");
    badge.className = `tunnel-badge${isCf ? " is-cf" : ""}`;
    badge.textContent = isCf ? "CF" : "SSH";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "tunnel-link";
    const shortHost = isCf ? String(tun.url || "").replace(/^https?:\/\//i, "") : `127.0.0.1:${tun.localPort}`;
    link.textContent = `${tun.label} · ${shortHost} ↗`;
    link.title = tun.url;
    link.addEventListener("click", () => openExternalUrl(tun.url));
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "tunnel-copy";
    copyBtn.title = state.activeLang === "en" ? "Copy URL" : "复制链接";
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(tun.url);
        showToast(state.activeLang === "en" ? "URL copied" : "链接已复制");
      } catch {}
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tunnel-close";
    closeBtn.title = state.activeLang === "en" ? "Close tunnel" : "关闭隧道";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", async () => {
      await fetch(`/api/tunnels/${encodeURIComponent(tun.id)}`, { method: "DELETE" });
      await refreshTunnels();
    });
    row.append(badge, link, copyBtn, closeBtn);
    dom.tunnelListEl.append(row);
  }
}

export async function refreshTunnels() {
  try {
    const res = await fetch("/api/tunnels");
    const data = await res.json();
    if (data.ok && Array.isArray(data.tunnels)) {
      state.activeTunnels = data.tunnels;
      renderTunnels();
    }
  } catch {}
}

export async function openTunnel(port, label) {
  if (!state.selected) return null;
  const isCf = state.activeTunnelMode === "cloudflared";
  showToast(
    isCf
      ? (state.activeLang === "en" ? `Starting Cloudflare tunnel for :${port}…` : `正在为 :${port} 建立 CF 公网隧道…`)
      : (state.activeLang === "en" ? `Opening SSH tunnel :${port}…` : `正在建立本地 SSH 转发 :${port}…`),
  );
  try {
    const res = await fetch("/api/tunnels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: state.selected,
        remotePort: Number(port),
        localPort: Number(port),
        label,
        mode: state.activeTunnelMode,
      }),
    });
    const data = await res.json();
    if (data.ok && data.tunnel) {
      await refreshTunnels();
      showToast(
        isCf
          ? (state.activeLang === "en" ? `CF tunnel ready: ${data.tunnel.url}` : `CF 隧道已就绪：${data.tunnel.url}`)
          : (state.activeLang === "en" ? `Forwarded to ${data.tunnel.url}` : `已转发到 ${data.tunnel.url}`),
      );
      return data.tunnel;
    } else {
      showToast(data.error || (state.activeLang === "en" ? "Tunnel failed" : "隧道建立失败"));
      return null;
    }
  } catch (err) {
    showToast(err.message);
    return null;
  }
}

export async function exportCurrentSession(format) {
  const entries = desk.bySession[state.selected || ""] || [];
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected || "", format, entries }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error || "Export failed");
      return;
    }
    const blob = new Blob([data.content || ""], { type: format === "md" ? "text/markdown;charset=utf-8" : "application/x-ipynb+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.filename || `colab-desk.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(state.activeLang === "en" ? `Exported ${data.filename}` : `已导出 ${data.filename}`);
  } catch (err) {
    showToast(err.message);
  }
}

export function initCloudRail() {
  on("cloud:refresh-gpu", (silent) => refreshGpuTelemetry(silent));
  on("cloud:render-tunnels", renderTunnels);
  on("cloud:export", (format) => exportCurrentSession(format));
  on("language:changed", () => {
    renderGpuTelemetry(state.latestGpuInfo);
    renderTunnels();
  });

  dom.gpuRefreshBtn.addEventListener("click", () => refreshGpuTelemetry(false));

  if (dom.tunnelModeCfBtn) {
    dom.tunnelModeCfBtn.addEventListener("click", () => {
      state.activeTunnelMode = "cloudflared";
      try { localStorage.setItem("colab-desk.tunnel-mode", "cloudflared"); } catch {}
      syncTunnelModeUi();
    });
  }
  if (dom.tunnelModeSshBtn) {
    dom.tunnelModeSshBtn.addEventListener("click", () => {
      state.activeTunnelMode = "ssh";
      try { localStorage.setItem("colab-desk.tunnel-mode", "ssh"); } catch {}
      syncTunnelModeUi();
    });
  }

  dom.tunnelPresetsWrap.querySelectorAll("[data-tunnel-port]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tun = await openTunnel(btn.dataset.tunnelPort, btn.dataset.tunnelLabel);
      if (tun && tun.url) openExternalUrl(tun.url);
    });
  });
  dom.tunnelOpenBtn.addEventListener("click", async () => {
    const p = Number(dom.tunnelPortInput.value);
    if (p >= 1 && p <= 65535) {
      dom.tunnelPortInput.value = "";
      const tun = await openTunnel(p, `:${p}`);
      if (tun && tun.url) openExternalUrl(tun.url);
    }
  });

  dom.exportIpynbBtn.addEventListener("click", () => exportCurrentSession("ipynb"));
  dom.exportMdBtn.addEventListener("click", () => exportCurrentSession("md"));
}

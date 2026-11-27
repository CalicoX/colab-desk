import { closeDialog, dom, openDialog } from "./dom.js";
import { currentSessionObject, desk, state } from "./state.js";
import {
  L,
  autoGrowCode,
  escapeHtml,
  formatFileSize,
  hardwareKind,
  openExternalUrl,
  showToast,
  tr,
} from "./utils.js";
import { flushStoreToDisk } from "./store.js";
import { closeToolsDropdown, setComposerMode } from "./composer.js";
import { sendAgentMessage } from "./agent.js";

/* ── Live GPU Telemetry, Process Kill & Auto-Detected Web Ports ── */
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
      killBtn.textContent = "Kill";
      killBtn.addEventListener("click", async () => {
        killBtn.disabled = true;
        await fetch("/api/gpu/kill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: state.selected, pid: proc.pid }),
        });
        showToast(`Killed PID ${proc.pid}`);
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

/* ── Export (.ipynb / .md) & Prompt Templates ── */
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

export function builtInTemplates() {
  if (state.activeLang === "en") {
    return [
      { id: "builtin-ollama", builtin: true, title: "Deploy Ollama Inference Server", prompt: "Install and start Ollama in the background on this Colab session (port 11434), verify it responds on localhost:11434, and recommend a model that fits our VRAM." },
      { id: "builtin-lora", builtin: true, title: "LoRA / Unsloth Fine-Tuning Check", prompt: "Audit GPU VRAM, CUDA, PyTorch, transformers, peft, bitsandbytes, and trl on this Colab session, and prepare a ready-to-run LoRA fine-tuning environment." },
      { id: "builtin-eda", builtin: true, title: "Explore CSV & Generate Charts", prompt: "Find CSV/Parquet files in /content, inspect schemas, missing values, and summary statistics, and plot key distributions inline." },
    ];
  }
  return [
    { id: "builtin-ollama", builtin: true, title: "一键部署 Ollama / 本地推理", prompt: "在当前 Colab 会话后台安装并启动 Ollama（监听 11434 端口），验证接口可用，并根据当前显卡显存推荐最适合拉取的模型。" },
    { id: "builtin-lora", builtin: true, title: "LoRA 微调环境体检", prompt: "检查当前 Colab 会话的 GPU 显存、CUDA、PyTorch、transformers、peft、bitsandbytes、trl 环境，缺失的帮我补齐。" },
    { id: "builtin-eda", builtin: true, title: "数据清洗与可视化分析", prompt: "扫描 /content 目录下的 CSV/Excel/Parquet 数据文件，输出字段概览、缺失值统计，并生成关键分布图表展示在聊天里。" },
  ];
}

export function renderTemplatesModal() {
  if (!dom.templatesListEl) return;
  dom.templatesListEl.replaceChildren();
  const all = [...state.promptTemplates, ...builtInTemplates()];
  for (const tpl of all) {
    const card = document.createElement("div");
    card.className = "tpl-card";
    const head = document.createElement("div");
    head.className = "tpl-card-head";
    const titleEl = document.createElement("span");
    titleEl.className = "tpl-card-title";
    titleEl.textContent = tpl.title;
    const acts = document.createElement("div");
    acts.className = "s-actions";
    const insBtn = document.createElement("button");
    insBtn.type = "button";
    insBtn.className = "s-btn";
    insBtn.textContent = tr("templates.insert");
    insBtn.addEventListener("click", () => {
      closeDialog(dom.templatesModal);
      setComposerMode("agent");
      dom.code.value = tpl.prompt;
      autoGrowCode();
      dom.code.focus();
    });
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "s-btn is-primary";
    runBtn.textContent = tr("templates.run");
    runBtn.addEventListener("click", () => {
      closeDialog(dom.templatesModal);
      setComposerMode("agent");
      sendAgentMessage(tpl.prompt);
    });
    acts.append(insBtn, runBtn);
    if (!tpl.builtin) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "s-btn is-danger";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", () => {
        state.promptTemplates = state.promptTemplates.filter((x) => x.id !== tpl.id);
        flushStoreToDisk();
        renderTemplatesModal();
      });
      acts.append(delBtn);
    }
    head.append(titleEl, acts);
    const body = document.createElement("div");
    body.className = "tpl-card-body";
    body.textContent = tpl.prompt;
    card.append(head, body);
    dom.templatesListEl.append(card);
  }
}

/* ── Direct Parameterized Script Runner (Zero Agent) ── */
export function defaultDirectScripts() {
  return [
    {
      id: "builtin-hf-dl",
      builtin: true,
      name: L("HF 高速下载模型 (hf_transfer)", "HF Fast Model Download (hf_transfer)"),
      runtime: "bash",
      code: "export HF_HUB_ENABLE_HF_TRANSFER=1\npip install -q huggingface_hub hf_transfer\nhuggingface-cli download {{repo_id}} --local-dir {{local_dir}}",
    },
    {
      id: "builtin-comfyui",
      builtin: true,
      name: L("启动 ComfyUI (:8188)", "Launch ComfyUI (:8188)"),
      runtime: "bash",
      code: "if [ ! -d /content/ComfyUI ]; then git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /content/ComfyUI && pip install -q -r /content/ComfyUI/requirements.txt; fi\nnohup python3 /content/ComfyUI/main.py --listen 127.0.0.1 --port 8188 > /content/comfyui.log 2>&1 &\nsleep 2 && tail -n 15 /content/comfyui.log",
    },
    {
      id: "builtin-diffusers",
      builtin: true,
      name: L("直连 Python 生成模板（参数化）", "Direct Python Inference Template"),
      runtime: "python",
      code: "import os\nprompt = '''{{prompt}}'''\nsteps = int('{{steps}}' or '25')\nout = '{{output_path}}' or '/content/output.png'\nprint('Prompt:', prompt, 'Steps:', steps, 'Target:', out)\n# Run your local inference pipeline here (e.g. Diffusers / Flux / Wan)\n# Save to /content/*.png or /content/*.mp4 and print(out) for inline preview",
    },
  ];
}

export function parseScriptParams(src) {
  const names = [];
  const seen = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(src || ""))) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
  }
  return names;
}

export function renderRunnerParams() {
  const names = parseScriptParams(dom.runnerCodeInput.value);
  dom.runnerParamsWrap.replaceChildren();
  for (const name of names) {
    const field = document.createElement("div");
    field.className = "s-field";
    if (/prompt/i.test(name)) field.classList.add("is-full");
    const lbl = document.createElement("label");
    lbl.textContent = name;
    const inp = document.createElement("input");
    inp.className = "s-input";
    inp.type = "text";
    inp.dataset.paramName = name;
    inp.value = state.runnerParamValues[name] || "";
    inp.placeholder = `{{${name}}}`;
    inp.addEventListener("input", () => { state.runnerParamValues[name] = inp.value; });
    field.append(lbl, inp);
    dom.runnerParamsWrap.append(field);
  }
}

export function selectRunnerScript(scr) {
  state.activeRunnerScriptId = scr ? scr.id : null;
  dom.runnerNameInput.value = scr ? scr.name : "";
  dom.runnerRuntimeSelect.value = scr ? (scr.runtime || "python") : "python";
  dom.runnerCodeInput.value = scr ? scr.code : "";
  dom.runnerDeleteBtn.hidden = !scr || !!scr.builtin;
  dom.runnerMediaEl.replaceChildren();
  dom.runnerOutputEl.hidden = true;
  dom.runnerStatusEl.textContent = "";
  renderRunnerParams();
  renderRunnerSidebar();
}

export function renderRunnerSidebar() {
  dom.runnerSidebarEl.replaceChildren();
  const all = [...state.directScripts, ...defaultDirectScripts()];
  for (const scr of all) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-nav-btn" + (scr.id === state.activeRunnerScriptId ? " is-active" : "");
    btn.textContent = scr.name;
    btn.addEventListener("click", () => selectRunnerScript(scr));
    dom.runnerSidebarEl.append(btn);
  }
}

export function openRunnerModal() {
  const all = [...state.directScripts, ...defaultDirectScripts()];
  if (!state.activeRunnerScriptId && all.length) selectRunnerScript(all[0]);
  else renderRunnerSidebar();
  openDialog(dom.runnerModal);
}

/* ── Local <-> Cloud Folder Sync ── */
export function openSyncModal() {
  dom.syncLocalInput.value = state.syncConfig.localDir || "";
  dom.syncRemoteInput.value = state.syncConfig.remoteDir || "/content/project";
  dom.syncLogEl.hidden = true;
  openDialog(dom.syncModal);
}

export async function triggerFolderSync(direction) {
  if (!state.selected) { showToast(L("请先连接 Colab 虚拟机", "Connect to a Colab VM first")); return; }
  state.syncConfig = { localDir: dom.syncLocalInput.value.trim(), remoteDir: dom.syncRemoteInput.value.trim() || "/content/project" };
  flushStoreToDisk();
  dom.syncLogEl.hidden = false;
  dom.syncLogEl.textContent = direction === "push"
    ? L("正在打包并推送到云端…", "Archiving and pushing to Colab…")
    : L("正在从云端打包拉回本地…", "Archiving and pulling from Colab…");
  try {
    const res = await fetch(`/api/sync/${direction}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.selected, ...state.syncConfig }),
    }).then((r) => r.json());
    dom.syncLogEl.textContent = res.ok
      ? L(
        `${direction === "push" ? "推送" : "拉回"}成功（${formatFileSize(res.bytes)}）：${res.localDir} ↔ ${res.remoteDir}`,
        `${direction === "push" ? "Push" : "Pull"} complete (${formatFileSize(res.bytes)}): ${res.localDir} ↔ ${res.remoteDir}`,
      )
      : L(`同步失败：${res.error}`, `Sync failed: ${res.error}`);
  } catch (err) {
    dom.syncLogEl.textContent = err.message;
  }
}

export function initCloudTools() {
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

  document.querySelector("#open-templates-btn").addEventListener("click", () => {
    closeToolsDropdown();
    renderTemplatesModal();
    openDialog(dom.templatesModal);
  });
  document.querySelector("#close-templates-modal").addEventListener("click", () => closeDialog(dom.templatesModal));
  dom.templatesModal.addEventListener("click", (e) => { if (e.target === dom.templatesModal) closeDialog(dom.templatesModal); });
  dom.templateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const titleVal = dom.tplTitleInput.value.trim();
    const promptVal = dom.tplPromptInput.value.trim();
    if (!titleVal || !promptVal) return;
    state.promptTemplates.unshift({ id: `tpl-${Date.now().toString(36)}`, title: titleVal, prompt: promptVal });
    dom.tplTitleInput.value = "";
    dom.tplPromptInput.value = "";
    flushStoreToDisk();
    renderTemplatesModal();
  });

  document.querySelector("#open-runner-btn").addEventListener("click", () => {
    closeToolsDropdown();
    openRunnerModal();
  });
  document.querySelector("#close-runner-modal").addEventListener("click", () => closeDialog(dom.runnerModal));
  dom.runnerModal.addEventListener("click", (e) => { if (e.target === dom.runnerModal) closeDialog(dom.runnerModal); });
  dom.runnerCodeInput.addEventListener("input", renderRunnerParams);
  document.querySelector("#runner-new-btn").addEventListener("click", () => selectRunnerScript(null));
  document.querySelector("#runner-save-btn").addEventListener("click", () => {
    const name = dom.runnerNameInput.value.trim() || L("未命名脚本", "Untitled Script");
    const runtime = dom.runnerRuntimeSelect.value === "bash" ? "bash" : "python";
    const codeVal = dom.runnerCodeInput.value;
    const isCustomExisting = state.directScripts.some((x) => x.id === state.activeRunnerScriptId);
    const id = isCustomExisting ? state.activeRunnerScriptId : `scr-${Date.now().toString(36)}`;
    const obj = { id, name, runtime, code: codeVal };
    if (isCustomExisting) {
      state.directScripts = state.directScripts.map((x) => (x.id === id ? obj : x));
    } else {
      state.directScripts.unshift(obj);
    }
    state.activeRunnerScriptId = id;
    flushStoreToDisk();
    renderRunnerSidebar();
    dom.runnerDeleteBtn.hidden = false;
    dom.runnerStatusEl.textContent = L("已保存到本地", "Saved locally");
  });
  dom.runnerDeleteBtn.addEventListener("click", () => {
    state.directScripts = state.directScripts.filter((x) => x.id !== state.activeRunnerScriptId);
    flushStoreToDisk();
    selectRunnerScript(state.directScripts[0] || defaultDirectScripts()[0]);
  });
  document.querySelector("#runner-exec-btn").addEventListener("click", async () => {
    if (!state.selected) {
      dom.runnerStatusEl.textContent = L("请先连接一台 Colab 虚拟机", "Connect to a Colab VM first");
      return;
    }
    const btn = document.querySelector("#runner-exec-btn");
    btn.disabled = true;
    dom.runnerStatusEl.textContent = L(`正在直连 ${state.selected} 执行（不经过 Agent）…`, `Running directly on ${state.selected} (no Agent)…`);
    dom.runnerOutputEl.hidden = false;
    dom.runnerOutputEl.textContent = L("执行中…", "Running…");
    dom.runnerMediaEl.replaceChildren();
    try {
      const res = await fetch("/api/runner/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: state.selected,
          runtime: dom.runnerRuntimeSelect.value,
          script: dom.runnerCodeInput.value,
          params: state.runnerParamValues,
          envVars: state.envVars,
        }),
      }).then((r) => r.json());
      dom.runnerStatusEl.textContent = res.ok ? L("执行完成", "Completed") : L(`执行失败：${res.error || ""}`, `Failed: ${res.error || ""}`);
      dom.runnerOutputEl.textContent = [res.stdout, res.stderr, res.error].filter(Boolean).join("\n").trim() || L("(无输出)", "(no output)");
      if (Array.isArray(res.media)) {
        for (const m of res.media) {
          if (m.kind === "video") {
            const v = document.createElement("video");
            v.className = "files-preview-video";
            v.src = m.url;
            v.controls = true;
            v.playsInline = true;
            dom.runnerMediaEl.append(v);
          } else {
            const img = document.createElement("img");
            img.className = "files-preview-img";
            img.src = m.url;
            img.alt = m.name;
            dom.runnerMediaEl.append(img);
          }
        }
      }
      refreshGpuTelemetry(true);
    } catch (err) {
      dom.runnerStatusEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  dom.inspectorSyncBtn.addEventListener("click", openSyncModal);
  document.querySelector("#close-sync-modal").addEventListener("click", () => closeDialog(dom.syncModal));
  dom.syncModal.addEventListener("click", (e) => { if (e.target === dom.syncModal) closeDialog(dom.syncModal); });
  document.querySelector("#sync-push-btn").addEventListener("click", () => triggerFolderSync("push"));
  document.querySelector("#sync-pull-btn").addEventListener("click", () => triggerFolderSync("pull"));
}

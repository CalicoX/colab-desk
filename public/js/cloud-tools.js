import { closeDialog, dom, openDialog } from "./dom.js";
import { state } from "./state.js";
import { L, autoGrowCode, formatFileSize, showToast, tr } from "./utils.js";
import { emit, on } from "./events.js";
import { flushStoreToDisk } from "./store.js";
import { mountModalTemplate } from "./templates/mount.js";
import { RUNNER_MODAL_HTML, SYNC_MODAL_HTML, TEMPLATES_MODAL_HTML } from "./templates/modals.js";

/* ── Prompt Templates Modal ── */
let templatesMounted = false;
let runnerMounted = false;
let syncMounted = false;
let cloudToolsEventsBound = false;

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

function ensureTemplatesModalMounted() {
  if (templatesMounted) return;
  templatesMounted = true;
  mountModalTemplate("templates-modal", TEMPLATES_MODAL_HTML);
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
}

export function renderTemplatesModal() {
  ensureTemplatesModalMounted();
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
      emit("composer:set-mode", "agent");
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
      emit("composer:set-mode", "agent");
      emit("agent:send", { promptText: tpl.prompt });
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

export function openTemplatesModal() {
  initCloudTools();
  emit("composer:close-tools-dropdown");
  renderTemplatesModal();
  openDialog(dom.templatesModal);
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
  if (!dom.runnerCodeInput || !dom.runnerParamsWrap) return;
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
  if (!dom.runnerSidebarEl) return;
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

function ensureRunnerModalMounted() {
  if (runnerMounted) return;
  runnerMounted = true;
  mountModalTemplate("runner-modal", RUNNER_MODAL_HTML);
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
      emit("cloud:refresh-gpu", true);
    } catch (err) {
      dom.runnerStatusEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

export function openRunnerModal() {
  initCloudTools();
  emit("composer:close-tools-dropdown");
  ensureRunnerModalMounted();
  const all = [...state.directScripts, ...defaultDirectScripts()];
  if (!state.activeRunnerScriptId && all.length) selectRunnerScript(all[0]);
  else renderRunnerSidebar();
  openDialog(dom.runnerModal);
}

/* ── Local <-> Cloud Folder Sync Modal ── */
function ensureSyncModalMounted() {
  if (syncMounted) return;
  syncMounted = true;
  mountModalTemplate("sync-modal", SYNC_MODAL_HTML);
  document.querySelector("#close-sync-modal").addEventListener("click", () => closeDialog(dom.syncModal));
  dom.syncModal.addEventListener("click", (e) => { if (e.target === dom.syncModal) closeDialog(dom.syncModal); });
  document.querySelector("#sync-push-btn").addEventListener("click", () => triggerFolderSync("push"));
  document.querySelector("#sync-pull-btn").addEventListener("click", () => triggerFolderSync("pull"));
}

export function openSyncModal() {
  initCloudTools();
  ensureSyncModalMounted();
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
  if (cloudToolsEventsBound) return;
  cloudToolsEventsBound = true;
  on("language:changed", () => {
    if (runnerMounted) renderRunnerSidebar();
    if (templatesMounted && dom.templatesModal?.open) renderTemplatesModal();
  });
}

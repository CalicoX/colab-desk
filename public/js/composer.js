import { composeAction } from "/desk.mjs";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { L, autoGrowCode, parseHardware, tr } from "./utils.js";
import { emit, on } from "./events.js";
import { scheduleStoreSync } from "./store.js";
import {
  consumeComposerDraft,
  enqueueAgentMessage,
  steerAgentMessage,
  syncSendButton,
} from "./threads.js";
import { sendAgentMessage } from "./agent.js";
import { appendResult, callAction, hardware } from "./sessions.js";

export function setComposerMode(nextMode, sync = true) {
  state.composerMode = nextMode === "cli" ? "cli" : nextMode === "notebook" ? "notebook" : "agent";
  const isAgent = state.composerMode === "agent";
  const isNotebook = state.composerMode === "notebook";
  const isCli = state.composerMode === "cli";
  dom.modeAgentBtn.classList.toggle("is-active", isAgent);
  dom.modeAgentBtn.setAttribute("aria-selected", isAgent ? "true" : "false");
  if (dom.modeNotebookBtn) {
    dom.modeNotebookBtn.classList.toggle("is-active", isNotebook);
    dom.modeNotebookBtn.setAttribute("aria-selected", isNotebook ? "true" : "false");
  }
  dom.modeCliBtn.classList.toggle("is-active", isCli);
  dom.modeCliBtn.setAttribute("aria-selected", isCli ? "true" : "false");
  if (dom.notebookView) dom.notebookView.hidden = !isNotebook;
  if (dom.transcript) dom.transcript.hidden = isNotebook;
  if (dom.composer) dom.composer.hidden = isNotebook;
  dom.agentControls.hidden = !isAgent;
  dom.cliControls.hidden = !isCli;
  if (isNotebook) emit("notebook:activate");
  try { localStorage.setItem("colab-desk.composer-mode", state.composerMode); } catch {}
  if (sync) scheduleStoreSync();
  syncComposer();
}

export function syncApprovalToggle(sync = true) {
  const isAsk = state.approvalMode === "ask";
  dom.approvalToggle.textContent = isAsk ? tr("composer.approvalAsk") : tr("composer.approvalAuto");
  dom.approvalToggle.title = isAsk
    ? (state.activeLang === "en" ? "Current: ask before running (click to toggle)" : "当前：执行前询问确认（点击切换）")
    : (state.activeLang === "en" ? "Current: auto-approve (click to toggle)" : "当前：自动执行操作（点击切换）");
  dom.approvalToggle.classList.toggle("is-ask", isAsk);
  try { localStorage.setItem("colab-desk.approval-mode", state.approvalMode); } catch {}
  if (sync) scheduleStoreSync();
}

export function syncBusyModeToggle(sync = true) {
  if (!dom.busyModeToggle) return;
  const isSteer = state.busySendMode === "steer";
  dom.busyModeToggle.textContent = isSteer ? L("⚡ 转向", "⚡ Steer") : L("排队", "Queue");
  dom.busyModeToggle.classList.toggle("is-steer", isSteer);
  dom.busyModeToggle.title = isSteer
    ? L("运行中按 Enter：立即中断并转向新指令（点击切换为排队）", "While running: Enter interrupts & steers immediately (click for Queue)")
    : L("运行中按 Enter：加入队列等待本轮结束发送（点击切换为转向）", "While running: Enter queues message for next turn (click for Steer)");
  if (dom.settingBusySendMode) dom.settingBusySendMode.value = state.busySendMode;
  syncSendButton();
  if (sync) scheduleStoreSync();
}

export function syncComposer() {
  const keyHint = state.enterToSend ? tr("composer.keyEnter") : tr("composer.keyCmd");
  if (state.composerMode === "agent") {
    dom.code.hidden = false;
    dom.code.classList.remove("is-mono");
    dom.code.placeholder = state.selected
      ? tr("composer.placeholderAgentSession", { session: state.selected, key: keyHint })
      : tr("composer.placeholderAgent", { key: keyHint });
    autoGrowCode();
    return;
  }

  const kind = dom.command.value;
  const needsEditor = kind === "exec" || kind === "ssh";
  dom.code.hidden = !needsEditor;
  dom.code.classList.add("is-mono");
  if (kind === "ssh") {
    dom.code.placeholder = tr("composer.placeholderCliSsh", { key: keyHint });
  } else if (kind === "exec") {
    dom.code.placeholder = tr("composer.placeholderCliExec", { key: keyHint });
  } else {
    dom.code.placeholder = tr("composer.placeholderCliDefault");
  }

  dom.extra.className = "extra";
  dom.extra.replaceChildren();
  const spec = {
    exec: [
      { name: "file", placeholder: L("-f 本地 .py/.ipynb（可选）", "-f local .py/.ipynb (optional)") },
      { name: "timeout", placeholder: L("timeout 秒（可选）", "timeout sec (optional)") },
    ],
    run: [
      { name: "script", placeholder: L("本地脚本路径", "Local script path") },
      { name: "runHardware", type: "select", options: ["cpu", "T4", "L4", "G4", "H100", "A100", "v5e1", "v6e1"] },
      { name: "runHighMem", type: "checkbox", label: "high-mem" },
      { name: "keep", type: "checkbox", label: "--keep" },
      { name: "args", placeholder: L("脚本参数（可选）", "Script args (optional)") },
    ],
    ls: [{ name: "path", placeholder: L("远程路径（默认 content）", "Remote path (default content)") }],
    upload: [
      { name: "local", placeholder: L("本地路径", "Local path") },
      { name: "remote", placeholder: L("远程路径", "Remote path") },
    ],
    download: [
      { name: "remote", placeholder: L("远程路径", "Remote path") },
      { name: "local", placeholder: L("本地路径", "Local path") },
    ],
    rm: [{ name: "path", placeholder: L("远程路径", "Remote path") }],
    install: [
      { name: "packages", placeholder: L("包名，空格分隔", "Packages (space-separated)") },
      { name: "requirements", placeholder: L("或 -r requirements.txt", "or -r requirements.txt") },
    ],
    log: [
      { name: "lines", placeholder: L("-n 行数（可选）", "-n lines (optional)") },
      { name: "eventType", placeholder: L("-t 类型（可选）", "-t event type (optional)") },
      { name: "output", placeholder: L("-o 导出 .ipynb/.md（可选）", "-o export .ipynb/.md (optional)") },
    ],
    drivemount: [{ name: "path", placeholder: L("挂载路径（默认 /content/drive）", "Mount path (default /content/drive)") }],
  }[kind];

  if (spec && spec.length) {
    dom.extra.classList.add("show");
    for (const item of spec) {
      if (item.type === "checkbox") {
        const label = document.createElement("label");
        label.className = "flag-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = item.name;
        label.append(input, document.createTextNode(item.label));
        dom.extra.append(label);
      } else if (item.type === "select") {
        const select = document.createElement("select");
        select.name = item.name;
        select.setAttribute("aria-label", "run 硬件");
        for (const optVal of item.options) {
          const opt = document.createElement("option");
          opt.value = optVal;
          opt.textContent = optVal === "cpu" ? "CPU" : optVal;
          select.append(opt);
        }
        dom.extra.append(select);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.name = item.name;
        input.placeholder = item.placeholder;
        input.setAttribute("aria-label", item.placeholder);
        dom.extra.append(input);
      }
    }
  }
  if (!dom.code.hidden) autoGrowCode();
}

export function fieldMap() {
  const fields = {};
  dom.extra.querySelectorAll("input, select").forEach((el) => {
    fields[el.name] = el.type === "checkbox" ? el.checked : el.value;
  });
  return fields;
}

export function closeToolsDropdown() {
  if (dom.toolsDropdownMenu) dom.toolsDropdownMenu.hidden = true;
  if (dom.toolsDropdownBtn) dom.toolsDropdownBtn.setAttribute("aria-expanded", "false");
}

export function initComposer() {
  on("composer:set-mode", (payload) => {
    if (payload && typeof payload === "object") setComposerMode(payload.mode, payload.sync);
    else setComposerMode(payload);
  });
  on("composer:sync-busy-mode", (sync) => syncBusyModeToggle(sync));
  on("composer:sync-approval", (sync) => syncApprovalToggle(sync));
  on("composer:sync", syncComposer);
  on("composer:close-tools-dropdown", closeToolsDropdown);
  on("language:changed", () => {
    syncBusyModeToggle(false);
    syncApprovalToggle(false);
    syncComposer();
  });

  dom.toolsDropdownBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = dom.toolsDropdownMenu.hidden;
    dom.toolsDropdownMenu.hidden = !opening;
    dom.toolsDropdownBtn.setAttribute("aria-expanded", opening ? "true" : "false");
  });
  dom.toolsDropdownMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeToolsDropdown);

  dom.modeAgentBtn.addEventListener("click", () => setComposerMode("agent"));
  if (dom.modeNotebookBtn) dom.modeNotebookBtn.addEventListener("click", () => setComposerMode("notebook"));
  dom.modeCliBtn.addEventListener("click", () => setComposerMode("cli"));

  dom.approvalToggle.addEventListener("click", () => {
    state.approvalMode = state.approvalMode === "auto" ? "ask" : "auto";
    syncApprovalToggle();
  });

  dom.command.addEventListener("change", syncComposer);

  dom.code.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      dom.composer.requestSubmit();
      return;
    }
    if (state.enterToSend && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      dom.composer.requestSubmit();
    }
  });

  dom.code.addEventListener("input", () => {
    autoGrowCode();
    syncSendButton();
  });

  dom.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.activeAgentController) {
      const submitter = event.submitter;
      const draft = state.composerMode === "agent" ? consumeComposerDraft() : null;
      if (submitter === dom.sendBtn || !draft) {
        state.stopReasonKind = "stop";
        state.activeAgentController.abort();
        return;
      }
      if (state.busySendMode === "steer") {
        steerAgentMessage(draft.promptText, draft.files);
      } else {
        enqueueAgentMessage(draft.promptText, draft.files);
      }
      return;
    }
    if (state.composerMode === "agent") {
      const draft = consumeComposerDraft();
      if (!draft) return;
      await sendAgentMessage(draft.promptText, draft.files);
      return;
    }

    const fields = fieldMap();
    const actionHardware = dom.command.value === "run"
      ? parseHardware(fields.runHardware || "cpu", fields.runHighMem)
      : hardware();
    const composed = composeAction({
      command: dom.command.value,
      selected: state.selected,
      hardware: actionHardware,
      fields,
      code: dom.code.value,
    });
    if (composed.error) {
      appendResult(dom.command.value, { ok: false, error: composed.error }, state.selected || "");
      return;
    }
    const key = composed.action.type === "run" ? `run:${composed.action.script}` : state.selected || "";
    if (composed.action.type === "run") {
      dom.title.textContent = composed.action.script;
      dom.crumbName.textContent = "run";
      dom.meta.textContent = composed.action.keep
        ? L("新机器（完成后保留会话）", "New runtime (kept after finish)")
        : L("新机器，不占用当前会话", "Ephemeral runtime (separate from current session)");
    }
    await callAction(composed.action, dom.command.value, key);
  });
}

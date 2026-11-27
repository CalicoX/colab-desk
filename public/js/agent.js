import { buildContextHandoffPrompt, parseColabNewSpec, record } from "/desk.mjs";
import { dom } from "./dom.js";
import { currentSessionObject, desk, state } from "./state.js";
import { L, sendDesktopNotification, showToast, tr } from "./utils.js";
import { callRegistered, emit, on } from "./events.js";
import { persistDeskHistory } from "./store.js";
import { recordAgentUsage } from "./usage-stats.js";
import {
  buildSteerContinuationPrompt,
  ensureActiveThread,
  getSessionQueue,
  renderChatThreads,
  renderComposerQueue,
  syncSendButton,
} from "./threads.js";
import {
  enqueueThoughtChunk,
  flushThoughtStream,
  renderTranscript,
  updateThoughtMetaInPlace,
} from "./transcript.js";
import { initAgentPickers, syncAgentPickerLabel, syncThoughtPickerLabel } from "./agent-pickers.js";
import { initAgentAttachments, renderStagedFiles } from "./agent-attachments.js";
import { initAgentNativeBridge } from "./agent-bridge.js";

/* ── Agent Streaming Turn Execution ── */
export async function sendAgentMessage(promptText, overrideFiles = null, overrideApiPrompt = null) {
  const text = String(promptText || "").trim();
  if (!text || state.activeAgentController) return;
  let promptForApi = String(overrideApiPrompt || text);

  const key = ensureActiveThread(text);
  const threadObj = state.chatThreads.find((tItem) => tItem.id === key);
  const provider = dom.agentProviderSelect.value || "agy";
  const providerLabel = dom.agentProviderSelect.selectedOptions[0]?.textContent?.replace(/\s*\((?:未安装|Not installed)\)/, "") || provider;
  const model = dom.agentModelSelect.value || "";
  const nextModelLabel = model ? `${providerLabel} · ${model}` : providerLabel;
  const priorEntries = Array.isArray(desk.bySession[key]) ? desk.bySession[key] : [];
  if (threadObj && priorEntries.length > 0) {
    const prevProvider = threadObj.lastProvider || "";
    const prevModel = threadObj.lastModel || "";
    const switchedProvider = Boolean(prevProvider && prevProvider !== provider);
    const switchedModel = Boolean(prevModel && model && prevModel !== model);
    if (switchedProvider || switchedModel) {
      const prevLabel = threadObj.lastModelLabel || prevModel || prevProvider;
      promptForApi = buildContextHandoffPrompt(priorEntries, promptForApi, prevLabel, nextModelLabel, state.activeLang);
      showToast(L(
        `已自动交接对话上下文（${prevLabel} → ${nextModelLabel}）`,
        `Handed off context (${prevLabel} → ${nextModelLabel})`,
      ));
    }
  }
  if (threadObj) {
    threadObj.lastProvider = provider;
    threadObj.lastModel = model;
    threadObj.lastModelLabel = nextModelLabel;
    threadObj.updatedAt = Date.now();
  }
  const attached = Array.isArray(overrideFiles) ? overrideFiles.slice() : state.stagedFiles.slice();
  if (!Array.isArray(overrideFiles)) {
    state.stagedFiles = [];
    renderStagedFiles();
  }

  const turnStartedAt = Date.now();
  if (state.agentxPendingTemplateId) {
    state.agentxThreadTemplates = state.agentxThreadTemplates || {};
    state.agentxThreadTemplates[key] = state.agentxPendingTemplateId;
    const assignedId = state.agentxPendingTemplateId;
    state.agentxPendingTemplateId = "";
    fetch("/api/agentx/templates/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeKey: key, templateId: assignedId }),
    }).catch(() => {});
  }
  const activeTemplateId =
    (state.agentxThreadTemplates && (state.agentxThreadTemplates[key] || state.agentxThreadTemplates[state.selected])) || "";
  const entry = {
    kind: "agent",
    timestamp: turnStartedAt,
    label: text,
    files: attached,
    provider,
    providerName: providerLabel,
    model: model || tr("composer.defaultModel"),
    ok: true,
    streaming: true,
    thought: "",
    thoughtTokens: 0,
    thinkSec: 0,
    thoughtOpen: undefined,
    tools: [],
    permissions: [],
    text: "",
    error: "",
  };
  record(desk, key, entry);
  renderTranscript(key);
  emit("sessions:render-inspector");

  const controller = new AbortController();
  state.activeAgentController = controller;
  state.activeAgentTurnContext = { key, prompt: text };
  syncSendButton();
  renderChatThreads();

  let renderScheduled = false;
  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if ((desk.view || "") === key) renderTranscript(key);
    });
  };

  const thinkTimer = setInterval(() => {
    if (entry.streaming && !entry.text) {
      entry.thinkSec = Number(((Date.now() - turnStartedAt) / 1000).toFixed(1));
      if ((desk.view || "") === key && !updateThoughtMetaInPlace(entry)) {
        scheduleRender();
      }
    }
  }, 200);

  state.lastActivityAt = Date.now();
  state.idleAlertedSession = "";
  try {
    const thoughtLevel = dom.thoughtPickerWrap && !dom.thoughtPickerWrap.hidden && dom.agentThoughtSelect ? dom.agentThoughtSelect.value : "";
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        model,
        thoughtLevel,
        approvalMode: state.approvalMode,
        prompt: promptForApi,
        chatThreadId: key,
        colabSession: state.selected,
        sessionInfo: currentSessionObject(),
        files: attached,
        templateId: activeTemplateId,
        lang: state.activeLang || "zh-CN",
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      entry.ok = false;
      entry.error = errData.error || `HTTP ${res.status}`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawTool = false;
    let lastCtxUsed = null;
    let lastCtxSize = null;
    let recordedUsage = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (ev.type === "meta") {
          if (ev.model) entry.model = ev.model;
          if (ev.providerName) entry.providerName = ev.providerName;
        } else if (ev.type === "text") {
          if (!entry.text) {
            flushThoughtStream(entry);
            entry.thinkSec = Number(((Date.now() - turnStartedAt) / 1000).toFixed(1));
            if (entry.thoughtOpen === undefined) entry.thoughtOpen = state.keepThoughtOpen;
          }
          entry.text += ev.text || "";
        } else if (ev.type === "thought") {
          const delta = ev.text || "";
          entry.thought += delta;
          entry.thinkSec = Number(((Date.now() - turnStartedAt) / 1000).toFixed(1));
          if ((desk.view || "") === key && enqueueThoughtChunk(entry, delta)) {
            continue;
          }
        } else if (ev.type === "usage") {
          if (ev.used != null) lastCtxUsed = ev.used;
          if (ev.size != null) lastCtxSize = ev.size;
        } else if (ev.type === "tool_call") {
          sawTool = true;
          const existing = entry.tools.find((tItem) => tItem.toolCallId === ev.toolCallId);
          if (existing) {
            Object.assign(existing, ev);
          } else {
            entry.tools.push({
              toolCallId: ev.toolCallId,
              title: ev.title,
              status: ev.status || "in_progress",
              input: ev.input || "",
              output: "",
            });
          }
          const newSpec = parseColabNewSpec(ev.input) || parseColabNewSpec(ev.title);
          if (newSpec && ev.status !== "completed" && ev.status !== "failed") {
            emit("session-create:track", { toolCallId: ev.toolCallId, spec: newSpec });
          }
        } else if (ev.type === "tool_update") {
          const target =
            entry.tools.find((tItem) => tItem.toolCallId && tItem.toolCallId === ev.toolCallId) ||
            entry.tools[entry.tools.length - 1];
          if (target) {
            if (ev.title) target.title = ev.title;
            if (ev.status) target.status = ev.status;
            if (ev.output) target.output = target.output ? `${target.output}\n${ev.output}` : ev.output;
            if (!state.agentCreate) {
              const lateSpec = parseColabNewSpec(target.input) || parseColabNewSpec(target.title);
              if (lateSpec && target.status !== "completed" && target.status !== "failed") {
                emit("session-create:track", { toolCallId: target.toolCallId, spec: lateSpec });
              }
            }
            if (state.agentCreate && (!state.agentCreate.toolCallId || state.agentCreate.toolCallId === target.toolCallId)) {
              if (target.status === "completed" || target.status === "failed") {
                emit("session-create:resolve", { status: target.status, outputText: target.output || ev.output || "" });
              }
            }
          }
        } else if (ev.type === "permission_request") {
          entry.permissions.push(ev);
        } else if (ev.type === "done") {
          const u = ev.usage;
          const tTok = u?.thoughtTokens ?? u?.reasoning_tokens ?? 0;
          if (tTok > 0) entry.thoughtTokens = tTok;
          if (!recordedUsage) {
            recordedUsage = true;
            recordAgentUsage(entry.provider, entry.providerName, u, ev.costUsd, lastCtxUsed, lastCtxSize);
          }
        } else if (ev.type === "error") {
          entry.ok = false;
          entry.error = ev.error || "Agent 执行出错";
          if (ev.authRequired) entry.authRequired = true;
        }
        scheduleRender();
      }
    }

    if (sawTool) {
      await callRegistered("sessions:refresh", state.selected);
      if (state.agentCreate && !state.agentCreate.failedRetryable) {
        const found = state.sessions.some((s) => s.name === state.agentCreate.name);
        emit("session-create:resolve", { status: found ? "completed" : "failed", outputText: entry.error || entry.text || "" });
      }
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      const abortNote = state.stopReasonKind === "steer"
        ? (state.activeLang === "en" ? "*(Redirected via Steer)*" : "*（已中断并转向新指令）*")
        : (state.activeLang === "en" ? "*(Stopped)*" : "*（已手动停止）*");
      entry.text = entry.text ? `${entry.text}\n\n${abortNote}` : abortNote;
    } else {
      entry.ok = false;
      entry.error = (err && err.message) || "连接 Agent 失败";
    }
  } finally {
    clearInterval(thinkTimer);
    flushThoughtStream(entry);
    entry.streaming = false;
    entry.permissions = [];
    for (const tItem of entry.tools) {
      if (tItem.status === "in_progress") tItem.status = "completed";
    }
    const nextSteer = state.pendingSteerItem;
    const wasManualStop = state.stopReasonKind === "stop";
    const wasSteerAbort = state.stopReasonKind === "steer";
    state.pendingSteerItem = null;
    state.stopReasonKind = null;
    if (state.activeAgentController === controller) state.activeAgentController = null;
    if (state.activeAgentTurnContext && state.activeAgentTurnContext.prompt === text) state.activeAgentTurnContext = null;
    if (!wasSteerAbort && !wasManualStop) {
      state.pendingUnfinishedTasks.delete(key);
    } else if (wasManualStop) {
      const prevList = state.pendingUnfinishedTasks.get(key) || [];
      prevList.push(text);
      state.pendingUnfinishedTasks.set(key, prevList);
    }
    state.lastActivityAt = Date.now();
    const elapsedMs = Date.now() - turnStartedAt;
    if (!nextSteer && (elapsedMs >= 8000 || !document.hasFocus())) {
      if (!entry.ok && entry.error) {
        sendDesktopNotification(
          L("Colab Desk — 任务异常", "Colab Desk — Task Error"),
          entry.error.slice(0, 120),
        );
      } else if (entry.text) {
        sendDesktopNotification(
          L("Colab Desk — 任务已完成", "Colab Desk — Task Completed"),
          `${state.selected || "Colab"} · ${entry.text.replace(/\s+/g, " ").slice(0, 100)}`,
        );
      }
    }
    syncSendButton();
    persistDeskHistory();
    renderTranscript(key);
    emit("sessions:render-inspector");
    renderComposerQueue();

    if (nextSteer) {
      const unfinished = state.pendingUnfinishedTasks.get(nextSteer.key) || [];
      const wrappedPrompt = buildSteerContinuationPrompt(nextSteer.promptText, unfinished);
      setTimeout(() => sendAgentMessage(nextSteer.promptText, nextSteer.files, wrappedPrompt), 0);
    } else if (!wasManualStop) {
      const q = getSessionQueue(key);
      if (q.length > 0 && (state.selected || "") === key) {
        const nextItem = q.shift();
        renderComposerQueue();
        setTimeout(() => sendAgentMessage(nextItem.promptText, nextItem.files), 0);
      }
    }
  }
}

export function initAgentControls() {
  // Register native macOS WKWebView bridges immediately at startup
  initAgentNativeBridge();
  initAgentPickers();
  initAgentAttachments();

  on("agent:send", ({ promptText, files, apiPrompt } = {}) => {
    sendAgentMessage(promptText, files, apiPrompt);
  });
  on("language:changed", () => {
    syncAgentPickerLabel();
    syncThoughtPickerLabel();
  });

  // Starter prompt cards
  document.querySelectorAll("[data-starter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      emit("composer:set-mode", "agent");
      sendAgentMessage(btn.dataset.starter);
    });
  });
}

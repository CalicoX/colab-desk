import { dom } from "./dom.js";
import { currentTranscriptKey, desk, state } from "./state.js";
import { L, autoGrowCode, isImageAttachment, showToast, tr } from "./utils.js";
import { flushStoreToDisk, persistDeskHistory, scheduleStoreSync } from "./store.js";
import { renderStagedFiles, sendAgentMessage } from "./agent.js";
import { renderTranscript } from "./transcript.js";
import { renderInspector, renderSessions } from "./sessions.js";
import { renderTunnels } from "./cloud-tools.js";
import { syncBusyModeToggle } from "./composer.js";

export function deriveThreadTitle(entries, fallback = "") {
  if (Array.isArray(entries)) {
    const firstUser = entries.find((e) => e && e.label && String(e.label).trim());
    if (firstUser) {
      const clean = String(firstUser.label).replace(/\s+/g, " ").trim();
      return clean.length > 36 ? `${clean.slice(0, 35)}…` : clean;
    }
  }
  if (fallback) return fallback;
  return L("新对话", "New Chat");
}

export function migrateLegacyThreads() {
  const existingIds = new Set(state.chatThreads.map((tItem) => tItem.id));
  for (const [k, list] of Object.entries(desk.bySession)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    let id = k;
    if (!id) {
      id = "chat-general";
      if (!desk.bySession[id] || desk.bySession[id].length === 0) {
        desk.bySession[id] = list;
      }
      delete desk.bySession[""];
    }
    if (!existingIds.has(id)) {
      existingIds.add(id);
      state.chatThreads.push({
        id,
        title: deriveThreadTitle(desk.bySession[id], k || L("历史对话", "Saved Chat")),
        sessionName: k || "",
        pinned: false,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      });
    }
  }
  // Keep only threads that either have entries or are the active empty thread
  state.chatThreads = state.chatThreads.filter((tItem) => tItem.id === state.activeThreadId || (Array.isArray(desk.bySession[tItem.id]) && desk.bySession[tItem.id].length > 0));
  if (state.activeThreadId && !state.chatThreads.some((tItem) => tItem.id === state.activeThreadId)) {
    state.activeThreadId = null;
  }
}

export function ensureActiveThread(firstPromptText = "") {
  let cur = state.chatThreads.find((tItem) => tItem.id === state.activeThreadId);
  if (!cur) {
    const id = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    cur = {
      id,
      title: firstPromptText ? deriveThreadTitle([{ label: firstPromptText }]) : L("新对话", "New Chat"),
      sessionName: state.selected || "",
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.chatThreads.unshift(cur);
    state.activeThreadId = id;
    if (!desk.bySession[id]) desk.bySession[id] = [];
  } else {
    if (firstPromptText && (!cur.title || cur.title === "新对话" || cur.title === "New Chat")) {
      cur.title = deriveThreadTitle([{ label: firstPromptText }]);
    }
    if (state.selected && !cur.sessionName) cur.sessionName = state.selected;
    cur.updatedAt = Date.now();
  }
  renderChatThreads();
  return cur.id;
}

export function openChatThread(threadId) {
  const target = state.chatThreads.find((tItem) => tItem.id === threadId);
  if (!target) return;
  state.activeThreadId = target.id;
  if (target.sessionName && state.sessions.some((s) => s.name === target.sessionName) && state.selected !== target.sessionName) {
    state.selected = target.sessionName;
    renderSessions();
    renderInspector();
    renderTunnels();
  }
  renderChatThreads();
  renderTranscript(state.activeThreadId);
  renderComposerQueue();
  scheduleStoreSync();
}

export async function createNewChatThread() {
  if (state.activeAgentController) {
    state.stopReasonKind = "stop";
    state.activeAgentController.abort();
  }
  // Drop any lingering empty placeholder threads and return cleanly to the New Chat screen
  state.chatThreads = state.chatThreads.filter((tItem) => Array.isArray(desk.bySession[tItem.id]) && desk.bySession[tItem.id].length > 0);
  state.activeThreadId = null;
  renderChatThreads();
  renderTranscript("");
  renderInspector();
  renderComposerQueue();
  persistDeskHistory();
  try {
    await fetch("/api/agent/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colabSession: state.selected || "", provider: "" }),
    });
  } catch {}
  dom.code.focus();
  showToast(tr("toast.newChat"));
}

export function togglePinChatThread(threadId) {
  const target = state.chatThreads.find((tItem) => tItem.id === threadId);
  if (!target) return;
  target.pinned = !target.pinned;
  renderChatThreads();
  scheduleStoreSync();
}

export function ensureUndoToast() {
  if (state.undoToastEl) return state.undoToastEl;
  const box = document.querySelector("#undo-toast") || document.createElement("div");
  box.id = "undo-toast";
  box.className = "undo-toast";
  box.setAttribute("role", "status");
  box.hidden = true;
  box.replaceChildren();
  const msg = document.createElement("span");
  msg.className = "undo-toast-msg";
  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "undo-toast-btn";
  undoBtn.addEventListener("click", () => undoLastDeletedThread());
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "undo-toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => hideUndoToast());
  box.append(msg, undoBtn, closeBtn);
  if (!box.parentElement) document.body.append(box);
  state.undoToastEl = box;
  return box;
}

export function hideUndoToast() {
  clearTimeout(state.undoToastTimer);
  state.undoToastTimer = null;
  if (state.undoToastEl) state.undoToastEl.hidden = true;
}

export function showUndoDeleteToast(title) {
  const box = ensureUndoToast();
  box.querySelector(".undo-toast-msg").textContent = L(
    `已删除对话「${title}」`,
    `Deleted "${title}"`,
  );
  box.querySelector(".undo-toast-btn").textContent = L("撤销 (⌘Z)", "Undo (⌘Z)");
  box.hidden = false;
  clearTimeout(state.undoToastTimer);
  state.undoToastTimer = setTimeout(() => {
    hideUndoToast();
  }, 9000);
}

export function undoLastDeletedThread() {
  const snap = state.deletedThreadStack.pop();
  if (!snap) return false;
  const insertAt = Math.min(Math.max(0, snap.index), state.chatThreads.length);
  state.chatThreads.splice(insertAt, 0, snap.thread);
  desk.bySession[snap.thread.id] = snap.entries;
  if (snap.queue && snap.queue.length > 0) {
    state.messageQueues.set(snap.thread.id, snap.queue);
  }
  state.activeThreadId = snap.thread.id;
  renderChatThreads();
  renderTranscript(state.activeThreadId);
  renderInspector();
  renderComposerQueue();
  persistDeskHistory();
  flushStoreToDisk();
  if (state.deletedThreadStack.length > 0) {
    showUndoDeleteToast(state.deletedThreadStack[state.deletedThreadStack.length - 1].thread.title || L("新对话", "New Chat"));
  } else {
    hideUndoToast();
  }
  showToast(L(`已恢复对话「${snap.thread.title || "新对话"}」`, `Restored "${snap.thread.title || "Chat"}"`));
  return true;
}

export function deleteChatThread(threadId) {
  const idx = state.chatThreads.findIndex((tItem) => tItem.id === threadId);
  if (idx < 0) return;
  const [removed] = state.chatThreads.splice(idx, 1);
  const savedEntries = Array.isArray(desk.bySession[threadId]) ? [...desk.bySession[threadId]] : [];
  const savedQueue = state.messageQueues.has(threadId) ? [...state.messageQueues.get(threadId)] : [];
  state.deletedThreadStack.push({
    thread: { ...removed },
    index: idx,
    entries: savedEntries,
    queue: savedQueue,
    wasActive: state.activeThreadId === threadId,
  });
  if (state.deletedThreadStack.length > 20) state.deletedThreadStack.shift();

  delete desk.bySession[threadId];
  state.messageQueues.delete(threadId);
  if (state.activeThreadId === threadId) {
    state.activeThreadId = null;
  }
  renderChatThreads();
  renderTranscript(currentTranscriptKey());
  renderInspector();
  renderComposerQueue();
  persistDeskHistory();
  flushStoreToDisk();
  showUndoDeleteToast(removed.title || L("新对话", "New Chat"));
}

export function renderChatThreads() {
  if (!dom.chatThreadsListEl) return;
  const q = (dom.filter ? dom.filter.value : "").trim().toLowerCase();
  const sorted = state.chatThreads
    .filter((tItem) => {
      if (!q) return true;
      return (tItem.title || "").toLowerCase().includes(q) || (tItem.sessionName || "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  dom.chatThreadsListEl.replaceChildren();
  if (!sorted.length) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "chat-threads-empty";
    emptyEl.textContent = tr("sidebar.chatsEmpty");
    dom.chatThreadsListEl.append(emptyEl);
    return;
  }
  for (const tItem of sorted) {
    const liveSession = tItem.sessionName
      ? state.sessions.find((s) => s.name === tItem.sessionName)
      : null;
    const isStreaming = Boolean(state.activeAgentTurnContext && state.activeAgentTurnContext.key === tItem.id);
    const isVmBusy = Boolean(liveSession && /busy|running/i.test(String(liveSession.status || "")));

    const row = document.createElement("div");
    row.className =
      "chat-thread-row" +
      (tItem.id === state.activeThreadId ? " is-active" : "") +
      (tItem.pinned ? " is-pinned" : "") +
      (liveSession ? " is-vm-live" : "");
    row.addEventListener("click", () => openChatThread(tItem.id));

    const main = document.createElement("div");
    main.className = "chat-thread-main";
    const titleLine = document.createElement("div");
    titleLine.className = "chat-thread-title-line";
    if (isStreaming || liveSession) {
      const dot = document.createElement("span");
      dot.className = `chat-thread-dot ${isStreaming || isVmBusy ? "is-busy" : "is-live"}`;
      dot.title = isStreaming
        ? L("Agent 正在执行中", "Agent is running")
        : isVmBusy
          ? L(`虚拟机 ${liveSession.name} 正在执行任务`, `VM ${liveSession.name} is busy`)
          : L(`虚拟机 ${liveSession.name} 活动中`, `VM ${liveSession.name} is active`);
      titleLine.append(dot);
    }
    if (tItem.pinned) {
      const pinBadge = document.createElement("span");
      pinBadge.className = "chat-thread-pin-ico";
      pinBadge.textContent = "★";
      titleLine.append(pinBadge);
    }
    const titleEl = document.createElement("span");
    titleEl.className = "chat-thread-title";
    titleEl.textContent = tItem.title || L("新对话", "New Chat");
    titleEl.title = titleEl.textContent;
    titleLine.append(titleEl);

    const count = (desk.bySession[tItem.id] || []).length;
    const metaEl = document.createElement("span");
    metaEl.className = "chat-thread-meta";
    if (isStreaming) {
      const st = document.createElement("span");
      st.className = "chat-thread-status is-busy";
      st.textContent = tItem.sessionName
        ? `${tItem.sessionName} ${L("运行中", "Running")}`
        : L("生成中", "Working");
      metaEl.append(st, document.createTextNode(` · ${tr("rail.historyCount", { count })}`));
    } else if (liveSession) {
      const st = document.createElement("span");
      st.className = `chat-thread-status ${isVmBusy ? "is-busy" : "is-live"}`;
      const hwPart = liveSession.hardware ? ` (${liveSession.hardware})` : "";
      st.textContent = isVmBusy
        ? `${liveSession.name}${hwPart} ${L("执行中", "Busy")}`
        : `${liveSession.name}${hwPart} ${L("活动中", "Active")}`;
      metaEl.append(st, document.createTextNode(` · ${tr("rail.historyCount", { count })}`));
    } else if (tItem.sessionName) {
      const st = document.createElement("span");
      st.className = "chat-thread-status is-off";
      st.textContent = `${tItem.sessionName} ${L("已停止", "Stopped")}`;
      metaEl.append(st, document.createTextNode(` · ${tr("rail.historyCount", { count })}`));
    } else {
      metaEl.textContent = tr("rail.historyCount", { count });
    }
    main.append(titleLine, metaEl);

    const actions = document.createElement("div");
    actions.className = "chat-thread-actions";

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "chat-thread-act" + (tItem.pinned ? " is-pinned" : "");
    pinBtn.title = tItem.pinned ? L("取消置顶", "Unpin") : L("置顶对话", "Pin chat");
    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePinChatThread(tItem.id);
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "chat-thread-act is-danger";
    delBtn.title = L("删除对话", "Delete chat");
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChatThread(tItem.id);
    });

    actions.append(pinBtn, delBtn);
    row.append(main, actions);
    dom.chatThreadsListEl.append(row);
  }
}

export function getSessionQueue(key = currentTranscriptKey()) {
  if (!state.messageQueues.has(key)) state.messageQueues.set(key, []);
  return state.messageQueues.get(key);
}

export function renderComposerQueue() {
  if (!dom.composerQueueEl) return;
  const key = currentTranscriptKey();
  const list = getSessionQueue(key);
  dom.composerQueueEl.replaceChildren();
  if (!list.length) {
    dom.composerQueueEl.hidden = true;
    return;
  }
  dom.composerQueueEl.hidden = false;
  list.forEach((item) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    const left = document.createElement("div");
    left.className = "queue-item-left";
    const dots = document.createElement("span");
    dots.className = "queue-dots";
    dots.textContent = "⁘";
    left.append(dots);

    const isEditing = state.editingQueueItemId === item.id;
    if (isEditing) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "queue-edit-input";
      inp.value = item.promptText;
      const commitEdit = () => {
        const next = inp.value.trim();
        if (next) item.promptText = next;
        state.editingQueueItemId = null;
        renderComposerQueue();
      };
      inp.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
        else if (e.key === "Escape") { e.preventDefault(); state.editingQueueItemId = null; renderComposerQueue(); }
      });
      left.append(inp);
      const actions = document.createElement("div");
      actions.className = "queue-item-actions";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "queue-mini-btn is-steer";
      saveBtn.textContent = L("保存", "Save");
      saveBtn.addEventListener("click", commitEdit);
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "queue-mini-btn";
      cancelBtn.textContent = L("取消", "Cancel");
      cancelBtn.addEventListener("click", () => { state.editingQueueItemId = null; renderComposerQueue(); });
      actions.append(saveBtn, cancelBtn);
      row.append(left, actions);
      dom.composerQueueEl.append(row);
      requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); });
      return;
    }

    const text = document.createElement("span");
    text.className = "queue-text";
    const fileTag = item.files?.length ? L(` [+${item.files.length} 个文件]`, ` [+${item.files.length} file${item.files.length > 1 ? "s" : ""}]`) : "";
    text.textContent = `${item.promptText.replace(/\s+/g, " ")}${fileTag}`;
    text.title = item.promptText;
    left.append(text);

    const actions = document.createElement("div");
    actions.className = "queue-item-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "queue-mini-btn";
    editBtn.textContent = L("修改", "Edit");
    editBtn.addEventListener("click", () => {
      state.editingQueueItemId = item.id;
      renderComposerQueue();
    });

    const sendNowBtn = document.createElement("button");
    sendNowBtn.type = "button";
    sendNowBtn.className = "queue-mini-btn is-steer";
    sendNowBtn.textContent = L("立即发送", "Send now");
    sendNowBtn.title = L("立即发送并要求 Agent 完成所有未完成的会话任务", "Send immediately and continue all unfinished tasks");
    sendNowBtn.addEventListener("click", () => {
      const cur = getSessionQueue(key);
      const pos = cur.findIndex((x) => x.id === item.id);
      if (pos >= 0) cur.splice(pos, 1);
      renderComposerQueue();
      steerAgentMessage(item.promptText, item.files);
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "queue-mini-btn";
    delBtn.textContent = L("取消", "Cancel");
    delBtn.addEventListener("click", () => {
      const cur = getSessionQueue(key);
      const pos = cur.findIndex((x) => x.id === item.id);
      if (pos >= 0) cur.splice(pos, 1);
      renderComposerQueue();
    });

    actions.append(editBtn, sendNowBtn, delBtn);
    row.append(left, actions);
    dom.composerQueueEl.append(row);
  });
}

export function consumeComposerDraft() {
  const rawText = dom.code.value.trim();
  const files = state.stagedFiles.slice();
  if (!rawText && files.length === 0) return null;
  const promptText = rawText || (
    files.some((f) => isImageAttachment(f))
      ? L("请查看附带的图片并结合上下文协助处理。", "Please inspect the attached image(s) and help.")
      : L("请查看附带的本地文件并协助处理。", "Please inspect the attached file(s) and help.")
  );
  dom.code.value = "";
  state.stagedFiles = [];
  autoGrowCode();
  renderStagedFiles();
  syncSendButton();
  return { promptText, files };
}

export function enqueueAgentMessage(promptText, files = []) {
  const key = currentTranscriptKey();
  const list = getSessionQueue(key);
  list.push({
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    promptText,
    files: Array.isArray(files) ? files : [],
    createdAt: Date.now(),
  });
  renderComposerQueue();
  showToast(L(`已加入队列（第 ${list.length} 条），当前回合结束后自动发送`, `Queued message (#${list.length}); will send when current turn finishes`));
}

export function buildSteerContinuationPrompt(newPrompt, unfinishedList) {
  if (!Array.isArray(unfinishedList) || unfinishedList.length === 0) return newPrompt;
  const unique = Array.from(new Set(unfinishedList.map((s) => String(s || "").trim()).filter(Boolean)));
  if (!unique.length) return newPrompt;
  const summary = unique.map((u, i) => `${i + 1}. ${u}`).join("\n");
  if (state.activeLang === "en") {
    return `[Mid-turn Steer / Continuation]\nYou were interrupted while working on unfinished session task(s):\n${summary}\n\nUser's immediate follow-up / new instruction:\n${newPrompt}\n\nImportant: Please address this new instruction AND make sure ALL unfinished tasks above are completed thoroughly without dropping any earlier requirements.`;
  }
  return `【中途插队 / Steer 任务衔接】\n你上一轮正在执行但尚未完成的会话任务如下：\n${summary}\n\n用户刚刚发送的最新指令/补充：\n${newPrompt}\n\n请务必结合用户的最新指令，把上述所有尚未完成的会话任务与本次新要求一并完整执行完毕，不要遗漏前面未做完的步骤。`;
}

export function steerAgentMessage(promptText, files = []) {
  const key = currentTranscriptKey();
  if (state.activeAgentController) {
    const prevList = state.pendingUnfinishedTasks.get(key) || [];
    if (state.activeAgentTurnContext && state.activeAgentTurnContext.key === key && state.activeAgentTurnContext.prompt) {
      prevList.push(state.activeAgentTurnContext.prompt);
    }
    state.pendingUnfinishedTasks.set(key, prevList);
    state.pendingSteerItem = { promptText, files: Array.isArray(files) ? files : [], key };
    state.stopReasonKind = "steer";
    state.activeAgentController.abort();
    showToast(L("正在衔接未完成任务并转向新指令…", "Steering Agent while preserving unfinished tasks…"));
  } else {
    const unfinished = state.pendingUnfinishedTasks.get(key) || [];
    const apiPrompt = unfinished.length ? buildSteerContinuationPrompt(promptText, unfinished) : promptText;
    sendAgentMessage(promptText, Array.isArray(files) ? files : [], apiPrompt);
  }
}

export function syncSendButton() {
  const isRunningAgent = !!state.activeAgentController;
  const hasDraft = !!dom.code.value.trim() || state.stagedFiles.length > 0;
  if (dom.busySendActionsEl) {
    dom.busySendActionsEl.hidden = !(isRunningAgent && state.composerMode === "agent" && hasDraft);
    if (dom.queueSendBtn) dom.queueSendBtn.textContent = L("排队", "Queue");
    if (dom.steerSendBtn) dom.steerSendBtn.textContent = L("⚡ 转向", "⚡ Steer");
  }
  if (isRunningAgent && state.composerMode === "agent") {
    const hint = state.busySendMode === "steer"
      ? L("继续输入… 按 Enter 立即转向（自动延续未完成任务）", "Send follow-up · Enter to steer now (completes unfinished tasks)")
      : L("继续输入… 按 Enter 加入排队，或点右侧「立即转向」", "Send follow-up · Enter to queue for later");
    dom.code.setAttribute("placeholder", hint);
  }
  if (isRunningAgent) {
    dom.sendBtn.disabled = false;
    dom.sendBtn.classList.add("is-stop");
    dom.sendBtn.textContent = "■";
    dom.sendBtn.title = tr("composer.stopTitle");
    dom.sendBtn.setAttribute("aria-label", "Stop");
  } else {
    dom.sendBtn.disabled = state.busyCount > 0;
    dom.sendBtn.classList.remove("is-stop");
    dom.sendBtn.textContent = "↑";
    dom.sendBtn.title = tr("composer.sendTitle");
    dom.sendBtn.setAttribute("aria-label", "Submit");
  }
}

export function setBusy(delta) {
  state.busyCount = Math.max(0, state.busyCount + delta);
  syncSendButton();
}

export function initThreadsAndQueue() {
  dom.newChatThreadBtn.addEventListener("click", () => createNewChatThread());

  dom.busyModeToggle.addEventListener("click", () => {
    state.busySendMode = state.busySendMode === "steer" ? "queue" : "steer";
    syncBusyModeToggle(true);
  });
  dom.queueSendBtn.addEventListener("click", () => {
    const draft = consumeComposerDraft();
    if (!draft) return;
    if (state.activeAgentController) enqueueAgentMessage(draft.promptText, draft.files);
    else sendAgentMessage(draft.promptText, draft.files);
  });
  dom.steerSendBtn.addEventListener("click", () => {
    const draft = consumeComposerDraft();
    if (!draft) return;
    steerAgentMessage(draft.promptText, draft.files);
  });
}

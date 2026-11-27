import { spawn } from "node:child_process";
import {
  AGENT_CLIENT_VERSION,
  extractToolContent,
  findExecutable,
  formatCompact,
  formatToolActionTitle,
} from "./constants.mjs";
import { formatTurnPrompt, loadImageAttachments } from "./prompts.mjs";

export function extractAcpModels(sessionNewResult) {
  const configOptions = Array.isArray(sessionNewResult?.configOptions) ? sessionNewResult.configOptions : [];
  const thoughtOpt = configOptions.find((opt) => opt && (opt.id === "thought_level" || opt.category === "thought_level"));
  const thoughtLevels = thoughtOpt && Array.isArray(thoughtOpt.options)
    ? {
        configId: thoughtOpt.id || "thought_level",
        current: thoughtOpt.currentValue || thoughtOpt.options[0]?.value || "",
        options: thoughtOpt.options.map((opt) => ({
          value: opt.value,
          name: opt.name || opt.value,
        })),
      }
    : null;

  const modelOpt = configOptions.find((opt) => opt && (opt.id === "model" || opt.category === "model"));
  if (modelOpt && Array.isArray(modelOpt.options) && modelOpt.options.length > 0) {
    return {
      mode: "configOption",
      configId: modelOpt.id || "model",
      current: modelOpt.currentValue || modelOpt.options[0].value,
      models: modelOpt.options.map((opt) => ({
        value: opt.value,
        name: opt.name || opt.value,
      })),
      thoughtLevels,
    };
  }
  const avail = sessionNewResult?.models?.availableModels;
  if (Array.isArray(avail) && avail.length > 0) {
    return {
      mode: "setModel",
      configId: "model",
      current: sessionNewResult.models.currentModelId || avail[0].modelId,
      models: avail.map((m) => ({
        value: m.modelId,
        name: m.name || m.modelId,
      })),
      thoughtLevels,
    };
  }
  return { mode: "none", configId: "model", current: "", models: [], thoughtLevels };
}

export function parseAcpSessionUpdate(params) {
  const update = params?.update;
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;

  if (kind === "agent_message_chunk") {
    const text = update.content?.text ?? update.text ?? "";
    if (text) return { type: "text", text };
    return null;
  }
  if (kind === "agent_thought_chunk" || kind === "thought_chunk" || kind === "reasoning_chunk") {
    const text = update.content?.text ?? update.text ?? "";
    if (text) return { type: "thought", text };
    return null;
  }
  if (kind === "plan" && Array.isArray(update.entries) && update.entries.length > 0) {
    const summary = update.entries
      .map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "·"} ${e.content || e.title || ""}`)
      .filter(Boolean)
      .join("\n");
    if (summary) return { type: "thought", text: summary + "\n" };
    return null;
  }
  if (kind === "tool_call") {
    const baseName = update.title || update.name || "";
    const title = formatToolActionTitle(baseName, update.rawInput, null);
    return {
      type: "tool_call",
      toolCallId: update.toolCallId || update.id || String(Date.now()),
      title,
      kind: update.kind || "tool",
      status: update.status || "in_progress",
      input: update.rawInput ? formatCompact(update.rawInput) : "",
    };
  }
  if (kind === "tool_call_update") {
    const contentText = extractToolContent(update.content) || (update.rawOutput ? formatCompact(update.rawOutput) : "");
    const title = update.rawInput || update.rawOutput
      ? formatToolActionTitle(update.title || "", update.rawInput, update.rawOutput)
      : (update.title || undefined);
    return {
      type: "tool_update",
      toolCallId: update.toolCallId || update.id || "",
      title,
      status: update.status || "completed",
      output: contentText,
    };
  }
  if (kind === "usage_update") {
    return {
      type: "usage",
      used: update.used ?? null,
      size: update.size ?? null,
    };
  }
  return null;
}

export function isAcpAuthError(err) {
  if (!err) return false;
  if (err.code === -32000) return true;
  return /auth|unauthenticated|login|sign in/i.test(String(err.message || ""));
}

export class AcpClient {
  constructor(provider, cwd) {
    this.provider = provider;
    this.cwd = cwd;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.readyPromise = null;
    this.buf = "";
    this.activeListener = null; // { sessionId, approvalMode, emit, registerPermission }
    this.modelCatalog = null;
    this.initResult = null;
    this.agentInfo = null;
    this.authMethods = [];
    this.supportsLogout = false;
    this.antigravityMeta = null;
    this.tier = null;
  }

  ensureStarted() {
    if (this.child && !this.child.killed && this.child.exitCode === null && this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = this._start();
    return this.readyPromise;
  }

  async _start() {
    const exe = findExecutable(this.provider.command);
    if (!exe) {
      throw new Error(`${this.provider.command} 未安装或不在 PATH 中`);
    }
    const child = spawn(exe, this.provider.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buf = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // Keep stderr drained so the child never blocks on pipe buffers.
    });
    child.on("exit", () => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`${this.provider.name} ACP 进程已退出`));
      }
      this.pending.clear();
      if (this.child === child) {
        this.child = null;
        this.readyPromise = null;
      }
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: true },
      },
      clientInfo: { name: "colab-desk", version: AGENT_CLIENT_VERSION },
    });
    this.initResult = init || null;
    this.agentInfo = init?.agentInfo || null;
    this.authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    this.supportsLogout = Boolean(init?.agentCapabilities?.auth?.logout);
    this.antigravityMeta = init?.agentCapabilities?._meta?.antigravity || null;
    return init;
  }

  _onStdout(chunk) {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    // Response to our request
    if (msg.id !== undefined && !msg.method) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    // Server -> Client notification
    if (msg.method === "session/update") {
      const listener = this.activeListener;
      if (listener && (!msg.params?.sessionId || msg.params.sessionId === listener.sessionId)) {
        const parsed = parseAcpSessionUpdate(msg.params);
        if (parsed) listener.emit(parsed);
      }
      return;
    }

    // Server -> Client request (e.g., session/request_permission)
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      this._handlePermissionRequest(msg.id, msg.params || {});
      return;
    }

    // Any other unsupported server request: respond cleanly with method not found
    if (msg.method && msg.id !== undefined) {
      this.sendRaw({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unsupported client method: ${msg.method}` },
      });
    }
  }

  async _handlePermissionRequest(rpcId, params) {
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOpt =
      options.find((o) => o.kind === "allow_once") ||
      options.find((o) => o.kind === "allow_always") ||
      options[0];
    const rejectOpt =
      options.find((o) => o.kind === "reject_once") ||
      options.find((o) => o.kind === "reject_always") ||
      options[options.length - 1];

    const listener = this.activeListener;
    if (!listener || listener.approvalMode === "auto") {
      if (allowOpt) {
        this.sendRaw({
          jsonrpc: "2.0",
          id: rpcId,
          result: { outcome: { outcome: "selected", optionId: allowOpt.optionId } },
        });
      } else {
        this.sendRaw({
          jsonrpc: "2.0",
          id: rpcId,
          result: { outcome: { outcome: "cancelled" } },
        });
      }
      return;
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = params.toolCall?.title || params.toolCall?.kind || "执行操作";
    const detail = formatCompact(params.toolCall?.rawInput || "");
    const allowed = await listener.registerPermission({ requestId, title, detail });
    const chosen = allowed ? allowOpt : rejectOpt;
    this.sendRaw({
      jsonrpc: "2.0",
      id: rpcId,
      result: chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } },
    });
  }

  sendRaw(payload) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {}
  }

  request(method, params, timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error(`${this.provider.name} ACP 未启动`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.provider.name} ${method} 超时`));
        }
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  async createSession() {
    await this.ensureStarted();
    const res = await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, 30_000);
    const catalog = extractAcpModels(res);
    if (catalog.models.length > 0) this.modelCatalog = catalog;
    if (res?._meta?.antigravity?.tier) {
      this.tier = res._meta.antigravity.tier;
    }
    return { sessionId: res.sessionId, catalog, tier: this.tier };
  }

  async authenticate(methodId = "oauth-personal", meta = undefined) {
    await this.ensureStarted();
    const params = meta ? { methodId, _meta: meta } : { methodId };
    const res = await this.request("authenticate", params, 180_000);
    this.modelCatalog = null;
    return res;
  }

  async logout() {
    await this.ensureStarted();
    const res = await this.request("logout", {}, 15_000);
    this.modelCatalog = null;
    this.tier = null;
    return res;
  }

  async setModel(sessionId, modelValue) {
    if (!modelValue) return;
    const mode = this.modelCatalog?.mode || "configOption";
    const configId = this.modelCatalog?.configId || "model";
    try {
      if (mode === "configOption") {
        await this.request("session/set_config_option", { sessionId, configId, value: modelValue }, 15_000);
      } else {
        await this.request("session/set_model", { sessionId, modelId: modelValue }, 15_000);
      }
    } catch {
      // Fallback to the other method if server prefers it
      try {
        if (mode === "configOption") {
          await this.request("session/set_model", { sessionId, modelId: modelValue }, 15_000);
        } else {
          await this.request("session/set_config_option", { sessionId, configId, value: modelValue }, 15_000);
        }
      } catch {}
    }
  }

  async setMode(sessionId, approvalMode) {
    const modeId = approvalMode === "auto" ? "auto" : "default";
    try {
      await this.request("session/set_mode", { sessionId, modeId }, 10_000);
    } catch {}
  }

  async setThoughtLevel(sessionId, level) {
    if (!level) return;
    const configId = this.modelCatalog?.thoughtLevels?.configId || "thought_level";
    try {
      await this.request("session/set_config_option", { sessionId, configId, value: level }, 15_000);
    } catch {}
  }

  cancel(sessionId) {
    if (!sessionId) return;
    this.notify("session/cancel", { sessionId });
  }

  stop() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
    this.child = null;
    this.readyPromise = null;
  }
}

export async function runAcpTurn({
  client,
  provider,
  threads,
  modelCache,
  pendingPermissions,
  threadKey,
  promptText,
  model,
  thoughtLevel,
  approvalMode,
  context,
  emit,
  signal,
}) {
  let thread = threads.get(threadKey);
  if (!thread) {
    try {
      const { sessionId, catalog } = await client.createSession();
      if (catalog.models.length > 0 && !modelCache.has(provider.id)) {
        modelCache.set(provider.id, {
          available: true,
          current: catalog.current,
          models: catalog.models,
          thoughtLevels: catalog.thoughtLevels || null,
        });
      }
      thread = {
        sessionId,
        initialized: false,
        lastModel: catalog.current || "",
        lastThought: catalog.thoughtLevels?.current || "",
        lastApproval: "",
      };
      threads.set(threadKey, thread);
    } catch (err) {
      if (isAcpAuthError(err)) {
        emit({
          type: "error",
          error: `${provider.name} ACP 需要先完成 Antigravity 认证：${err.message}`,
          authRequired: true,
          provider: provider.id,
          authMethods: client.authMethods,
        });
        return;
      }
      throw err;
    }
  }

  if (model && model !== thread.lastModel) {
    await client.setModel(thread.sessionId, model);
    thread.lastModel = model;
  }
  if (thoughtLevel && thoughtLevel !== thread.lastThought) {
    await client.setThoughtLevel(thread.sessionId, thoughtLevel);
    thread.lastThought = thoughtLevel;
  }
  if (approvalMode !== thread.lastApproval) {
    await client.setMode(thread.sessionId, approvalMode);
    thread.lastApproval = approvalMode;
  }

  emit({
    type: "meta",
    provider: provider.id,
    providerName: provider.name,
    model: thread.lastModel || model || "default",
    sessionId: thread.sessionId,
  });

  const formatted = formatTurnPrompt(promptText, context, !thread.initialized);
  thread.initialized = true;

  const onAbort = () => {
    client.cancel(thread.sessionId);
  };
  if (signal) {
    if (signal.aborted) {
      emit({ type: "error", error: "已中止对话" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  client.activeListener = {
    sessionId: thread.sessionId,
    approvalMode,
    emit,
    registerPermission: ({ requestId, title, detail }) =>
      new Promise((resolve) => {
        pendingPermissions.set(requestId, resolve);
        emit({ type: "permission_request", requestId, title, detail });
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              if (pendingPermissions.has(requestId)) {
                pendingPermissions.delete(requestId);
                resolve(false);
              }
            },
            { once: true },
          );
        }
      }),
  };

  try {
    const promptBlocks = [{ type: "text", text: formatted }];
    const supportsAcpImage = client.initResult?.agentCapabilities?.promptCapabilities?.image !== false;
    const attachedImages = supportsAcpImage ? loadImageAttachments(context.files) : [];
    for (const img of attachedImages) {
      promptBlocks.push({ type: "image", data: img.base64, mimeType: img.mimeType });
    }
    let res;
    try {
      res = await client.request("session/prompt", {
        sessionId: thread.sessionId,
        prompt: promptBlocks,
      });
    } catch (imgErr) {
      if (attachedImages.length > 0 && !(signal && signal.aborted)) {
        res = await client.request("session/prompt", {
          sessionId: thread.sessionId,
          prompt: [{ type: "text", text: formatted }],
        });
      } else {
        throw imgErr;
      }
    }
    emit({ type: "done", stopReason: res?.stopReason || "end_turn", usage: res?.usage || null });
  } catch (err) {
    if (signal && signal.aborted) {
      emit({ type: "done", stopReason: "cancelled" });
    } else {
      // If the ACP session became stale, clear thread so next message creates a fresh one.
      threads.delete(threadKey);
      emit({ type: "error", error: err.message || String(err) });
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (client.activeListener?.sessionId === thread.sessionId) {
      client.activeListener = null;
    }
  }
}

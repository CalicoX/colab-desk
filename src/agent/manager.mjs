import fs from "node:fs";
import { AcpClient, isAcpAuthError, runAcpTurn } from "./acp.mjs";
import { DEFAULT_GROK_MODELS, IMAGE_DIR, PROVIDERS, UPLOAD_DIR, findExecutable } from "./constants.mjs";
import { fetchGrokModels, runGrokTurn } from "./grok.mjs";
import {
  fetchOpenAiModels,
  getApiConfig,
  getApiProfiles,
  runOpenAiCompatTurn,
  testOpenAiApiConfig,
} from "./openai-compat.mjs";
import { execCapture, fetchAllQuotas, fetchGrokBilling } from "./quotas.mjs";
import { executeColabTool } from "./tools.mjs";
import { mcpManager } from "./mcp.mjs";

export class AgentManager {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.acpClients = new Map();
    this.threads = new Map(); // key: `${colabSession}:${providerId}` -> { sessionId, initialized, lastModel, lastApproval }
    this.modelCache = new Map();
    this.quotaCache = null;
    this.pendingPermissions = new Map(); // requestId -> resolve(bool)
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
  }

  getAcpClient(providerId) {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) throw new Error(`unknown ACP provider: ${providerId}`);
    let client = this.acpClients.get(providerId);
    if (!client) {
      client = new AcpClient(provider, this.cwd);
      this.acpClients.set(providerId, client);
    }
    return client;
  }

  getApiProfiles() {
    return getApiProfiles();
  }

  getApiConfig(override, profileId = null) {
    return getApiConfig(override, profileId);
  }

  listProviders() {
    const profiles = this.getApiProfiles().filter((p) => p.baseUrl && p.model);
    const out = [];
    for (const p of PROVIDERS) {
      if (p.transport === "openai-compat") {
        if (profiles.length > 0) {
          for (const prof of profiles) {
            out.push({
              id: `api:${prof.id}`,
              profileId: prof.id,
              name: prof.label,
              label: prof.label,
              transport: p.transport,
              available: true,
              path: prof.baseUrl,
              models: [{ value: prof.model, name: prof.model }],
              defaultModel: prof.model,
            });
          }
        } else {
          out.push({
            id: "api",
            name: p.name,
            label: p.label,
            transport: p.transport,
            available: false,
            path: null,
            models: [],
            defaultModel: "",
          });
        }
        continue;
      }
      const cached = this.modelCache.get(p.id);
      const exePath = findExecutable(p.command);
      out.push({
        id: p.id,
        name: p.name,
        label: p.label,
        transport: p.transport,
        available: !!exePath,
        path: exePath,
        models: cached ? cached.models : p.id === "grok" ? DEFAULT_GROK_MODELS : [],
        defaultModel: cached ? cached.current : p.id === "grok" ? DEFAULT_GROK_MODELS[0].value : "",
        thoughtLevels: cached?.thoughtLevels || null,
      });
    }
    return out;
  }

  async fetchOpenAiModelsDirect(cfg) {
    const apiCfg = this.getApiConfig(cfg, cfg?.profileId || null);
    if (!apiCfg.baseUrl) {
      return { ok: false, models: [], error: "请先填写 Base URL" };
    }
    return fetchOpenAiModels(apiCfg);
  }

  async fetchModels(providerId) {
    if (providerId === "api" || String(providerId).startsWith("api:")) {
      const profileId = String(providerId).startsWith("api:") ? String(providerId).slice(4) : null;
      const apiCfg = this.getApiConfig(null, profileId);
      const ok = Boolean(apiCfg.baseUrl && apiCfg.model);
      if (!apiCfg.baseUrl) {
        return { available: false, current: "", models: [], thoughtLevels: null };
      }
      const remote = await fetchOpenAiModels(apiCfg);
      const list = [];
      const seen = new Set();
      if (apiCfg.model) {
        seen.add(apiCfg.model);
        list.push({ value: apiCfg.model, name: apiCfg.model });
      }
      if (remote.ok && Array.isArray(remote.models)) {
        for (const m of remote.models) {
          if (!m?.value || seen.has(m.value)) continue;
          seen.add(m.value);
          list.push(m);
        }
      }
      return {
        available: ok || list.length > 0,
        current: apiCfg.model || list[0]?.value || "",
        models: list,
        thoughtLevels: null,
        fetchedFromGateway: remote.ok,
        gatewayError: remote.ok ? null : remote.error,
      };
    }
    if (this.modelCache.has(providerId)) return this.modelCache.get(providerId);
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) throw new Error(`unknown provider: ${providerId}`);
    if (!findExecutable(provider.command)) {
      return { current: "", models: [], available: false, thoughtLevels: null };
    }

    if (provider.transport === "acp") {
      const client = this.getAcpClient(providerId);
      const { catalog } = await client.createSession();
      const result = {
        available: true,
        current: catalog.current,
        models: catalog.models,
        thoughtLevels: catalog.thoughtLevels || null,
      };
      this.modelCache.set(providerId, result);
      return result;
    }

    if (provider.id === "grok") {
      const models = await this._fetchGrokModels();
      const result = {
        available: true,
        current: models[0]?.value || DEFAULT_GROK_MODELS[0].value,
        models,
      };
      this.modelCache.set(providerId, result);
      return result;
    }

    return { available: false, current: "", models: [] };
  }

  _fetchGrokModels() {
    return fetchGrokModels();
  }

  _execCapture(command, args, timeoutMs = 10_000) {
    return execCapture(this.cwd, command, args, timeoutMs);
  }

  _fetchGrokBilling() {
    return fetchGrokBilling();
  }

  async fetchQuotas(force = false) {
    if (!force && this.quotaCache && Date.now() - this.quotaCache.fetchedAt < 60_000) {
      return this.quotaCache;
    }
    const result = await fetchAllQuotas({
      cwd: this.cwd,
      exec: (_cwd, command, args, timeoutMs) => this._execCapture(command, args, timeoutMs),
      getGrokBilling: () => this._fetchGrokBilling(),
    });
    this.quotaCache = result;
    return result;
  }

  resetThread(colabSession, providerId) {
    const key = `${colabSession || ""}:${providerId || ""}`;
    if (providerId) {
      this.threads.delete(key);
    } else {
      for (const k of Array.from(this.threads.keys())) {
        if (k.startsWith(`${colabSession || ""}:`)) this.threads.delete(k);
      }
    }
  }

  resolvePermission(requestId, allow) {
    const resolver = this.pendingPermissions.get(requestId);
    if (!resolver) return false;
    this.pendingPermissions.delete(requestId);
    resolver(!!allow);
    return true;
  }

  isAcpAuthError(err) {
    return isAcpAuthError(err);
  }

  async getAcpAuthStatus(providerId = "agy") {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) {
      return { ok: false, installed: false, authenticated: false, error: `unknown ACP provider: ${providerId}` };
    }
    const exe = findExecutable(provider.command);
    if (!exe) {
      return {
        ok: true,
        provider: providerId,
        installed: false,
        path: null,
        authenticated: false,
        agentInfo: null,
        tier: null,
        authMethods: [],
        supportsLogout: false,
        error: `${provider.command} not found in PATH`,
      };
    }

    const client = this.getAcpClient(providerId);
    try {
      await client.ensureStarted();
    } catch (err) {
      return {
        ok: false,
        provider: providerId,
        installed: true,
        path: exe,
        authenticated: false,
        agentInfo: client.agentInfo,
        tier: null,
        authMethods: client.authMethods,
        supportsLogout: client.supportsLogout,
        error: err.message || String(err),
      };
    }

    try {
      const { catalog, tier } = await client.createSession();
      if (catalog.models.length > 0) {
        this.modelCache.set(providerId, {
          available: true,
          current: catalog.current,
          models: catalog.models,
        });
      }
      return {
        ok: true,
        provider: providerId,
        installed: true,
        path: exe,
        authenticated: true,
        agentInfo: client.agentInfo,
        tier: tier || client.tier || null,
        authMethods: client.authMethods,
        supportsLogout: client.supportsLogout,
        error: null,
      };
    } catch (err) {
      return {
        ok: true,
        provider: providerId,
        installed: true,
        path: exe,
        authenticated: false,
        authRequired: this.isAcpAuthError(err),
        agentInfo: client.agentInfo,
        tier: null,
        authMethods: client.authMethods,
        supportsLogout: client.supportsLogout,
        error: err.message || String(err),
      };
    }
  }

  async authenticateAcp(providerId = "agy", methodId = "oauth-personal") {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) return { ok: false, error: `unknown ACP provider: ${providerId}` };
    if (!findExecutable(provider.command)) {
      return { ok: false, error: `${provider.command} not installed` };
    }
    const client = this.getAcpClient(providerId);
    try {
      await client.authenticate(methodId || "oauth-personal");
      this.modelCache.delete(providerId);
      for (const k of Array.from(this.threads.keys())) {
        if (k.endsWith(`:${providerId}`)) this.threads.delete(k);
      }
      const status = await this.getAcpAuthStatus(providerId);
      return { ok: status.authenticated, status, error: status.authenticated ? null : status.error };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async logoutAcp(providerId = "agy") {
    const provider = PROVIDERS.find((p) => p.id === providerId && p.transport === "acp");
    if (!provider) return { ok: false, error: `unknown ACP provider: ${providerId}` };
    const client = this.getAcpClient(providerId);
    try {
      await client.logout();
      this.modelCache.delete(providerId);
      for (const k of Array.from(this.threads.keys())) {
        if (k.endsWith(`:${providerId}`)) this.threads.delete(k);
      }
      const status = await this.getAcpAuthStatus(providerId);
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async testApiConfig(cfg) {
    const api = this.getApiConfig(cfg);
    return testOpenAiApiConfig(api);
  }

  async runChat(input, emit, signal) {
    const providerId = String(input.provider || "agy");
    const isApiProfile = providerId === "api" || providerId.startsWith("api:");
    const provider = isApiProfile
      ? PROVIDERS.find((p) => p.id === "api")
      : PROVIDERS.find((p) => p.id === providerId);
    if (!provider) {
      emit({ type: "error", error: `未知的 Agent 引擎: ${providerId}` });
      return;
    }
    const promptText = String(input.prompt || "").trim();
    if (!promptText) {
      emit({ type: "error", error: "请输入对话内容" });
      return;
    }

    const colabSession = input.colabSession || "";
    const scopeKey = String(input.chatThreadId || colabSession || "");
    const threadKey = `${scopeKey}:${providerId}`;
    const approvalMode = input.approvalMode === "ask" ? "ask" : "auto";
    const model = String(input.model || "").trim();
    const thoughtLevel = String(input.thoughtLevel || "").trim();
    const context = {
      colabSession: colabSession || null,
      sessionInfo: input.sessionInfo || null,
      files: Array.isArray(input.files) ? input.files : [],
      threadId: scopeKey || null,
      templateId: input.templateId ? String(input.templateId).trim() : "",
      lang: input.lang === "en" ? "en" : "zh-CN",
    };

    if (provider.transport === "openai-compat") {
      const profileId = providerId.startsWith("api:") ? providerId.slice(4) : null;
      await this._runOpenAiCompatTurn({ provider, providerId, profileId, threadKey, promptText, model, approvalMode, context, emit, signal });
      return;
    }

    if (!findExecutable(provider.command)) {
      emit({ type: "error", error: `未找到 ${provider.command} 命令。如未安装本机 CLI，可在「设置 → 智能体提供方」中配置自定义 API 密钥直接使用。` });
      return;
    }

    if (provider.transport === "acp") {
      await this._runAcpTurn({ provider, threadKey, promptText, model, thoughtLevel, approvalMode, context, emit, signal });
    } else if (provider.id === "grok") {
      await this._runGrokTurn({ provider, threadKey, promptText, model, approvalMode, context, emit, signal });
    }
  }

  async _executeColabTool(name, args, colabSession, signal) {
    return executeColabTool(name, args, colabSession, signal);
  }

  async _runOpenAiCompatTurn({ provider, providerId, profileId, threadKey, promptText, model, approvalMode, context, emit, signal }) {
    const api = this.getApiConfig(null, profileId);
    return runOpenAiCompatTurn({
      api,
      threads: this.threads,
      pendingPermissions: this.pendingPermissions,
      executeTool: (name, args, colabSession, sig) => this._executeColabTool(name, args, colabSession, sig),
      provider,
      providerId,
      threadKey,
      promptText,
      model,
      approvalMode,
      context,
      emit,
      signal,
    });
  }

  async _runAcpTurn({ provider, threadKey, promptText, model, thoughtLevel, approvalMode, context, emit, signal }) {
    const client = this.getAcpClient(provider.id);
    return runAcpTurn({
      client,
      provider,
      threads: this.threads,
      modelCache: this.modelCache,
      pendingPermissions: this.pendingPermissions,
      threadKey,
      promptText,
      model,
      thoughtLevel,
      approvalMode,
      context,
      emit,
      signal,
    });
  }

  _runGrokTurn({ provider, threadKey, promptText, model, approvalMode, context, emit, signal }) {
    return runGrokTurn({
      cwd: this.cwd,
      threads: this.threads,
      provider,
      threadKey,
      promptText,
      model,
      approvalMode,
      context,
      emit,
      signal,
    });
  }

  shutdown() {
    for (const [, client] of this.acpClients) {
      client.stop();
    }
    this.acpClients.clear();
    mcpManager.shutdown();
  }
}

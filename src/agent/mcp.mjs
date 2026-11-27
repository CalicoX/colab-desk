// Minimal zero-dependency MCP client (JSON-RPC 2.0 over stdio, or HTTP POST).
import { spawn } from "node:child_process";
import { loadAgentx, saveAgentx } from "./agentx-store.mjs";

export const MCP_PREFIX = "mcp__";
const MAX_OUTPUT = 16_000;

export function sanitizeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "srv";
}

export class McpStdioClient {
  constructor({ command, args = [], env = {}, cwd, timeoutMs = 15_000 }) {
    this.command = command;
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env && typeof env === "object" ? env : {};
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.proc = null;
    this.stderrTail = "";
  }

  async start() {
    if (this.proc) return;
    // argv array, no shell, no login shell.
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd || process.cwd(),
      env: { ...process.env, ...Object.fromEntries(Object.entries(this.env).map(([k, v]) => [k, String(v)])) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => this._onData(c));
    this.proc.stderr.on("data", (c) => { this.stderrTail = (this.stderrTail + c).slice(-2000); });
    const fail = (err) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      this.proc = null;
    };
    this.proc.on("error", (e) => fail(e));
    this.proc.on("exit", (code) => fail(new Error(`MCP server exited (${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`)));
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "colab-desk", version: "0.8.4" },
    });
    this.notify("notifications/initialized", {});
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
        else p.resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // Server-initiated request: we support nothing; answer method-not-found.
        this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
      }
    }
  }

  _send(obj) {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method, params) { this._send({ jsonrpc: "2.0", method, params }); }

  request(method, params, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("MCP server not running"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools() {
    const r = await this.request("tools/list", {});
    return Array.isArray(r?.tools) ? r.tools : [];
  }

  callTool(name, args, timeoutMs = 60_000) {
    return this.request("tools/call", { name, arguments: args || {} }, timeoutMs);
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    for (const [, x] of this.pending) { clearTimeout(x.timer); x.reject(new Error("MCP client stopped")); }
    this.pending.clear();
    if (!p) return;
    try { p.stdin.end(); } catch {}
    try { p.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 1500).unref();
  }
}

export class McpHttpClient {
  constructor({ url, headers = {}, timeoutMs = 15_000 }) {
    this.url = url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.sessionId = null;
    this.running = false;
  }

  async _post(body, timeoutMs = this.timeoutMs) {
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (body.id == null) return null;
    const text = await res.text();
    let msg;
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const block of text.split(/\n\n/)) {
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === body.id) { msg = m; break; } } catch {}
      }
    } else msg = JSON.parse(text);
    if (!msg) throw new Error("empty MCP response");
    if (msg.error) throw new Error(msg.error.message || "MCP error");
    return msg.result;
  }

  request(method, params, t) { return this._post({ jsonrpc: "2.0", id: this.nextId++, method, params }, t); }

  async start() {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "colab-desk", version: "0.8.4" } });
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
    this.running = true;
  }
  async listTools() { const r = await this.request("tools/list", {}); return Array.isArray(r?.tools) ? r.tools : []; }
  callTool(name, args, t = 60_000) { return this.request("tools/call", { name, arguments: args || {} }, t); }
  stop() { this.running = false; }
}

export function formatMcpResult(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  let text = parts.map((c) => (c.type === "text" ? String(c.text ?? "") : `[${c.type || "content"}]`)).join("\n").trim();
  if (!text && result && typeof result === "object") text = JSON.stringify(result);
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`;
  return { ok: !result?.isError, output: text || "(empty)" };
}

export function validateServer(s) {
  const type = s.type === "http" ? "http" : "stdio";
  const out = {
    id: s.id ? sanitizeName(s.id) : `srv${Date.now().toString(36)}`,
    name: String(s.name || "").slice(0, 60) || "MCP",
    type,
    enabled: s.enabled === true,
  };
  if (type === "stdio") {
    out.command = String(s.command || "").trim();
    if (!out.command) throw new Error("command required");
    out.args = Array.isArray(s.args) ? s.args.map(String) : [];
    out.env = s.env && typeof s.env === "object" ? s.env : {};
  } else {
    const u = new URL(String(s.url || ""));
    if (!/^https?:$/.test(u.protocol)) throw new Error("http(s) url required");
    out.url = u.toString();
    out.headers = s.headers && typeof s.headers === "object" ? s.headers : {};
  }
  return out;
}

export class McpManager {
  constructor() {
    this.clients = new Map(); // id -> { client, tools, error }
  }

  servers() { return loadAgentx().mcpServers; }

  async ensure(server) {
    let e = this.clients.get(server.id);
    if (e?.client && e.ready) return e;
    if (e?.starting) return e.starting;
    e = { client: null, tools: [], error: null, ready: false };
    this.clients.set(server.id, e);
    e.starting = (async () => {
      try {
        e.client = server.type === "http"
          ? new McpHttpClient({ url: server.url, headers: server.headers })
          : new McpStdioClient({ command: server.command, args: server.args, env: server.env });
        await e.client.start();
        e.tools = await e.client.listTools();
        e.ready = true;
      } catch (err) {
        e.error = err.message || String(err);
        try { e.client?.stop(); } catch {}
      }
      e.starting = null;
      return e;
    })();
    return e.starting;
  }

  stopServer(id) {
    const e = this.clients.get(id);
    if (e) { try { e.client?.stop(); } catch {} this.clients.delete(id); }
  }

  async testServer(server) {
    this.stopServer(server.id);
    const e = await this.ensure(server);
    return e.ready ? { ok: true, tools: e.tools.map((t) => ({ name: t.name, description: t.description || "" })) } : { ok: false, error: e.error };
  }

  /** OpenAI tool definitions for all enabled servers. Failures are skipped. */
  async getOpenAiTools() {
    const defs = [];
    for (const s of this.servers().filter((x) => x.enabled)) {
      const e = await this.ensure(s);
      if (!e.ready) continue;
      for (const t of e.tools) {
        defs.push({
          type: "function",
          function: {
            name: `${MCP_PREFIX}${sanitizeName(s.id)}__${sanitizeName(t.name)}`.slice(0, 64),
            description: `[MCP:${s.name}] ${t.description || t.name}`.slice(0, 1000),
            parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
          },
          _mcp: { serverId: s.id, tool: t.name },
        });
      }
    }
    return defs;
  }

  isMcpTool(name) { return String(name).startsWith(MCP_PREFIX); }

  async callByName(fullName, args) {
    for (const s of this.servers().filter((x) => x.enabled)) {
      const prefix = `${MCP_PREFIX}${sanitizeName(s.id)}__`;
      if (!fullName.startsWith(prefix)) continue;
      const e = await this.ensure(s);
      if (!e.ready) return { ok: false, output: `MCP server unavailable: ${e.error}` };
      const tool = e.tools.find((t) => `${prefix}${sanitizeName(t.name)}`.slice(0, 64) === fullName);
      if (!tool) break;
      try { return formatMcpResult(await e.client.callTool(tool.name, args)); }
      catch (err) { return { ok: false, output: err.message || String(err) }; }
    }
    return { ok: false, output: `Unknown MCP tool: ${fullName}` };
  }

  shutdown() { for (const id of [...this.clients.keys()]) this.stopServer(id); }
}

export const mcpManager = new McpManager();
export { loadAgentx, saveAgentx };

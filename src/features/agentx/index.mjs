import { loadAgentx, mcpManager, saveAgentx, validateServer } from "../../agent/mcp.mjs";
import {
  createTemplate,
  deleteTemplate,
  getAssignments,
  listTemplates,
  setAssignedTemplate,
  updateTemplate,
} from "../../agent/templates.mjs";

const MASK = "••••••••";
const SECRET_KEY_RE = /(key|token|secret|pass|auth|cookie|credential)/i;

export function maskSecretMap(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const str = String(v ?? "");
    out[k] = SECRET_KEY_RE.test(k) && str ? MASK : str;
  }
  return out;
}

export function mergeSecretMap(prev = {}, next = {}) {
  const out = {};
  for (const [k, v] of Object.entries(next || {})) {
    const key = String(k || "").trim();
    if (!key) continue;
    const val = String(v ?? "");
    if (val === MASK && prev && Object.prototype.hasOwnProperty.call(prev, key)) {
      out[key] = prev[key];
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function sanitizeServerForClient(server) {
  const live = mcpManager.clients.get(server.id);
  const base = {
    id: server.id,
    name: server.name,
    type: server.type,
    enabled: Boolean(server.enabled),
    status: !server.enabled ? "disabled" : live?.ready ? "connected" : live?.error ? "error" : "idle",
    error: live?.error || "",
    tools: Array.isArray(live?.tools)
      ? live.tools.map((t) => ({ name: t.name, description: t.description || "" }))
      : [],
  };
  if (server.type === "http") {
    base.url = server.url;
    base.headers = maskSecretMap(server.headers);
  } else {
    base.command = server.command;
    base.args = Array.isArray(server.args) ? server.args : [];
    base.env = maskSecretMap(server.env);
  }
  return base;
}

function getHttpHelpers(ctx) {
  const sendJson = ctx?.http?.sendJson || ctx?.sendJson || ((res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  });
  const readJsonBodySafe = ctx?.http?.readJsonBodySafe || ctx?.readJsonBodySafe || (async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
  });
  return { sendJson, readJsonBodySafe };
}

export const feature = {
  id: "agentx",

  init(_ctx) {
    // Lazy: MCP servers start on demand when enabled and queried or tested.
  },

  async handleRoutes(req, res, url, ctx) {
    if (!url.pathname.startsWith("/api/agentx/")) return false;
    const { sendJson, readJsonBodySafe } = getHttpHelpers(ctx);
    const subpath = url.pathname.slice("/api/agentx".length);

    // ── MCP Servers ──
    if (req.method === "GET" && subpath === "/mcp/servers") {
      const data = loadAgentx();
      const servers = (data.mcpServers || []).map(sanitizeServerForClient);
      sendJson(res, 200, { ok: true, servers });
      return true;
    }

    if (req.method === "POST" && subpath === "/mcp/servers") {
      try {
        const body = await readJsonBodySafe(req);
        const srv = validateServer({ ...body, enabled: body.enabled === true });
        const data = loadAgentx();
        data.mcpServers = (data.mcpServers || []).filter((s) => s.id !== srv.id);
        data.mcpServers.push(srv);
        saveAgentx(data);
        sendJson(res, 200, { ok: true, server: sanitizeServerForClient(srv) });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message || "Invalid MCP server config" });
      }
      return true;
    }

    const mcpMatch = subpath.match(/^\/mcp\/servers\/([^/]+?)(?:\/(toggle|test))?$/);
    if (mcpMatch) {
      const id = decodeURIComponent(mcpMatch[1]);
      const action = mcpMatch[2] || "";

      if (req.method === "PUT" && !action) {
        try {
          const body = await readJsonBodySafe(req);
          const data = loadAgentx();
          const idx = (data.mcpServers || []).findIndex((s) => s.id === id);
          if (idx < 0) {
            sendJson(res, 404, { ok: false, error: "MCP server not found" });
            return true;
          }
          const prev = data.mcpServers[idx];
          const merged = {
            ...prev,
            ...body,
            id,
            env: body.env != null ? mergeSecretMap(prev.env, body.env) : prev.env,
            headers: body.headers != null ? mergeSecretMap(prev.headers, body.headers) : prev.headers,
          };
          const srv = validateServer(merged);
          mcpManager.stopServer(id);
          data.mcpServers[idx] = srv;
          saveAgentx(data);
          sendJson(res, 200, { ok: true, server: sanitizeServerForClient(srv) });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message || "Invalid MCP server config" });
        }
        return true;
      }

      if (req.method === "DELETE" && !action) {
        const data = loadAgentx();
        const prevLen = (data.mcpServers || []).length;
        data.mcpServers = (data.mcpServers || []).filter((s) => s.id !== id);
        if (data.mcpServers.length === prevLen) {
          sendJson(res, 404, { ok: false, error: "MCP server not found" });
          return true;
        }
        mcpManager.stopServer(id);
        saveAgentx(data);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === "POST" && action === "toggle") {
        const body = await readJsonBodySafe(req);
        const data = loadAgentx();
        const srv = (data.mcpServers || []).find((s) => s.id === id);
        if (!srv) {
          sendJson(res, 404, { ok: false, error: "MCP server not found" });
          return true;
        }
        srv.enabled = body.enabled != null ? Boolean(body.enabled) : !srv.enabled;
        if (!srv.enabled) mcpManager.stopServer(id);
        saveAgentx(data);
        sendJson(res, 200, { ok: true, server: sanitizeServerForClient(srv) });
        return true;
      }

      if (req.method === "POST" && action === "test") {
        const data = loadAgentx();
        const srv = (data.mcpServers || []).find((s) => s.id === id);
        if (!srv) {
          sendJson(res, 404, { ok: false, error: "MCP server not found" });
          return true;
        }
        const result = await mcpManager.testServer(srv);
        sendJson(res, 200, { ...result, server: sanitizeServerForClient(srv) });
        return true;
      }
    }

    // ── Prompt Templates ──
    if (req.method === "GET" && subpath === "/templates") {
      sendJson(res, 200, {
        ok: true,
        templates: listTemplates(),
        assignments: getAssignments(),
      });
      return true;
    }

    if (req.method === "POST" && subpath === "/templates") {
      try {
        const body = await readJsonBodySafe(req);
        const template = createTemplate(body);
        sendJson(res, 200, { ok: true, template, templates: listTemplates() });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return true;
    }

    if (req.method === "POST" && subpath === "/templates/assign") {
      try {
        const body = await readJsonBodySafe(req);
        const assigned = setAssignedTemplate(body.scopeKey, body.templateId);
        sendJson(res, 200, { ok: true, ...assigned, assignments: getAssignments() });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return true;
    }

    const tplMatch = subpath.match(/^\/templates\/([^/]+)$/);
    if (tplMatch) {
      const id = decodeURIComponent(tplMatch[1]);
      if (req.method === "PUT") {
        try {
          const body = await readJsonBodySafe(req);
          const template = updateTemplate(id, body);
          sendJson(res, 200, { ok: true, template, templates: listTemplates() });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }
      if (req.method === "DELETE") {
        try {
          deleteTemplate(id);
          sendJson(res, 200, { ok: true, templates: listTemplates(), assignments: getAssignments() });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }
    }

    return false;
  },

  shutdown() {
    mcpManager.shutdown();
  },
};

import { bootstrapSession } from "../../cloud/runner.mjs";
import { fetchGpuTelemetry } from "../../cloud/gpu.mjs";
import { syncPushFolder } from "../../cloud/files.mjs";
import { runAction } from "../../run.mjs";
import { loadStore } from "../../store.mjs";
import { sendJson as defaultSendJson } from "../../routes/http.mjs";
import { readJsonBodySafe as defaultReadBody } from "../../routes/http.mjs";
import { BroadcastManager, mapLimit } from "./broadcast.mjs";
import { detectDanger } from "./danger.mjs";

const TELEMETRY_TTL_MS = 5000;
const TELEMETRY_CONCURRENCY = 3;

let manager = null;
const telemetryCache = new Map();

async function telemetryFor(name, force) {
  const hit = telemetryCache.get(name);
  if (!force && hit && Date.now() - hit.at < TELEMETRY_TTL_MS) return hit.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const value = await fetchGpuTelemetry(name, controller.signal);
    telemetryCache.set(name, { at: Date.now(), value });
    return value;
  } catch (err) {
    return { ok: false, available: false, gpus: [], error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildOverview({ telemetry = true, force = false } = {}) {
  const res = await runAction({ type: "sessions" });
  const sessions = res.state?.sessions || [];
  const items = sessions.map((s) => ({ ...s, telemetry: null }));
  if (telemetry && items.length) {
    await mapLimit(items, TELEMETRY_CONCURRENCY, async (item) => {
      const t = await telemetryFor(item.name, force);
      item.telemetry = t && t.ok ? {
        available: t.available,
        gpus: (t.gpus || []).map((g) => ({ name: g.name, utilPct: g.utilPct, memUsedMb: g.memUsedMb, memTotalMb: g.memTotalMb, tempC: g.tempC })),
      } : { available: false, gpus: [], error: t?.error || "telemetry failed" };
    });
  }
  for (const key of Array.from(telemetryCache.keys())) {
    if (!items.some((i) => i.name === key)) telemetryCache.delete(key);
  }
  return { ok: res.ok, error: res.ok ? null : res.error, sessions: items, now: Date.now() };
}

export async function runBulk({ action, sessions, localDir, remoteDir, confirm }, ctx = {}) {
  const names = Array.from(new Set((sessions || []).map((s) => String(s || "").trim()).filter(Boolean)));
  if (names.length === 0) return { ok: false, error: "no sessions selected" };
  if (action === "stop" && !confirm) return { ok: false, needsConfirm: true, error: "stopping VMs requires confirmation" };
  const store = loadStore().settings || {};
  const results = await mapLimit(names, 3, async (session) => {
    try {
      if (action === "stop") {
        const r = await runAction({ type: "stop", session });
        return { session, ok: r.ok, error: r.ok ? null : r.error };
      }
      if (action === "bootstrap") {
        const r = await bootstrapSession({ session, envVars: store.envVars || [], config: store.bootstrapConfig || {} });
        return { session, ok: !!r.ok, error: r.ok ? null : r.error };
      }
      if (action === "push") {
        const r = await syncPushFolder({ session, localDir, remoteDir });
        return { session, ok: !!r.ok, error: r.ok ? null : r.error };
      }
      return { session, ok: false, error: `unknown action: ${action}` };
    } catch (err) {
      return { session, ok: false, error: err.message };
    }
  });
  if (action === "stop") telemetryCache.clear();
  ctx.pushEvent?.("fleet:bulk", { action, results });
  return { ok: results.every((r) => r.ok), action, results };
}

export const feature = {
  id: "fleet",
  init(ctx) {
    manager = new BroadcastManager({ emit: (type, payload) => ctx.pushEvent?.(type, payload) });
  },
  async handleRoutes(req, res, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith("/api/fleet/")) return false;
    const sendJson = ctx.http?.sendJson || defaultSendJson;
    const readBody = ctx.http?.readJsonBodySafe || defaultReadBody;
    if (!manager) this.init(ctx);

    if (req.method === "GET" && p === "/api/fleet/overview") {
      const out = await buildOverview({
        telemetry: url.searchParams.get("telemetry") !== "0",
        force: url.searchParams.get("force") === "1",
      });
      sendJson(res, 200, out);
      return true;
    }
    if (req.method === "POST" && p === "/api/fleet/danger") {
      const body = await readBody(req);
      sendJson(res, 200, { ok: true, ...detectDanger(body.command) });
      return true;
    }
    if (req.method === "POST" && p === "/api/fleet/broadcast") {
      const body = await readBody(req);
      const danger = detectDanger(body.command);
      if (danger.dangerous && !body.confirmDanger) {
        sendJson(res, 409, { ok: false, needsConfirm: true, matches: danger.matches, error: "dangerous command requires confirmation" });
        return true;
      }
      try {
        const job = manager.start(body);
        sendJson(res, 200, { ok: true, job });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return true;
    }
    const m = p.match(/^\/api\/fleet\/broadcast\/([\w-]+)(?:\/(cancel|rerun-failed))?$/);
    if (m) {
      const [, id, sub] = m;
      if (req.method === "GET" && !sub) {
        const job = manager.get(id);
        sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: "not found" });
        return true;
      }
      if (req.method === "POST" && sub === "cancel") {
        const job = manager.cancel(id);
        sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: "not found" });
        return true;
      }
      if (req.method === "POST" && sub === "rerun-failed") {
        const body = await readBody(req);
        const job = manager.rerunFailed(id, body.concurrency);
        if (!job) sendJson(res, 404, { ok: false, error: "not found" });
        else if (job.empty) sendJson(res, 200, { ok: true, empty: true });
        else sendJson(res, 200, { ok: true, job });
        return true;
      }
    }
    if (req.method === "POST" && p === "/api/fleet/bulk") {
      const body = await readBody(req);
      const out = await runBulk(body, ctx);
      sendJson(res, out.needsConfirm ? 409 : 200, out);
      return true;
    }
    return false;
  },
  shutdown() {
    manager?.shutdown();
    manager = null;
  },
};

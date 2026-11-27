// Session Guard backend plugin: wires GuardEngine to Colab Desk's plugin contract.
import { runAction } from "../../run.mjs";
import { bootstrapSession, syncPushFolder } from "../../cloud-ops.mjs";
import { sendJson as fallbackSendJson, readJsonBodySafe as fallbackReadJsonBodySafe } from "../../routes/http.mjs";
import { GuardEngine } from "./engine.mjs";

let engine = null;

function ensureEngine(ctx) {
  if (engine) return engine;
  const storage = ctx.storage("guard");
  engine = new GuardEngine({
    run: (action) => runAction(action),
    storage,
    bootstrapFn: bootstrapSession,
    syncFn: syncPushFolder,
    notify: (payload) => ctx.pushEvent("guard:notify", payload),
    emit: (type, payload) => ctx.pushEvent(type, payload),
  });
  return engine;
}

export const feature = {
  id: "guard",

  init(ctx) {
    const g = ensureEngine(ctx);
    g.start();
  },

  async handleRoutes(req, res, url, ctx) {
    if (!url.pathname.startsWith("/api/guard")) return false;
    const g = ensureEngine(ctx);
    const sendJson = (ctx.http && ctx.http.sendJson) || ctx.sendJson || fallbackSendJson;
    const readJsonBodySafe = (ctx.http && ctx.http.readJsonBodySafe) || ctx.readJsonBodySafe || fallbackReadJsonBodySafe;
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/guard/state") {
      sendJson(res, 200, { ok: true, ...g.snapshot() });
      return true;
    }

    if (req.method === "GET" && p === "/api/guard/cu-history") {
      sendJson(res, 200, { ok: true, history: g.cuHistory(), summary: g.cuSummary() });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/settings") {
      const body = await readJsonBodySafe(req, {});
      const settings = g.setSettings(body);
      sendJson(res, 200, { ok: true, settings });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/session") {
      const body = await readJsonBodySafe(req, {});
      const name = String(body.session || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, error: "session is required" });
        return true;
      }
      const config = g.setSessionCfg(name, body);
      sendJson(res, 200, { ok: true, session: name, config });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/remember") {
      const body = await readJsonBodySafe(req, {});
      const name = String(body.session || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, error: "session is required" });
        return true;
      }
      const lastConfig = g.remember(name, body.config || body);
      sendJson(res, 200, { ok: true, session: name, lastConfig });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/activity") {
      const body = await readJsonBodySafe(req, {});
      const name = String(body.session || "").trim();
      if (name) g.recordActivity(name);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/heartbeat") {
      const body = await readJsonBodySafe(req, {});
      const name = String(body.session || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, error: "session is required" });
        return true;
      }
      const ok = await g.beat(name);
      sendJson(res, ok ? 200 : 422, { ok, session: name });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/poll") {
      await g.poll();
      sendJson(res, 200, { ok: true, ...g.snapshot() });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/sample-cu") {
      const usage = await g.sampleCu();
      sendJson(res, 200, { ok: Boolean(usage), usage, history: g.cuHistory(), summary: g.cuSummary() });
      return true;
    }

    if (req.method === "POST" && p === "/api/guard/rebuild") {
      const body = await readJsonBodySafe(req, {});
      const name = String(body.session || "").trim();
      if (!name) {
        sendJson(res, 400, { ok: false, error: "session is required" });
        return true;
      }
      const result = await g.rebuild(name);
      sendJson(res, result.ok ? 200 : 422, result);
      return true;
    }

    return false;
  },

  shutdown() {
    if (engine) {
      engine.stop();
      engine = null;
    }
  },
};

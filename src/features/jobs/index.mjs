import { runDirectScript } from "../../cloud/runner.mjs";
import { createJobs } from "./core.mjs";

let jobs = null;
let timer = null;

export const feature = {
  id: "jobs",
  init(ctx) {
    jobs = createJobs({
      runScript: runDirectScript,
      storage: ctx.storage,
      pushEvent: ctx.pushEvent,
      bus: ctx.bus,
    });
    ctx.bus?.on?.("jobs:submit", (payload) => {
      jobs.submit(payload || {}).catch(() => {});
    });
    timer = setInterval(() => {
      jobs.pollAll().catch(() => {});
    }, 5000);
    timer.unref?.();
    ctx.jobs = jobs;
  },
  async handleRoutes(req, res, url, ctx) {
    if (!url.pathname.startsWith("/api/jobs")) return false;
    const { sendJson, readJsonBodySafe } = ctx.http || ctx;
    const sub = url.pathname.slice("/api/jobs".length).replace(/^\/|\/$/g, "");
    const m = req.method;
    const body = async () => (await readJsonBodySafe(req)) || {};

    try {
      if (m === "GET" && sub === "") {
        const session = url.searchParams.get("session") || undefined;
        return sendJson(res, 200, { ok: true, jobs: jobs.list(session) }), true;
      }
      if (m === "GET" && sub === "config") {
        return sendJson(res, 200, { ok: true, config: jobs.publicConfig() }), true;
      }
      if (m === "PUT" && sub === "config") {
        return sendJson(res, 200, { ok: true, config: jobs.setConfig(await body()) }), true;
      }
      if (m === "POST" && sub === "submit") {
        const r = await jobs.submit(await body());
        return sendJson(res, r.ok ? 200 : 400, r), true;
      }
      if (m === "POST" && sub === "poll") {
        await jobs.pollAll();
        return sendJson(res, 200, { ok: true, jobs: jobs.list() }), true;
      }
      if (m === "POST" && sub === "clear") {
        const b = await body();
        return sendJson(res, 200, jobs.clearFinished(b.session || undefined)), true;
      }
      if (m === "POST" && sub === "webhook-test") {
        const b = await body();
        const r = await jobs.testEndpoint(b.id, b.endpoint);
        return sendJson(res, 200, r), true;
      }
      const mm = sub.match(/^([a-z0-9-]+)\/(log|cancel|rerun)$/);
      if (mm) {
        const [, id, action] = mm;
        if (action === "log" && m === "GET") {
          const lines = Number(url.searchParams.get("lines") || 0);
          const poll = url.searchParams.get("poll") === "1";
          const r = await jobs.getLog(id, { lines, poll });
          return sendJson(res, r.ok ? 200 : 404, r), true;
        }
        if (action === "cancel" && m === "POST") {
          const r = await jobs.cancel(id);
          return sendJson(res, r.ok ? 200 : 400, r), true;
        }
        if (action === "rerun" && m === "POST") {
          const r = await jobs.rerun(id);
          return sendJson(res, r.ok ? 200 : 400, r), true;
        }
      }
      return sendJson(res, 404, { ok: false, error: "Not found" }), true;
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) }), true;
    }
  },
  shutdown() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

import {
  DEFAULT_RULES,
  DEFAULT_SETTINGS,
  normalizeRules,
  normalizeSettings,
  runBackupPass,
  validateLocalRoot,
} from "./engine.mjs";

const DEFAULT_LOCAL_ROOT_HINT = "~/Downloads/ColabDesk-Backups";
const SAFETY_NET_COOLDOWN_MS = 60_000;

function validSessionName(name) {
  return typeof name === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(name.trim());
}

export function createBackupController(ctx, opts = {}) {
  const storage = ctx.storage("backup");
  const passFn = opts.runPass || runBackupPass;
  const sleep = opts.sleep;
  const now = opts.now || Date.now;
  const pushEvent = ctx.pushEvent || (() => {});

  const running = new Map(); // session -> { controller, startedAt, trigger, done, total, synced }
  const timers = new Map(); // session -> Timeout
  const seenMap = new Map(); // session -> { [remotePath]: size }
  const safetyNetCooldown = new Map(); // session -> ts
  let guardListener = null;

  function getSettings() {
    return normalizeSettings(storage.get("settings", {}) || {});
  }

  function saveSettings(patch = {}) {
    const next = normalizeSettings(patch, getSettings());
    if (next.targets !== "drive" && next.localRoot) {
      const v = validateLocalRoot(next.localRoot);
      if (!v.ok) return { ok: false, error: v.error };
    }
    storage.set("settings", next);
    pushState();
    return { ok: true, settings: next };
  }

  function getAllSessions() {
    const raw = storage.get("sessions", {}) || {};
    return raw && typeof raw === "object" ? raw : {};
  }

  function getSessionRecord(session) {
    const all = getAllSessions();
    const cur = all[session] || {};
    return {
      session,
      enabled: Boolean(cur.enabled),
      rules: normalizeRules(cur.rules || {}),
      lastRun: cur.lastRun || null,
      lastOk: cur.lastOk ?? null,
      lastTrigger: cur.lastTrigger || null,
      synced: Number(cur.synced) || 0,
      totalSynced: Number(cur.totalSynced) || 0,
      bytes: Number(cur.bytes) || 0,
      pending: Number(cur.pending) || 0,
      deferred: Number(cur.deferred) || 0,
      errors: Array.isArray(cur.errors) ? cur.errors : [],
    };
  }

  function saveSessionRecord(session, patch) {
    const all = { ...getAllSessions() };
    const cur = getSessionRecord(session);
    const next = {
      ...cur,
      ...patch,
      rules: patch.rules ? normalizeRules(patch.rules) : cur.rules,
    };
    delete next.session;
    all[session] = next;
    storage.set("sessions", all);
    return { session, ...next };
  }

  function getManifest(session) {
    const all = storage.get("manifests", {}) || {};
    return all[session] && typeof all[session] === "object" ? { ...all[session] } : {};
  }

  function saveManifest(session, manifest) {
    const all = { ...(storage.get("manifests", {}) || {}) };
    all[session] = manifest;
    storage.set("manifests", all);
  }

  function clearManifest(session) {
    const all = { ...(storage.get("manifests", {}) || {}) };
    delete all[session];
    storage.set("manifests", all);
    seenMap.delete(session);
    pushState();
  }

  function snapshot() {
    const all = getAllSessions();
    const sessions = {};
    for (const name of Object.keys(all)) {
      const rec = getSessionRecord(name);
      const run = running.get(name);
      sessions[name] = {
        ...rec,
        running: Boolean(run),
        progress: run ? { done: run.done, total: run.total, synced: run.synced, trigger: run.trigger, startedAt: run.startedAt } : null,
      };
    }
    for (const [name, run] of running.entries()) {
      if (!sessions[name]) {
        sessions[name] = {
          ...getSessionRecord(name),
          running: true,
          progress: { done: run.done, total: run.total, synced: run.synced, trigger: run.trigger, startedAt: run.startedAt },
        };
      }
    }
    return {
      ok: true,
      settings: getSettings(),
      defaults: { rules: DEFAULT_RULES, settings: DEFAULT_SETTINGS, localRootHint: DEFAULT_LOCAL_ROOT_HINT },
      sessions,
    };
  }

  function pushState() {
    pushEvent("backup:state", snapshot());
  }

  function stopTimer(session) {
    const t = timers.get(session);
    if (t) clearTimeout(t);
    timers.delete(session);
  }

  function scheduleSession(session) {
    stopTimer(session);
    const rec = getSessionRecord(session);
    if (!rec.enabled) return;
    const ms = Math.max(10, rec.rules.intervalSec) * 1000;
    const t = setTimeout(async () => {
      timers.delete(session);
      if (!getSessionRecord(session).enabled) return;
      await runNow(session, { trigger: "poll", force: false }).catch(() => {});
      if (getSessionRecord(session).enabled) scheduleSession(session);
    }, ms);
    if (t && typeof t.unref === "function") t.unref();
    timers.set(session, t);
  }

  function configureSession(session, patch = {}) {
    if (!validSessionName(session)) return { ok: false, error: "invalid session name" };
    const nextPatch = {};
    if (patch.enabled !== undefined) nextPatch.enabled = Boolean(patch.enabled);
    if (patch.rules !== undefined) nextPatch.rules = normalizeRules(patch.rules);
    const rec = saveSessionRecord(session, nextPatch);
    if (rec.enabled) scheduleSession(session);
    else stopTimer(session);
    pushState();
    return { ok: true, session: rec };
  }

  function cancelRun(session) {
    const run = running.get(session);
    if (!run) return { ok: false, error: "no active backup for session" };
    run.controller.abort();
    pushState();
    return { ok: true, session, cancelled: true };
  }

  async function runNow(session, { trigger = "manual", force = false } = {}) {
    if (!validSessionName(session)) return { ok: false, error: "invalid session name" };
    if (running.has(session)) return { ok: true, alreadyRunning: true, session };

    const rec = getSessionRecord(session);
    const settings = getSettings();
    const effSettings = {
      ...settings,
      localRoot: settings.localRoot || (settings.targets !== "drive" ? DEFAULT_LOCAL_ROOT_HINT : ""),
    };
    const manifest = getManifest(session);
    const seen = seenMap.get(session) || {};
    const controller = new AbortController();
    const runState = { controller, startedAt: now(), trigger, done: 0, total: 0, synced: 0 };
    running.set(session, runState);
    pushState();

    let result;
    try {
      result = await passFn({
        session,
        rules: rec.rules,
        settings: effSettings,
        manifest,
        seen,
        signal: controller.signal,
        sleep,
        force,
        onProgress: (p) => {
          runState.done = p.done;
          runState.total = p.total;
          runState.synced = p.synced;
          pushState();
        },
      });
    } catch (err) {
      result = {
        ok: false,
        session,
        started: runState.startedAt,
        finished: now(),
        synced: 0,
        bytes: 0,
        pending: 0,
        deferred: 0,
        errors: [String(err?.message || err)],
      };
    } finally {
      running.delete(session);
    }

    if (result.nextSeen) seenMap.set(session, result.nextSeen);
    saveManifest(session, manifest);

    const prev = getSessionRecord(session);
    saveSessionRecord(session, {
      lastRun: result.finished || now(),
      lastOk: Boolean(result.ok),
      lastTrigger: trigger,
      synced: Number(result.synced) || 0,
      totalSynced: prev.totalSynced + (Number(result.synced) || 0),
      bytes: prev.bytes + (Number(result.bytes) || 0),
      pending: Number(result.pending) || 0,
      deferred: Number(result.deferred) || 0,
      errors: Array.isArray(result.errors) ? result.errors.slice(0, 20) : [],
    });

    pushState();
    if (!result.ok && !result.cancelled) {
      pushEvent("backup:error", {
        session,
        trigger,
        errors: (result.errors || []).slice(0, 5),
      });
    }
    return result;
  }

  function handleGuardState(payload) {
    if (!payload || typeof payload !== "object") return [];
    const settings = getSettings();
    if (!settings.safetyNet) return [];

    const candidates = [];
    const warnMinutes = Number(payload.settings?.warnMinutes ?? 15);
    if (Array.isArray(payload.sessions)) {
      for (const s of payload.sessions) {
        if (!s || !validSessionName(s.name)) continue;
        const isLoss = s.state === "reconnecting" || s.state === "lost";
        const isRecycle = Number.isFinite(s.remainingMinutes) && s.remainingMinutes <= warnMinutes;
        if (isLoss || isRecycle) candidates.push({ session: s.name, reason: isLoss ? s.state : "recycle" });
      }
    } else if (validSessionName(payload.session)) {
      const isLoss = payload.state === "reconnecting" || payload.state === "lost" || Boolean(payload.loss);
      const isRecycle = Boolean(payload.recycleWarning) || payload.state === "recycle";
      if (isLoss || isRecycle) candidates.push({ session: payload.session, reason: isLoss ? "loss" : "recycle" });
    }

    const triggered = [];
    const t = now();
    for (const c of candidates) {
      const lastAt = safetyNetCooldown.get(c.session) || 0;
      if (t - lastAt < SAFETY_NET_COOLDOWN_MS) continue;
      if (running.has(c.session)) continue;
      safetyNetCooldown.set(c.session, t);
      triggered.push(c.session);
      pushEvent("backup:safety-net", { session: c.session, reason: c.reason, ts: t });
      void runNow(c.session, { trigger: `safety-net:${c.reason}`, force: true }).catch(() => {});
    }
    return triggered;
  }

  function init() {
    const all = getAllSessions();
    for (const [name, rec] of Object.entries(all)) {
      if (rec && rec.enabled && validSessionName(name)) scheduleSession(name);
    }
    if (ctx.bus && typeof ctx.bus.on === "function") {
      guardListener = (payload) => handleGuardState(payload);
      ctx.bus.on("guard:state", guardListener);
    }
  }

  function shutdown() {
    if (guardListener && ctx.bus && typeof ctx.bus.off === "function") {
      ctx.bus.off("guard:state", guardListener);
      guardListener = null;
    }
    for (const session of [...timers.keys()]) stopTimer(session);
    for (const run of running.values()) {
      try { run.controller.abort(); } catch {}
    }
    running.clear();
  }

  async function handleRoutes(req, res, url, routeCtx) {
    const sendJson = (routeCtx && routeCtx.sendJson) || ctx.sendJson;
    const readJsonBodySafe = (routeCtx && routeCtx.readJsonBodySafe) || ctx.readJsonBodySafe;
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/backup/state") {
      sendJson(res, 200, snapshot());
      return true;
    }
    if (req.method === "POST" && p === "/api/backup/settings") {
      const body = (await readJsonBodySafe(req)) || {};
      const r = saveSettings(body);
      sendJson(res, r.ok ? 200 : 400, r.ok ? { ...r, state: snapshot() } : r);
      return true;
    }
    if (req.method === "POST" && p === "/api/backup/session") {
      const body = (await readJsonBodySafe(req)) || {};
      const r = configureSession(body.session, body);
      sendJson(res, r.ok ? 200 : 400, r.ok ? { ...r, state: snapshot() } : r);
      return true;
    }
    if (req.method === "POST" && p === "/api/backup/run") {
      const body = (await readJsonBodySafe(req)) || {};
      if (!validSessionName(body.session)) {
        sendJson(res, 400, { ok: false, error: "invalid session name" });
        return true;
      }
      if (body.async) {
        if (running.has(body.session)) {
          sendJson(res, 200, { ok: true, alreadyRunning: true, session: body.session });
        } else {
          void runNow(body.session, { trigger: "manual", force: body.force !== false }).catch(() => {});
          sendJson(res, 202, { ok: true, started: true, session: body.session });
        }
        return true;
      }
      const r = await runNow(body.session, { trigger: "manual", force: body.force !== false });
      sendJson(res, 200, { ...r, state: snapshot() });
      return true;
    }
    if (req.method === "POST" && p === "/api/backup/cancel") {
      const body = (await readJsonBodySafe(req)) || {};
      const r = cancelRun(body.session);
      sendJson(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (req.method === "POST" && p === "/api/backup/clear-manifest") {
      const body = (await readJsonBodySafe(req)) || {};
      if (!validSessionName(body.session)) {
        sendJson(res, 400, { ok: false, error: "invalid session name" });
        return true;
      }
      clearManifest(body.session);
      sendJson(res, 200, { ok: true, state: snapshot() });
      return true;
    }
    return false;
  }

  return {
    init,
    shutdown,
    handleRoutes,
    snapshot,
    saveSettings,
    configureSession,
    runNow,
    cancelRun,
    clearManifest,
    handleGuardState,
  };
}

let activeController = null;

export const feature = {
  id: "backup",
  init(ctx) {
    activeController = createBackupController(ctx);
    activeController.init();
  },
  async handleRoutes(req, res, url, ctx) {
    if (!activeController) return false;
    return activeController.handleRoutes(req, res, url, ctx);
  },
  shutdown() {
    if (activeController) {
      activeController.shutdown();
      activeController = null;
    }
  },
};

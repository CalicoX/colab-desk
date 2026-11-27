import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ID_RE = /^[a-z0-9_][a-z0-9_-]{0,40}$/;

export function isValidFeatureId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

export function resolveConfigDir() {
  return process.env.COLAB_DESK_STATE_DIR || path.join(os.homedir(), ".config", "colab-desk");
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Per-feature JSON storage persisted under <configDir>/features/<id>.json (never in the repo). */
export function createStorage(id, configDir = resolveConfigDir) {
  if (!isValidFeatureId(id)) throw new Error(`invalid feature id: ${id}`);
  const file = () => path.join(typeof configDir === "function" ? configDir() : configDir, "features", `${id}.json`);
  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file(), "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  };
  return {
    get(key, def = undefined) {
      const data = read();
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : def;
    },
    set(key, val) {
      const data = read();
      if (val === undefined) delete data[key];
      else data[key] = val;
      write(data);
      return val;
    },
    all() {
      return read();
    },
  };
}

/**
 * Feature host: auto-discovers src/features/<id>/index.mjs, runs init/handleRoutes/shutdown
 * with per-feature isolation, and owns the SSE client set behind GET /api/events.
 */
export function createFeatureHost({ featuresDir, publicDir, ctxBase = {}, configDir = resolveConfigDir, helpers = {} }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const clients = new Set();
  const features = new Map(); // id -> feature
  const errors = [];
  let loading = null;

  function pushEvent(type, payload = null) {
    const event = { type: String(type), payload, ts: Date.now() };
    bus.emit(event.type, payload);
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of Array.from(clients)) {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  const ctx = {
    ...ctxBase,
    bus,
    pushEvent,
    storage: (id) => createStorage(id, configDir),
    ...helpers,
  };

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      let realFeaturesDir = null;
      try {
        realFeaturesDir = fs.realpathSync(featuresDir);
      } catch {
        return;
      }
      for (const entry of safeReaddir(featuresDir)) {
        if (!entry.isDirectory() || !isValidFeatureId(entry.name)) continue;
        const entryFile = path.join(featuresDir, entry.name, "index.mjs");
        if (!fs.existsSync(entryFile)) continue;
        try {
          const realEntry = fs.realpathSync(entryFile);
          if (!realEntry.startsWith(realFeaturesDir + path.sep)) {
            throw new Error("feature path escapes features directory");
          }
          const mod = await import(pathToFileURL(realEntry).href);
          const feature = mod.feature;
          if (!feature || typeof feature !== "object") throw new Error("missing `feature` export");
          const id = feature.id || entry.name;
          if (id !== entry.name) throw new Error(`feature id "${id}" must match directory "${entry.name}"`);
          feature.id = id;
          if (typeof feature.init === "function") await feature.init({ ...ctx, featureId: id });
          features.set(id, feature);
        } catch (err) {
          errors.push({ id: entry.name, error: String(err?.message || err) });
          console.error(`[features] ${entry.name} failed to load: ${err?.message || err}`);
        }
      }
    })();
    return loading;
  }

  async function handleRoutes(req, res, url) {
    await load();
    const m = /^\/api\/([^/]+)(?:\/|$)/.exec(url.pathname);
    if (!m) return false;
    const feature = features.get(m[1]);
    if (!feature || typeof feature.handleRoutes !== "function") return false;
    try {
      return Boolean(await feature.handleRoutes(req, res, url, { ...ctx, featureId: feature.id }));
    } catch (err) {
      if (!res.headersSent) {
        const payload = JSON.stringify({ ok: false, error: String(err?.message || err) });
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(payload);
      }
      return true;
    }
  }

  function listFrontend() {
    const frontend = [];
    const styles = [];
    if (publicDir) {
      for (const entry of safeReaddir(path.join(publicDir, "js", "features"))) {
        if (!entry.isDirectory() || !isValidFeatureId(entry.name)) continue;
        if (fs.existsSync(path.join(publicDir, "js", "features", entry.name, "index.js"))) {
          frontend.push(`/js/features/${entry.name}/index.js`);
        }
      }
      for (const entry of safeReaddir(path.join(publicDir, "styles", "features"))) {
        if (entry.isFile() && entry.name.endsWith(".css") && isValidFeatureId(entry.name.slice(0, -4))) {
          styles.push(`/styles/features/${entry.name}`);
        }
      }
    }
    frontend.sort();
    styles.sort();
    return { frontend, styles };
  }

  async function describe() {
    await load();
    return { ok: true, backend: Array.from(features.keys()).sort(), ...listFrontend(), errors };
  }

  function addClient(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\nretry: 2000\n\n");
    clients.add(res);
    const beat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(": ping\n\n");
    }, 25_000);
    beat.unref?.();
    const cleanup = () => {
      clearInterval(beat);
      clients.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  function shutdown() {
    for (const feature of features.values()) {
      try {
        feature.shutdown?.();
      } catch {}
    }
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    clients.clear();
  }

  return { bus, ctx, load, handleRoutes, describe, addClient, pushEvent, shutdown, features, errors };
}

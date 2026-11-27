import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkColabEnvironment, installColabCli, loginColabCli } from "../colab-env.mjs";
import { checkForUpdates } from "../cloud-ops.mjs";
import { emptyState } from "../parse.mjs";
import { runAction } from "../run.mjs";
import { loadStore, saveStore } from "../store.mjs";
import { readJsonBody, readJsonBodySafe, sendJson, withAbortSignal } from "./http.mjs";

function readRecentColabLog() {
  const logPath = path.join(os.homedir(), ".config", "colab-cli", "colab.log");
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size;
    const readBytes = Math.min(size, 8192);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
      const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
      return lines.slice(-24);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export async function handleSessionRoutes(req, res, url, { rootDir, terminals, defaultVersion }) {
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const result = await runAction({ type: "sessions" });
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const result = await runAction({ type: "usage" });
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const session = url.searchParams.get("session");
    const result = await runAction(session ? { type: "status", session } : { type: "status" });
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/store") {
    sendJson(res, 200, { ok: true, data: loadStore() });
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/api/store") {
    let patch;
    try {
      patch = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return true;
    }
    try {
      const saved = saveStore(patch);
      sendJson(res, 200, { ok: true, data: saved });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/env/check") {
    const env = await checkColabEnvironment();
    sendJson(res, 200, { ok: true, env });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/env/install") {
    const body = await readJsonBodySafe(req);
    const result = await withAbortSignal(res, (signal) => installColabCli(body.method || "auto", signal));
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/env/login") {
    const result = await withAbortSignal(res, (signal) => loginColabCli(signal));
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, 200, result);
    return true;
  }

  // In-app Update Check
  if (req.method === "GET" && url.pathname === "/api/updates/check") {
    let ver = defaultVersion;
    try {
      ver = JSON.parse(fs.readFileSync(path.join(rootDir, "../package.json"), "utf8")).version || ver;
    } catch {}
    const result = await checkForUpdates(ver);
    sendJson(res, 200, result);
    return true;
  }

  // Interactive PTY Terminals
  if (req.method === "GET" && url.pathname === "/api/terminal/list") {
    sendJson(res, 200, { ok: true, terminals: terminals.list() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/create") {
    const body = await readJsonBodySafe(req);
    const result = terminals.create(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/terminal/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/terminal/".length));
    const ok = terminals.close(id);
    sendJson(res, 200, { ok });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/log-tail") {
    const lines = readRecentColabLog();
    sendJson(res, 200, { ok: true, lines });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/action") {
    let action;
    try {
      action = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message, argv: [], state: emptyState() });
      return true;
    }
    const result = await withAbortSignal(res, (signal) => runAction(action, { signal }));
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, result.ok ? 200 : 422, result);
    return true;
  }

  return false;
}

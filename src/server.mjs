import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentManager, IMAGE_DIR, UPLOAD_DIR } from "./agent.mjs";
import { checkColabEnvironment, installColabCli, loginColabCli } from "./colab-env.mjs";
import {
  bootstrapSession,
  checkForUpdates,
  copyFilesToDrive,
  deleteRemoteFile,
  downloadRemoteFile,
  ensureRemoteMedia,
  execNotebookCell,
  exportSession,
  fetchGpuTelemetry,
  inspectKernelVariables,
  killRemoteProcess,
  listRemoteFiles,
  previewRemoteFile,
  readCloudNotebook,
  runDirectScript,
  saveCloudNotebook,
  syncPullFolder,
  syncPushFolder,
  TunnelManager,
  uploadRemoteFile,
} from "./cloud-ops.mjs";
import { runAction } from "./run.mjs";
import { emptyState } from "./parse.mjs";
import { loadStore, saveStore } from "./store.mjs";
import { TerminalManager } from "./terminal.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(rootDir, "../public/index.html");
const vendorDir = path.join(rootDir, "../public/vendor");
const deskPath = path.join(rootDir, "desk.mjs");
const i18nPath = path.join(rootDir, "i18n.mjs");
const agents = new AgentManager(path.resolve(rootDir, ".."));
const tunnels = new TunnelManager();
const terminals = new TerminalManager(path.resolve(rootDir, ".."));

function sendSse(res, event) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readRawBody(req, maxBytes = 50_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("file too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeFileName(raw) {
  const base = path.basename(String(raw || "file.bin")).replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
  return base || "file.bin";
}

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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/") {
    const html = fs.readFileSync(pagePath);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": html.length,
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/desk.mjs") {
    const body = fs.readFileSync(deskPath);
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/i18n.mjs") {
    const body = fs.readFileSync(i18nPath);
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
    const rel = url.pathname.slice("/vendor/".length);
    const resolved = path.resolve(vendorDir, rel);
    if (!resolved.startsWith(path.resolve(vendorDir) + path.sep)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    try {
      const body = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mime = ext === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": "public, max-age=3600",
        "content-length": body.length,
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { ok: false, error: "asset not found" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const result = await runAction({ type: "sessions" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const result = await runAction({ type: "usage" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const session = url.searchParams.get("session");
    const result = await runAction(session ? { type: "status", session } : { type: "status" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/store") {
    sendJson(res, 200, { ok: true, data: loadStore() });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/store") {
    let patch;
    try {
      patch = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    try {
      const saved = saveStore(patch);
      sendJson(res, 200, { ok: true, data: saved });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/env/check") {
    const env = await checkColabEnvironment();
    sendJson(res, 200, { ok: true, env });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/env/install") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    const result = await installColabCli(body.method || "auto", controller.signal);
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/env/login") {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    const result = await loginColabCli(controller.signal);
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/test-api") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await agents.testApiConfig(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/fetch-models") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await agents.fetchOpenAiModelsDirect(body);
    sendJson(res, 200, result);
    return;
  }

  // Native Notebook Mode endpoints (powered by official colab CLI)
  if (req.method === "POST" && url.pathname === "/api/notebook/exec") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    const result = await execNotebookCell({
      session: body.session || "",
      code: body.code || "",
      timeout: body.timeout || 300,
      signal: controller.signal,
    });
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notebook/vars") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await inspectKernelVariables(body.session || "");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notebook/cloud-read") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await readCloudNotebook(body.session || "", body.remotePath || "");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notebook/cloud-save") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await saveCloudNotebook(
      body.session || "",
      body.remotePath || "",
      body.cells || [],
      body.metadata || {},
    );
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/acp-auth") {
    const provider = url.searchParams.get("provider") || "agy";
    const status = await agents.getAcpAuthStatus(provider);
    sendJson(res, 200, status);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/acp-auth/login") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await agents.authenticateAcp(body.provider || "agy", body.methodId || "oauth-personal");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/acp-auth/logout") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await agents.logoutAcp(body.provider || "agy");
    sendJson(res, 200, result);
    return;
  }

  // GPU Telemetry & Process Kill
  if (req.method === "GET" && url.pathname === "/api/gpu") {
    const session = url.searchParams.get("session") || "";
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    const result = await fetchGpuTelemetry(session, controller.signal);
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gpu/kill") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await killRemoteProcess(body.session || "", body.pid);
    sendJson(res, 200, result);
    return;
  }

  // Media Streaming (supports HTTP Range for <video controls>)
  if (req.method === "GET" && url.pathname === "/api/files/media") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await ensureRemoteMedia(session, remotePath);
    if (!result.ok) {
      sendJson(res, 404, result);
      return;
    }
    const total = result.size;
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
      if (start >= total || start > end) {
        res.writeHead(416, { "content-range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": result.mime,
        "content-range": `bytes ${start}-${end}/${total}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "cache-control": "no-store",
      });
      fs.createReadStream(result.localPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "content-type": result.mime,
        "accept-ranges": "bytes",
        "content-length": total,
        "cache-control": "no-store",
      });
      fs.createReadStream(result.localPath).pipe(res);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/files/copy-to-drive") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await copyFilesToDrive(body.session || "", body.paths || [], body.targetDir);
    sendJson(res, 200, result);
    return;
  }

  // Direct Parameterized Script Runner (zero Agent)
  if (req.method === "POST" && url.pathname === "/api/runner/exec") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    const savedEnv = loadStore().settings?.envVars || [];
    const result = await runDirectScript({
      session: body.session || "",
      runtime: body.runtime || "python",
      script: body.script || "",
      params: body.params || {},
      envVars: Array.isArray(body.envVars) ? body.envVars : savedEnv,
      signal: controller.signal,
    });
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, result);
    return;
  }

  // Auto-Bootstrap & Env Vault Injection
  if (req.method === "POST" && url.pathname === "/api/bootstrap") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const storeSettings = loadStore().settings || {};
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    const result = await bootstrapSession({
      session: body.session || "",
      envVars: Array.isArray(body.envVars) ? body.envVars : (storeSettings.envVars || []),
      config: body.config || storeSettings.bootstrapConfig || {},
      signal: controller.signal,
    });
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, result);
    return;
  }

  // Local <-> Colab Folder Sync
  if (req.method === "POST" && url.pathname === "/api/sync/push") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await syncPushFolder(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sync/pull") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await syncPullFolder(body);
    sendJson(res, 200, result);
    return;
  }

  // In-app Update Check
  if (req.method === "GET" && url.pathname === "/api/updates/check") {
    let ver = "0.4.1";
    try {
      ver = JSON.parse(fs.readFileSync(path.join(rootDir, "../package.json"), "utf8")).version || ver;
    } catch {}
    const result = await checkForUpdates(ver);
    sendJson(res, 200, result);
    return;
  }

  // Cloud File Browser
  if (req.method === "GET" && url.pathname === "/api/files") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "/content";
    const result = await listRemoteFiles(session, remotePath);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/files/preview") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await previewRemoteFile(session, remotePath);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/files/download") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await downloadRemoteFile(session, remotePath);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    try {
      const bytes = fs.readFileSync(result.localPath);
      try { fs.unlinkSync(result.localPath); } catch {}
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${encodeURIComponent(result.name)}"`,
        "content-length": bytes.length,
        "cache-control": "no-store",
      });
      res.end(bytes);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/files/upload") {
    const session = url.searchParams.get("session") || "";
    const remoteDir = url.searchParams.get("dir") || "/content";
    const rawName = url.searchParams.get("name") || "file.bin";
    const safeName = sanitizeFileName(rawName);
    try {
      const buf = await readRawBody(req, 50_000_000);
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const localPath = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${safeName}`);
      fs.writeFileSync(localPath, buf);
      const result = await uploadRemoteFile(session, localPath, remoteDir, safeName);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/files") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await deleteRemoteFile(session, remotePath);
    sendJson(res, 200, result);
    return;
  }

  // SSH Port Forwarding Tunnels
  if (req.method === "GET" && url.pathname === "/api/tunnels") {
    const session = url.searchParams.get("session") || null;
    sendJson(res, 200, { ok: true, tunnels: tunnels.list(session) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tunnels") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await tunnels.open(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/tunnels/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/tunnels/".length));
    const ok = tunnels.close(id);
    sendJson(res, 200, { ok });
    return;
  }

  // Interactive PTY Terminals
  if (req.method === "GET" && url.pathname === "/api/terminal/list") {
    sendJson(res, 200, { ok: true, terminals: terminals.list() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/create") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = terminals.create(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/terminal/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/terminal/".length));
    const ok = terminals.close(id);
    sendJson(res, 200, { ok });
    return;
  }

  // Export Session (.ipynb / .md)
  if (req.method === "POST" && url.pathname === "/api/export") {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const result = await exportSession(body.session || "", body.format || "ipynb", body.entries || []);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/log-tail") {
    const lines = readRecentColabLog();
    sendJson(res, 200, { ok: true, lines });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/providers") {
    sendJson(res, 200, { ok: true, providers: agents.listProviders() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/models") {
    const provider = url.searchParams.get("provider") || "agy";
    try {
      const data = await agents.fetchModels(provider);
      sendJson(res, 200, { ok: true, provider, ...data });
    } catch (err) {
      sendJson(res, 200, { ok: false, provider, error: err.message, models: [], current: "" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/quota") {
    const force = url.searchParams.get("refresh") === "1";
    try {
      const quota = await agents.fetchQuotas(force);
      sendJson(res, 200, { ok: true, quota });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/reset") {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {}
    agents.resetThread(body.colabSession || "", body.provider || "");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/permission") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    const resolved = agents.resolvePermission(body.requestId, !!body.allow);
    sendJson(res, 200, { ok: resolved });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/chat") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      await agents.runChat(body, (ev) => sendSse(res, ev), controller.signal);
    } catch (err) {
      sendSse(res, { type: "error", error: err.message || String(err) });
    } finally {
      res.off("close", onClose);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stage-file") {
    const rawName = url.searchParams.get("name") || "file.bin";
    const safeName = sanitizeFileName(rawName);
    try {
      const buf = await readRawBody(req, 50_000_000);
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const target = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${safeName}`);
      fs.writeFileSync(target, buf);
      sendJson(res, 200, { ok: true, name: safeName, path: target, size: buf.length });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/image") {
    const requested = url.searchParams.get("path") || "";
    const resolved = path.resolve(requested);
    const allowedRoot = path.resolve(IMAGE_DIR) + path.sep;
    if (!resolved.startsWith(allowedRoot)) {
      sendJson(res, 403, { ok: false, error: "forbidden image path" });
      return;
    }
    try {
      const bytes = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": "no-store",
        "content-length": bytes.length,
      });
      res.end(bytes);
    } catch {
      sendJson(res, 404, { ok: false, error: "image not found" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/action") {
    let action;
    try {
      action = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message, argv: [], state: emptyState() });
      return;
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    const result = await runAction(action, { signal: controller.signal });
    res.off("close", onClose);
    if (res.writableEnded || res.destroyed) return;
    sendJson(res, result.ok ? 200 : 422, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found", argv: [], state: emptyState() });
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      sendJson(res, 500, { ok: false, error: err.message, argv: [], state: emptyState() });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/api/terminal/ws") {
        const id = url.searchParams.get("id") || "";
        terminals.handleUpgrade(req, socket, head, id);
        return;
      }
    } catch {}
    socket.destroy();
  });
  server.on("close", () => {
    agents.shutdown();
    tunnels.shutdown();
    terminals.shutdown();
  });
  return server;
}

export function listen(port = Number(process.env.PORT ?? 4173)) {
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`colab-desk listening on http://127.0.0.1:${address.port}`);
  });
  const cleanup = () => {
    agents.shutdown();
    tunnels.shutdown();
    terminals.shutdown();
    process.exit(0);
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  return server;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  listen();
}

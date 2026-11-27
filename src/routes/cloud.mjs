import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "../agent.mjs";
import {
  bootstrapSession,
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
  uploadRemoteFile,
} from "../cloud-ops.mjs";
import { loadStore } from "../store.mjs";
import { readJsonBodySafe, readRawBody, sanitizeFileName, sendJson, withAbortSignal } from "./http.mjs";

export async function handleCloudRoutes(req, res, url, { tunnels }) {
  // Native Notebook Mode endpoints (powered by official colab CLI)
  if (req.method === "POST" && url.pathname === "/api/notebook/exec") {
    const body = await readJsonBodySafe(req);
    const result = await withAbortSignal(res, (signal) =>
      execNotebookCell({
        session: body.session || "",
        code: body.code || "",
        timeout: body.timeout || 300,
        signal,
      }),
    );
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/notebook/vars") {
    const body = await readJsonBodySafe(req);
    const result = await inspectKernelVariables(body.session || "");
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/notebook/cloud-read") {
    const body = await readJsonBodySafe(req);
    const result = await readCloudNotebook(body.session || "", body.remotePath || "");
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/notebook/cloud-save") {
    const body = await readJsonBodySafe(req);
    const result = await saveCloudNotebook(
      body.session || "",
      body.remotePath || "",
      body.cells || [],
      body.metadata || {},
    );
    sendJson(res, 200, result);
    return true;
  }

  // GPU Telemetry & Process Kill
  if (req.method === "GET" && url.pathname === "/api/gpu") {
    const session = url.searchParams.get("session") || "";
    const result = await withAbortSignal(res, (signal) => fetchGpuTelemetry(session, signal));
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/gpu/kill") {
    const body = await readJsonBodySafe(req);
    const result = await killRemoteProcess(body.session || "", body.pid);
    sendJson(res, 200, result);
    return true;
  }

  // Media Streaming (supports HTTP Range for <video controls>)
  if (req.method === "GET" && url.pathname === "/api/files/media") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await ensureRemoteMedia(session, remotePath);
    if (!result.ok) {
      sendJson(res, 404, result);
      return true;
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
        return true;
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
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/files/copy-to-drive") {
    const body = await readJsonBodySafe(req);
    const result = await copyFilesToDrive(body.session || "", body.paths || [], body.targetDir);
    sendJson(res, 200, result);
    return true;
  }

  // Direct Parameterized Script Runner (zero Agent)
  if (req.method === "POST" && url.pathname === "/api/runner/exec") {
    const body = await readJsonBodySafe(req);
    const savedEnv = loadStore().settings?.envVars || [];
    const result = await withAbortSignal(res, (signal) =>
      runDirectScript({
        session: body.session || "",
        runtime: body.runtime || "python",
        script: body.script || "",
        params: body.params || {},
        envVars: Array.isArray(body.envVars) ? body.envVars : savedEnv,
        signal,
      }),
    );
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, 200, result);
    return true;
  }

  // Auto-Bootstrap & Env Vault Injection
  if (req.method === "POST" && url.pathname === "/api/bootstrap") {
    const body = await readJsonBodySafe(req);
    const storeSettings = loadStore().settings || {};
    const result = await withAbortSignal(res, (signal) =>
      bootstrapSession({
        session: body.session || "",
        envVars: Array.isArray(body.envVars) ? body.envVars : (storeSettings.envVars || []),
        config: body.config || storeSettings.bootstrapConfig || {},
        signal,
      }),
    );
    if (res.writableEnded || res.destroyed) return true;
    sendJson(res, 200, result);
    return true;
  }

  // Local <-> Colab Folder Sync
  if (req.method === "POST" && url.pathname === "/api/sync/push") {
    const body = await readJsonBodySafe(req);
    const result = await syncPushFolder(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sync/pull") {
    const body = await readJsonBodySafe(req);
    const result = await syncPullFolder(body);
    sendJson(res, 200, result);
    return true;
  }

  // Cloud File Browser
  if (req.method === "GET" && url.pathname === "/api/files") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "/content";
    const result = await listRemoteFiles(session, remotePath);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/files/preview") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await previewRemoteFile(session, remotePath);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/files/download") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await downloadRemoteFile(session, remotePath);
    if (!result.ok) {
      sendJson(res, 400, result);
      return true;
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
    return true;
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
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/files") {
    const session = url.searchParams.get("session") || "";
    const remotePath = url.searchParams.get("path") || "";
    const result = await deleteRemoteFile(session, remotePath);
    sendJson(res, 200, result);
    return true;
  }

  // SSH Port Forwarding Tunnels
  if (req.method === "GET" && url.pathname === "/api/tunnels") {
    const session = url.searchParams.get("session") || null;
    sendJson(res, 200, { ok: true, tunnels: tunnels.list(session) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/tunnels") {
    const body = await readJsonBodySafe(req);
    const result = await tunnels.open(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/tunnels/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/tunnels/".length));
    const ok = tunnels.close(id);
    sendJson(res, 200, { ok });
    return true;
  }

  // Export Session (.ipynb / .md)
  if (req.method === "POST" && url.pathname === "/api/export") {
    const body = await readJsonBodySafe(req);
    const result = await exportSession(body.session || "", body.format || "ipynb", body.entries || []);
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

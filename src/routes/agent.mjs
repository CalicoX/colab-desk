import fs from "node:fs";
import path from "node:path";
import { IMAGE_DIR, UPLOAD_DIR } from "../agent.mjs";
import {
  readJsonBody,
  readJsonBodySafe,
  readRawBody,
  sanitizeFileName,
  sendJson,
  sendSse,
  withAbortSignal,
} from "./http.mjs";

const IMAGE_MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

const IMAGE_EXT_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export async function handleAgentRoutes(req, res, url, { agents }) {
  if (req.method === "POST" && url.pathname === "/api/agent/test-api") {
    const body = await readJsonBodySafe(req);
    const result = await agents.testApiConfig(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/fetch-models") {
    const body = await readJsonBodySafe(req);
    const result = await agents.fetchOpenAiModelsDirect(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/acp-auth") {
    const provider = url.searchParams.get("provider") || "agy";
    const status = await agents.getAcpAuthStatus(provider);
    sendJson(res, 200, status);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/acp-auth/login") {
    const body = await readJsonBodySafe(req);
    const result = await agents.authenticateAcp(body.provider || "agy", body.methodId || "oauth-personal");
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/acp-auth/logout") {
    const body = await readJsonBodySafe(req);
    const result = await agents.logoutAcp(body.provider || "agy");
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/providers") {
    sendJson(res, 200, { ok: true, providers: agents.listProviders() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/models") {
    const provider = url.searchParams.get("provider") || "agy";
    try {
      const data = await agents.fetchModels(provider);
      sendJson(res, 200, { ok: true, provider, ...data });
    } catch (err) {
      sendJson(res, 200, { ok: false, provider, error: err.message, models: [], current: "" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/quota") {
    const force = url.searchParams.get("refresh") === "1";
    try {
      const quota = await agents.fetchQuotas(force);
      sendJson(res, 200, { ok: true, quota });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/reset") {
    const body = await readJsonBodySafe(req);
    agents.resetThread(body.colabSession || "", body.provider || "");
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/permission") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return true;
    }
    const resolved = agents.resolvePermission(body.requestId, !!body.allow);
    sendJson(res, 200, { ok: resolved });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/chat") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    try {
      await withAbortSignal(res, (signal) => agents.runChat(body, (ev) => sendSse(res, ev), signal));
    } catch (err) {
      sendSse(res, { type: "error", error: err.message || String(err) });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/stage-file") {
    const rawName = url.searchParams.get("name") || "file.bin";
    const reqMime = String(url.searchParams.get("mime") || req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    let safeName = sanitizeFileName(rawName);
    let ext = path.extname(safeName).toLowerCase();
    if (!ext && IMAGE_MIME_TO_EXT[reqMime]) {
      safeName = `${safeName}${IMAGE_MIME_TO_EXT[reqMime]}`;
      ext = IMAGE_MIME_TO_EXT[reqMime];
    }
    const mimeType = IMAGE_EXT_TO_MIME[ext] || (IMAGE_MIME_TO_EXT[reqMime] ? reqMime : (reqMime || "application/octet-stream"));
    const isImage = Boolean(IMAGE_EXT_TO_MIME[ext]);
    try {
      const buf = await readRawBody(req, 50_000_000);
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const target = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${safeName}`);
      fs.writeFileSync(target, buf);
      sendJson(res, 200, {
        ok: true,
        name: safeName,
        path: target,
        size: buf.length,
        mimeType,
        isImage,
        previewUrl: isImage ? `/api/image?path=${encodeURIComponent(target)}` : null,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/image") {
    const requested = url.searchParams.get("path") || "";
    const resolved = path.resolve(requested);
    const allowedImageRoot = path.resolve(IMAGE_DIR) + path.sep;
    const allowedUploadRoot = path.resolve(UPLOAD_DIR) + path.sep;
    const ext = path.extname(resolved).toLowerCase();
    const inImageDir = resolved.startsWith(allowedImageRoot);
    const inUploadDir = resolved.startsWith(allowedUploadRoot);
    if ((!inImageDir && !inUploadDir) || !IMAGE_EXT_TO_MIME[ext]) {
      sendJson(res, 403, { ok: false, error: "forbidden image path" });
      return true;
    }
    try {
      const bytes = fs.readFileSync(resolved);
      res.writeHead(200, {
        "content-type": IMAGE_EXT_TO_MIME[ext],
        "cache-control": "no-store",
        "content-length": bytes.length,
      });
      res.end(bytes);
    } catch {
      sendJson(res, 404, { ok: false, error: "image not found" });
    }
    return true;
  }

  return false;
}

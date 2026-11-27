import path from "node:path";

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendSse(res, event) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

export async function readJsonBody(req) {
  return JSON.parse(await readBody(req));
}

export async function readJsonBodySafe(req, fallback = {}) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return fallback;
  }
}

export function readRawBody(req, maxBytes = 50_000_000) {
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

export function sanitizeFileName(raw) {
  const base = path.basename(String(raw || "file.bin")).replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
  return base || "file.bin";
}

export async function withAbortSignal(res, fn) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  try {
    return await fn(controller.signal);
  } finally {
    res.off("close", onClose);
  }
}

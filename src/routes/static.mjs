import fs from "node:fs";
import path from "node:path";

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function sendStaticError(res, isHead, status, error) {
  const payload = JSON.stringify({ ok: false, error });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(isHead ? undefined : payload);
}

function sendFileResponse(res, isHead, filePath, contentType, cacheControl) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "content-length": body.length,
  });
  res.end(isHead ? undefined : body);
}

function serveStaticMount(res, isHead, pathname, mount, publicDir) {
  const rawRel = pathname.slice(mount.prefix.length);
  let decoded;
  try {
    decoded = decodeURIComponent(rawRel);
  } catch {
    sendStaticError(res, isHead, 400, "invalid path encoding");
    return;
  }
  if (decoded.includes("\0")) {
    sendStaticError(res, isHead, 400, "invalid path");
    return;
  }
  if (!decoded || decoded.endsWith("/") || decoded.includes("\\")) {
    sendStaticError(res, isHead, 403, "forbidden");
    return;
  }
  const segments = decoded.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === ".." || seg.startsWith("."))) {
    sendStaticError(res, isHead, 403, "forbidden");
    return;
  }

  const baseRoot = path.resolve(mount.dir);
  const resolved = path.resolve(baseRoot, ...segments);
  if (!resolved.startsWith(baseRoot + path.sep) || !resolved.startsWith(publicDir + path.sep)) {
    sendStaticError(res, isHead, 403, "forbidden");
    return;
  }

  let realPublicRoot;
  let realBaseRoot;
  let realFile;
  try {
    realPublicRoot = fs.realpathSync(publicDir);
    realBaseRoot = fs.realpathSync(baseRoot);
    realFile = fs.realpathSync(resolved);
  } catch {
    sendStaticError(res, isHead, 404, "asset not found");
    return;
  }

  if (!realFile.startsWith(realBaseRoot + path.sep) || !realFile.startsWith(realPublicRoot + path.sep)) {
    sendStaticError(res, isHead, 403, "forbidden");
    return;
  }
  const realRelSegments = path.relative(realBaseRoot, realFile).split(path.sep);
  if (realRelSegments.some((seg) => !seg || seg === "." || seg === ".." || seg.startsWith("."))) {
    sendStaticError(res, isHead, 403, "forbidden");
    return;
  }

  try {
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) {
      sendStaticError(res, isHead, 404, "asset not found");
      return;
    }
    const ext = path.extname(realFile).toLowerCase();
    const mime = STATIC_MIME_TYPES[ext] || "application/octet-stream";
    sendFileResponse(res, isHead, realFile, mime, mount.cacheControl);
  } catch {
    sendStaticError(res, isHead, 404, "asset not found");
  }
}

export function createStaticHandler({ rootDir, publicDir }) {
  const pagePath = path.join(publicDir, "index.html");
  const deskPath = path.join(rootDir, "desk.mjs");
  const i18nPath = path.join(rootDir, "i18n.mjs");
  const mounts = [
    { prefix: "/styles/", dir: path.join(publicDir, "styles"), cacheControl: "no-store" },
    { prefix: "/js/", dir: path.join(publicDir, "js"), cacheControl: "no-store" },
    { prefix: "/assets/", dir: path.join(publicDir, "assets"), cacheControl: "no-store" },
    { prefix: "/vendor/", dir: path.join(publicDir, "vendor"), cacheControl: "public, max-age=3600" },
  ];

  return function handleStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const isHead = req.method === "HEAD";

    if (url.pathname === "/") {
      sendFileResponse(res, isHead, pagePath, "text/html; charset=utf-8", "no-store");
      return true;
    }
    if (url.pathname === "/desk.mjs") {
      sendFileResponse(res, isHead, deskPath, "text/javascript; charset=utf-8", "no-store");
      return true;
    }
    if (url.pathname === "/i18n.mjs") {
      sendFileResponse(res, isHead, i18nPath, "text/javascript; charset=utf-8", "no-store");
      return true;
    }

    for (const mount of mounts) {
      if (url.pathname.startsWith(mount.prefix)) {
        serveStaticMount(res, isHead, url.pathname, mount, publicDir);
        return true;
      }
    }
    return false;
  };
}

import fs from "node:fs";
import path from "node:path";
import { readCloudNotebook, serializeIpynb } from "../../cloud/notebook.mjs";
import { diffNotebooks } from "./diff.mjs";
import { gitCommitNotebook, gitShowFile, gitStatus, resolveDir } from "./git.mjs";

const MAX_LOCAL_BYTES = 30_000_000;

/** Resolve one diff side into a raw ipynb object. */
async function resolveSide(side) {
  if (!side || typeof side !== "object") throw new Error("Missing diff side");
  if (side.ipynb) return typeof side.ipynb === "string" ? JSON.parse(side.ipynb) : side.ipynb;
  if (Array.isArray(side.cells)) return JSON.parse(serializeIpynb(side.cells));
  if (side.remotePath) {
    const r = await readCloudNotebook(side.session, side.remotePath);
    if (!r.ok) throw new Error(r.error || "Cloud read failed");
    return JSON.parse(serializeIpynb(r.notebook.cells, r.notebook.metadata));
  }
  if (side.localPath) {
    const p = String(side.localPath);
    if (!path.isAbsolute(p) || !p.toLowerCase().endsWith(".ipynb")) throw new Error("localPath must be an absolute .ipynb path");
    const real = fs.realpathSync(p);
    if (fs.statSync(real).size > MAX_LOCAL_BYTES) throw new Error("Notebook too large");
    return JSON.parse(fs.readFileSync(real, "utf8"));
  }
  if (side.repoDir && side.file) {
    const r = await gitShowFile(side.repoDir, side.file, side.rev || "HEAD");
    if (!r.ok) throw new Error(r.error);
    return JSON.parse(r.content);
  }
  throw new Error("Unsupported diff side");
}

export async function handleNotebookxRoute(req, res, url, helpers, store) {
  const { sendJson, readJsonBodySafe } = helpers;
  const p = url.pathname;
  if (req.method !== "POST" || !p.startsWith("/api/notebookx/")) return false;
  const body = await readJsonBodySafe(req);
  try {
    if (p === "/api/notebookx/diff") {
      const [a, b] = await Promise.all([resolveSide(body.a), resolveSide(body.b)]);
      const result = diffNotebooks(a, b, { includeOutputs: !!body.includeOutputs, ignoreMetadata: body.ignoreMetadata !== false });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
    if (p === "/api/notebookx/git/status") {
      const dir = body.dir || store?.get("repoDir", "");
      if (!dir) { sendJson(res, 200, { ok: true, isRepo: false, dir: "", needsDir: true }); return true; }
      const st = await gitStatus(dir);
      if (st.ok && body.dir) store?.set("repoDir", resolveDir(body.dir));
      sendJson(res, 200, st);
      return true;
    }
    if (p === "/api/notebookx/git/commit") {
      const dir = body.dir || store?.get("repoDir", "");
      const content = serializeIpynb(body.cells || [], {});
      const r = await gitCommitNotebook(dir, body.file, content, body.message);
      sendJson(res, 200, r);
      return true;
    }
    if (p === "/api/notebookx/git/diff-head") {
      const dir = body.dir || store?.get("repoDir", "");
      const head = await gitShowFile(dir, body.file, "HEAD");
      if (!head.ok) { sendJson(res, 200, { ok: false, error: head.error }); return true; }
      const result = diffNotebooks(JSON.parse(head.content), JSON.parse(serializeIpynb(body.cells || [])), {
        includeOutputs: !!body.includeOutputs,
        ignoreMetadata: body.ignoreMetadata !== false,
      });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err?.message || String(err) });
    return true;
  }
  return false;
}

export const feature = {
  id: "notebookx",
  store: null,
  init(ctx) { this.store = ctx?.storage ? ctx.storage("notebookx") : null; },
  async handleRoutes(req, res, url, ctx) {
    return handleNotebookxRoute(req, res, url, ctx.http || ctx, this.store);
  },
  shutdown() {},
};

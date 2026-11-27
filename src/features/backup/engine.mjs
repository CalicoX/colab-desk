import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAction } from "../../run.mjs";
import { expandHomePath, parseLastJsonLine, runRemotePythonSsh } from "../../cloud/shared.mjs";

export const DEFAULT_EXCLUDES = ["*.tmp", "__pycache__", ".ipynb_checkpoints"];
export const DEFAULT_RULES = Object.freeze({
  paths: ["/content/output"],
  include: [],
  exclude: DEFAULT_EXCLUDES,
  intervalSec: 120,
  minAgeSec: 20,
});
export const DEFAULT_SETTINGS = Object.freeze({
  targets: "drive", // drive | local | both
  driveDir: "/content/drive/MyDrive/colab-desk-backups",
  localRoot: "",
  safetyNet: true,
  batchFiles: 40,
  batchBytes: 512 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  retries: 3,
});
export const TARGETS = ["drive", "local", "both"];

const clampInt = (v, lo, hi, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const strList = (v, def) => {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]/) : null;
  if (!arr) return [...def];
  return arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
};

export function normalizeRules(input = {}) {
  const paths = strList(input.paths, DEFAULT_RULES.paths)
    .map((p) => p.replace(/\/+$/, "") || "/")
    .filter((p) => p.startsWith("/") && !p.split("/").includes(".."));
  return {
    paths: paths.length ? paths : [...DEFAULT_RULES.paths],
    include: strList(input.include, []),
    exclude: input.exclude === undefined ? [...DEFAULT_EXCLUDES] : strList(input.exclude, []),
    intervalSec: clampInt(input.intervalSec, 10, 86400, DEFAULT_RULES.intervalSec),
    minAgeSec: clampInt(input.minAgeSec, 0, 3600, DEFAULT_RULES.minAgeSec),
  };
}

export function normalizeSettings(input = {}, prev = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...prev, ...input };
  const targets = TARGETS.includes(merged.targets) ? merged.targets : "drive";
  let driveDir = String(merged.driveDir || DEFAULT_SETTINGS.driveDir).replace(/\/+$/, "");
  if (!driveDir.startsWith("/") || driveDir.split("/").includes("..")) driveDir = DEFAULT_SETTINGS.driveDir;
  return {
    targets,
    driveDir,
    localRoot: String(merged.localRoot || "").trim(),
    safetyNet: merged.safetyNet !== false,
    batchFiles: clampInt(merged.batchFiles, 1, 500, DEFAULT_SETTINGS.batchFiles),
    batchBytes: clampInt(merged.batchBytes, 1024 * 1024, 64 * 1024 ** 3, DEFAULT_SETTINGS.batchBytes),
    maxFileBytes: clampInt(merged.maxFileBytes, 1024, 256 * 1024 ** 3, DEFAULT_SETTINGS.maxFileBytes),
    retries: clampInt(merged.retries, 0, 8, DEFAULT_SETTINGS.retries),
  };
}

/* ── glob matching (fnmatch-ish: * ? [..], no path separators special) ── */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let body = glob.slice(i + 1, end);
        if (body[0] === "!") body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

function matchesAny(globs, relPath) {
  const segs = relPath.split("/").filter(Boolean);
  const base = segs[segs.length - 1] || "";
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(relPath) || re.test(base) || segs.some((s) => re.test(s));
  });
}

/** Does a file (relative path under a watched root) pass the include/exclude rules? */
export function passesRules(rules, relPath) {
  if (matchesAny(rules.exclude, relPath)) return false;
  if (!rules.include.length) return true;
  const base = relPath.split("/").pop();
  return rules.include.some((g) => {
    const re = globToRegExp(g);
    return re.test(relPath) || re.test(base);
  });
}

/* ── remote scan: ONE ssh python call → [{p, s, m}] + remote now ── */
export function buildScanPython(rules) {
  const cfg = Buffer.from(JSON.stringify({ paths: rules.paths, exclude: rules.exclude, cap: 20000 }), "utf8").toString("base64");
  return [
    "import os, json, base64, time, fnmatch",
    `cfg = json.loads(base64.b64decode('${cfg}').decode('utf-8'))`,
    "ex = cfg['exclude']",
    "def bad(n): return any(fnmatch.fnmatch(n, g) for g in ex)",
    "out = []",
    "trunc = False",
    "for root in cfg['paths']:",
    "  if os.path.isfile(root):",
    "    try:",
    "      st = os.stat(root); out.append({'p': root, 's': st.st_size, 'm': st.st_mtime})",
    "    except OSError: pass",
    "    continue",
    "  for d, dirs, files in os.walk(root, followlinks=False):",
    "    dirs[:] = [x for x in dirs if not bad(x)]",
    "    for f in files:",
    "      if bad(f): continue",
    "      fp = os.path.join(d, f)",
    "      try:",
    "        if os.path.islink(fp): continue",
    "        st = os.stat(fp)",
    "      except OSError: continue",
    "      out.append({'p': fp, 's': st.st_size, 'm': st.st_mtime})",
    "      if len(out) >= cfg['cap']: trunc = True; break",
    "    if trunc: break",
    "print(json.dumps({'scan': True, 'now': time.time(), 'truncated': trunc, 'files': out}))",
  ].join("\n");
}

export async function scanRemote(session, rules, signal) {
  const res = await runRemotePythonSsh(session, buildScanPython(rules), { signal });
  if (!res.ok) return { ok: false, error: res.error || res.stderr || "scan failed" };
  const parsed = parseLastJsonLine(res.stdout, (o) => o && o.scan === true);
  if (!parsed) return { ok: false, error: "could not parse remote scan" };
  const files = parsed.files
    .filter((f) => f && typeof f.p === "string")
    .filter((f) => rules.paths.some((root) => f.p === root || f.p.startsWith(`${root}/`)))
    .map((f) => ({ path: f.p, size: Number(f.s) || 0, mtime: Number(f.m) || 0, rel: relativeTo(rules.paths, f.p) }))
    .filter((f) => passesRules(rules, f.rel));
  return { ok: true, now: Number(parsed.now) || Date.now() / 1000, files, truncated: !!parsed.truncated };
}

export function relativeTo(roots, remotePath) {
  const root = roots.filter((r) => remotePath === r || remotePath.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (!root) return remotePath.replace(/^\/+/, "");
  if (remotePath === root) return path.posix.basename(remotePath);
  // keep the watched root's own name so multiple roots never collide
  return `${path.posix.basename(root) || "root"}/${remotePath.slice(root.length + 1)}`;
}

/**
 * Decide which scanned files need backing up.
 * `manifest` = { [remotePath]: { size, mtime, targets: { drive?:true, local?:true } } }
 * `seen` = { [remotePath]: size } from the previous pass (size-stable check).
 */
export function diffFiles({ files, manifest = {}, seen = {}, now, rules, wanted, maxFileBytes = Infinity }) {
  const pending = [];
  const deferred = [];
  const skipped = [];
  const wantTargets = wanted === "both" ? ["drive", "local"] : [wanted];
  for (const f of files) {
    const prev = manifest[f.path];
    const synced = prev && prev.size === f.size && Math.abs(prev.mtime - f.mtime) < 0.001
      && wantTargets.every((t) => prev.targets && prev.targets[t]);
    if (synced) continue;
    if (f.size > maxFileBytes) { skipped.push({ ...f, reason: "too-large" }); continue; }
    const young = now - f.mtime < rules.minAgeSec;
    const unstable = seen[f.path] !== undefined && seen[f.path] !== f.size;
    if (young || unstable) { deferred.push(f); continue; }
    pending.push(f);
  }
  return { pending, deferred, skipped };
}

export function makeBatches(files, maxFiles, maxBytes) {
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= maxFiles || bytes + f.size > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += f.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/* ── safe local destination ── */
export function sanitizeRelParts(rel) {
  return String(rel)
    .split(/[\\/]+/)
    .map((s) => s.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+$/, "").trim())
    .filter(Boolean);
}

export function validateLocalRoot(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "local folder not set" };
  if (raw.includes("\0")) return { ok: false, error: "invalid path" };
  const resolved = expandHomePath(raw);
  if (!path.isAbsolute(resolved)) return { ok: false, error: "path must be absolute" };
  if (resolved === path.parse(resolved).root) return { ok: false, error: "refusing filesystem root" };
  if (resolved === os.homedir()) return { ok: false, error: "refusing home directory itself; choose a subfolder" };
  return { ok: true, root: resolved };
}

export function resolveLocalDest(root, session, rel) {
  const parts = [...sanitizeRelParts(session || "session"), ...sanitizeRelParts(rel)];
  if (parts.length < 2) return null;
  const dest = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) return null;
  return dest;
}

/* ── retry ── */
export async function withRetry(fn, { retries = 3, baseMs = 1000, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal && signal.aborted) return { ok: false, error: "cancelled" };
    last = await fn(attempt);
    if (last && (last.ok || last.fatal || last.error === "cancelled")) return last;
    if (attempt < retries) await sleep(baseMs * 2 ** attempt);
  }
  return last || { ok: false, error: "failed" };
}

/* ── targets ── */
export function buildDriveCopyPython({ items, destDir }) {
  const cfg = Buffer.from(JSON.stringify({ items, destDir }), "utf8").toString("base64");
  return [
    "import os, shutil, json, base64",
    `cfg = json.loads(base64.b64decode('${cfg}').decode('utf-8'))`,
    "if not os.path.isdir('/content/drive/MyDrive'): print(json.dumps({'drive': True, 'ok': False, 'fatal': 'Google Drive not mounted'})); raise SystemExit(0)",
    "done = []; failed = []",
    "for it in cfg['items']:",
    "  dst = os.path.normpath(os.path.join(cfg['destDir'], it['rel']))",
    "  if not dst.startswith(os.path.normpath(cfg['destDir']) + os.sep): failed.append({'p': it['p'], 'e': 'bad path'}); continue",
    "  try:",
    "    os.makedirs(os.path.dirname(dst), exist_ok=True)",
    "    tmp = dst + '.part'",
    "    shutil.copy2(it['p'], tmp); os.replace(tmp, dst); done.append(it['p'])",
    "  except Exception as e: failed.append({'p': it['p'], 'e': str(e)})",
    "print(json.dumps({'drive': True, 'ok': True, 'done': done, 'failed': failed}))",
  ].join("\n");
}

export function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export async function backupBatchToDrive(session, batch, settings, signal, date = dateStamp()) {
  const destDir = `${settings.driveDir}/${sanitizeRelParts(session).join("_") || "session"}/${date}`;
  const items = batch.map((f) => ({ p: f.path, rel: sanitizeRelParts(f.rel).join("/") }));
  const res = await runRemotePythonSsh(session, buildDriveCopyPython({ items, destDir }), { signal });
  if (!res.ok) return { ok: false, error: res.error || res.stderr || "drive copy failed" };
  const parsed = parseLastJsonLine(res.stdout, (o) => o && o.drive === true);
  if (!parsed) return { ok: false, error: "could not parse drive copy result" };
  if (!parsed.ok) return { ok: false, fatal: true, error: parsed.fatal || "drive copy failed" };
  return { ok: true, done: parsed.done || [], failed: parsed.failed || [], destDir };
}

export async function backupFileToLocal(session, file, root, signal) {
  const dest = resolveLocalDest(root, session, file.rel);
  if (!dest) return { ok: false, error: "unsafe destination" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const real = fs.realpathSync(path.dirname(dest));
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, error: "unsafe destination" };
  const tmp = `${dest}.part`;
  const res = await runAction({ type: "download", session, remote: file.path, local: tmp }, { signal });
  if (!res.ok || !fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: res.error || "download failed" };
  }
  fs.renameSync(tmp, dest);
  return { ok: true, dest };
}

/* ── one backup pass ── */
export async function runBackupPass({ session, rules, settings, manifest, seen, signal, onProgress = () => {}, sleep, force = false }) {
  const started = Date.now();
  const result = { ok: true, session, started, synced: 0, bytes: 0, pending: 0, deferred: 0, skipped: 0, errors: [] };
  const wanted = settings.targets;
  let root = null;
  if (wanted !== "drive") {
    const v = validateLocalRoot(settings.localRoot);
    if (!v.ok) return { ...result, ok: false, errors: [v.error], finished: Date.now() };
    root = v.root;
    fs.mkdirSync(root, { recursive: true });
  }
  const effRules = force ? { ...rules, minAgeSec: 0 } : rules;
  const scan = await withRetry(() => scanRemote(session, effRules, signal), { retries: Math.min(settings.retries, 2), baseMs: 800, signal, sleep });
  if (!scan.ok) return { ...result, ok: false, unreachable: true, errors: [scan.error], finished: Date.now() };

  const { pending, deferred, skipped } = diffFiles({
    files: scan.files, manifest, seen, now: scan.now, rules: effRules, wanted, maxFileBytes: settings.maxFileBytes,
  });
  result.pending = pending.length;
  result.deferred = deferred.length;
  result.skipped = skipped.length;
  result.truncated = scan.truncated;
  result.nextSeen = Object.fromEntries(scan.files.map((f) => [f.path, f.size]));
  for (const s of skipped) result.errors.push(`${s.path}: file exceeds size limit`);
  const mark = (f, target) => {
    const prev = manifest[f.path];
    const same = prev && prev.size === f.size && prev.mtime === f.mtime;
    manifest[f.path] = { size: f.size, mtime: f.mtime, syncedAt: Date.now(), targets: { ...(same ? prev.targets : {}), [target]: true } };
  };
  const total = pending.length;
  let handled = 0;
  const retryOpts = { retries: settings.retries, baseMs: 1000, signal, sleep };
  const aborted = () => signal && signal.aborted;

  const isSyncedTo = (f, target) => {
    const prev = manifest[f.path];
    return Boolean(prev && prev.size === f.size && Math.abs(prev.mtime - f.mtime) < 0.001 && prev.targets && prev.targets[target]);
  };

  for (const batch of makeBatches(pending, settings.batchFiles, settings.batchBytes)) {
    if (aborted()) { result.cancelled = true; break; }
    if (wanted === "drive" || wanted === "both") {
      const driveBatch = batch.filter((f) => !isSyncedTo(f, "drive"));
      if (driveBatch.length) {
        const r = await withRetry(() => backupBatchToDrive(session, driveBatch, settings, signal), retryOpts);
        if (r.ok) {
          const done = new Set(r.done);
          for (const f of driveBatch) if (done.has(f.path)) mark(f, "drive");
          for (const f of r.failed) result.errors.push(`${f.p}: ${f.e}`);
        } else {
          result.errors.push(`drive: ${r.error}`);
        }
      }
    }
    if (wanted === "local" || wanted === "both") {
      for (const f of batch) {
        if (aborted()) { result.cancelled = true; break; }
        if (isSyncedTo(f, "local")) continue;
        const r = await withRetry(() => backupFileToLocal(session, f, root, signal), retryOpts);
        if (r.ok) mark(f, "local");
        else result.errors.push(`${f.path}: ${r.error}`);
      }
    }
    for (const f of batch) {
      if (wanted === "both" ? (isSyncedTo(f, "drive") && isSyncedTo(f, "local")) : isSyncedTo(f, wanted)) {
        result.synced += 1;
        result.bytes += f.size;
      }
    }
    handled += batch.length;
    onProgress({ session, done: handled, total, synced: result.synced });
  }
  result.pending = Math.max(0, total - result.synced) + deferred.length;
  result.ok = result.errors.length === 0 && !result.cancelled;
  result.finished = Date.now();
  return result;
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  DEFAULT_EXCLUDES,
  DEFAULT_RULES,
  backupBatchToDrive,
  backupFileToLocal,
  diffFiles,
  globToRegExp,
  makeBatches,
  normalizeRules,
  normalizeSettings,
  passesRules,
  relativeTo,
  resolveLocalDest,
  runBackupPass,
  sanitizeRelParts,
  validateLocalRoot,
  withRetry,
} from "../src/features/backup/engine.mjs";
import { createBackupController } from "../src/features/backup/index.mjs";
import { readJsonBodySafe, sendJson } from "../src/routes/http.mjs";

function makeMemoryStorage() {
  const data = {};
  return {
    get(k, def = undefined) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : def;
    },
    set(k, v) {
      if (v === undefined) delete data[k];
      else data[k] = v;
      return v;
    },
    all() {
      return { ...data };
    },
  };
}

const FAKE_COLAB_SCRIPT = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0] || "";
const logFile = process.env.FAKE_COLAB_LOG;
const modeFile = process.env.FAKE_COLAB_MODE;
const stateFile = process.env.FAKE_COLAB_STATE;

function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}
if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify({ cmd, argv }) + "\\n");
}
const mode = modeFile ? readJson(modeFile, {}) : {};

if (cmd === "ssh") {
  const raw = argv.join(" ");
  const b64Match = raw.match(/b64decode\\('([^']+)'\\)/);
  const py = b64Match ? Buffer.from(b64Match[1], "base64").toString("utf8") : "";
  const cfgMatch = py.match(/b64decode\\('([^']+)'\\)/);
  const cfg = cfgMatch ? JSON.parse(Buffer.from(cfgMatch[1], "base64").toString("utf8")) : {};

  if (mode.sshFail) {
    process.stderr.write("ssh unreachable\\n");
    process.exit(1);
  }
  if (py.includes("'scan': True")) {
    const files = mode.files || [
      { p: "/content/output/ckpt-1.pt", s: 1024, m: 1000 },
      { p: "/content/output/sub/metrics.json", s: 120, m: 1000 },
      { p: "/content/output/temp.tmp", s: 50, m: 1000 },
      { p: "/content/output/fresh.pt", s: 2048, m: 1995 },
    ];
    process.stdout.write(JSON.stringify({ scan: true, now: mode.now ?? 2000, truncated: false, files }) + "\\n");
    process.exit(0);
  }
  if (py.includes("'drive': True")) {
    if (mode.driveUnmounted) {
      process.stdout.write(JSON.stringify({ drive: true, ok: false, fatal: "Google Drive not mounted" }) + "\\n");
      process.exit(0);
    }
    const items = cfg.items || [];
    const done = items.map((i) => i.p);
    if (stateFile) {
      const prev = readJson(stateFile, { driveCopies: [] });
      prev.driveCopies.push({ destDir: cfg.destDir, items });
      fs.writeFileSync(stateFile, JSON.stringify(prev));
    }
    process.stdout.write(JSON.stringify({ drive: true, ok: true, done, failed: [] }) + "\\n");
    process.exit(0);
  }
  process.stdout.write("ok\\n");
  process.exit(0);
}

if (cmd === "download") {
  // argv: ["download", "-s", session, remote, local]
  const remote = argv[argv.length - 2];
  const local = argv[argv.length - 1];
  const st = stateFile ? readJson(stateFile, { dlAttempts: 0 }) : { dlAttempts: 0 };
  st.dlAttempts = (st.dlAttempts || 0) + 1;
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(st));

  if (mode.downloadFailTimes && st.dlAttempts <= mode.downloadFailTimes) {
    process.stderr.write("transient network error\\n");
    process.exit(1);
  }
  if (mode.downloadFail) {
    process.stderr.write("download failed\\n");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, "CONTENT:" + remote);
  process.stdout.write("downloaded " + remote + "\\n");
  process.exit(0);
}

process.stdout.write("ok\\n");
`;

describe("backup engine pure helpers", () => {
  test("glob matching & watch rules (include/exclude defaults)", () => {
    const rules = normalizeRules({});
    assert.deepEqual(rules.paths, DEFAULT_RULES.paths);
    assert.deepEqual(rules.exclude, DEFAULT_EXCLUDES);

    assert.equal(passesRules(rules, "output/model.pt"), true);
    assert.equal(passesRules(rules, "output/weights.tmp"), false);
    assert.equal(passesRules(rules, "output/__pycache__/a.pyc"), false);
    assert.equal(passesRules(rules, "output/.ipynb_checkpoints/nb.ipynb"), false);

    const incRules = normalizeRules({ include: ["*.pt", "*.json"], exclude: ["*.tmp"] });
    assert.equal(passesRules(incRules, "output/model.pt"), true);
    assert.equal(passesRules(incRules, "output/metrics.json"), true);
    assert.equal(passesRules(incRules, "output/readme.txt"), false);
    assert.equal(globToRegExp("ckpt-[0-9]?.pt").test("ckpt-4a.pt"), true);
  });

  test("relativeTo preserves watched root basename to avoid collisions", () => {
    const roots = ["/content/output", "/content/logs"];
    assert.equal(relativeTo(roots, "/content/output/a/b.pt"), "output/a/b.pt");
    assert.equal(relativeTo(roots, "/content/logs/a/b.pt"), "logs/a/b.pt");
  });

  test("diffFiles skips synced, defers young or size-unstable, skips oversized", () => {
    const rules = normalizeRules({ minAgeSec: 20 });
    const files = [
      { path: "/content/output/synced.pt", rel: "output/synced.pt", size: 100, mtime: 1000 },
      { path: "/content/output/young.pt", rel: "output/young.pt", size: 200, mtime: 1990 },
      { path: "/content/output/growing.pt", rel: "output/growing.pt", size: 500, mtime: 1000 },
      { path: "/content/output/huge.pt", rel: "output/huge.pt", size: 999999, mtime: 1000 },
      { path: "/content/output/ready.pt", rel: "output/ready.pt", size: 300, mtime: 1000 },
    ];
    const manifest = {
      "/content/output/synced.pt": { size: 100, mtime: 1000, targets: { drive: true } },
    };
    const seen = { "/content/output/growing.pt": 400 };
    const { pending, deferred, skipped } = diffFiles({
      files,
      manifest,
      seen,
      now: 2000,
      rules,
      wanted: "drive",
      maxFileBytes: 10000,
    });
    assert.deepEqual(pending.map((f) => f.path), ["/content/output/ready.pt"]);
    assert.deepEqual(deferred.map((f) => f.path), ["/content/output/young.pt", "/content/output/growing.pt"]);
    assert.deepEqual(skipped.map((f) => f.path), ["/content/output/huge.pt"]);
  });

  test("makeBatches respects file count and byte budgets", () => {
    const files = [
      { path: "a", size: 60 },
      { path: "b", size: 60 },
      { path: "c", size: 30 },
      { path: "d", size: 30 },
    ];
    const batches = makeBatches(files, 2, 100);
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map((b) => b.map((x) => x.path)), [["a"], ["b", "c"], ["d"]]);
  });

  test("local path validation & traversal sanitization", () => {
    assert.equal(validateLocalRoot("").ok, false);
    assert.equal(validateLocalRoot("/").ok, false);
    assert.equal(validateLocalRoot(os.homedir()).ok, false);
    assert.equal(validateLocalRoot("/tmp/colab-backups-test").ok, true);

    const root = path.join(os.tmpdir(), "backup-sec-root");
    assert.deepEqual(sanitizeRelParts("../etc/passwd"), ["etc", "passwd"]);
    assert.deepEqual(sanitizeRelParts("a/../../b:c*?.pt"), ["a", "b_c__.pt"]);
    const dest = resolveLocalDest(root, "sess1", "../../evil/file.txt");
    assert.ok(dest && dest.startsWith(path.resolve(root) + path.sep));
    assert.equal(resolveLocalDest(root, "..", ".."), null);
  });

  test("withRetry retries transient errors and stops on fatal or abort", async () => {
    let calls = 0;
    const r1 = await withRetry(async () => {
      calls += 1;
      return calls < 3 ? { ok: false, error: "net" } : { ok: true, v: 42 };
    }, { retries: 3, baseMs: 1, sleep: async () => {} });
    assert.equal(r1.ok, true);
    assert.equal(calls, 3);

    let fatalCalls = 0;
    const r2 = await withRetry(async () => {
      fatalCalls += 1;
      return { ok: false, fatal: true, error: "not mounted" };
    }, { retries: 3, baseMs: 1, sleep: async () => {} });
    assert.equal(r2.ok, false);
    assert.equal(fatalCalls, 1);

    const ac = new AbortController();
    ac.abort();
    const r3 = await withRetry(async () => ({ ok: true }), { signal: ac.signal, sleep: async () => {} });
    assert.equal(r3.error, "cancelled");
  });
});

describe("backup end-to-end with fake colab CLI & temp dir", () => {
  let tmpDir;
  let binDir;
  let localRoot;
  let logFile;
  let modeFile;
  let stateFile;
  let origPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-backup-test-"));
    binDir = path.join(tmpDir, "bin");
    localRoot = path.join(tmpDir, "local-backups");
    logFile = path.join(tmpDir, "colab.log");
    modeFile = path.join(tmpDir, "mode.json");
    stateFile = path.join(tmpDir, "state.json");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeBin = path.join(binDir, "colab");
    fs.writeFileSync(fakeBin, FAKE_COLAB_SCRIPT, { mode: 0o755 });
    origPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
    process.env.FAKE_COLAB_LOG = logFile;
    process.env.FAKE_COLAB_MODE = modeFile;
    process.env.FAKE_COLAB_STATE = stateFile;
  });

  after(() => {
    process.env.PATH = origPath;
    delete process.env.FAKE_COLAB_LOG;
    delete process.env.FAKE_COLAB_MODE;
    delete process.env.FAKE_COLAB_STATE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setMode(obj) {
    fs.writeFileSync(modeFile, JSON.stringify(obj));
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  }

  test("runBackupPass syncs to both Drive and local, skips already-synced on 2nd pass, retries transient download", async () => {
    setMode({ downloadFailTimes: 1 });
    const manifest = {};
    const rules = normalizeRules({ paths: ["/content/output"], minAgeSec: 20 });
    const settings = normalizeSettings({ targets: "both", localRoot, retries: 2 });

    const r1 = await runBackupPass({
      session: "lab-1",
      rules,
      settings,
      manifest,
      seen: {},
      sleep: async () => {},
    });
    assert.equal(r1.ok, true);
    // ckpt-1.pt + sub/metrics.json synced; temp.tmp excluded; fresh.pt deferred (age 5 < 20)
    assert.equal(r1.synced, 2);
    assert.equal(r1.deferred, 1);

    const f1 = path.join(localRoot, "lab-1", "output", "ckpt-1.pt");
    const f2 = path.join(localRoot, "lab-1", "output", "sub", "metrics.json");
    assert.equal(fs.readFileSync(f1, "utf8"), "CONTENT:/content/output/ckpt-1.pt");
    assert.equal(fs.readFileSync(f2, "utf8"), "CONTENT:/content/output/sub/metrics.json");

    const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(st.driveCopies.length, 1);
    assert.equal(st.driveCopies[0].items.length, 2);
    assert.equal(st.dlAttempts, 3); // 1 fail + 1 retry + 1 second file

    // Second pass with same files -> 0 newly synced (incremental skip)
    setMode({});
    const r2 = await runBackupPass({
      session: "lab-1",
      rules,
      settings,
      manifest,
      seen: r1.nextSeen,
      sleep: async () => {},
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.synced, 0);
  });

  test("Drive unmounted surfaces fatal error without hanging", async () => {
    setMode({ driveUnmounted: true });
    const r = await backupBatchToDrive(
      "lab-1",
      [{ path: "/content/output/a.pt", rel: "output/a.pt", size: 10, mtime: 1 }],
      normalizeSettings({ targets: "drive" }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.fatal, true);
    assert.match(r.error, /not mounted/i);
  });

  test("backupFileToLocal rejects symlink escape outside chosen root", async () => {
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const escapeRoot = path.join(tmpDir, "escape-root");
    fs.mkdirSync(path.join(escapeRoot, "lab-x"), { recursive: true });
    fs.symlinkSync(outside, path.join(escapeRoot, "lab-x", "output"));

    setMode({});
    const r = await backupFileToLocal("lab-x", { path: "/content/output/a.pt", rel: "output/a.pt" }, escapeRoot);
    assert.equal(r.ok, false);
    assert.match(r.error, /unsafe/i);
  });

  test("controller guard:state safety net + HTTP routes + cancel", async () => {
    setMode({});
    const bus = new EventEmitter();
    const events = [];
    const storage = makeMemoryStorage();
    const ctrl = createBackupController({
      bus,
      storage: () => storage,
      pushEvent: (type, payload) => events.push({ type, payload }),
      sendJson,
      readJsonBodySafe,
    }, { sleep: async () => {} });
    ctrl.init();
    ctrl.saveSettings({ targets: "local", localRoot, safetyNet: true });

    // Trigger safety net via guard:state recycle warning
    const triggered = ctrl.handleGuardState({
      settings: { warnMinutes: 15 },
      sessions: [{ name: "gpu-a", state: "ok", remainingMinutes: 10 }],
    });
    assert.deepEqual(triggered, ["gpu-a"]);

    // Wait briefly for async safety-net backup pass to complete
    await new Promise((r) => setTimeout(r, 400));
    const snap = ctrl.snapshot();
    assert.equal(snap.sessions["gpu-a"].lastOk, true);
    assert.equal(snap.sessions["gpu-a"].lastTrigger, "safety-net:recycle");
    assert.ok(events.some((e) => e.type === "backup:safety-net"));

    // Cooldown prevents duplicate immediate safety-net trigger
    const second = ctrl.handleGuardState({
      settings: { warnMinutes: 15 },
      sessions: [{ name: "gpu-a", state: "reconnecting", remainingMinutes: 5 }],
    });
    assert.deepEqual(second, []);

    // HTTP route check
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const handled = await ctrl.handleRoutes(req, res, url);
      if (!handled) sendJson(res, 404, { ok: false });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const stRes = await fetch(`${base}/api/backup/state`).then((r) => r.json());
      assert.equal(stRes.ok, true);
      assert.equal(stRes.settings.targets, "local");

      const sessRes = await fetch(`${base}/api/backup/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "gpu-b", enabled: true, rules: { paths: ["/content/output"], intervalSec: 60 } }),
      }).then((r) => r.json());
      assert.equal(sessRes.ok, true);
      assert.equal(sessRes.session.enabled, true);

      const runRes = await fetch(`${base}/api/backup/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "gpu-b" }),
      }).then((r) => r.json());
      assert.equal(runRes.ok, true);
      assert.equal(runRes.synced, 3); // force=true includes fresh.pt too

      const badRes = await fetch(`${base}/api/backup/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: "local", localRoot: "/" }),
      });
      assert.equal(badRes.status, 400);
    } finally {
      ctrl.shutdown();
      server.close();
    }
  });
});

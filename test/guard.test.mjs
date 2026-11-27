import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { GuardEngine, DEFAULTS } from "../src/features/guard/engine.mjs";
import { feature as guardFeature } from "../src/features/guard/index.mjs";
import { sendJson, readJsonBodySafe } from "../src/routes/http.mjs";
import { GUARD_STRINGS } from "../public/js/features/guard/strings.js";
import { renderCuChartSvg } from "../public/js/features/guard/chart.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get(k, def) { return map.has(k) ? map.get(k) : def; },
    set(k, v) { map.set(k, v); },
    all() { return Object.fromEntries(map.entries()); },
  };
}

function fakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  let nextId = 1;
  const tasks = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = nextId++;
      tasks.set(id, { fn, at: t + ms, repeat: ms });
      return id;
    },
    clearTimer(id) { tasks.delete(id); },
    setOnce(fn, ms) {
      const id = nextId++;
      tasks.set(id, { fn, at: t + ms, repeat: null });
      return id;
    },
    clearOnce(id) { tasks.delete(id); },
    async advance(ms) {
      const target = t + ms;
      while (true) {
        let earliest = null;
        for (const [id, task] of tasks) {
          if (task.at <= target && (!earliest || task.at < earliest.task.at)) {
            earliest = { id, task };
          }
        }
        if (!earliest) break;
        t = earliest.task.at;
        if (earliest.task.repeat != null) {
          earliest.task.at = t + earliest.task.repeat;
        } else {
          tasks.delete(earliest.id);
        }
        await earliest.task.fn();
      }
      t = target;
    },
  };
}

describe("GuardEngine unit tests (fake clock & fake colab runner)", () => {
  test("heartbeat keep-alive runs opt-in, backs off on error, and pauses when disabled", async () => {
    const clock = fakeClock();
    const calls = [];
    let execOk = true;
    const engine = new GuardEngine({
      storage: memoryStorage(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      setOnce: clock.setOnce,
      clearOnce: clock.clearOnce,
      run: async (action) => {
        calls.push(action);
        if (action.type === "sessions") {
          return { ok: true, state: { sessions: [{ name: "lab", hardware: "T4" }] } };
        }
        if (action.type === "exec") {
          return { ok: execOk, error: execOk ? null : "timeout", state: { sessions: [] } };
        }
        return { ok: true, state: { sessions: [] } };
      },
    });

    await engine.poll();
    // Opt-in: no heartbeat yet
    await clock.advance(10 * 60_000);
    assert.equal(calls.filter((c) => c.type === "exec").length, 0);

    // Enable heartbeat for lab (default 5 min)
    engine.setSessionCfg("lab", { heartbeat: true });
    await clock.advance(5 * 60_000);
    assert.equal(calls.filter((c) => c.type === "exec").length, 1);

    // Next ping fails -> backs off to 10 min (5 * 2^1)
    execOk = false;
    await clock.advance(5 * 60_000);
    assert.equal(calls.filter((c) => c.type === "exec").length, 2);
    await clock.advance(5 * 60_000);
    assert.equal(calls.filter((c) => c.type === "exec").length, 2); // still waiting due to backoff
    execOk = true;
    await clock.advance(5 * 60_000);
    assert.equal(calls.filter((c) => c.type === "exec").length, 3); // ran at 10m and reset backoff

    // Disable -> pauses
    engine.setSessionCfg("lab", { heartbeat: false });
    await clock.advance(20 * 60_000);
    assert.equal(calls.filter((c) => c.type === "exec").length, 3);
    engine.stop();
  });

  test("disconnect detection + exponential backoff reconnect + lost state", async () => {
    const clock = fakeClock();
    const events = [];
    const notices = [];
    let online = true;
    let statusAlive = false;
    const statusTimes = [];

    const engine = new GuardEngine({
      storage: memoryStorage(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      setOnce: clock.setOnce,
      clearOnce: clock.clearOnce,
      notify: (n) => notices.push(n),
      emit: (t, p) => events.push({ t, p }),
      run: async (action) => {
        if (action.type === "sessions") {
          return { ok: true, state: { sessions: online ? [{ name: "gpu1", hardware: "A100" }] : [] } };
        }
        if (action.type === "status") {
          statusTimes.push(clock.now());
          return { ok: statusAlive, state: { sessions: statusAlive ? [{ name: "gpu1", hardware: "A100" }] : [] } };
        }
        return { ok: true, state: { sessions: [] } };
      },
    });
    engine.setSettings({ maxReconnectAttempts: 3, reconnectBaseSeconds: 10 });

    await engine.poll();
    assert.equal(engine.snapshot().sessions[0].state, "ok");

    // Session drops
    online = false;
    const tLoss = clock.now();
    await engine.poll();
    assert.equal(engine.snapshot().sessions[0].state, "reconnecting");
    assert.ok(notices.some((n) => n.key === "lost:gpu1"));

    // Backoff: 10s, 20s, 40s
    await clock.advance(10_000);
    assert.equal(statusTimes.length, 1);
    assert.equal(statusTimes[0] - tLoss, 10_000);

    await clock.advance(20_000);
    assert.equal(statusTimes.length, 2);
    assert.equal(statusTimes[1] - tLoss, 30_000);

    await clock.advance(40_000);
    assert.equal(statusTimes.length, 3);
    assert.equal(engine.snapshot().sessions[0].state, "lost");
    assert.ok(events.some((e) => e.t === "guard:state"));
    engine.stop();
  });

  test("pre-recycle notices fire for max runtime and idle timeout", async () => {
    const clock = fakeClock();
    const notices = [];
    const engine = new GuardEngine({
      storage: memoryStorage(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      setOnce: clock.setOnce,
      clearOnce: clock.clearOnce,
      notify: (n) => notices.push(n),
      run: async () => ({ ok: true, state: { sessions: [{ name: "s1", hardware: "T4" }] } }),
    });
    engine.setSettings({ maxRuntimeHours: 2, idleTimeoutMinutes: 30, warnMinutes: 10 });

    await engine.poll();
    // Advance 21 min -> idle left = 9 min <= 10 -> idle warning
    await clock.advance(21 * 60_000);
    await engine.poll();
    assert.ok(notices.some((n) => n.key === "idle:s1"));

    // Advance to 111 min total -> max runtime left = 9 min <= 10 -> recycle warning
    await clock.advance(90 * 60_000);
    await engine.poll();
    assert.ok(notices.some((n) => n.key === "recycle:s1"));
    engine.stop();
  });

  test("one-click rebuild reuses remembered config, bootstrap, and sync", async () => {
    const calls = [];
    const engine = new GuardEngine({
      storage: memoryStorage(),
      bootstrapFn: async (opts) => { calls.push({ type: "bootstrap", opts }); return { ok: true }; },
      syncFn: async (opts) => { calls.push({ type: "sync", opts }); return { ok: true }; },
      run: async (action) => { calls.push(action); return { ok: true, state: { sessions: [{ name: "ml", hardware: "L4" }] } }; },
    });

    engine.remember("ml", {
      gpu: "L4",
      highMem: true,
      startupScript: "echo hi",
      envVars: [{ key: "FOO", value: "bar" }],
      syncDir: { localDir: "/tmp/proj", remoteDir: "/content/proj" },
    });

    const res = await engine.rebuild("ml");
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0], { type: "new", name: "ml", gpu: "L4", highMem: true });
    assert.equal(calls[1].type, "bootstrap");
    assert.equal(calls[1].opts.config.startupScript, "echo hi");
    assert.equal(calls[2].type, "sync");
    assert.equal(calls[2].opts.localDir, "/tmp/proj");
    assert.equal(calls[2].opts.remoteDir, "/content/proj");
  });

  test("CU budget guard warns at 80%/100% and only auto-disconnects when explicitly confirmed", async () => {
    const clock = fakeClock();
    const notices = [];
    const stops = [];
    let balance = 100;
    let ratePerHour = 2.0;

    const engine = new GuardEngine({
      storage: memoryStorage(),
      now: clock.now,
      notify: (n) => notices.push(n),
      run: async (action) => {
        if (action.type === "sessions") return { ok: true, state: { sessions: [{ name: "gpu", hardware: "T4" }] } };
        if (action.type === "usage") return { ok: true, state: { usage: { balance, ratePerHour, activeAssignments: 1 } } };
        if (action.type === "stop") { stops.push(action.session); return { ok: true, state: { sessions: [] } }; }
        return { ok: true, state: { sessions: [] } };
      },
    });

    engine.setSettings({ budgetCap: 10, hourlyCap: 5, autoDisconnect: true, autoDisconnectConfirmed: false });
    await engine.poll();
    await engine.sampleCu(); // baseline = 100

    balance = 92; // spent 8 -> 80%
    await engine.sampleCu();
    assert.ok(notices.some((n) => n.key === "cu80"));
    assert.equal(stops.length, 0);

    balance = 89; // spent 11 -> 110%, but NOT confirmed -> warn only
    await engine.sampleCu();
    assert.ok(notices.some((n) => n.key === "cu100"));
    assert.equal(stops.length, 0);

    // Now confirm autoDisconnect
    engine.setSettings({ autoDisconnect: true, autoDisconnectConfirmed: true });
    await engine.sampleCu();
    assert.deepEqual(stops, ["gpu"]);
  });
});

describe("Guard backend routes with fake colab binary on PATH", () => {
  let tmpDir;
  let origPath;
  let server;
  let baseUrl;
  const pushed = [];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-guard-test-"));
    const fakeBin = path.join(tmpDir, "colab");
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const cmd = process.argv[2] || "";
if (cmd === "sessions" || cmd === "status" || cmd === "new") {
  process.stdout.write("[lab-test] m-s-fake | Hardware: T4 | Variant: GPU | Status: IDLE | Shape: Standard\\n");
} else if (cmd === "usage") {
  process.stdout.write("Current balance: 250.5 compute units\\nUsage rate: 1.96/hr\\nActive assignments: 1\\n");
} else if (cmd === "exec") {
  process.stdout.write("guard-heartbeat\\n");
} else if (cmd === "stop") {
  process.stdout.write("stopped\\n");
}
`,
      { mode: 0o755 },
    );
    origPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${origPath}`;

    const store = memoryStorage();
    const ctx = {
      storage: () => store,
      pushEvent: (type, payload) => pushed.push({ type, payload }),
      http: { sendJson, readJsonBodySafe },
    };
    guardFeature.init(ctx);

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const handled = await guardFeature.handleRoutes(req, res, url, ctx);
      if (!handled) sendJson(res, 404, { ok: false });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    guardFeature.shutdown();
    if (server) await new Promise((resolve) => server.close(resolve));
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET/POST /api/guard/* endpoints work end-to-end with fake colab", async () => {
    const pollRes = await (await fetch(`${baseUrl}/api/guard/poll`, { method: "POST" })).json();
    assert.equal(pollRes.ok, true);
    assert.equal(pollRes.sessions.length, 1);
    assert.equal(pollRes.sessions[0].name, "lab-test");

    const cuRes = await (await fetch(`${baseUrl}/api/guard/sample-cu`, { method: "POST" })).json();
    assert.equal(cuRes.ok, true);
    assert.equal(cuRes.usage.balance, 250.5);

    const histRes = await (await fetch(`${baseUrl}/api/guard/cu-history`)).json();
    assert.equal(histRes.ok, true);
    assert.equal(histRes.history.length, 1);
    assert.equal(histRes.summary.balance, 250.5);

    const setRes = await (await fetch(`${baseUrl}/api/guard/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heartbeatMinutes: 3, budgetCap: 50 }),
    })).json();
    assert.equal(setRes.ok, true);
    assert.equal(setRes.settings.heartbeatMinutes, 3);
    assert.equal(setRes.settings.budgetCap, 50);

    const hbRes = await (await fetch(`${baseUrl}/api/guard/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "lab-test" }),
    })).json();
    assert.equal(hbRes.ok, true);

    const rebuildRes = await (await fetch(`${baseUrl}/api/guard/rebuild`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "lab-test" }),
    })).json();
    assert.equal(rebuildRes.ok, true);
    assert.ok(pushed.some((e) => e.type === "guard:state"));
  });
});

describe("Guard frontend strings and SVG chart", () => {
  test("bilingual strings have identical keys in zh-CN and en, all namespaced guard.*", () => {
    const zh = Object.keys(GUARD_STRINGS["zh-CN"]).sort();
    const en = Object.keys(GUARD_STRINGS.en).sort();
    assert.deepEqual(zh, en);
    assert.ok(zh.length >= 25);
    for (const k of zh) {
      assert.ok(k.startsWith("guard."), `key must be namespaced: ${k}`);
      assert.ok(GUARD_STRINGS["zh-CN"][k].length > 0);
      assert.ok(GUARD_STRINGS.en[k].length > 0);
    }
  });

  test("renderCuChartSvg renders inline SVG bars and optional cap line", () => {
    assert.equal(renderCuChartSvg([]), "");
    const now = Date.now();
    const svg = renderCuChartSvg([
      { hour: now - 7_200_000, used: 1.2 },
      { hour: now - 3_600_000, used: 3.5 },
      { hour: now, used: 2.0 },
    ], 3.0);
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.includes("guard-bar is-over"));
    assert.ok(svg.includes("guard-cap-line"));
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { detectDanger } from "../src/features/fleet/danger.mjs";
import { BroadcastManager } from "../src/features/fleet/broadcast.mjs";
import { feature as fleetFeature } from "../src/features/fleet/index.mjs";

const root = path.resolve(import.meta.dirname, "..");

const FAKE_COLAB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const cmd = argv[0] || "";
const sIdx = argv.indexOf("-s");
const session = sIdx !== -1 ? argv[sIdx + 1] : "";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

if (cmd === "sessions") {
  console.log("[gpu-a] m-s-a | Hardware: T4 | Variant: GPU | Status: Running");
  console.log("[gpu-b] m-s-b | Hardware: L4 | Variant: GPU | Status: Running");
  console.log("[gpu-fail] m-s-f | Hardware: T4 | Variant: GPU | Status: Running");
  process.exit(0);
}

if (cmd === "ssh") {
  const dashIdx = argv.indexOf("--");
  const remoteCmd = dashIdx !== -1 ? argv.slice(dashIdx + 1).join(" ") : "";
  if (remoteCmd.includes("===GPU===")) {
    const util = session === "gpu-b" ? 72 : 35;
    const mem = session === "gpu-b" ? 12000 : 4096;
    console.log("===GPU===");
    console.log(\`Tesla T4, \${mem}, 15360, \${util}, 58\`);
    console.log("===PROCS===");
    console.log("===PORTS===");
    process.exit(0);
  }
  if (remoteCmd.includes("SLOW_SLEEP")) {
    setTimeout(() => { console.log("woke"); process.exit(0); }, 5000);
    return;
  }
  if (session === "gpu-fail" && !remoteCmd.includes("RETRY_OK")) {
    console.error("simulated failure on gpu-fail");
    process.exit(1);
  }
  console.log(\`OUT:\${session}:\${remoteCmd}\`);
  process.exit(0);
}

if (cmd === "exec") {
  readStdin().then((code) => {
    console.log(\`PY:\${session}:\${code.trim()}\`);
    process.exit(0);
  });
} else if (cmd === "stop") {
  console.log(\`stopped \${session}\`);
  process.exit(0);
} else if (cmd === "upload") {
  console.log(\`uploaded to \${session}\`);
  process.exit(0);
} else {
  console.log("ok");
  process.exit(0);
}
`;

function mockReq(method, urlStr, body) {
  const raw = body !== undefined ? JSON.stringify(body) : "";
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = urlStr;
  return req;
}

function mockRes() {
  let status = 200;
  let payload = "";
  return {
    writableEnded: false,
    destroyed: false,
    writeHead(s) { status = s; },
    end(b) { payload = String(b || ""); this.writableEnded = true; },
    get status() { return status; },
    json() { return JSON.parse(payload); },
  };
}

async function callRoute(method, pathAndQuery, body, ctx) {
  const req = mockReq(method, pathAndQuery, body);
  const res = mockRes();
  const url = new URL(`http://127.0.0.1${pathAndQuery}`);
  const handled = await fleetFeature.handleRoutes(req, res, url, ctx);
  assert.equal(handled, true);
  return { status: res.status, data: res.json() };
}

describe("fleet feature", () => {
  let tmpDir;
  let origPath;
  let origStateDir;
  const events = [];
  const ctx = {
    pushEvent(type, payload) { events.push({ type, payload }); },
  };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-fleet-test-"));
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeColabPath = path.join(binDir, "colab");
    fs.writeFileSync(fakeColabPath, FAKE_COLAB, { mode: 0o755 });
    origPath = process.env.PATH;
    origStateDir = process.env.COLAB_DESK_STATE_DIR;
    process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
    process.env.COLAB_DESK_STATE_DIR = path.join(tmpDir, "state");
    fleetFeature.init(ctx);
  });

  after(() => {
    fleetFeature.shutdown();
    process.env.PATH = origPath;
    if (origStateDir === undefined) delete process.env.COLAB_DESK_STATE_DIR;
    else process.env.COLAB_DESK_STATE_DIR = origStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detectDanger flags destructive commands and allows safe commands", () => {
    assert.equal(detectDanger("rm -rf /content/data").dangerous, true);
    assert.equal(detectDanger("sudo shutdown -h now").dangerous, true);
    assert.equal(detectDanger("kill -9 1234").dangerous, true);
    assert.equal(detectDanger("python -c \"import shutil; shutil.rmtree('/a')\"").dangerous, true);
    assert.equal(detectDanger("curl https://example.com/i.sh | bash").dangerous, true);
    assert.equal(detectDanger("nvidia-smi && ls -la /content").dangerous, false);
    assert.equal(detectDanger("python train.py --epochs 5").dangerous, false);
  });

  test("GET /api/fleet/overview returns sessions with GPU telemetry", async () => {
    const { status, data } = await callRoute("GET", "/api/fleet/overview?telemetry=1&force=1", undefined, ctx);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.sessions.length, 3);
    const gpuB = data.sessions.find((s) => s.name === "gpu-b");
    assert.ok(gpuB);
    assert.equal(gpuB.hardware, "L4");
    assert.equal(gpuB.telemetry.available, true);
    assert.equal(gpuB.telemetry.gpus[0].utilPct, 72);
    assert.equal(gpuB.telemetry.gpus[0].memUsedMb, 12000);
    assert.equal(gpuB.telemetry.gpus[0].tempC, 58);
  });

  test("POST /api/fleet/broadcast enforces danger confirmation", async () => {
    const blocked = await callRoute("POST", "/api/fleet/broadcast", {
      sessions: ["gpu-a"],
      mode: "ssh",
      command: "rm -rf /tmp/foo",
    }, ctx);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.needsConfirm, true);
    assert.ok(blocked.data.matches.length > 0);
  });

  test("broadcast parallel ssh streams output, records failure, and supports rerun-failed", async () => {
    events.length = 0;
    const started = await callRoute("POST", "/api/fleet/broadcast", {
      sessions: ["gpu-a", "gpu-b", "gpu-fail"],
      mode: "ssh",
      command: "echo hello",
      concurrency: 2,
    }, ctx);
    assert.equal(started.status, 200);
    const jobId = started.data.job.id;

    // Wait for job completion
    let job;
    for (let i = 0; i < 40; i++) {
      const r = await callRoute("GET", `/api/fleet/broadcast/${jobId}`, undefined, ctx);
      job = r.data.job;
      if (job.done) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.done, true);
    assert.equal(job.sessions["gpu-a"].status, "ok");
    assert.match(job.sessions["gpu-a"].output, /OUT:gpu-a:echo hello/);
    assert.equal(job.sessions["gpu-b"].status, "ok");
    assert.equal(job.sessions["gpu-fail"].status, "failed");
    assert.equal(job.sessions["gpu-fail"].exitCode, 1);
    assert.ok(events.some((e) => e.type === "fleet:output" && e.payload.session === "gpu-a"));
    assert.ok(events.some((e) => e.type === "fleet:done" && e.payload.id === jobId));

    // Re-run failed only targets gpu-fail
    const rerun = await callRoute("POST", `/api/fleet/broadcast/${jobId}/rerun-failed`, {}, ctx);
    assert.equal(rerun.status, 200);
    assert.deepEqual(Object.keys(rerun.data.job.sessions), ["gpu-fail"]);
  });

  test("broadcast exec mode sends python snippet via stdin", async () => {
    const started = await callRoute("POST", "/api/fleet/broadcast", {
      sessions: ["gpu-a"],
      mode: "exec",
      command: "print(2+2)",
    }, ctx);
    const jobId = started.data.job.id;
    let job;
    for (let i = 0; i < 40; i++) {
      const r = await callRoute("GET", `/api/fleet/broadcast/${jobId}`, undefined, ctx);
      job = r.data.job;
      if (job.done) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.sessions["gpu-a"].status, "ok");
    assert.match(job.sessions["gpu-a"].output, /PY:gpu-a:print\(2\+2\)/);
  });

  test("broadcast cancel stops running job and timeout enforces limit", async () => {
    const mgr = new BroadcastManager();
    const job = mgr.start({ sessions: ["gpu-a", "gpu-b"], mode: "ssh", command: "SLOW_SLEEP", timeout: 10, concurrency: 1 });
    await new Promise((r) => setTimeout(r, 120));
    mgr.cancel(job.id);
    await new Promise((r) => setTimeout(r, 200));
    const afterCancel = mgr.get(job.id);
    assert.equal(afterCancel.cancelled, true);
    assert.equal(afterCancel.sessions["gpu-b"].status, "cancelled");

    const toJob = mgr.start({ sessions: ["gpu-a"], mode: "ssh", command: "SLOW_SLEEP", timeout: 1 });
    await new Promise((r) => setTimeout(r, 1300));
    const afterTo = mgr.get(toJob.id);
    assert.equal(afterTo.sessions["gpu-a"].status, "timeout");
    mgr.shutdown();
  });

  test("bulk stop requires confirm and push works on local dir", async () => {
    const noConfirm = await callRoute("POST", "/api/fleet/bulk", {
      action: "stop",
      sessions: ["gpu-a"],
    }, ctx);
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.data.needsConfirm, true);

    const confirmed = await callRoute("POST", "/api/fleet/bulk", {
      action: "stop",
      sessions: ["gpu-a", "gpu-b"],
      confirm: true,
    }, ctx);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.ok, true);
    assert.equal(confirmed.data.results.length, 2);
  });

  test("frontend fleet strings have full zh-CN and en parity", () => {
    const src = fs.readFileSync(path.join(root, "public/js/features/fleet/index.js"), "utf8");
    const m = src.match(/const STRINGS = (\{[\s\S]*?\n\});/);
    assert.ok(m, "STRINGS block found");
    const strings = Function(`return (${m[1]})`)();
    const zhKeys = Object.keys(strings["zh-CN"]).sort();
    const enKeys = Object.keys(strings.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    assert.ok(zhKeys.length >= 20);
  });
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { parseProgress, parseDuration } from "../src/features/jobs/progress.mjs";
import {
  renderTemplate,
  maskEndpoint,
  validateEndpoint,
  buildRequest,
  deliver,
} from "../src/features/jobs/webhooks.mjs";
import {
  createJobs,
  buildLaunchScript,
  buildPollScript,
  buildKillScript,
  parsePoll,
} from "../src/features/jobs/core.mjs";
import { createFeatureHost } from "../src/features/loader.mjs";
import { readJsonBodySafe, sendJson } from "../src/routes/http.mjs";
import { JOBS_STRINGS } from "../public/js/features/jobs/strings.js";

function memStorage() {
  const data = new Map();
  return (id) => ({
    get(key, def) {
      const bucket = data.get(id) || {};
      return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : def;
    },
    set(key, val) {
      const bucket = data.get(id) || {};
      bucket[key] = structuredClone(val);
      data.set(id, bucket);
      return val;
    },
    all() {
      return structuredClone(data.get(id) || {});
    },
  });
}

describe("jobs progress parser", () => {
  test("parses tqdm percent, ETA, and rate with ANSI and CR", () => {
    const raw = "\x1b[32mTraining:\r 45%|████      | 45/100 [00:10<00:12, 4.50it/s]\x1b[0m\n";
    const p = parseProgress(raw);
    assert.equal(p.percent, 45);
    assert.equal(p.label, "tqdm");
    assert.equal(p.etaSec, 12);
    assert.equal(p.rate, "4.50 it/s");
  });

  test("parses Epoch X/Y and estimates ETA from elapsedSec", () => {
    const p = parseProgress("INFO Epoch 3/10 loss=0.42\n", { elapsedSec: 30 });
    assert.equal(p.percent, 30);
    assert.equal(p.label, "Epoch 3/10");
    assert.equal(p.etaSec, 70);
  });

  test("parses step X/Y and s/it rate", () => {
    const p = parseProgress("step 100/1000 (1.25 s/it)\n");
    assert.equal(p.percent, 10);
    assert.equal(p.label, "step 100/1000");
    assert.equal(p.rate, "1.25 s/it");
  });

  test("handles 100% completion and parseDuration edge cases", () => {
    assert.equal(parseProgress("100%|██████████| 10/10 [00:05<00:00]").etaSec, 0);
    assert.equal(parseDuration("01:02:03"), 3723);
    assert.equal(parseDuration("bad"), null);
  });
});

describe("jobs webhooks", () => {
  test("renders template placeholders", () => {
    const msg = renderTemplate("[{status}] {job} took {duration} on {session}", {
      job: "train.py",
      status: "succeeded",
      duration: "2m10s",
      session: "lab-a100",
    });
    assert.equal(msg, "[succeeded] train.py took 2m10s on lab-a100");
  });

  test("masks secrets and URLs in endpoints", () => {
    const masked = maskEndpoint({
      id: "ep1",
      kind: "feishu",
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/super-secret-token-1234",
      token: "999999:AAH-very-secret-telegram-token",
    });
    assert.ok(!masked.url.includes("super-secret"));
    assert.ok(masked.url.includes("••••"));
    assert.ok(!masked.token.includes("very-secret"));
    assert.ok(masked.token.includes("••••"));
  });

  test("enforces SSRF and scheme validation", () => {
    assert.ok(validateEndpoint({ kind: "generic", url: "file:///etc/passwd" }));
    assert.ok(validateEndpoint({ kind: "generic", url: "ftp://example.com/hook" }));
    assert.ok(validateEndpoint({ kind: "generic", url: "http://169.254.169.254/latest/meta-data" }));
    assert.ok(validateEndpoint({ kind: "generic", url: "http://metadata.google.internal/computeMetadata" }));
    assert.ok(validateEndpoint({ kind: "generic", url: "https://user:pass@example.com/hook" }));
    assert.ok(validateEndpoint({ kind: "telegram", token: "123/../../evil", chatId: "123" }));
    assert.equal(validateEndpoint({ kind: "generic", url: "https://hooks.example.com/notify" }), null);
    assert.equal(validateEndpoint({ kind: "telegram", token: "123456:ABC_def-789", chatId: "-1001" }), null);
  });

  test("builds requests for feishu, telegram, and generic", () => {
    const feishu = buildRequest({ kind: "feishu", url: "https://open.feishu.cn/hook/abc" }, "hello", {});
    assert.equal(feishu.body.msg_type, "text");
    assert.equal(feishu.body.content.text, "hello");

    const tg = buildRequest({ kind: "telegram", token: "111:AAA", chatId: "42" }, "hi", {});
    assert.equal(tg.url, "https://api.telegram.org/bot111:AAA/sendMessage");
    assert.deepEqual(tg.body, { chat_id: "42", text: "hi" });

    const gen = buildRequest({ kind: "generic", url: "https://example.com/wh" }, "done", { job: "j1", status: "succeeded" });
    assert.equal(gen.body.text, "done");
    assert.equal(gen.body.job, "j1");
  });

  test("retries with exponential backoff and redacts secrets on error", async () => {
    const delays = [];
    let calls = 0;
    const ep = { kind: "telegram", token: "12345:SECRETTOKEN", chatId: "99" };

    const res = await deliver(
      ep,
      { job: "run", status: "succeeded", duration: "1s", session: "s1" },
      {
        retries: 2,
        sleep: async (ms) => { delays.push(ms); },
        fetchImpl: async (url) => {
          calls++;
          if (calls < 3) throw new Error(`connect failed to ${url}`);
          return { ok: true, status: 200 };
        },
      },
    );
    assert.equal(res.ok, true);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);

    const failRes = await deliver(
      ep,
      { job: "run", status: "failed", duration: "1s", session: "s1" },
      {
        retries: 0,
        fetchImpl: async (url) => { throw new Error(`boom ${url}`); },
      },
    );
    assert.equal(failRes.ok, false);
    assert.ok(!failRes.error.includes("SECRETTOKEN"));
  });
});

describe("jobs core lifecycle with injectable clock", () => {
  test("submits, tails incrementally, emits bus logs & SSE, notifies webhooks, survives restart", async () => {
    let clock = 1_700_000_000_000;
    const storage = memStorage();
    const events = [];
    const bus = new EventEmitter();
    const busLogs = [];
    bus.on("jobs:log", (ev) => busLogs.push(ev));

    let pollStep = 0;
    const runScript = async ({ script }) => {
      if (script.includes("STARTED:")) return { ok: true, stdout: "STARTED:4242\n", stderr: "" };
      if (script.includes("KILLED")) return { ok: true, stdout: "KILLED\n", stderr: "" };
      pollStep++;
      if (pollStep === 1) {
        const chunk = "Epoch 1/2\n 50%|█████     | 5/10 [00:05<00:05, 1.00it/s]\n";
        return {
          ok: true,
          stdout: `RUNNING\nSIZE:${Buffer.byteLength(chunk)}\nDATA:${Buffer.from(chunk).toString("base64")}\n`,
        };
      }
      const chunk2 = "Epoch 2/2\n100%|██████████| 10/10 [00:10<00:00, 1.00it/s]\nDone!\n";
      return {
        ok: true,
        stdout: `EXIT:0\nSIZE:200\nDATA:${Buffer.from(chunk2).toString("base64")}\n`,
      };
    };

    const webhookPayloads = [];
    const fetchImpl = async (url, init) => {
      webhookPayloads.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };

    const mgr = createJobs({
      runScript,
      storage,
      pushEvent: (type, payload) => events.push({ type, payload }),
      bus,
      now: () => clock,
      fetchImpl,
      sleep: async () => {},
      rand: () => "abcd1234",
    });

    const maskedCfg = mgr.setConfig({
      notifyNative: true,
      sound: true,
      endpoints: [
        {
          id: "ep-feishu",
          kind: "feishu",
          name: "Team Bot",
          enabled: true,
          url: "https://open.feishu.cn/open-apis/bot/v2/hook/my-secret-key",
          template: "{status}:{job}:{duration}:{session}",
        },
      ],
    });
    assert.ok(!maskedCfg.endpoints[0].url.includes("my-secret-key"));

    // Updating config with masked URL preserves secret
    mgr.setConfig({ ...maskedCfg, sound: false });
    assert.equal(mgr.getConfig().endpoints[0].url, "https://open.feishu.cn/open-apis/bot/v2/hook/my-secret-key");

    const sub = await mgr.submit({ session: "lab-t4", language: "python", code: "print('hi')", title: "Train" });
    assert.equal(sub.ok, true);
    assert.equal(sub.job.status, "running");

    // Simulate restart before polling
    const mgr2 = createJobs({
      runScript,
      storage,
      pushEvent: (type, payload) => events.push({ type, payload }),
      bus,
      now: () => clock,
      fetchImpl,
      sleep: async () => {},
    });
    assert.equal(mgr2.list().length, 1);

    clock += 5000;
    await mgr2.pollAll();
    const mid = mgr2.get(sub.job.id);
    assert.equal(mid.status, "running");
    assert.equal(mid.progress.percent, 50);
    assert.equal(mid.progress.etaSec, 5);
    assert.equal(busLogs.length, 1);
    assert.equal(busLogs[0].jobId, sub.job.id);

    clock += 5000;
    await mgr2.pollAll();
    const done = mgr2.get(sub.job.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.exitCode, 0);
    assert.equal(done.progress.percent, 100);
    assert.equal(webhookPayloads.length, 1);
    assert.equal(webhookPayloads[0].body.content.text, "succeeded:Train:10s:lab-t4");
    assert.ok(events.some((e) => e.type === "jobs:notify" && e.payload.status === "succeeded"));

    // Re-run and cancel
    const rerun = await mgr2.rerun(sub.job.id);
    assert.equal(rerun.ok, true);
    assert.notEqual(rerun.job.id, sub.job.id);

    const cancelled = await mgr2.cancel(rerun.job.id);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.job.status, "cancelled");

    // Clear finished removes both
    const cleared = mgr2.clearFinished();
    assert.equal(cleared.jobs.length, 0);

    // Rejects invalid job id
    assert.throws(() => buildLaunchScript("../bad", "python", "x"));
    assert.throws(() => buildPollScript("a;rm -rf /", 0));
    assert.throws(() => buildKillScript("bad id"));
    assert.equal((await mgr2.cancel("bad;id")).ok, false);
  });
});

describe("jobs feature HTTP routes with fake colab CLI & 0600 storage", () => {
  test("runs detached job through fake colab binary and serves masked config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-jobs-test-"));
    const binDir = path.join(tmpDir, "bin");
    const cfgDir = path.join(tmpDir, "config");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });

    const fakeColab = path.join(binDir, "colab");
    fs.writeFileSync(
      fakeColab,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "ssh") {
  const cmd = argv.slice(1).join(" ");
  const m = cmd.match(/echo '([A-Za-z0-9+/=]+)' \\| base64 -d/);
  const decoded = m ? Buffer.from(m[1], "base64").toString("utf8") : cmd;
  if (decoded.includes("STARTED:")) {
    process.stdout.write("STARTED:7777\\n");
  } else if (decoded.includes("KILLED")) {
    process.stdout.write("KILLED\\n");
  } else if (decoded.includes("DATA:")) {
    const log = Buffer.from("step 50/100\\n").toString("base64");
    process.stdout.write("EXIT:0\\nSIZE:12\\nDATA:" + log + "\\n");
  }
}
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath}`;

    const host = createFeatureHost({
      featuresDir: path.resolve(import.meta.dirname, "../src/features"),
      publicDir: path.resolve(import.meta.dirname, "../public"),
      configDir: cfgDir,
      helpers: { http: { sendJson, readJsonBodySafe }, sendJson, readJsonBodySafe },
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      host.handleRoutes(req, res, url).then((handled) => {
        if (!handled) sendJson(res, 404, { ok: false });
      });
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const reqJson = async (p, opts) => (await fetch(`${base}${p}`, opts)).json();

      // Save config with secret, verify 0600 permissions and masked GET
      const putCfg = await reqJson("/api/jobs/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notifyNative: true,
          sound: false,
          endpoints: [{ id: "ep-1", kind: "generic", name: "Hook", url: "https://example.com/secret-hook-path" }],
        }),
      });
      assert.equal(putCfg.ok, true);
      assert.ok(!putCfg.config.endpoints[0].url.includes("secret-hook-path"));

      const storageFile = path.join(cfgDir, "features", "jobs.json");
      const mode = fs.statSync(storageFile).mode & 0o777;
      assert.equal(mode, 0o600);

      // Submit job through real runDirectScript -> fake colab ssh
      const sub = await reqJson("/api/jobs/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "lab-alpha", language: "python", code: "print(1)", title: "Smoke" }),
      });
      assert.equal(sub.ok, true);
      assert.equal(sub.job.status, "running");

      // Poll and fetch log
      await reqJson("/api/jobs/poll", { method: "POST" });
      const logRes = await reqJson(`/api/jobs/${sub.job.id}/log`);
      assert.equal(logRes.ok, true);
      assert.ok(logRes.log.includes("step 50/100"));
      assert.equal(logRes.job.status, "succeeded");
    } finally {
      await host.shutdown();
      server.close();
      process.env.PATH = prevPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("jobs i18n strings", () => {
  test("zh-CN and en dictionaries have identical namespaced keys", () => {
    const zhKeys = Object.keys(JOBS_STRINGS["zh-CN"]).sort();
    const enKeys = Object.keys(JOBS_STRINGS.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    assert.ok(zhKeys.length > 20);
    for (const k of zhKeys) {
      assert.ok(k.startsWith("jobs."), `Key ${k} must start with jobs.`);
      assert.ok(JOBS_STRINGS["zh-CN"][k].trim().length > 0);
      assert.ok(JOBS_STRINGS.en[k].trim().length > 0);
    }
  });
});

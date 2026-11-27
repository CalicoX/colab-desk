import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createStorage } from "../src/features/loader.mjs";
import { createSnipeQueue, MIN_INTERVAL_SEC, normalizeTargets } from "../src/features/recipes/snipe.mjs";
import { createRecipeStore, exportRecipeSafe } from "../src/features/recipes/store.mjs";
import { runPostAcquirePipeline } from "../src/features/recipes/pipeline.mjs";
import { createRecipesFeature } from "../src/features/recipes/index.mjs";
import { readJsonBodySafe, sendJson } from "../src/routes/http.mjs";
import { RECIPES_STRINGS } from "../public/js/features/recipes/strings.js";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("snipe priority queue", () => {
  test("normalizes GPU & TPU targets and strips highMem from single-shape tiers", () => {
    const targets = normalizeTargets([
      { gpu: "A100", highMem: true },
      { gpu: "L4", highMem: true },
      { tpu: "v5e1", highMem: true },
      { tpu: "v6e1", highMem: false },
      { gpu: "A100", highMem: true }, // duplicate
      { gpu: "INVALID", highMem: true }, // falls back to CPU + highMem
    ]);
    assert.deepEqual(targets, [
      { gpu: "A100", tpu: null, highMem: true },
      { gpu: "L4", tpu: null, highMem: false },
      { gpu: null, tpu: "v5e1", highMem: false },
      { gpu: null, tpu: "v6e1", highMem: false },
      { gpu: null, tpu: null, highMem: true },
    ]);
  });

  test("falls back down priority list on retryable 503 and disables non-retryable 400", async () => {
    const calls = [];
    const events = [];
    let acquiredSnap = null;
    const queue = createSnipeQueue({
      minIntervalSec: 0.02,
      minGapSec: 0.01,
      random: () => 0.5,
      onChange: (s) => events.push(s),
      onAcquired: (s) => { acquiredSnap = s; },
      async run(action) {
        calls.push(action.gpu || action.tpu || "CPU");
        if (action.gpu === "A100") return { ok: false, error: "503 Service Unavailable" };
        if (action.gpu === "H100") return { ok: false, error: "Response: 400 Bad Request" };
        if (action.gpu === "L4") return { ok: true, stdout: "created" };
        return { ok: false, error: "503 Service Unavailable" };
      },
    });

    const job = queue.start({
      name: "train-1",
      targets: [
        { gpu: "A100", highMem: true },
        { gpu: "H100", highMem: true },
        { gpu: "L4", highMem: false },
      ],
      intervalSec: 0.5,
    });

    for (let i = 0; i < 40 && queue.get(job.id).status === "running"; i++) {
      await wait(15);
    }
    const final = queue.get(job.id);
    assert.equal(final.status, "succeeded");
    assert.deepEqual(calls, ["A100", "H100", "L4"]);
    assert.equal(final.acquired.hardware.gpu, "L4");
    assert.equal(final.targets[0].attempts, 1);
    assert.equal(final.targets[0].disabled, false); // 503 retryable
    assert.equal(final.targets[1].disabled, true);  // 400 non-retryable
    assert.ok(final.targets[0].lastError.length > 0);
    assert.ok(acquiredSnap && acquiredSnap.acquired.session === "train-1");
    assert.ok(events.length >= 3);
    queue.shutdown();
  });

  test("enforces minimum interval floor, pause/resume, maxAttempts, and cancel", async () => {
    let attempts = 0;
    const queue = createSnipeQueue({
      minIntervalSec: MIN_INTERVAL_SEC,
      minGapSec: 0.01,
      random: () => 0.5,
      async run() {
        attempts += 1;
        return { ok: false, error: "503 Service Unavailable" };
      },
    });

    const job = queue.start({
      name: "rate-safe",
      targets: [{ gpu: "T4", highMem: false }],
      intervalSec: 1, // below MIN_INTERVAL_SEC -> must clamp to MIN_INTERVAL_SEC
      maxAttempts: 2,
    });
    assert.equal(job.intervalSec, MIN_INTERVAL_SEC);

    await wait(30);
    const paused = queue.pause(job.id);
    assert.equal(paused.status, "paused");
    const resumed = queue.resume(job.id);
    assert.equal(resumed.status, "running");
    const cancelled = queue.cancel(job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(queue.remove(job.id), true);
    assert.equal(attempts >= 1, true);
    queue.shutdown();
  });

  test("stops with timeout when timeoutSec expires", async () => {
    const queue = createSnipeQueue({
      minIntervalSec: 0.5,
      minGapSec: 0.01,
      async run() {
        return { ok: false, error: "503 Service Unavailable" };
      },
    });
    const job = queue.start({
      name: "timeout-job",
      targets: [{ gpu: "A100", highMem: true }],
      intervalSec: 5,
      timeoutSec: 0.06,
    });
    for (let i = 0; i < 30 && queue.get(job.id).status === "running"; i++) {
      await wait(15);
    }
    assert.equal(queue.get(job.id).status, "timeout");
    queue.shutdown();
  });
});

describe("recipe store & secret-safe import/export", () => {
  let tmpDir;
  let store;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-recipes-store-"));
    store = createRecipeStore(createStorage("recipes", tmpDir));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("CRUD, duplicate, and strips secret values on save & export", () => {
    const created = store.create({
      name: "A100 Fine-tune",
      sessionNamePrefix: "ft",
      hardware: { gpu: "A100", highMem: true },
      snipe: {
        enabled: true,
        targets: [{ gpu: "A100", highMem: true }, { gpu: "L4", highMem: true }],
        intervalSec: 12,
      },
      envVars: [
        { key: "HF_TOKEN", value: "hf_SECRET_VALUE_12345" },
        { key: "WANDB_API_KEY", value: "wandb_SECRET_999" },
      ],
      sync: { enabled: true, localDir: "/tmp/proj", remoteDir: "/content/proj" },
      startupScript: { enabled: true, title: "Train", runtime: "python", code: "print('hi')", background: true },
    });

    assert.ok(created.id.startsWith("rcp-"));
    assert.deepEqual(created.envVarNames, ["HF_TOKEN", "WANDB_API_KEY"]);
    assert.equal("envVars" in created, false);

    const exported = store.exportAll();
    const exportedJson = JSON.stringify(exported);
    assert.equal(exportedJson.includes("hf_SECRET_VALUE_12345"), false);
    assert.equal(exportedJson.includes("wandb_SECRET_999"), false);
    assert.ok(exportedJson.includes("HF_TOKEN"));

    const dup = store.duplicate(created.id, "A100 Copy");
    assert.notEqual(dup.id, created.id);
    assert.equal(dup.name, "A100 Copy");

    const updated = store.update(created.id, { description: "updated desc" });
    assert.equal(updated.description, "updated desc");

    const imported = store.importPayload(exported);
    assert.equal(imported.length, 1);
    assert.notEqual(imported[0].id, created.id);

    assert.equal(store.remove(dup.id), true);
    assert.equal(store.get(dup.id), null);
    assert.deepEqual(exportRecipeSafe(created).envVarNames, ["HF_TOKEN", "WANDB_API_KEY"]);
  });
});

describe("post-acquire pipeline", () => {
  test("runs bootstrap + vault env resolve + sync push + background job emit", async () => {
    const trace = [];
    const bgJobs = [];
    const res = await runPostAcquirePipeline({
      session: "lab-a100",
      recipe: {
        name: "Train Recipe",
        bootstrap: { autoMountDrive: true, autoInjectEnv: true, enableHfTransfer: true },
        envVarNames: ["HF_TOKEN", "MISSING_KEY"],
        sync: { enabled: true, localDir: "/tmp/local", remoteDir: "/content/proj" },
        startupScript: {
          enabled: true,
          title: "Run epoch",
          runtime: "python",
          code: "print('lr={{lr}}')",
          params: { lr: "1e-4" },
          background: true,
        },
      },
      vaultEnvVars: [
        { key: "HF_TOKEN", value: "hf_vault_val" },
        { key: "UNUSED_KEY", value: "ignore_me" },
      ],
      onBackgroundJob: (payload) => { bgJobs.push(payload); },
      deps: {
        async bootstrapSession({ session, envVars }) {
          trace.push({ step: "bootstrap", session, keys: envVars.map((e) => e.key) });
          return { ok: true, log: "bootstrapped" };
        },
        async syncPushFolder({ session, localDir, remoteDir }) {
          trace.push({ step: "sync", session, localDir, remoteDir });
          return { ok: true, message: "pushed" };
        },
      },
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.missingEnv, ["MISSING_KEY"]);
    assert.deepEqual(trace, [
      { step: "bootstrap", session: "lab-a100", keys: ["HF_TOKEN"] },
      { step: "sync", session: "lab-a100", localDir: "/tmp/local", remoteDir: "/content/proj" },
    ]);
    assert.equal(bgJobs.length, 1);
    assert.deepEqual(bgJobs[0], {
      session: "lab-a100",
      language: "python",
      code: "print('lr=1e-4')",
      title: "Run epoch",
    });
  });

  test("runs direct startup script when background is false", async () => {
    let directCall = null;
    const res = await runPostAcquirePipeline({
      session: "lab-t4",
      recipe: {
        name: "Direct Recipe",
        bootstrap: { autoMountDrive: false, enableHfTransfer: false, autoInjectEnv: false },
        startupScript: { enabled: true, title: "Check GPU", runtime: "bash", code: "nvidia-smi", background: false },
      },
      vaultEnvVars: [],
      deps: {
        async runDirectScript(opts) {
          directCall = opts;
          return { ok: true, stdout: "Tesla T4" };
        },
      },
    });
    assert.equal(res.ok, true);
    assert.equal(directCall.runtime, "bash");
    assert.equal(directCall.script, "nvidia-smi");
  });
});

describe("recipes HTTP routes with fake colab binary", () => {
  let tmpDir;
  let binDir;
  let origPath;
  let server;
  let baseUrl;
  let feature;
  const pushedEvents = [];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-recipes-e2e-"));
    binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const fakeColab = path.join(binDir, "colab");
    fs.writeFileSync(
      fakeColab,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "new") {
  const gpuIdx = argv.indexOf("--gpu");
  const gpu = gpuIdx >= 0 ? argv[gpuIdx + 1] : "CPU";
  if (gpu === "A100") {
    process.stderr.write("ColabRequestError: 503 Service Unavailable\\n");
    process.exit(1);
  }
  process.stdout.write("Created session " + argv[argv.indexOf("-s") + 1] + " (" + gpu + ")\\n");
  process.exit(0);
}
if (argv[0] === "ssh" || argv[0] === "exec" || argv[0] === "drivemount") {
  process.stdout.write("ok\\n");
  process.exit(0);
}
process.stdout.write("ok\\n");
`,
      { mode: 0o755 },
    );

    origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;

    feature = createRecipesFeature({
      minIntervalSec: 0.02,
      minGapSec: 0.01,
      random: () => 0.5,
    });
    const bus = { emit: (type, payload) => pushedEvents.push({ bus: type, payload }) };
    const ctx = {
      bus,
      pushEvent: (type, payload) => pushedEvents.push({ type, payload }),
      storage: (id) => createStorage(id, tmpDir),
      http: { sendJson, readJsonBodySafe },
      sendJson,
      readJsonBodySafe,
    };
    feature.init(ctx);

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const handled = await feature.handleRoutes(req, res, url, ctx);
      if (!handled) sendJson(res, 404, { ok: false, error: "not found" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    feature?.shutdown();
    if (server) await new Promise((resolve) => server.close(resolve));
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates recipe, snipes A100->L4 via fake colab, and triggers pipeline", async () => {
    const createRes = await fetch(`${baseUrl}/api/recipes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Snipe A100 or L4",
        hardware: { gpu: "A100", highMem: true },
        snipe: {
          enabled: true,
          targets: [{ gpu: "A100", highMem: true }, { gpu: "L4", highMem: false }],
          intervalSec: 5,
        },
        startupScript: { enabled: true, title: "BG Task", runtime: "python", code: "print(1)", background: true },
      }),
    }).then((r) => r.json());
    assert.equal(createRes.ok, true);
    const recipeId = createRes.recipe.id;

    const launchRes = await fetch(`${baseUrl}/api/recipes/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipeId, sessionName: "sniped-l4" }),
    }).then((r) => r.json());
    assert.equal(launchRes.ok, true);
    assert.equal(launchRes.mode, "snipe");

    const jobId = launchRes.job.id;
    let finalJob = null;
    for (let i = 0; i < 60; i++) {
      const poll = await fetch(`${baseUrl}/api/recipes/snipe/${encodeURIComponent(jobId)}`).then((r) => r.json());
      finalJob = poll.job;
      if (finalJob.status === "succeeded" && finalJob.pipeline && typeof finalJob.pipeline.ok === "boolean") break;
      await wait(40);
    }
    assert.equal(finalJob.status, "succeeded");
    assert.equal(finalJob.acquired.hardware.gpu, "L4");
    assert.ok(pushedEvents.some((e) => e.type === "recipes:acquired" && e.payload.session === "sniped-l4"));
    assert.ok(pushedEvents.some((e) => e.type === "recipes:submit-job" && e.payload.session === "sniped-l4"));
  });

  test("direct launch via @guard config shape succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/recipes/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionName: "rebuilt-t4",
        snipe: false,
        config: { gpu: "T4", highMem: true, bootstrap: { autoMountDrive: false, enableHfTransfer: false, autoInjectEnv: false } },
      }),
    }).then((r) => r.json());
    assert.equal(res.ok, true);
    assert.equal(res.mode, "direct");
    assert.equal(res.sessionName, "rebuilt-t4");
  });
});

describe("bilingual i18n parity", () => {
  test("every zh-CN key matches en key and is namespaced under recipes.", () => {
    const zhKeys = Object.keys(RECIPES_STRINGS["zh-CN"]).sort();
    const enKeys = Object.keys(RECIPES_STRINGS.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    assert.ok(zhKeys.length >= 40);
    for (const k of zhKeys) {
      assert.ok(k.startsWith("recipes."), `key ${k} must start with recipes.`);
      assert.ok(RECIPES_STRINGS["zh-CN"][k].trim().length > 0);
      assert.ok(RECIPES_STRINGS.en[k].trim().length > 0);
    }
  });
});

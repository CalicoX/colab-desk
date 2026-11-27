import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, test } from "node:test";
import { redactSecrets, sanitizeText, stripAnsi } from "../src/features/search/redact.mjs";
import { SearchIndex } from "../src/features/search/indexer.mjs";
import { feature as searchFeature } from "../src/features/search/index.mjs";

const root = path.resolve(import.meta.dirname, "..");

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

function createMemStorage() {
  const map = new Map();
  return () => ({
    get(k, def) { return map.has(k) ? map.get(k) : def; },
    set(k, v) { map.set(k, v); },
    all() { return Object.fromEntries(map); },
  });
}

describe("search feature", () => {
  afterEach(() => {
    searchFeature.shutdown();
  });

  test("redactSecrets masks tokens, API keys, webhooks and strips ANSI", () => {
    const sample = [
      "\x1b[32mOK\x1b[0m",
      "export HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz1234",
      "OPENAI_API_KEY=sk-proj-1234567890abcdefABCDEF",
      "ghp_1234567890abcdefghijklmnop",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXX",
    ].join("\n");

    const clean = sanitizeText(sample);
    assert.equal(stripAnsi("\x1b[31mERR\x1b[0m"), "ERR");
    assert.ok(!clean.includes("hf_abcdefghijklmnopqrstuvwxyz1234"));
    assert.ok(!clean.includes("sk-proj-1234567890abcdefABCDEF"));
    assert.ok(!clean.includes("ghp_1234567890abcdefghijklmnop"));
    assert.ok(!clean.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert.ok(!clean.includes("T00000000/B00000000"));
    assert.match(clean, /\[REDACTED/);
    assert.ok(redactSecrets("normal training loss=0.42").includes("loss=0.42"));
  });

  test("SearchIndex ranks matches, computes valid highlight spans, supports CJK and persistence", () => {
    const storeFactory = createMemStorage();
    const storage = storeFactory("search");
    const idx = new SearchIndex({ storage });

    idx.upsert({
      id: "doc-1",
      scope: "chat",
      session: "lab-a",
      title: "CUDA Out of Memory debugging",
      text: "Hit CUDA out of memory when batch_size=64 on T4 GPU. Reduced batch size to 16.",
      timestamp: Date.now() - 1000,
      target: { type: "thread", threadId: "t1", session: "lab-a" },
    });
    idx.upsert({
      id: "doc-2",
      scope: "terminal",
      session: "lab-b",
      title: "colab: lab-b",
      text: "Epoch 3 loss=0.18 显存占用正常，训练完成",
      timestamp: Date.now(),
      target: { type: "terminal", terminalId: "term-1", session: "lab-b" },
    });

    const res = idx.search({ q: "CUDA out of memory" });
    assert.equal(res.total, 1);
    assert.equal(res.results[0].id, "doc-1");
    assert.ok(res.results[0].highlights.length > 0);
    for (const h of res.results[0].highlights) {
      assert.ok(h.start >= 0 && h.end > h.start && h.end <= res.results[0].snippet.length);
    }

    // CJK search
    const cjk = idx.search({ q: "显存占用" });
    assert.equal(cjk.total, 1);
    assert.equal(cjk.results[0].id, "doc-2");

    // Persistence round-trip
    idx.persistNow();
    const idx2 = new SearchIndex({ storage });
    assert.equal(idx2.loadPersisted(), 2);
    assert.equal(idx2.search({ q: "batch_size" }).total, 1);
  });

  test("GET /api/search indexes store history, terminal scrollback, and bus jobs:log with redaction", async () => {
    const bus = new EventEmitter();
    const fakeTerminals = {
      sessions: new Map([
        ["term-9", {
          id: "term-9",
          session: "gpu-a",
          title: "colab: gpu-a",
          createdAt: Date.now(),
          scrollback: [
            Buffer.from("\x1b[33mDownloading model...\x1b[0m\n"),
            Buffer.from("HF_TOKEN=hf_SecretTokenValue1234567890\nCheckpoint saved at step 500\n"),
          ],
        }],
      ]),
    };

    const ctx = {
      bus,
      terminals: fakeTerminals,
      storage: createMemStorage(),
      storeData: {
        history: {
          "thread:thr-1": [
            { id: "e1", kind: "agent", prompt: "Fix PyTorch dataloader", reply: "Set num_workers=2 for Colab VM", timestamp: Date.now() - 5000 },
          ],
          "gpu-a": [
            { id: "e2", kind: "exec", command: "python eval.py", stdout: "Validation accuracy: 94.2%", timestamp: Date.now() - 2000 },
          ],
        },
        settings: {
          chatThreads: [{ id: "thr-1", title: "PyTorch Dataloader", session: "gpu-a", updatedAt: Date.now() }],
        },
      },
    };

    searchFeature.init(ctx);

    // Emit jobs:log on ctx.bus
    bus.emit("jobs:log", {
      jobId: "job-42",
      name: "LoRA fine-tune",
      session: "gpu-b",
      text: "step 100 loss=0.312 wandb key sk-ant-secretkey1234567890",
      timestamp: Date.now(),
    });

    const call = async (urlPath, method = "GET", body) => {
      const req = mockReq(method, urlPath, body);
      const res = mockRes();
      const handled = await searchFeature.handleRoutes(req, res, new URL(`http://127.0.0.1${urlPath}`), ctx);
      assert.equal(handled, true);
      return { status: res.status, data: res.json() };
    };

    // 1. Search terminal scrollback & verify secret redaction
    const termRes = await call("/api/search?q=Checkpoint&scope=terminal");
    assert.equal(termRes.status, 200);
    assert.equal(termRes.data.total, 1);
    assert.equal(termRes.data.results[0].target.type, "terminal");
    assert.equal(termRes.data.results[0].target.terminalId, "term-9");
    assert.ok(!termRes.data.results[0].snippet.includes("hf_SecretTokenValue1234567890"));

    // 2. Search jobs:log & verify sk- secret redacted
    const jobRes = await call("/api/search?q=loss%3D0.312&scope=jobs");
    assert.equal(jobRes.data.total, 1);
    assert.equal(jobRes.data.results[0].target.type, "job");
    assert.equal(jobRes.data.results[0].target.jobId, "job-42");
    assert.ok(!jobRes.data.results[0].snippet.includes("sk-ant-secretkey1234567890"));

    // 3. Search chat transcript
    const chatRes = await call("/api/search?q=num_workers&scope=chat&session=gpu-a");
    assert.equal(chatRes.data.total, 1);
    assert.equal(chatRes.data.results[0].target.type, "thread");
    assert.equal(chatRes.data.results[0].target.threadId, "thr-1");

    // 4. Search notebook/exec output
    const nbRes = await call("/api/search?q=94.2%25&scope=notebook");
    assert.equal(nbRes.data.total, 1);

    // 5. Session filter excludes non-matching sessions
    const wrongSess = await call("/api/search?q=num_workers&session=gpu-b");
    assert.equal(wrongSess.data.total, 0);

    // 6. Ingest + stats endpoints
    const ing = await call("/api/search/ingest", "POST", {
      id: "nb:cell:1",
      scope: "notebook",
      session: "gpu-a",
      title: "train.ipynb #1",
      text: "Custom ingested notebook metric=0.99",
    });
    assert.equal(ing.data.added, 1);
    const hitIng = await call("/api/search?q=metric%3D0.99");
    assert.equal(hitIng.data.total, 1);
  });

  test("frontend search strings have full zh-CN and en parity", () => {
    const src = fs.readFileSync(path.join(root, "public/js/features/search/index.js"), "utf8");
    const m = src.match(/const STRINGS = (\{[\s\S]*?\n\});/);
    assert.ok(m, "STRINGS block found");
    const strings = Function(`return (${m[1]})`)();
    const zhKeys = Object.keys(strings["zh-CN"]).sort();
    const enKeys = Object.keys(strings.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    assert.ok(zhKeys.length >= 12);
  });
});

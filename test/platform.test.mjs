import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";
import { createStorage, isValidFeatureId } from "../src/features/loader.mjs";
import { registerTranslations, t } from "../src/i18n.mjs";
import { createServer } from "../src/server.mjs";

const tmpDirs = [];

function makeTmpDir(prefix = "colab-platform-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function startTestServer(options) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    server,
    baseUrl,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeFeatureFixtures(baseDir) {
  const featuresDir = path.join(baseDir, "features");
  const publicDir = path.join(baseDir, "public");
  const configDir = path.join(baseDir, "config");

  // 1. Healthy _example backend + frontend + css
  const exDir = path.join(featuresDir, "_example");
  fs.mkdirSync(exDir, { recursive: true });
  fs.writeFileSync(
    path.join(exDir, "index.mjs"),
    `
let shutdownCalled = false;
export const feature = {
  id: "_example",
  init(ctx) {
    const store = ctx.storage("_example");
    store.set("booted", true);
    ctx.bus.on("example:ping-internal", (p) => ctx.pushEvent("example:pong", p));
  },
  async handleRoutes(req, res, url, ctx) {
    if (req.method === "GET" && url.pathname === "/api/_example/ping") {
      const store = ctx.storage("_example");
      ctx.http.sendJson(res, 200, { ok: true, booted: store.get("booted", false), count: store.get("count", 0) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/_example/echo") {
      const body = await ctx.http.readJsonBodySafe(req, {});
      const store = ctx.storage("_example");
      const next = store.get("count", 0) + 1;
      store.set("count", next);
      ctx.pushEvent("example:echo", { body, count: next });
      ctx.http.sendJson(res, 200, { ok: true, echo: body, count: next });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/_example/shutdown-state") {
      ctx.http.sendJson(res, 200, { ok: true, shutdownCalled });
      return true;
    }
    return false;
  },
  shutdown() {
    shutdownCalled = true;
    globalThis.__colabExampleShutdownCount = (globalThis.__colabExampleShutdownCount || 0) + 1;
  },
};
`,
  );

  const exFrontDir = path.join(publicDir, "js", "features", "_example");
  fs.mkdirSync(exFrontDir, { recursive: true });
  fs.writeFileSync(
    path.join(exFrontDir, "index.js"),
    `export async function init(api) {
  api.registerStrings({
    "zh-CN": { "_example.hello": "你好" },
    en: { "_example.hello": "Hello" },
  });
}
`,
  );

  const exStyleDir = path.join(publicDir, "styles", "features");
  fs.mkdirSync(exStyleDir, { recursive: true });
  fs.writeFileSync(path.join(exStyleDir, "_example.css"), `.example-widget { color: inherit; }\n`);

  // 2. Broken feature that throws in init()
  const brokenInitDir = path.join(featuresDir, "_broken_init");
  fs.mkdirSync(brokenInitDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenInitDir, "index.mjs"),
    `export const feature = {
  id: "_broken_init",
  init() { throw new Error("boom in init"); },
};
`,
  );

  // 3. Broken feature that throws in handleRoutes()
  const brokenRouteDir = path.join(featuresDir, "_broken_route");
  fs.mkdirSync(brokenRouteDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenRouteDir, "index.mjs"),
    `export const feature = {
  id: "_broken_route",
  async handleRoutes() { throw new Error("boom in route"); },
};
`,
  );

  // 4. Symlink escape attempt outside featuresDir
  const outsideDir = path.join(baseDir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(
    path.join(outsideDir, "index.mjs"),
    `export const feature = { id: "_escape", init() {} };\n`,
  );
  const escapeDir = path.join(featuresDir, "_escape");
  fs.mkdirSync(escapeDir, { recursive: true });
  fs.symlinkSync(path.join(outsideDir, "index.mjs"), path.join(escapeDir, "index.mjs"));

  return { featuresDir, publicDir, configDir };
}

describe("Platform plugin loader, SSE, storage & isolation", () => {
  it("discovers backend/frontend/styles, dispatches routes, and isolates broken features", async () => {
    const tmp = makeTmpDir();
    const { featuresDir, publicDir, configDir } = writeFeatureFixtures(tmp);
    const prevShutdownCount = globalThis.__colabExampleShutdownCount || 0;

    const srv = await startTestServer({ featuresDir, publicDir, configDir });
    try {
      // 1. Discovery
      const featRes = await fetch(`${srv.baseUrl}/api/features`);
      assert.equal(featRes.status, 200);
      const manifest = await featRes.json();
      assert.equal(manifest.ok, true);
      assert.ok(manifest.backend.includes("_example"));
      assert.ok(manifest.backend.includes("_broken_route"));
      assert.ok(!manifest.backend.includes("_broken_init"), "broken init feature must not register");
      assert.ok(!manifest.backend.includes("_escape"), "symlink escape feature must not register");
      assert.ok(manifest.frontend.includes("/js/features/_example/index.js"));
      assert.ok(manifest.styles.includes("/styles/features/_example.css"));
      assert.ok(manifest.errors.some((e) => e.id === "_broken_init"));
      assert.ok(manifest.errors.some((e) => e.id === "_escape"));

      // 2. Frontend asset serving
      const jsRes = await fetch(`${srv.baseUrl}/js/features/_example/index.js`);
      assert.equal(jsRes.status, 200);
      assert.match(await jsRes.text(), /export async function init/);

      const cssRes = await fetch(`${srv.baseUrl}/styles/features/_example.css`);
      assert.equal(cssRes.status, 200);
      assert.match(await cssRes.text(), /\.example-widget/);

      // 3. Route dispatch + storage persistence
      const pingRes = await fetch(`${srv.baseUrl}/api/_example/ping`);
      assert.equal(pingRes.status, 200);
      assert.deepEqual(await pingRes.json(), { ok: true, booted: true, count: 0 });

      const echoRes = await fetch(`${srv.baseUrl}/api/_example/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      assert.equal(echoRes.status, 200);
      assert.deepEqual(await echoRes.json(), { ok: true, echo: { hello: "world" }, count: 1 });

      // Storage file persisted in temp configDir with 0600 permissions
      const storageFile = path.join(configDir, "features", "_example.json");
      assert.ok(fs.existsSync(storageFile));
      const persisted = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      assert.equal(persisted.booted, true);
      assert.equal(persisted.count, 1);
      const mode = fs.statSync(storageFile).mode & 0o777;
      assert.equal(mode, 0o600);

      // 4. Broken route isolation (returns 500 JSON, does not crash server)
      const brokenRes = await fetch(`${srv.baseUrl}/api/_broken_route/anything`);
      assert.equal(brokenRes.status, 500);
      const brokenBody = await brokenRes.json();
      assert.equal(brokenBody.ok, false);
      assert.match(brokenBody.error, /boom in route/);

      // Server still healthy after broken route
      const pingAfter = await fetch(`${srv.baseUrl}/api/_example/ping`);
      assert.equal(pingAfter.status, 200);
      assert.equal((await pingAfter.json()).count, 1);
    } finally {
      await srv.close();
    }

    assert.equal(globalThis.__colabExampleShutdownCount, prevShutdownCount + 1, "shutdown() must be called on close");
  });

  it("delivers SSE events over GET /api/events when pushEvent is called", async () => {
    const tmp = makeTmpDir();
    const { featuresDir, publicDir, configDir } = writeFeatureFixtures(tmp);
    const srv = await startTestServer({ featuresDir, publicDir, configDir });

    try {
      const received = await new Promise((resolve, reject) => {
        const req = http.get(`${srv.baseUrl}/api/events`, (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers["content-type"], /text\/event-stream/);
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
            const lines = buf.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const ev = JSON.parse(line.slice(6));
                  if (ev.type === "example:echo") {
                    req.destroy();
                    resolve(ev);
                  }
                } catch {}
              }
            }
          });
          // Trigger an event via POST /api/_example/echo once connected
          fetch(`${srv.baseUrl}/api/_example/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sse: true }),
          }).catch(reject);
        });
        req.on("error", (err) => {
          if (err.code !== "ECONNRESET") reject(err);
        });
        setTimeout(() => {
          req.destroy();
          reject(new Error("timed out waiting for SSE event"));
        }, 4000);
      });

      assert.equal(received.type, "example:echo");
      assert.deepEqual(received.payload.body, { sse: true });
      assert.equal(typeof received.ts, "number");
    } finally {
      await srv.close();
    }
  });

  it("enforces path-traversal safety in storage and HTTP routes", async () => {
    const tmp = makeTmpDir();
    const { featuresDir, publicDir, configDir } = writeFeatureFixtures(tmp);

    // Invalid feature IDs rejected by storage
    assert.equal(isValidFeatureId("../evil"), false);
    assert.equal(isValidFeatureId("foo/bar"), false);
    assert.equal(isValidFeatureId(".hidden"), false);
    assert.equal(isValidFeatureId("valid_id-1"), true);
    assert.throws(() => createStorage("../evil", configDir), /invalid feature id/);
    assert.throws(() => createStorage("a/b", configDir), /invalid feature id/);

    // Storage persistence round-trip
    const s1 = createStorage("persist_test", configDir);
    assert.equal(s1.get("missing", "fallback"), "fallback");
    s1.set("nested", { a: 1, b: [2, 3] });
    const s2 = createStorage("persist_test", configDir);
    assert.deepEqual(s2.get("nested"), { a: 1, b: [2, 3] });
    assert.deepEqual(s2.all(), { nested: { a: 1, b: [2, 3] } });

    const srv = await startTestServer({ featuresDir, publicDir, configDir });
    try {
      const trav1 = await fetch(`${srv.baseUrl}/js/features/..%2F..%2Fpackage.json`);
      assert.ok(trav1.status === 400 || trav1.status === 403 || trav1.status === 404);

      const trav2 = await fetch(`${srv.baseUrl}/api/..%2Fetc/passwd`);
      assert.equal(trav2.status, 404);
    } finally {
      await srv.close();
    }
  });

  it("merges registered i18n strings for both zh-CN and en", () => {
    registerTranslations({
      "zh-CN": { "_platform_test.greeting": "你好 {name}" },
      en: { "_platform_test.greeting": "Hello {name}" },
    });
    assert.equal(t("zh-CN", "_platform_test.greeting", { name: "Colab" }), "你好 Colab");
    assert.equal(t("en", "_platform_test.greeting", { name: "Colab" }), "Hello Colab");
  });

  it("keeps public/js module graph strictly acyclic", () => {
    const jsRoot = path.resolve("public/js");
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
      }
    };
    walk(jsRoot);

    const graph = new Map();
    const importRe = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?["'](\.[^"']+)["']/g;
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const deps = [];
      let m;
      while ((m = importRe.exec(src)) !== null) {
        const resolved = path.resolve(path.dirname(file), m[1]);
        if (fs.existsSync(resolved)) deps.push(resolved);
      }
      graph.set(file, deps);
    }

    const visiting = new Set();
    const visited = new Set();
    const visit = (node, stack) => {
      if (visiting.has(node)) {
        const cycle = [...stack.slice(stack.indexOf(node)), node].map((p) => path.relative(jsRoot, p));
        assert.fail(`Import cycle detected in public/js: ${cycle.join(" -> ")}`);
      }
      if (visited.has(node)) return;
      visiting.add(node);
      for (const dep of graph.get(node) || []) {
        visit(dep, [...stack, node]);
      }
      visiting.delete(node);
      visited.add(node);
    };
    for (const file of files) visit(file, []);
  });
});

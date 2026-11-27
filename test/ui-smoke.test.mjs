import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

const FAKE_COLAB_SOURCE = `import fs from "node:fs";

const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const cmd = argv[0] || "";
const rest = argv.slice(1).join(" ");
const sessionLine = (status) =>
  "[lab-alpha] m-s-fixture-endpoint | Hardware: T4 | Variant: GPU" +
  (status ? " | Status: " + status : "") + " | Shape: Standard\\n";

if (cmd === "sessions") {
  process.stdout.write(sessionLine());
} else if (cmd === "status") {
  process.stdout.write(sessionLine("IDLE") + "  Last Execution: train.py | Cell: 1 at 2026-11-25T10:30:00\\n");
} else if (cmd === "usage") {
  process.stdout.write("Current balance: 310.34 compute units\\nUsage rate: 1.96/hr\\nActive assignments: 1\\n");
} else if (cmd === "version") {
  process.stdout.write("colab 0.1.0\\n");
} else if (cmd === "whoami") {
  process.stdout.write("Auth provider: oauth2\\nEmail: smoke@example.com\\nExpires in: 59m\\nScopes:\\n  - email\\n");
} else if (cmd === "ssh") {
  if (rest.includes("===GPU===")) {
    process.stdout.write("===GPU===\\nTesla T4, 1024, 15360, 22, 43\\n===PROCS===\\n===PORTS===\\n");
  } else if (rest.includes("base64")) {
    process.stdout.write(JSON.stringify({
      path: "/content",
      parent: "/",
      driveMounted: false,
      entries: [
        { name: "sample.py", path: "/content/sample.py", isDir: false, size: 128, mtime: 1730000000000 },
        { name: "data", path: "/content/data", isDir: true, size: 4096, mtime: 1730000000000 },
      ],
    }) + "\\n");
  } else {
    process.stdout.write("ok\\n");
  }
} else if (cmd === "ls") {
  process.stdout.write("/content/sample.py\\n");
} else if (cmd === "exec") {
  process.stdout.write("exec-stdout-fixture\\n");
} else {
  process.stdout.write("ok " + cmd + "\\n");
}
`;

function installFakeColab(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(dir, "fake-colab.mjs");
  fs.writeFileSync(script, FAKE_COLAB_SOURCE);
  const wrapper = path.join(bin, "colab");
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return bin;
}

function startServer(binDir, isolatedHome, isolatedStateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: root,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
        HOME: isolatedHome,
        USER: process.env.USER || "test",
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        COLAB_DESK_STATE_DIR: isolatedStateDir,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`colab-desk server did not start in time:\n${buf}`));
    }, 10000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, baseUrl: m[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`colab-desk server exited early (${code}):\n${buf}`));
    });
  });
}

function stopProcess(child, timeoutMs = 4000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", finish);
    try { child.kill("SIGTERM"); } catch {}
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      setTimeout(finish, 300);
    }, timeoutMs);
  });
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      } else if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) {
          for (const fn of handlers) {
            try { fn(msg.params || {}); } catch {}
          }
        }
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, awaitPromise = true) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description
        || res.exceptionDetails.text
        || "Unknown evaluation exception";
      throw new Error(`Page evaluation failed: ${text}`);
    }
    return res.result?.value;
  }

  async waitFor(expression, { timeoutMs = 8000, intervalMs = 40, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastVal;
    while (Date.now() < deadline) {
      lastVal = await this.eval(expression);
      if (lastVal) return lastVal;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label} (last=${JSON.stringify(lastVal)})`);
  }

  close() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    try { this.ws.close(); } catch {}
  }
}

async function launchChrome(chromeBin, userDataDir) {
  const child = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--window-size=1440,900",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderrBuf = "";
  const browserWsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Chrome did not expose DevTools port in time:\n${stderrBuf}`));
    }, 12000);
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}):\n${stderrBuf}`));
    });
  });

  const debugPort = new URL(browserWsUrl).port;
  let pageTarget = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (pageTarget) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!pageTarget) {
    throw new Error("Could not find a debuggable Chrome page target");
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (err) => { clearTimeout(timer); reject(err); }, { once: true });
  });

  return { child, cdp: new CdpClient(ws) };
}

const chromeBin = findChromeBinary();

describe("Colab Desk headless Chrome UI/E2E smoke suite", { skip: !chromeBin && "No Chrome/Chromium binary found on this machine" }, () => {
  let tmpRoot;
  let serverProc;
  let chromeProc;
  let cdp;
  let baseUrl;

  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const loadedResponses = new Map();
  const pendingRequests = new Map();

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-e2e-"));
    const fakeBin = installFakeColab(tmpRoot);
    const isolatedHome = path.join(tmpRoot, "home");
    const isolatedStateDir = path.join(tmpRoot, "state");
    const chromeProfileDir = path.join(tmpRoot, "chrome-profile");
    fs.mkdirSync(isolatedHome, { recursive: true });
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    fs.mkdirSync(chromeProfileDir, { recursive: true });

    const srv = await startServer(fakeBin, isolatedHome, isolatedStateDir);
    serverProc = srv.child;
    baseUrl = srv.baseUrl;

    const browser = await launchChrome(chromeBin, chromeProfileDir);
    chromeProc = browser.child;
    cdp = browser.cdp;

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");

    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails || {};
      pageErrors.push({
        text: details.exception?.description || details.text || "Uncaught exception",
        url: details.url || "",
        line: details.lineNumber,
      });
    });

    cdp.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error") {
        const text = (params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        consoleErrors.push({ source: "console.error", text });
      }
    });

    cdp.on("Log.entryAdded", (params) => {
      const entry = params.entry || {};
      if (entry.level === "error") {
        // Ignore Chrome's automatic /favicon.ico probe if the app doesn't serve a favicon
        if (entry.url && entry.url.endsWith("/favicon.ico")) return;
        consoleErrors.push({ source: entry.source || "log", text: entry.text || "", url: entry.url || "" });
      }
    });

    cdp.on("Network.requestWillBeSent", (params) => {
      pendingRequests.set(params.requestId, params.request?.url || "");
    });

    cdp.on("Network.responseReceived", (params) => {
      const url = params.response?.url || pendingRequests.get(params.requestId) || "";
      const status = params.response?.status;
      if (url.startsWith(baseUrl)) {
        const pathname = new URL(url).pathname;
        loadedResponses.set(pathname, status);
        if (status >= 400 && pathname !== "/favicon.ico") {
          failedRequests.push({ url, status, type: "http-status" });
        }
      }
    });

    cdp.on("Network.loadingFailed", (params) => {
      if (params.canceled) return;
      const url = pendingRequests.get(params.requestId) || "";
      if (url.endsWith("/favicon.ico")) return;
      failedRequests.push({ url, errorText: params.errorText || "loadingFailed", type: "network-error" });
    });
  });

  after(async () => {
    if (cdp) cdp.close();
    await stopProcess(chromeProc);
    await stopProcess(serverProc);
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
    }
  });

  test("initial page load renders cleanly with styles, ES modules, CSS variables, and WKWebView bridges", async () => {
    const loadDone = new Promise((resolve) => {
      cdp.on("Page.loadEventFired", resolve);
    });
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await loadDone;

    // Wait for initial hydration & fixture session lab-alpha to load
    await cdp.waitFor(
      `document.querySelector("#session-items")?.textContent?.includes("lab-alpha")`,
      { label: "fixture session lab-alpha rendered in sidebar" },
    );

    assert.equal(loadedResponses.get("/"), 200, "GET / should return 200");
    assert.equal(loadedResponses.get("/js/main.js"), 200, "GET /js/main.js should return 200");
    assert.equal(loadedResponses.get("/desk.mjs"), 200, "GET /desk.mjs should return 200");
    assert.equal(loadedResponses.get("/i18n.mjs"), 200, "GET /i18n.mjs should return 200");
    assert.equal(loadedResponses.get("/vendor/xterm/xterm.js"), 200, "GET /vendor/xterm/xterm.js should return 200");

    const loadedStyles = [...loadedResponses.entries()].filter(([p, st]) => p.startsWith("/styles/") && st === 200);
    assert.ok(loadedStyles.length >= 10, `expected >= 10 modular stylesheets loaded, got ${loadedStyles.length}`);

    const checks = await cdp.eval(`(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const appEl = document.querySelector("#app");
      const appStyle = appEl ? getComputedStyle(appEl) : rootStyle;
      return {
        bgVar: rootStyle.getPropertyValue("--bg").trim(),
        textVar: rootStyle.getPropertyValue("--text").trim(),
        indigoVar: rootStyle.getPropertyValue("--indigo").trim(),
        sidebarWidthVar: (appStyle.getPropertyValue("--sidebar-width") || rootStyle.getPropertyValue("--sidebar-width")).trim(),
        hasNativeStagedFiles: typeof window.__onNativeStagedFiles === "function",
        hasNativeClipboardImages: typeof window.__onNativeClipboardImages === "function",
        hasNativeClipboardImage: typeof window.__onNativeClipboardImage === "function",
        sidebarPresent: !!document.querySelector('[data-region="sidebar"]'),
        transcriptPresent: !!document.querySelector('[data-region="transcript"]'),
        composerPresent: !!document.querySelector('[data-region="composer"]'),
        inspectorPresent: !!document.querySelector('[data-region="inspector"]'),
      };
    })()`);

    assert.ok(checks.bgVar.length > 0, "CSS custom property --bg should be applied");
    assert.ok(checks.textVar.length > 0, "CSS custom property --text should be applied");
    assert.ok(checks.indigoVar.length > 0, "CSS custom property --indigo should be applied");
    assert.ok(checks.sidebarWidthVar.length > 0, "CSS custom property --sidebar-width should be applied");
    assert.equal(checks.hasNativeStagedFiles, true, "window.__onNativeStagedFiles should be registered");
    assert.equal(checks.hasNativeClipboardImages, true, "window.__onNativeClipboardImages should be registered");
    assert.equal(checks.hasNativeClipboardImage, true, "window.__onNativeClipboardImage should be registered");
    assert.equal(checks.sidebarPresent, true);
    assert.equal(checks.transcriptPresent, true);
    assert.equal(checks.composerPresent, true);
    assert.equal(checks.inspectorPresent, true);

    // Verify lazy modules are deferred on initial paint
    for (const lazyUrl of [
      "/js/settings.js",
      "/js/notebook.js",
      "/js/files.js",
      "/js/cloud-tools.js",
      "/js/palette.js",
      "/js/session-create.js",
      "/js/usage.js",
    ]) {
      assert.equal(loadedResponses.has(lazyUrl), false, `${lazyUrl} should be lazy-loaded, not fetched on initial load`);
    }
  });

  test("Settings modal opens, switches all 7 tabs cleanly, and closes", async () => {
    await cdp.eval(`document.querySelector("#open-settings-modal").click()`);
    await cdp.waitFor(`document.querySelector("#settings-modal")?.open === true`, { label: "settings modal open" });

    const tabs = ["general", "chat", "providers", "safety", "colab", "maintenance", "about"];
    for (const tab of tabs) {
      await cdp.eval(`document.querySelector('#settings-modal [data-settings-tab="${tab}"]').click()`);
      await cdp.waitFor(
        `document.querySelector('#settings-modal [data-settings-pane="${tab}"]')?.classList.contains("is-active")`,
        { label: `settings tab ${tab} active` },
      );
      const tabActive = await cdp.eval(
        `document.querySelector('#settings-modal [data-settings-tab="${tab}"]')?.classList.contains("is-active")`,
      );
      assert.equal(tabActive, true, `settings nav button for ${tab} should be active`);
    }

    await cdp.eval(`document.querySelector("#close-settings-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#settings-modal")?.open`, { label: "settings modal closed" });
  });

  test("New Session, Usage, and Colab CU modals open and close cleanly", async () => {
    // New Session modal
    await cdp.eval(`document.querySelector("#open-new-session").click()`);
    await cdp.waitFor(`document.querySelector("#new-session-modal")?.open === true`, { label: "new-session modal open" });
    const hasHwPicker = await cdp.eval(`!!document.querySelector('#new-session-modal [data-region="hardware-picker"]')`);
    assert.equal(hasHwPicker, true, "hardware picker should be present inside new-session modal");
    await cdp.eval(`document.querySelector("#close-new-session").click()`);
    await cdp.waitFor(`!document.querySelector("#new-session-modal")?.open`, { label: "new-session modal closed" });

    // Agent Usage modal
    await cdp.eval(`document.querySelector("#open-usage-modal").click()`);
    await cdp.waitFor(`document.querySelector("#agent-usage-modal")?.open === true`, { label: "usage modal open" });
    await cdp.eval(`document.querySelector("#close-usage-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#agent-usage-modal")?.open`, { label: "usage modal closed" });

    // Colab CU modal
    await cdp.eval(`document.querySelector("#quick-usage").click()`);
    await cdp.waitFor(`document.querySelector("#colab-cu-modal")?.open === true`, { label: "colab CU modal open" });
    await cdp.eval(`document.querySelector("#close-cu-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#colab-cu-modal")?.open`, { label: "colab CU modal closed" });
  });

  test("Files, Templates, Runner, and Sync modals open and close cleanly", async () => {
    // Ensure lab-alpha is selected so VM-bound buttons (#inspector-ls, #inspector-sync-btn) are enabled
    await cdp.waitFor(
      `document.querySelector("#inspector-ls") && !document.querySelector("#inspector-ls").disabled`,
      { label: "inspector-ls enabled for selected VM" },
    );

    // Files modal
    await cdp.eval(`document.querySelector("#inspector-ls").click()`);
    await cdp.waitFor(`document.querySelector("#files-modal")?.open === true`, { label: "files modal open" });
    await cdp.waitFor(
      `document.querySelector("#files-list")?.textContent?.includes("sample.py")`,
      { label: "files modal renders remote sample.py" },
    );
    await cdp.eval(`document.querySelector("#close-files-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#files-modal")?.open`, { label: "files modal closed" });

    // Templates modal via Tools dropdown
    await cdp.eval(`document.querySelector("#tools-dropdown-btn").click()`);
    await cdp.waitFor(`document.querySelector("#tools-dropdown-menu")?.hidden === false`, { label: "tools dropdown open" });
    await cdp.eval(`document.querySelector("#open-templates-btn").click()`);
    await cdp.waitFor(`document.querySelector("#templates-modal")?.open === true`, { label: "templates modal open" });
    await cdp.waitFor(
      `document.querySelectorAll("#templates-list .tpl-card").length > 0`,
      { label: "templates list rendered" },
    );
    await cdp.eval(`document.querySelector("#close-templates-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#templates-modal")?.open`, { label: "templates modal closed" });

    // Runner modal via Tools dropdown
    await cdp.eval(`document.querySelector("#tools-dropdown-btn").click()`);
    await cdp.waitFor(`document.querySelector("#tools-dropdown-menu")?.hidden === false`, { label: "tools dropdown open for runner" });
    await cdp.eval(`document.querySelector("#open-runner-btn").click()`);
    await cdp.waitFor(`document.querySelector("#runner-modal")?.open === true`, { label: "runner modal open" });
    await cdp.waitFor(
      `document.querySelectorAll("#runner-sidebar button").length > 0`,
      { label: "runner sidebar populated" },
    );
    await cdp.eval(`document.querySelector("#close-runner-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#runner-modal")?.open`, { label: "runner modal closed" });

    // Sync modal
    await cdp.eval(`document.querySelector("#inspector-sync-btn").click()`);
    await cdp.waitFor(`document.querySelector("#sync-modal")?.open === true`, { label: "sync modal open" });
    await cdp.eval(`document.querySelector("#close-sync-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#sync-modal")?.open`, { label: "sync modal closed" });
  });

  test("mode switching (Agent / Notebook / CLI) updates workspace panes cleanly", async () => {
    // Switch to Notebook mode
    await cdp.eval(`document.querySelector("#mode-notebook").click()`);
    await cdp.waitFor(
      `document.querySelector("#mode-notebook")?.classList.contains("is-active") &&
       document.querySelector("#notebook-view")?.hidden === false &&
       document.querySelector("#nb-cells")?.children.length > 0`,
      { label: "notebook mode active with rendered cells" },
    );
    const nbFlags = await cdp.eval(`({
      transcriptHidden: document.querySelector("#transcript").hidden,
      composerHidden: document.querySelector("#composer").hidden,
    })`);
    assert.equal(nbFlags.transcriptHidden, true);
    assert.equal(nbFlags.composerHidden, true);

    // Switch to CLI mode
    await cdp.eval(`document.querySelector("#mode-cli").click()`);
    await cdp.waitFor(
      `document.querySelector("#mode-cli")?.classList.contains("is-active") &&
       document.querySelector("#cli-controls")?.hidden === false`,
      { label: "cli mode active" },
    );
    const cliFlags = await cdp.eval(`({
      notebookHidden: document.querySelector("#notebook-view").hidden,
      agentControlsHidden: document.querySelector("#agent-controls").hidden,
    })`);
    assert.equal(cliFlags.notebookHidden, true);
    assert.equal(cliFlags.agentControlsHidden, true);

    // Switch back to Agent mode
    await cdp.eval(`document.querySelector("#mode-agent").click()`);
    await cdp.waitFor(
      `document.querySelector("#mode-agent")?.classList.contains("is-active") &&
       document.querySelector("#agent-controls")?.hidden === false`,
      { label: "agent mode active" },
    );
  });

  test("Sidebar collapse/expand and Command Palette (⌘K) work cleanly", async () => {
    // Collapse & expand sidebar
    await cdp.eval(`document.querySelector("#sidebar-toggle").click()`);
    await cdp.waitFor(`document.querySelector("#app")?.classList.contains("is-sidebar-collapsed")`, { label: "sidebar collapsed" });
    await cdp.eval(`document.querySelector("#sidebar-open").click()`);
    await cdp.waitFor(`!document.querySelector("#app")?.classList.contains("is-sidebar-collapsed")`, { label: "sidebar expanded" });

    // Open Command Palette via ⌘K keyboard event
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))`);
    await cdp.waitFor(
      `document.querySelector("#cmd-palette-modal")?.open === true &&
       document.querySelectorAll("#cmd-palette-list .palette-item").length > 0`,
      { label: "command palette open with items" },
    );

    // Filter command palette list
    const beforeCount = await cdp.eval(`document.querySelectorAll("#cmd-palette-list .palette-item").length`);
    await cdp.eval(`(() => {
      const inp = document.querySelector("#cmd-palette-input");
      inp.value = "Colab";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const afterCount = await cdp.eval(`document.querySelectorAll("#cmd-palette-list .palette-item").length`);
    assert.ok(afterCount > 0 && afterCount <= beforeCount, `palette filter should narrow items (${beforeCount} -> ${afterCount})`);

    // Close Command Palette via backdrop click
    await cdp.eval(`document.querySelector("#cmd-palette-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#cmd-palette-modal")?.open`, { label: "command palette closed" });
  });

  test("Theme toggle (dark/light) and Language toggle (ZH/EN) update DOM & translations", async () => {
    await cdp.eval(`document.querySelector("#open-settings-modal").click()`);
    await cdp.waitFor(`document.querySelector("#settings-modal")?.open === true`, { label: "settings open for theme/lang" });

    // Switch Theme -> light
    await cdp.eval(`(() => {
      const sel = document.querySelector("#setting-theme");
      sel.value = "light";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === "light"`, { label: "light theme applied" });
    const lightBg = await cdp.eval(`getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()`);

    // Switch Theme -> dark
    await cdp.eval(`(() => {
      const sel = document.querySelector("#setting-theme");
      sel.value = "dark";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === "dark"`, { label: "dark theme applied" });
    const darkBg = await cdp.eval(`getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()`);
    assert.notEqual(lightBg, darkBg, `light (--bg=${lightBg}) and dark (--bg=${darkBg}) themes should differ`);

    // Switch Language -> English
    await cdp.eval(`(() => {
      const sel = document.querySelector("#setting-language");
      sel.value = "en";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.documentElement.lang === "en"`, { label: "English language applied" });
    const enTexts = await cdp.eval(`({
      crumb: document.querySelector("#settings-crumb-tab")?.textContent?.trim(),
      refreshBtn: document.querySelector("#refresh")?.textContent?.trim(),
    })`);
    assert.equal(enTexts.crumb, "General");
    assert.equal(enTexts.refreshBtn, "Refresh");

    // Switch Language -> Simplified Chinese
    await cdp.eval(`(() => {
      const sel = document.querySelector("#setting-language");
      sel.value = "zh-CN";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.documentElement.lang === "zh-CN"`, { label: "Chinese language applied" });
    const zhTexts = await cdp.eval(`({
      crumb: document.querySelector("#settings-crumb-tab")?.textContent?.trim(),
      refreshBtn: document.querySelector("#refresh")?.textContent?.trim(),
    })`);
    assert.equal(zhTexts.crumb, "通用");
    assert.equal(zhTexts.refreshBtn, "刷新");

    await cdp.eval(`document.querySelector("#close-settings-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#settings-modal")?.open`, { label: "settings closed after theme/lang" });
  });

  test("zero uncaught page errors, zero console errors, and zero failed network requests across all flows", async () => {
    // Allow any trailing store sync / background fetch to settle cleanly
    await new Promise((r) => setTimeout(r, 350));
    // Verify lazy feature modules were actually loaded on demand during the interactive flows
    for (const lazyUrl of [
      "/js/settings.js",
      "/js/notebook.js",
      "/js/files.js",
      "/js/cloud-tools.js",
      "/js/palette.js",
      "/js/session-create.js",
      "/js/usage.js",
      "/js/templates/modals.js",
      "/js/templates/settings-modal.js",
    ]) {
      assert.equal(loadedResponses.get(lazyUrl), 200, `Expected lazy module ${lazyUrl} to be loaded with HTTP 200`);
    }
    assert.deepEqual(pageErrors, [], `Expected 0 uncaught page errors, got: ${JSON.stringify(pageErrors, null, 2)}`);
    assert.deepEqual(consoleErrors, [], `Expected 0 console errors, got: ${JSON.stringify(consoleErrors, null, 2)}`);
    assert.deepEqual(failedRequests, [], `Expected 0 failed network requests, got: ${JSON.stringify(failedRequests, null, 2)}`);
  });
});

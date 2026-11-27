import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

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

export function findChromeBinary() {
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

export function installFakeAgentClis(bin) {
  fs.mkdirSync(bin, { recursive: true });
  const agy = path.join(bin, "agy");
  fs.writeFileSync(
    agy,
    `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\\n' '{"command":{"data":{"description":"fixture","groups":[{"name":"default","buckets":[{"id":"b1","name":"Fixture","window":"daily","remaining_fraction":0.95}]}]}}}'
  exit 0
fi
if [ "$1" = "acp" ]; then
  exit 0
fi
printf '{}\\n'
exit 0
`,
  );
  fs.chmodSync(agy, 0o755);

  const grok = path.join(bin, "grok");
  fs.writeFileSync(grok, `#!/bin/sh\nprintf '{}\\n'\nexit 0\n`);
  fs.chmodSync(grok, 0o755);

  const opencode = path.join(bin, "opencode");
  fs.writeFileSync(
    opencode,
    `#!/bin/sh
printf '%s\\n' '{"sessions":0,"prompts":0,"steps":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0}},"cost":0,"models":[]}'
exit 0
`,
  );
  fs.chmodSync(opencode, 0o755);
}

export function installFakeColab(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(dir, "fake-colab.mjs");
  fs.writeFileSync(script, FAKE_COLAB_SOURCE);
  const wrapper = path.join(bin, "colab");
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  installFakeAgentClis(bin);
  return bin;
}

export function startServer(binDir, isolatedHome, isolatedStateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: root,
      detached: process.platform !== "win32",
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
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      try { child.kill("SIGKILL"); } catch {}
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

function killGroup(child, signal) {
  if (process.platform !== "win32" && child?.pid) {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

export function stopProcess(child, timeoutMs = 4000) {
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
    killGroup(child, "SIGTERM");
    const killTimer = setTimeout(() => {
      killGroup(child, "SIGKILL");
      setTimeout(finish, 300);
    }, timeoutMs);
  });
}

export class CdpClient {
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

export async function launchChrome(chromeBin, userDataDir) {
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
  ], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });

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


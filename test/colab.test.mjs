import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentManager,
  buildColabSystemRules,
  buildOpenAiUserContent,
  extractAcpModels,
  fetchOpenAiModels,
  formatTurnPrompt,
  inferImageMime,
  parseAcpSessionUpdate,
  parseAgyQuotaJson,
  parseGrokBillingPayload,
  parseGrokEvent,
  parseOpenAiJsonCompletion,
  resolveOpenAiChatEndpoints,
  resolveOpenAiModelsEndpoints,
  UPLOAD_DIR,
} from "../src/agent.mjs";
import { parseWhoami } from "../src/colab-env.mjs";
import {
  buildMarkdownFromHistory,
  buildNotebookFromHistory,
  compareSemver,
  extractTemplateParams,
  extractTryCloudflareUrl,
  parseGpuProcesses,
  parseIpynb,
  parseListeningPorts,
  parseNvidiaSmi,
  parseReleaseTagFromUrl,
  renderParameterizedScript,
  serializeIpynb,
} from "../src/cloud-ops.mjs";
import { resolveLanguage, t } from "../src/i18n.mjs";
import { applyNewResult, buildContextHandoffPrompt, composeAction, createDeskState, isRetryableColabError, parseColabNewSpec, record, showSession, summarizeColabError } from "../src/desk.mjs";
import { parseCommandOutput } from "../src/parse.mjs";
import { plan } from "../src/plan.mjs";
import { runAction } from "../src/run.mjs";
import { createServer } from "../src/server.mjs";

const root = path.resolve(import.meta.dirname, "..");

const fakeSource = `import fs from "node:fs";

const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
if (process.env.COLAB_FAKE_LOG) {
  fs.appendFileSync(process.env.COLAB_FAKE_LOG, JSON.stringify({ argv, stdin }) + "\\n");
}
const fail = process.env.COLAB_FAKE_FAIL;
if (fail && (fail === "*" || fail === argv[0])) {
  process.stderr.write("forced failure\\n");
  process.exit(3);
}
const name = process.env.COLAB_FAKE_SESSION || "lab-alpha";
const hardware = process.env.COLAB_FAKE_HARDWARE || "T4";
const execOut = process.env.COLAB_FAKE_EXEC || "exec-stdout-fixture";
const endpoint = "m-s-fixture-endpoint";
const line = (status) =>
  "[" + name + "] " + endpoint + " | Hardware: " + hardware + " | Variant: GPU" +
  (status ? " | Status: " + status : "") + " | Shape: Standard\\n";
const cmd = argv[0];
if (cmd === "sessions") process.stdout.write(line());
else if (cmd === "status") process.stdout.write(line("IDLE") + "  Last Execution: train.py | Cell: 1 at 2026-11-25T10:30:00\\n");
else if (cmd === "usage") process.stdout.write("Current balance: 310.34 compute units\\nUsage rate: 1.96/hr\\nActive assignments: 1\\n");
else if (cmd === "exec") process.stdout.write(execOut.endsWith("\\n") ? execOut : execOut + "\\n");
else if (cmd === "run") process.stdout.write("run-stdout-fixture\\n");
else process.stdout.write("ok " + cmd + "\\n");
`;

function readLog(log) {
  const text = fs.readFileSync(log, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

function installFake(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const script = path.join(dir, "fake-colab.mjs");
  fs.writeFileSync(script, fakeSource);
  const wrapper = path.join(bin, "colab");
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec node ${JSON.stringify(script)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return bin;
}

test("parser reads a sessions, status, and exec transcript", () => {
  const sessions = parseCommandOutput(
    "sessions",
    "[lab-alpha] m-s-fixture-endpoint | Hardware: T4 | Variant: GPU | Shape: Standard\n",
  );
  assert.equal(sessions.sessions[0].name, "lab-alpha");
  assert.equal(sessions.sessions[0].hardware, "T4");
  const status = parseCommandOutput(
    "status",
    "[lab-alpha] m-s-fixture-endpoint | Hardware: T4 | Variant: GPU | Status: IDLE | Shape: Standard\n  Last Execution: train.py | Cell: 1 at 2026-11-25T10:30:00\n",
  );
  assert.equal(status.sessions[0].name, "lab-alpha");
  assert.equal(status.sessions[0].hardware, "T4");
  assert.equal(status.sessions[0].status, "IDLE");
  assert.equal(status.sessions[0].lastExecution, "train.py | Cell: 1 at 2026-11-25T10:30:00");
  const usage = parseCommandOutput(
    "usage",
    "Current balance: 310.34 compute units\nUsage rate: 1.96/hr\nActive assignments: 1\n",
  );
  assert.deepEqual(usage.usage, { balance: 310.34, ratePerHour: 1.96, activeAssignments: 1 });
  const exec = parseCommandOutput("exec", "exec-stdout-fixture\n");
  assert.equal(exec.execStdout, "exec-stdout-fixture\n");
});

const spawnDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-"));
const spawnLog = path.join(spawnDir, "argv.log");
const spawnBin = installFake(spawnDir);
const fixtureSession = `lab-${process.pid.toString(36)}`;
const fixtureHardware = "T4";
const fixtureExec = `exec-stdout-${fixtureSession}`;
const savedEnv = {
  PATH: process.env.PATH,
  COLAB_FAKE_LOG: process.env.COLAB_FAKE_LOG,
  COLAB_FAKE_SESSION: process.env.COLAB_FAKE_SESSION,
  COLAB_FAKE_HARDWARE: process.env.COLAB_FAKE_HARDWARE,
  COLAB_FAKE_EXEC: process.env.COLAB_FAKE_EXEC,
  COLAB_FAKE_FAIL: process.env.COLAB_FAKE_FAIL,
};

function useFakeEnv() {
  process.env.PATH = `${spawnBin}${path.delimiter}${savedEnv.PATH}`;
  process.env.COLAB_FAKE_LOG = spawnLog;
  process.env.COLAB_FAKE_SESSION = fixtureSession;
  process.env.COLAB_FAKE_HARDWARE = fixtureHardware;
  process.env.COLAB_FAKE_EXEC = fixtureExec;
  delete process.env.COLAB_FAKE_FAIL;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function observed(action) {
  useFakeEnv();
  try {
    const result = await runAction(action);
    const row = readLog(spawnLog).at(-1);
    return { result, argv: row.argv, stdin: row.stdin };
  } finally {
    restoreEnv();
  }
}

test("colab new --gpu T4 --high-mem", async () => {
  const { result, argv } = await observed({
    type: "new",
    name: fixtureSession,
    gpu: "T4",
    highMem: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["new", "-s", fixtureSession, "--gpu", "T4", "--high-mem"]);
});

test("colab new --tpu v5e1", async () => {
  const { result, argv } = await observed({ type: "new", name: "tpu-job", tpu: "v5e1" });
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["new", "-s", "tpu-job", "--tpu", "v5e1"]);
});

test("colab sessions parses fixture session name and hardware", async () => {
  const { result, argv } = await observed({ type: "sessions" });
  assert.deepEqual(argv, ["sessions"]);
  assert.equal(result.ok, true);
  assert.equal(result.state.sessions[0].name, fixtureSession);
  assert.equal(result.state.sessions[0].hardware, fixtureHardware);
});

test("colab status parses fixture session name and hardware", async () => {
  const { result, argv } = await observed({ type: "status", session: fixtureSession });
  assert.deepEqual(argv, ["status", "-s", fixtureSession]);
  assert.equal(result.state.sessions[0].name, fixtureSession);
  assert.equal(result.state.sessions[0].hardware, fixtureHardware);
});

test("colab restart-kernel", async () => {
  const { argv } = await observed({ type: "restart-kernel", session: fixtureSession });
  assert.deepEqual(argv, ["restart-kernel", "-s", fixtureSession]);
});

test("colab stop", async () => {
  const { argv } = await observed({ type: "stop", session: fixtureSession });
  assert.deepEqual(argv, ["stop", "-s", fixtureSession]);
});

test("colab url", async () => {
  const { argv } = await observed({ type: "url", session: fixtureSession });
  assert.deepEqual(argv, ["url", "-s", fixtureSession]);
});

test("colab exec stdin code body and exec stdout", async () => {
  const { result, argv, stdin } = await observed({
    type: "exec",
    session: fixtureSession,
    code: "print(1)\n",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["exec", "-s", fixtureSession]);
  assert.equal(stdin, "print(1)\n");
  assert.equal(result.state.execStdout, `${fixtureExec}\n`);
});

test("colab exec -f", async () => {
  const { result, argv, stdin } = await observed({
    type: "exec",
    session: fixtureSession,
    file: "/tmp/cell.py",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["exec", "-s", fixtureSession, "-f", "/tmp/cell.py"]);
  assert.equal(stdin, "");
});

test("colab run script path", async () => {
  const { result, argv } = await observed({ type: "run", script: "/tmp/job.py", gpu: "L4" });
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["run", "--gpu", "L4", "/tmp/job.py"]);
  assert.equal(result.state.execStdout, "run-stdout-fixture\n");
});

test("composer run ignores the selected session", async () => {
  const composed = composeAction({
    command: "run",
    selected: fixtureSession,
    hardware: { gpu: "L4", highMem: true },
    fields: { script: "/tmp/job.py" },
    code: "print(1)\n",
  });
  assert.equal(composed.error, undefined);
  assert.equal(composed.action.session, undefined);
  assert.deepEqual(plan(composed.action).argv, ["run", "--gpu", "L4", "--high-mem", "/tmp/job.py"]);
  const { argv } = await observed(composed.action);
  assert.deepEqual(argv, ["run", "--gpu", "L4", "--high-mem", "/tmp/job.py"]);
  assert.equal(argv.includes("-s"), false);
  assert.equal(argv.includes(fixtureSession), false);
});

test("composer run starts with no session selected", async () => {
  const composed = composeAction({
    command: "run",
    selected: null,
    hardware: { tpu: "v5e1" },
    fields: { script: "/tmp/job.py" },
  });
  assert.equal(composed.action.session, undefined);
  const { argv } = await observed(composed.action);
  assert.deepEqual(argv, ["run", "--tpu", "v5e1", "/tmp/job.py"]);
});

test("switching sessions shows only that session transcript", () => {
  const state = createDeskState();
  record(state, "lab-alpha", { label: "exec", text: "alpha-stdout" });
  record(state, "other-box", { label: "status", text: "other-stdout" });
  record(state, "lab-alpha", { label: "ls", text: "alpha-files" });
  assert.deepEqual(
    showSession(state, "lab-alpha").map((entry) => entry.text),
    ["alpha-stdout", "alpha-files"],
  );
  assert.deepEqual(
    showSession(state, "other-box").map((entry) => entry.text),
    ["other-stdout"],
  );
  assert.equal(state.view, "other-box");
});

test("failed new stays on the selected session transcript", () => {
  const state = createDeskState();
  record(state, "lab-alpha", { label: "exec", ok: true, error: "", text: "alpha-stdout" });
  showSession(state, "lab-alpha");
  const shown = applyNewResult(state, {
    current: "lab-alpha",
    requestedName: "missing-box",
    ok: false,
    entry: { label: "new missing-box", ok: false, error: "forced failure", text: "" },
    sessionNames: ["lab-alpha"],
  });
  assert.equal(shown.view, "lab-alpha");
  assert.equal(state.view, "lab-alpha");
  assert.deepEqual(
    shown.entries.map((entry) => entry.text || entry.error),
    ["alpha-stdout", "forced failure"],
  );
  assert.deepEqual(showSession(state, "missing-box"), []);
});

test("colab ls", async () => {
  const { argv } = await observed({ type: "ls", session: fixtureSession, path: "/content" });
  assert.deepEqual(argv, ["ls", "-s", fixtureSession, "/content"]);
});

test("colab upload", async () => {
  const { argv } = await observed({
    type: "upload",
    session: fixtureSession,
    local: "a.txt",
    remote: "/content/a.txt",
  });
  assert.deepEqual(argv, ["upload", "-s", fixtureSession, "a.txt", "/content/a.txt"]);
});

test("colab download", async () => {
  const { argv } = await observed({
    type: "download",
    session: fixtureSession,
    remote: "/content/a.txt",
    local: "a.txt",
  });
  assert.deepEqual(argv, ["download", "-s", fixtureSession, "/content/a.txt", "a.txt"]);
});

test("colab rm", async () => {
  const { argv } = await observed({ type: "rm", session: fixtureSession, path: "/content/a.txt" });
  assert.deepEqual(argv, ["rm", "-s", fixtureSession, "/content/a.txt"]);
});

test("colab install", async () => {
  const { argv } = await observed({ type: "install", session: fixtureSession, packages: ["numpy"] });
  assert.deepEqual(argv, ["install", "-s", fixtureSession, "numpy"]);
});

test("colab log", async () => {
  const { argv } = await observed({ type: "log", session: fixtureSession });
  assert.deepEqual(argv, ["log", "-s", fixtureSession]);
});

test("colab usage", async () => {
  const { result, argv } = await observed({ type: "usage" });
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["usage"]);
});

test("colab drivemount", async () => {
  const { argv } = await observed({ type: "drivemount", session: fixtureSession });
  assert.deepEqual(argv, ["drivemount", "-s", fixtureSession]);
});

test("colab auth", async () => {
  const { argv } = await observed({ type: "auth", session: fixtureSession });
  assert.deepEqual(argv, ["auth", "-s", fixtureSession]);
});

test("colab ssh one-shot command", async () => {
  const composed = composeAction({
    command: "ssh",
    selected: fixtureSession,
    code: "nvidia-smi",
  });
  assert.equal(composed.error, undefined);
  const { result, argv } = await observed(composed.action);
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["ssh", "-s", fixtureSession, "--", "nvidia-smi"]);
});

test("colab exec supports -f, --timeout, and --env", async () => {
  const composed = composeAction({
    command: "exec",
    selected: fixtureSession,
    fields: { file: "/tmp/nb.ipynb", timeout: "60", env: "FOO=1 BAR=2" },
    code: "",
  });
  assert.equal(composed.error, undefined);
  const { result, argv } = await observed(composed.action);
  assert.equal(result.ok, true);
  assert.deepEqual(argv, [
    "exec",
    "-s",
    fixtureSession,
    "--timeout",
    "60",
    "--env",
    "FOO=1",
    "--env",
    "BAR=2",
    "-f",
    "/tmp/nb.ipynb",
  ]);
});

test("colab run supports --keep and forwarded script args", async () => {
  const composed = composeAction({
    command: "run",
    selected: fixtureSession,
    hardware: { gpu: "T4" },
    fields: { script: "/tmp/train.py", args: "--epochs 3", keep: true },
  });
  assert.equal(composed.error, undefined);
  const { result, argv } = await observed(composed.action);
  assert.equal(result.ok, true);
  assert.deepEqual(argv, ["run", "--gpu", "T4", "--keep", "/tmp/train.py", "--epochs", "3"]);
});

test("colab install -r requirements and log export flags", async () => {
  const inst = composeAction({
    command: "install",
    selected: fixtureSession,
    fields: { requirements: "requirements.txt" },
  });
  assert.deepEqual(plan(inst.action).argv, ["install", "-s", fixtureSession, "-r", "requirements.txt"]);

  const log = composeAction({
    command: "log",
    selected: fixtureSession,
    fields: { lines: "20", eventType: "execution", output: "out.ipynb" },
  });
  assert.deepEqual(plan(log.action).argv, [
    "log",
    "-s",
    fixtureSession,
    "-n",
    "20",
    "-t",
    "execution",
    "-o",
    "out.ipynb",
  ]);
});

test("colab version and whoami require no session", async () => {
  const ver = composeAction({ command: "version", selected: null });
  const who = composeAction({ command: "whoami", selected: null });
  assert.deepEqual((await observed(ver.action)).argv, ["version"]);
  assert.deepEqual((await observed(who.action)).argv, ["whoami"]);
});

test("non-zero colab exit is an error", async () => {
  useFakeEnv();
  process.env.COLAB_FAKE_FAIL = "usage";
  try {
    const failed = await runAction({ type: "usage" });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.match(failed.error, /forced failure/);
    assert.equal(failed.state.execStdout, null);
  } finally {
    restoreEnv();
  }
});

test("runAction aborts child process when signal aborts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-abort-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, "colab");
  fs.writeFileSync(wrapper, "#!/bin/bash\nsleep 15\n");
  fs.chmodSync(wrapper, 0o755);
  useFakeEnv();
  process.env.PATH = `${bin}${path.delimiter}${savedEnv.PATH}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);
    const started = Date.now();
    const res = await runAction({ type: "sessions" }, { signal: controller.signal });
    clearTimeout(timer);
    assert.equal(res.ok, false);
    assert.equal(res.error, "cancelled");
    assert.ok(Date.now() - started < 3000);
  } finally {
    restoreEnv();
  }
});

test("missing colab binary is an error", async () => {
  useFakeEnv();
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-missing-"));
  try {
    const missing = await runAction({ type: "sessions" });
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, null);
    assert.match(missing.error, /colab executable not found on PATH/);
    assert.deepEqual(missing.state.sessions, []);
  } finally {
    restoreEnv();
  }
});

test("http session list is the parsed fixture and the page has the three regions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-http-"));
  const bin = installFake(dir);
  const isolatedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-http-state-"));
  const prevStateDir = process.env.COLAB_DESK_STATE_DIR;
  let server;
  try {
    useFakeEnv();
    process.env.COLAB_DESK_STATE_DIR = isolatedStateDir;
    delete process.env.COLAB_FAKE_SESSION;
    delete process.env.COLAB_FAKE_HARDWARE;
    delete process.env.COLAB_FAKE_EXEC;
    process.env.PATH = `${bin}${path.delimiter}${savedEnv.PATH}`;
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const body = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((res) => res.text());
    assert.match(body, /lab-alpha/);
    assert.match(body, /T4/);
    assert.doesNotMatch(body, /"sessions":\[\]/);
    const page = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
    assert.match(page, /data-region="sidebar"/);
    assert.match(page, /data-region="transcript"/);
    assert.match(page, /data-region="composer"/);
    assert.match(page, /data-region="hardware-picker"/);
    assert.match(page, /Hardware picker/);
    assert.match(page, /from "\/desk\.mjs"/);
    assert.match(page, /composeAction\(/);
    assert.match(page, /showSession\(/);
    assert.match(page, /applyNewResult\(/);
    assert.match(page, /id="sidebar-toggle"/);
    assert.match(page, /id="sidebar-open"/);
    assert.match(page, /id="sidebar-resizer"/);
    assert.match(page, /--sidebar-width/);
    assert.match(page, /id="open-new-session"/);
    assert.match(page, /id="new-session-modal"/);
    assert.match(page, /session-menu-close/);
    assert.doesNotMatch(page, /class="start-row"/);
    assert.match(page, /data-region="inspector"/);
    assert.match(page, /id="bar-balance"/);
    assert.match(page, /id="bar-rate"/);
    assert.match(page, /id="bar-uptime"/);
    // Hardware picker lives inside the new-session modal, not the right rail
    const railBlock = page.match(/<aside id="rail"[\s\S]*?<\/aside>/)?.[0] || "";
    const modalBlock = page.match(/<dialog id="new-session-modal"[\s\S]*?<\/dialog>/)?.[0] || "";
    assert.doesNotMatch(railBlock, /data-region="hardware-picker"/);
    assert.match(modalBlock, /data-region="hardware-picker"/);

    const usageRes = await fetch(`http://127.0.0.1:${port}/api/usage`).then((res) => res.json());
    assert.equal(usageRes.ok, true);
    assert.equal(usageRes.state.usage.balance, 310.34);
    assert.equal(usageRes.state.usage.ratePerHour, 1.96);
    assert.equal(usageRes.state.usage.activeAssignments, 1);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status?session=lab-alpha`).then((res) => res.json());
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.state.sessions[0].status, "IDLE");
    assert.match(statusRes.state.sessions[0].lastExecution, /train\.py/);

    const provRes = await fetch(`http://127.0.0.1:${port}/api/agent/providers`).then((res) => res.json());
    assert.equal(provRes.ok, true);
    assert.deepEqual(
      provRes.providers.map((p) => p.id),
      ["agy", "grok", "opencode", "api"],
    );
    const envRes = await fetch(`http://127.0.0.1:${port}/api/env/check`).then((res) => res.json());
    assert.equal(envRes.ok, true);
    assert.equal(typeof envRes.env.colabInstalled, "boolean");
    assert.match(page, /class="settings-shell"/);
    assert.match(page, /data-settings-tab="colab"/);
    assert.match(page, /data-settings-tab="providers"/);
    assert.match(page, /id="env-install-uv-btn"/);
    assert.match(page, /id="env-login-btn"/);
    assert.match(page, /id="rail-toggle"/);
    assert.match(page, /is-rail-collapsed/);
    assert.match(page, /id="setting-language"/);
    assert.match(page, /id="agy-acp-login-btn"/);
    assert.match(page, /from "\/i18n\.mjs"/);
    const i18nJs = await fetch(`http://127.0.0.1:${port}/i18n.mjs`).then((res) => res.text());
    assert.match(i18nJs, /resolveLanguage/);
    const acpAuthRes = await fetch(`http://127.0.0.1:${port}/api/agent/acp-auth?provider=agy`).then((res) => res.json());
    assert.equal(typeof acpAuthRes.installed, "boolean");
    assert.equal(typeof acpAuthRes.authenticated, "boolean");
    assert.match(page, /id="files-modal"/);
    assert.match(page, /id="templates-modal"/);
    assert.match(page, /id="setting-theme"/);
    assert.match(page, /id="agent-thought"/);
    assert.match(page, /id="gpu-section"/);
    assert.match(page, /id="tunnels-section"/);
    assert.match(page, /id="guard-alert-banner"/);
    assert.match(page, /id="view-switch"[^>]*hidden/);
    assert.match(page, /id="view-split-btn"/);
    assert.match(page, /id="view-term-btn"/);
    assert.match(page, /id="terminal-view"/);
    assert.match(page, /id="term-send-agent"/);
    assert.match(page, /id="runner-modal"/);
    assert.match(page, /id="sync-modal"/);
    assert.match(page, /id="cmd-palette-modal"/);
    assert.match(page, /id="env-vars-list"/);
    assert.match(page, /id="boot-hf-transfer"/);
    assert.match(page, /id="files-mode-gallery"/);
    assert.match(page, /id="check-updates-btn"/);
    assert.match(page, /id="bg-snipe-btn"/);
    assert.match(page, /id="snipe-banner"/);
    assert.match(page, /id="snipe-takeover-btn"/);
    assert.match(page, /id="setting-default-high-mem"[^>]*checked/);
    assert.match(page, /id="high-mem"[^>]*checked/);
    assert.match(page, /id="composer-queue"/);
    assert.match(page, /id="busy-mode-toggle"/);
    assert.match(page, /id="queue-send-btn"/);
    assert.match(page, /id="steer-send-btn"/);
    assert.match(page, /id="setting-busy-send-mode"/);
    assert.match(page, /createDottedOrb/);
    assert.match(page, /thought-orb/);
    assert.match(page, /id="tools-dropdown-btn"/);
    assert.match(page, /id="chat-threads-list"/);
    assert.match(page, /#templates-modal,\s*#sync-modal\s*\{\s*height:\s*auto;\s*max-height:/);
    assert.match(page, /chat-thread-dot/);
    assert.match(page, /chat-thread-status/);
    assert.match(page, /undoLastDeletedThread/);
    assert.match(page, /id="undo-toast"/);
    assert.match(page, /\*::-webkit-scrollbar\s*\{[\s\S]*?width:\s*10px;/);
    assert.match(page, /\*::-webkit-scrollbar-thumb\s*\{[\s\S]*?border:\s*3px solid transparent;/);
    assert.match(page, /\*::-webkit-scrollbar-thumb:hover\s*\{[\s\S]*?border-width:\s*1px;/);
    assert.match(page, /\.thought-collapse\s*\{[\s\S]*?grid-template-rows:\s*0fr;/);
    assert.match(page, /\.thought-body\s*\{[\s\S]*?max-height:\s*220px;/);
    assert.match(page, /@keyframes thoughtChunkReveal/);
    assert.match(page, /\.thought-body\.has-fade-top/);
    assert.match(page, /function enqueueThoughtChunk\(/);
    assert.match(page, /id="tunnel-mode-cf"/);
    assert.match(page, /id="tunnel-mode-ssh"/);
    assert.match(page, /tunnel-badge/);
    assert.match(page, /\.staged-img-card/);
    assert.match(page, /\.staged-img-remove/);
    assert.match(page, /function handleComposerPaste\(/);
    assert.match(page, /function openImageLightbox\(/);
    assert.match(page, /__onNativeClipboardImage/);
    assert.match(page, /__onNativeStagedFiles/);

    // Guard against duplicate top-level declarations inside <script type="module"> (which crash Safari/WKWebView)
    const scriptMatch = page.match(/<script type="module">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "expected inline module script");
    const topDecls = new Map();
    for (const line of scriptMatch[1].split(/\r?\n/)) {
      const m = line.match(/^    (?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (!m) continue;
      const name = m[1];
      assert.equal(topDecls.has(name), false, `duplicate top-level function declaration in public/index.html: ${name}`);
      topDecls.set(name, true);
    }

    // Verify image staging + /api/image preview serving (and non-image rejection)
    const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const stageImgRes = await fetch(`http://127.0.0.1:${port}/api/stage-file?name=paste-test.png&mime=image/png`, {
      method: "POST",
      body: pngBytes,
    }).then((r) => r.json());
    assert.equal(stageImgRes.ok, true);
    assert.equal(stageImgRes.isImage, true);
    assert.equal(stageImgRes.mimeType, "image/png");
    assert.match(stageImgRes.previewUrl, /^\/api\/image\?path=/);
    const previewResp = await fetch(`http://127.0.0.1:${port}${stageImgRes.previewUrl}`);
    assert.equal(previewResp.status, 200);
    assert.equal(previewResp.headers.get("content-type"), "image/png");
    const returnedBytes = Buffer.from(await previewResp.arrayBuffer());
    assert.deepEqual(returnedBytes, pngBytes);

    const stageTxtRes = await fetch(`http://127.0.0.1:${port}/api/stage-file?name=notes.txt&mime=text/plain`, {
      method: "POST",
      body: "hello",
    }).then((r) => r.json());
    assert.equal(stageTxtRes.ok, true);
    assert.equal(stageTxtRes.isImage, false);
    const forbiddenPreview = await fetch(`http://127.0.0.1:${port}/api/image?path=${encodeURIComponent(stageTxtRes.path)}`);
    assert.equal(forbiddenPreview.status, 403);

    const multimodal = buildOpenAiUserContent("describe this", [stageImgRes]);
    assert.ok(Array.isArray(multimodal));
    assert.equal(multimodal[0].type, "text");
    assert.equal(multimodal[1].type, "image_url");
    assert.match(multimodal[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(buildOpenAiUserContent("plain", [stageTxtRes]), "plain");
    assert.equal(inferImageMime("foo.webp"), "image/webp");
    assert.equal(inferImageMime("foo.csv"), null);
    try { fs.unlinkSync(stageImgRes.path); } catch {}
    try { fs.unlinkSync(stageTxtRes.path); } catch {}
    assert.match(page, /@container\s*\(max-width:\s*268px\)/);
    assert.match(page, /id="new-chat-thread-btn"/);
    assert.match(page, /function currentTranscriptKey\(\)\s*\{\s*return activeThreadId \|\| "";\s*\}/);
    assert.doesNotMatch(page, /id="reset-chat"/);
    assert.doesNotMatch(page, /id="term-new-local"/);
    assert.match(page, /\/vendor\/xterm\/xterm\.js/);
    const xtermAsset = await fetch(`http://127.0.0.1:${port}/vendor/xterm/xterm.js`);
    assert.equal(xtermAsset.status, 200);
    const termListRes = await fetch(`http://127.0.0.1:${port}/api/terminal/list`).then((res) => res.json());
    assert.equal(termListRes.ok, true);
    assert.deepEqual(termListRes.terminals, []);
    const tunRes = await fetch(`http://127.0.0.1:${port}/api/tunnels`).then((res) => res.json());
    assert.equal(tunRes.ok, true);
    assert.deepEqual(tunRes.tunnels, []);
    const expRes = await fetch(`http://127.0.0.1:${port}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "", format: "ipynb", entries: [{ kind: "agent", prompt: "hello", text: "world", tools: [] }] }),
    }).then((res) => res.json());
    assert.equal(expRes.ok, true);
    assert.match(expRes.content, /"nbformat": 4/);
    assert.match(page, /id="agent-provider"/);
    assert.match(page, /id="agent-model"/);
    assert.match(page, /id="agent-picker-btn"/);
    assert.match(page, /id="agent-picker-menu"/);
    assert.match(page, /\.agent-picker-menu\s*\{[\s\S]*?height:\s*296px;/);
    assert.match(page, /id="ap-providers-list"/);
    assert.match(page, /id="ap-models-list"/);
    assert.match(page, /id="thought-picker-btn"/);
    assert.match(page, /id="mode-notebook"/);
    assert.match(page, /id="notebook-view"/);
    assert.match(page, /id="nb-cells"/);
    assert.match(page, /#composer\[hidden\],\s*#transcript\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    assert.match(page, /#nb-cells\s*\{[\s\S]*?gap:\s*14px;/);
    assert.match(page, /id="nb-vars-toggle"/);
    assert.match(page, /id="api-fetch-models-btn"/);
    assert.match(page, /id="skin-picker-grid"/);
    assert.match(page, /id="quick-skin-btn"/);
    assert.match(page, /data-skin="ocean"/);
    assert.match(page, /data-skin="paper"/);
    assert.match(page, /--toggle-on:/);
    assert.doesNotMatch(page, /#9d68e8/);
    assert.doesNotMatch(page, /color:\s*#dad5ff/);
    assert.match(page, /initUniversalIconTooltips/);
    assert.match(page, /id="open-usage-modal"/);
    assert.match(page, /id="colab-cu-modal"/);
    assert.match(page, /id="open-settings-modal"/);
    assert.match(page, /\/api\/agent\/quota/);
    assert.match(page, /class="sidebar-mini"/);
    assert.match(page, /tool-group/);
    assert.match(page, /\/api\/store/);
    assert.match(page, /isComposing/);
    assert.match(page, /\.workspace\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/);
    assert.match(page, /\.entry\.fail\s+\.error\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
    assert.match(page, /\.meter-row\s*\{[^}]*grid-template-columns:\s*minmax\(78px,\s*1fr\)\s+82px\s+74px;/);
    assert.match(page, /#transcript\s*\{[^}]*flex:\s*1\s+1\s+0;/);
    assert.match(page, /resize:\s*none;/);
    assert.doesNotMatch(page, /resize:\s*vertical;/);

    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-store-"));
    const prevStoreDir = process.env.COLAB_DESK_STATE_DIR;
    process.env.COLAB_DESK_STATE_DIR = storeDir;
    try {
      const putRes = await fetch(`http://127.0.0.1:${port}/api/store`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          history: { "lab-alpha": [{ kind: "agent", label: "hi", text: "hello" }] },
          usageStats: { turns: 2, inputTokens: 100, outputTokens: 50 },
          settings: { enterToSend: true },
        }),
      }).then((res) => res.json());
      assert.equal(putRes.ok, true);
      const getRes = await fetch(`http://127.0.0.1:${port}/api/store`).then((res) => res.json());
      assert.equal(getRes.ok, true);
      assert.equal(getRes.data.history["lab-alpha"][0].text, "hello");
      assert.equal(getRes.data.usageStats.turns, 2);
      assert.equal(getRes.data.settings.enterToSend, true);
    } finally {
      if (prevStoreDir === undefined) delete process.env.COLAB_DESK_STATE_DIR;
      else process.env.COLAB_DESK_STATE_DIR = prevStoreDir;
    }

    const staged = await fetch(`http://127.0.0.1:${port}/api/stage-file?name=demo.csv`, {
      method: "POST",
      body: "a,b\n1,2\n",
    }).then((res) => res.json());
    assert.equal(staged.ok, true);
    assert.equal(staged.name, "demo.csv");
    assert.equal(fs.readFileSync(staged.path, "utf8"), "a,b\n1,2\n");
    const deskSource = await fetch(`http://127.0.0.1:${port}/desk.mjs`).then((res) => res.text());
    assert.match(deskSource, /export function composeAction/);
    assert.match(deskSource, /export function showSession/);
    for (const name of ["T4", "L4", "G4", "H100", "A100", "v5e1", "v6e1", "high-mem"]) {
      assert.match(page, new RegExp(name));
    }

    process.env.COLAB_FAKE_FAIL = "status";
    const failed = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "status", session: "lab-alpha" }),
    }).then((res) => res.json());
    assert.equal(failed.ok, false);
    assert.match(failed.error, /forced failure/);
  } finally {
    if (server) server.close();
    if (prevStateDir === undefined) delete process.env.COLAB_DESK_STATE_DIR;
    else process.env.COLAB_DESK_STATE_DIR = prevStateDir;
    restoreEnv();
  }
});

function startEntry(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: root,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
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
      reject(new Error(`entry did not listen\n${buf}`));
    }, 8000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: match[1] });
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
  });
}

function stopEntry(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000);
  });
}

test("real entry returns the same session list on two launches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-launch-"));
  const bin = installFake(dir);
  const bodies = [];
  let page = "";
  for (let i = 0; i < 2; i += 1) {
    const { child, url } = await startEntry(bin);
    try {
      const response = await fetch(`${url}/api/sessions`);
      bodies.push(await response.text());
      if (i === 0) page = await fetch(url).then((res) => res.text());
    } finally {
      await stopEntry(child);
    }
  }
  assert.equal(bodies[0], bodies[1]);
  assert.match(bodies[0], /lab-alpha/);
  assert.match(bodies[0], /T4/);
  assert.doesNotMatch(bodies[0], /"sessions":\[\]/);
  assert.match(page, /data-region="sidebar"/);
  assert.match(page, /data-region="transcript"/);
  assert.match(page, /data-region="composer"/);
  assert.match(page, /data-region="hardware-picker"/);
});

test("agent parsers handle ACP updates, model catalogs, and Grok NDJSON events", () => {
  const models = extractAcpModels({
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gemini-4-neon",
        options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
      },
    ],
  });
  assert.equal(models.current, "gemini-4-neon");
  assert.equal(models.models.length, 1);

  assert.deepEqual(
    parseAcpSessionUpdate({
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } },
    }),
    { type: "text", text: "你好" },
  );

  const tc = parseAcpSessionUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "colab exec",
      status: "in_progress",
      rawInput: { cmd: "colab exec -s lab" },
    },
  });
  assert.equal(tc.type, "tool_call");
  assert.equal(tc.toolCallId, "t1");

  assert.deepEqual(parseGrokEvent({ type: "text", data: "收到" }), { type: "text", text: "收到" });
  assert.deepEqual(parseGrokEvent({ type: "thought", data: "正在思考" }), { type: "thought", text: "正在思考" });
  const end = parseGrokEvent({ type: "end", sessionId: "grok-sid-1", usage: { total_tokens: 10 } });
  assert.equal(end.type, "grok_end");
  assert.equal(end.sessionId, "grok-sid-1");

  const rules = buildColabSystemRules({ colabSession: "gpu-1", sessionInfo: { hardware: "T4" } });
  assert.match(rules, /-s gpu-1/);
  assert.match(rules, /T4/);

  const turn = formatTurnPrompt("画个图", {
    colabSession: "gpu-1",
    files: [{ name: "data.csv", path: "/tmp/colab-desk-uploads/data.csv" }],
  });
  assert.match(turn, /data\.csv/);
  assert.match(turn, /画个图/);

  const quota = parseAgyQuotaJson(
    JSON.stringify({
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-5h", name: "Five Hour", window: "5h", remaining_fraction: 0.965, reset_time: "2026-11-25T06:29:08Z" },
                { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.726, reset_time: "2026-12-01T02:10:13Z" },
              ],
            },
          ],
        },
      },
    }),
  );
  assert.equal(quota.ok, true);
  assert.equal(quota.buckets.length, 2);
  assert.equal(quota.buckets[0].remainingPct, 97);
  assert.equal(quota.buckets[1].remainingPct, 73);

  const grokB = parseGrokBillingPayload({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-25T07:22:34Z" },
      creditUsagePercent: 58.0,
      productUsage: [{ product: "GrokBuild", usagePercent: 56.0 }, { product: "GrokChat", usagePercent: 1.0 }],
    },
  });
  assert.equal(grokB.usedPct, 58);
  assert.equal(grokB.remainingPct, 42);
  assert.equal(grokB.window, "Weekly");
  assert.equal(grokB.products.length, 2);

  const who = parseWhoami("Auth provider: oauth2\nEmail:         user@example.com\nExpires in:    59m\nScopes:\n  - email\n  - openid\n");
  assert.equal(who.loggedIn, true);
  assert.equal(who.authProvider, "oauth2");
  assert.equal(who.email, "user@example.com");
  assert.deepEqual(who.scopes, ["email", "openid"]);

  assert.equal(resolveLanguage("auto", "zh-CN"), "zh-CN");
  assert.equal(resolveLanguage("auto", "zh-Hans-CN"), "zh-CN");
  assert.equal(resolveLanguage("auto", "en-US"), "en");
  assert.equal(resolveLanguage("auto", "ja-JP"), "en");
  assert.equal(resolveLanguage("en", "zh-CN"), "en");
  assert.equal(resolveLanguage("zh-CN", "en-US"), "zh-CN");
  assert.equal(t("en", "settings.tab.general"), "General");
  assert.equal(t("zh-CN", "settings.tab.general"), "通用");

  const gpus = parseNvidiaSmi("NVIDIA L4, 4210, 23034, 67, 58\n");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, "NVIDIA L4");
  assert.equal(gpus[0].memUsedMb, 4210);
  assert.equal(gpus[0].memTotalMb, 23034);
  assert.equal(gpus[0].utilPct, 67);
  assert.equal(gpus[0].tempC, 58);

  const nb = JSON.parse(buildNotebookFromHistory("gpu-1", [{ kind: "agent", prompt: "test", text: "ok", tools: [{ title: "exec", input: "print(1)", output: "1" }] }]));
  assert.equal(nb.nbformat, 4);
  assert.ok(nb.cells.length >= 3);
  const md = buildMarkdownFromHistory("gpu-1", [{ kind: "agent", prompt: "test", text: "ok", tools: [] }]);
  assert.match(md, /# Colab Desk Export — gpu-1/);

  const procs = parseGpuProcesses("1234, /usr/bin/python3, 8192\n5678, vllm, 12000\n");
  assert.equal(procs.length, 2);
  assert.equal(procs[0].pid, 1234);
  assert.equal(procs[0].name, "python3");
  assert.equal(procs[0].memMb, 8192);

  const ports = parseListeningPorts("22\n7860\n8188\n6000\n11434\n45000\n");
  assert.deepEqual(ports, [7860, 8188, 11434]);

  assert.deepEqual(extractTemplateParams("echo {{prompt}} {{seed}} {{prompt}}"), ["prompt", "seed"]);
  assert.equal(renderParameterizedScript("run {{prompt}} --seed {{seed}}", { prompt: "sunset", seed: 42 }), "run sunset --seed 42");
  assert.equal(parseReleaseTagFromUrl("https://github.com/CalicoX/colab-desk/releases/tag/v0.2.1"), "0.2.1");
  assert.equal(compareSemver("0.2.0", "0.1.0"), 1);
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
  const richTraceback = "╭── Traceback (most recent call last) ──╮\n| colab_cli/client.py:238 |\n╰──╯\nColabRequestError: Failed to issue request POST https://colab.research.google.com/tun/m/assign: Service Unavailable";
  assert.doesNotMatch(summarizeColabError(richTraceback, "zh-CN"), /Traceback/);
  assert.match(summarizeColabError(richTraceback, "zh-CN"), /稍后再试/);
  assert.equal(isRetryableColabError(richTraceback), true);
  assert.equal(isRetryableColabError("TooManyAssignmentsError: limit reached"), false);
  const agentSource = fs.readFileSync(path.join(root, "src/agent.mjs"), "utf8");
  assert.match(agentSource, /bypassPermissions/);
  const spec = parseColabNewSpec('{"command":"colab new -s A100 --gpu A100 --high-mem"}');
  assert.deepEqual(spec, { name: "A100", hw: { gpu: "A100", tpu: null, highMem: true }, hwLabel: "A100 + high-mem" });
  const grokTc = parseGrokEvent({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "run_terminal_command",
    rawInput: { command: "colab new -s A100 --gpu A100" },
  });
  assert.equal(grokTc.toolCallId, "c1");
  assert.match(grokTc.title, /colab new -s A100/);
  const grokTu = parseGrokEvent({
    type: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    rawOutput: { exit_code: 1, output_for_prompt: "503 Service Unavailable" },
  });
  assert.equal(grokTu.status, "failed");
  const handoff = buildContextHandoffPrompt(
    [{ label: "Check GPU", tools: [{ title: "nvidia-smi", status: "completed" }], text: "A100 40GB ready" }],
    "Now install ComfyUI",
    "Grok",
    "AGY",
    "en",
  );
  assert.match(handoff, /Model Context Handoff \(Grok -> AGY\)/);
  assert.match(handoff, /A100 40GB ready/);
  assert.match(handoff, /Now install ComfyUI/);
});

test("custom OpenAI-compatible gateway resolves /v1, handles non-SSE JSON, retries without stream_options, and surfaces errors", async () => {
  assert.deepEqual(resolveOpenAiChatEndpoints("http://127.0.0.1:18765"), [
    "http://127.0.0.1:18765/v1/chat/completions",
    "http://127.0.0.1:18765/chat/completions",
  ]);
  assert.deepEqual(resolveOpenAiChatEndpoints("http://127.0.0.1:18765/v1/"), [
    "http://127.0.0.1:18765/v1/chat/completions",
  ]);
  assert.deepEqual(resolveOpenAiChatEndpoints("http://127.0.0.1:18765/v1/chat/completions"), [
    "http://127.0.0.1:18765/v1/chat/completions",
  ]);

  const parsedJson = parseOpenAiJsonCompletion({
    choices: [{ message: { content: "hello", reasoning_content: "thinking" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(parsedJson.text, "hello");
  assert.equal(parsedJson.thought, "thinking");
  assert.equal(parsedJson.usage.inputTokens, 10);

  let receivedPaths = [];
  let sawNoStreamOptions = false;
  const mockGw = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      receivedPaths.push(req.url);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (req.url === "/v1/chat/completions") {
        if (body.stream_options) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "stream_options not supported" } }));
          return;
        }
        sawNoStreamOptions = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Gateway OK!", reasoning_content: "checked" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });

  await new Promise((resolve) => mockGw.listen(0, "127.0.0.1", resolve));
  const { port } = mockGw.address();
  const prevStateDir = process.env.COLAB_DESK_STATE_DIR;
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-gw-test-"));
  process.env.COLAB_DESK_STATE_DIR = tmpStateDir;
  fs.writeFileSync(
    path.join(tmpStateDir, "state.json"),
    JSON.stringify({
      settings: {
        apiProfiles: [{
          id: "gw1",
          label: "LocalGW",
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: "",
          model: "glm-5.3-flash",
        }],
      },
    }),
  );

  try {
    const mgr = new AgentManager(tmpStateDir);
    const testRes = await mgr.testApiConfig({ baseUrl: `http://127.0.0.1:${port}`, model: "glm-5.3-flash" });
    assert.equal(testRes.ok, true);
    assert.equal(testRes.endpoint, `http://127.0.0.1:${port}/v1/chat/completions`);

    const events = [];
    await mgr.runChat(
      { provider: "api:gw1", model: "glm-5.3-flash", prompt: "test", chatThreadId: "t-gw" },
      (ev) => events.push(ev),
    );
    assert.equal(sawNoStreamOptions, true);
    assert.ok(receivedPaths.includes("/v1/chat/completions"));
    assert.equal(events.find((e) => e.type === "error"), undefined);
    assert.equal(events.filter((e) => e.type === "thought").map((e) => e.text).join(""), "checked");
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Gateway OK!");
    assert.ok(events.some((e) => e.type === "done" && e.stopReason === "end_turn"));
  } finally {
    mockGw.close();
    if (prevStateDir === undefined) delete process.env.COLAB_DESK_STATE_DIR;
    else process.env.COLAB_DESK_STATE_DIR = prevStateDir;
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
});

test("gateway /v1/models discovery and .ipynb parse/serialize round-trip work cleanly", async () => {
  assert.deepEqual(resolveOpenAiModelsEndpoints("http://127.0.0.1:18765"), [
    "http://127.0.0.1:18765/v1/models",
    "http://127.0.0.1:18765/models",
  ]);
  assert.deepEqual(resolveOpenAiModelsEndpoints("http://127.0.0.1:18765/v1/chat/completions"), [
    "http://127.0.0.1:18765/v1/models",
  ]);

  const mockModelsSrv = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "glm-5-flash" }, { id: "deepseek-r1" }, { id: "glm-5-flash" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockModelsSrv.listen(0, "127.0.0.1", resolve));
  const { port } = mockModelsSrv.address();
  try {
    const res = await fetchOpenAiModels({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-key" });
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.models.map((m) => m.value),
      ["deepseek-r1", "glm-5-flash"],
    );
  } finally {
    mockModelsSrv.close();
  }

  const rawNb = serializeIpynb([
    { type: "markdown", source: "# Hello\nWorld" },
    {
      type: "code",
      source: "print(42)",
      executionCount: 3,
      stdout: "42\n",
      stderr: "",
      images: [{ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
    },
  ]);
  const parsed = parseIpynb(rawNb);
  assert.equal(parsed.cells.length, 2);
  assert.equal(parsed.cells[0].type, "markdown");
  assert.equal(parsed.cells[0].source, "# Hello\nWorld");
  assert.equal(parsed.cells[1].executionCount, 3);
  assert.equal(parsed.cells[1].stdout, "42\n");
  assert.equal(parsed.cells[1].images.length, 1);
  assert.match(parsed.cells[1].images[0].dataUrl, /^data:image\/png;base64,/);

  assert.equal(
    extractTryCloudflareUrl("2026-11-25 INF |  https://gentle-river-42.trycloudflare.com  |"),
    "https://gentle-river-42.trycloudflare.com",
  );
  assert.equal(extractTryCloudflareUrl("no tunnel url here"), null);
  assert.deepEqual(parseListeningPorts("22\n2222\n8188\n7860\n9000\n"), [7860, 8188]);
});

test("mac app does not start a login shell", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const swift = fs.readFileSync(path.join(root, "macos/ColabDesk.swift"), "utf8");
  const plist = fs.readFileSync(path.join(root, "macos/Info.plist"), "utf8");
  assert.match(plist, new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${pkg.version.replace(/\./g, "\\.")}</string>`));
  assert.match(plist, new RegExp(`<key>CFBundleVersion</key>\\s*<string>${pkg.version.replace(/\./g, "\\.")}</string>`));
  assert.doesNotMatch(swift, /zsh -lic|\/bin\/zsh/);
  assert.match(swift, /SIGTERM/);
  assert.match(swift, /WKWebView/);
  assert.match(swift, /WKUIDelegate/);
  assert.match(swift, /runOpenPanelWith/);
  assert.match(swift, /WKDownloadDelegate/);
  assert.match(swift, /windowZoom/);
  assert.match(swift, /toggleFillScreen/);
  assert.match(swift, /visibleFrame/);
  assert.match(swift, /clipboardImage/);
  assert.match(swift, /pasteFromMenu/);
  assert.match(swift, /installPasteKeyMonitor/);
  assert.match(swift, /addLocalMonitorForEvents/);
  assert.match(swift, /NSPasteboard/);
  assert.match(plist, /com\.calicox\.colab-desk/);
  assert.match(plist, /ColabDesk/);
  assert.match(plist, /CFBundleIconFile/);
  assert.match(plist, /AppIcon/);
});

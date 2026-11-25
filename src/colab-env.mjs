import { spawn } from "node:child_process";
import { findExecutable } from "./agent.mjs";

export function parseWhoami(text) {
  const raw = String(text || "");
  const providerMatch = raw.match(/Auth provider:\s*(.+)/i);
  const emailMatch = raw.match(/Email:\s*(.+)/i);
  const expiresMatch = raw.match(/Expires in:\s*(.+)/i);
  const scopes = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m) scopes.push(m[1].trim());
  }
  const email = emailMatch ? emailMatch[1].trim() : null;
  const authProvider = providerMatch ? providerMatch[1].trim() : null;
  const expiresIn = expiresMatch ? expiresMatch[1].trim() : null;
  return {
    loggedIn: Boolean(email || authProvider),
    authProvider,
    email,
    expiresIn,
    scopes,
  };
}

function runCapture(exe, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = options.signal;
  return new Promise((resolve) => {
    let settled = false;
    let onAbort = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve(res);
    };

    if (signal && signal.aborted) {
      finish({ ok: false, exitCode: null, stdout: "", stderr: "cancelled" });
      return;
    }

    let child;
    try {
      child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ ok: false, exitCode: null, stdout: "", stderr: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ ok: false, exitCode: null, stdout, stderr: stderr || "命令执行超时" });
    }, timeoutMs);
    timer.unref();

    if (signal) {
      onAbort = () => {
        try { child.kill("SIGTERM"); } catch {}
        finish({ ok: false, exitCode: null, stdout, stderr: "cancelled" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish({ ok: false, exitCode: null, stdout, stderr: err.message }));
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, stdout, stderr }));
  });
}

export async function checkColabEnvironment() {
  const colabPath = findExecutable("colab");
  const uvPath = findExecutable("uv");
  const pipPath = findExecutable("pip3") || findExecutable("pip");
  const pythonPath = findExecutable("python3") || findExecutable("python");

  if (!colabPath) {
    return {
      colabInstalled: false,
      colabPath: null,
      colabVersion: null,
      loggedIn: false,
      authProvider: null,
      email: null,
      expiresIn: null,
      scopes: [],
      hasUv: Boolean(uvPath),
      uvPath,
      hasPip: Boolean(pipPath),
      pipPath,
      hasPython: Boolean(pythonPath),
      error: "未在 PATH 中找到 colab 命令（需安装 google-colab-cli）",
    };
  }

  const [verRes, whoRes] = await Promise.all([
    runCapture(colabPath, ["version"], { timeoutMs: 8_000 }),
    runCapture(colabPath, ["whoami"], { timeoutMs: 10_000 }),
  ]);

  const versionMatch = (verRes.stdout || verRes.stderr || "").match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  const colabVersion = versionMatch ? versionMatch[1] : (verRes.stdout || "").trim() || null;
  const who = whoRes.ok ? parseWhoami(whoRes.stdout) : { loggedIn: false, authProvider: null, email: null, expiresIn: null, scopes: [] };

  return {
    colabInstalled: true,
    colabPath,
    colabVersion,
    loggedIn: who.loggedIn,
    authProvider: who.authProvider,
    email: who.email,
    expiresIn: who.expiresIn,
    scopes: who.scopes,
    hasUv: Boolean(uvPath),
    uvPath,
    hasPip: Boolean(pipPath),
    pipPath,
    hasPython: Boolean(pythonPath),
    error: who.loggedIn ? null : ((whoRes.stderr || whoRes.stdout || "尚未登录 Google Colab 账号").trim()),
  };
}

export async function installColabCli(method = "auto", signal) {
  const uvPath = findExecutable("uv");
  const pipPath = findExecutable("pip3") || findExecutable("pip");

  let exe = null;
  let args = [];
  let commandLabel = "";

  if ((method === "uv" || method === "auto") && uvPath) {
    exe = uvPath;
    args = ["tool", "install", "google-colab-cli"];
    commandLabel = "uv tool install google-colab-cli";
  } else if ((method === "pip" || method === "auto") && pipPath) {
    exe = pipPath;
    args = ["install", "--user", "google-colab-cli"];
    commandLabel = "pip3 install --user google-colab-cli";
  } else {
    return {
      ok: false,
      command: "",
      output: "",
      error: "未检测到 uv 或 pip3，请先在终端安装 uv（brew install uv）或 Python 3。",
    };
  }

  const res = await runCapture(exe, args, { timeoutMs: 180_000, signal });
  const env = await checkColabEnvironment();
  return {
    ok: res.ok && env.colabInstalled,
    command: commandLabel,
    output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim(),
    error: res.ok ? null : (res.stderr || res.stdout || "安装失败").trim(),
    env,
  };
}

export async function loginColabCli(signal) {
  const colabPath = findExecutable("colab");
  if (!colabPath) {
    return { ok: false, error: "尚未安装 colab CLI，请先安装。", output: "" };
  }
  const res = await runCapture(colabPath, ["--auth=oauth2", "sessions"], {
    timeoutMs: 180_000,
    signal,
  });
  const env = await checkColabEnvironment();
  return {
    ok: res.ok || env.loggedIn,
    output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim(),
    error: res.ok || env.loggedIn ? null : (res.stderr || res.stdout || "登录未完成").trim(),
    env,
  };
}

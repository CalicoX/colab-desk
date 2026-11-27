import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runAction } from "../run.mjs";

export const EXPORT_DIR = path.join(os.tmpdir(), "colab-desk-exports");
export const DOWNLOAD_DIR = path.join(os.tmpdir(), "colab-desk-downloads");
export const MEDIA_DIR = path.join(os.tmpdir(), "colab-desk-media");
export const SYNC_DIR = path.join(os.tmpdir(), "colab-desk-sync");
export const NOTEBOOK_DIR = path.join(os.tmpdir(), "colab-desk-notebooks");

export function buildRemotePythonCmd(pyCode) {
  const pyB64 = Buffer.from(pyCode, "utf8").toString("base64");
  return `python3 -c "import base64; exec(base64.b64decode('${pyB64}').decode())"`;
}

export async function runRemotePythonSsh(session, pyCode, options = {}) {
  return runAction({ type: "ssh", session, command: buildRemotePythonCmd(pyCode) }, options);
}

export async function runRemotePython(session, pyCode, timeoutSec = 45, options = {}) {
  const sshRes = await runRemotePythonSsh(session, pyCode, options);
  if (sshRes.ok && String(sshRes.stdout || "").trim()) {
    return sshRes;
  }
  const execRes = await runAction({ type: "exec", session, code: pyCode, timeout: timeoutSec }, options);
  return execRes.ok ? execRes : (sshRes.stderr ? sshRes : execRes);
}

export function parseLastJsonLine(stdout, predicate = Boolean) {
  const lines = String(stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (predicate(parsed)) return parsed;
    } catch {}
  }
  return null;
}

export function sanitizeFilename(name, fallback = "file") {
  return String(name || fallback).replace(/[^\w.-]+/g, "_");
}

export function expandHomePath(dirPath) {
  return path.resolve(String(dirPath || "").replace(/^~(?=\/|$)/, os.homedir()));
}

export function runLocalCommand(exe, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve({ ok: false, stdout, stderr: "timeout" });
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
  });
}

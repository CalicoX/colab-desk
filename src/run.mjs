import { spawn } from "node:child_process";
import { plan } from "./plan.mjs";
import { emptyState, parseCommandOutput } from "./parse.mjs";

function failed(error) {
  return {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    error,
    argv: [],
    state: emptyState(),
  };
}

export function spawnColab(planned, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const signal = options && options.signal;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    let child;
    let onAbort = null;
    if (signal && signal.aborted) {
      finish({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "cancelled",
        argv: planned.argv,
        state: emptyState(),
      });
      return;
    }

    try {
      child = spawn("colab", planned.argv, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const missing = err && err.code === "ENOENT";
      finish(failed(missing ? "colab executable not found on PATH" : err.message));
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    if (signal) {
      onAbort = () => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 500).unref();
        } catch {}
        finish({
          ok: false,
          exitCode: null,
          stdout,
          stderr,
          error: "cancelled",
          argv: planned.argv,
          state: emptyState(),
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      const missing = err && err.code === "ENOENT";
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        error: missing ? "colab executable not found on PATH" : err.message,
        argv: planned.argv,
        state: emptyState(),
      });
    });
    child.on("close", (code) => {
      const command = planned.argv[0];
      const ok = code === 0;
      finish({
        ok,
        exitCode: code,
        stdout,
        stderr,
        error: ok ? null : stderr.trim() || stdout.trim() || `colab exited with code ${code}`,
        argv: planned.argv,
        state: parseCommandOutput(command, stdout),
      });
    });

    child.stdin.on("error", () => {});
    try {
      if (planned.stdin != null && planned.stdin !== "") child.stdin.write(planned.stdin);
      child.stdin.end();
    } catch {
      // The process may already be gone (missing binary). The error handler reports it.
    }
  });
}

export async function runAction(action, options = {}) {
  let planned;
  try {
    planned = plan(action);
  } catch (err) {
    return failed(err.message);
  }
  return spawnColab(planned, options);
}

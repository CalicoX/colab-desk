// Minimal local git helper for notebooks. argv-array spawn only, no shell, no login shell,
// restricted subcommand allowlist (no push / fetch / reset / checkout / clean ...).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED = new Set(["rev-parse", "status", "branch", "add", "commit", "show", "log"]);
const MAX_OUT = 8_000_000;

export function expandHome(p) {
  const s = String(p || "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Validate the user-chosen directory: absolute, existing, a directory. Returns realpath. */
export function resolveDir(input) {
  const raw = expandHome(input);
  if (!raw || raw.includes("\0")) throw new Error("Invalid directory");
  if (!path.isAbsolute(raw)) throw new Error("Directory must be an absolute path");
  let real;
  try { real = fs.realpathSync(raw); } catch { throw new Error("Directory does not exist"); }
  if (!fs.statSync(real).isDirectory()) throw new Error("Not a directory");
  return real;
}

/** Validate a notebook path relative to dir; returns { rel, abs }. */
export function resolveNotebookPath(dir, file) {
  const rel = String(file || "").replace(/\\/g, "/").trim();
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || rel.startsWith("-")) throw new Error("Invalid notebook path");
  const segs = rel.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "" || s.toLowerCase() === ".git")) throw new Error("Invalid notebook path");
  if (!rel.toLowerCase().endsWith(".ipynb")) throw new Error("Only .ipynb files are allowed");
  const abs = path.join(dir, rel);
  // Guard against symlinked parents escaping the chosen directory.
  let parent = path.dirname(abs);
  while (!fs.existsSync(parent) && parent !== dir) parent = path.dirname(parent);
  const realParent = fs.realpathSync(parent);
  if (realParent !== dir && !realParent.startsWith(dir + path.sep)) throw new Error("Path escapes the chosen directory");
  return { rel, abs };
}

export function runGit(dir, args, { timeoutMs = 20_000, bin = "git" } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(args) || !ALLOWED.has(args[0])) {
      resolve({ ok: false, code: -1, stdout: "", stderr: `git subcommand not allowed: ${args?.[0]}` });
      return;
    }
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
      HOME: process.env.HOME || os.homedir(),
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: dir, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: "", stderr: err.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, code: -1, stdout, stderr: "git timed out" }); }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 100_000) stderr += d; });
    child.on("error", (err) => finish({ ok: false, code: -1, stdout, stderr: err.code === "ENOENT" ? "git not found" : err.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

export async function gitStatus(dirInput) {
  const dir = resolveDir(dirInput);
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: true, isRepo: false, dir, error: top.stderr.trim() };
  const branchRes = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const st = await runGit(dir, ["status", "--porcelain=v1", "-b", "--untracked-files=normal"]);
  const lines = st.stdout.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
  const files = lines.map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  return {
    ok: true,
    isRepo: true,
    dir,
    root: top.stdout.trim(),
    branch: branchRes.ok ? branchRes.stdout.trim() : head.split("...")[0],
    tracking: head,
    files,
    clean: files.length === 0,
  };
}

/** Content of `rev:file` (file relative to dir). */
export async function gitShowFile(dirInput, file, rev = "HEAD") {
  const dir = resolveDir(dirInput);
  const { rel } = resolveNotebookPath(dir, file);
  if (!/^[A-Za-z0-9_./~^@-]{1,100}$/.test(rev) || rev.startsWith("-")) throw new Error("Invalid revision");
  const r = await runGit(dir, ["show", `${rev}:./${rel}`]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "git show failed" };
  return { ok: true, content: r.stdout };
}

/** Write the notebook into the repo, stage and commit only that file. Never pushes. */
export async function gitCommitNotebook(dirInput, file, content, message) {
  const dir = resolveDir(dirInput);
  const { rel, abs } = resolveNotebookPath(dir, file);
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, error: "Commit message is required" };
  if (msg.length > 500 || msg.includes("\0")) return { ok: false, error: "Invalid commit message" };
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: false, error: "Not a git repository" };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ""), "utf8");
  const add = await runGit(dir, ["add", "--", rel]);
  if (!add.ok) return { ok: false, error: add.stderr.trim() || "git add failed" };
  const commit = await runGit(dir, ["commit", "--only", "-m", msg, "--", rel]);
  if (!commit.ok) {
    const text = `${commit.stdout}\n${commit.stderr}`.trim();
    if (/nothing (added )?to commit|no changes added/i.test(text)) return { ok: true, committed: false, message: "Nothing to commit (no changes)", staged: true };
    return { ok: false, error: text || "git commit failed" };
  }
  const log = await runGit(dir, ["log", "-1", "--format=%h %s"]);
  return { ok: true, committed: true, commit: log.stdout.trim(), path: rel };
}

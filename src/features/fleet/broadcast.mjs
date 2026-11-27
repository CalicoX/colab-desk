import { spawn } from "node:child_process";
import { plan } from "../../plan.mjs";

const MAX_OUTPUT = 200_000;

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Runs one command on many sessions through the official colab CLI, streaming output. */
export class BroadcastManager {
  constructor({ emit, spawnFn = spawn, now = () => Date.now() } = {}) {
    this.emit = emit || (() => {});
    this.spawnFn = spawnFn;
    this.now = now;
    this.jobs = new Map();
    this.seq = 0;
  }

  _publicJob(job) {
    return {
      id: job.id,
      mode: job.mode,
      command: job.command,
      timeout: job.timeout,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      done: job.done,
      cancelled: job.cancelled,
      sessions: Object.fromEntries(
        Object.entries(job.sessions).map(([k, s]) => [k, {
          status: s.status, exitCode: s.exitCode, output: s.output, error: s.error,
          startedAt: s.startedAt, endedAt: s.endedAt,
        }]),
      ),
    };
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this._publicJob(job) : null;
  }

  start({ sessions, mode = "ssh", command, timeout = 120, concurrency = 4 }) {
    const names = Array.from(new Set((sessions || []).map((s) => String(s || "").trim()).filter(Boolean)));
    if (names.length === 0) throw new Error("no sessions selected");
    if (typeof command !== "string" || !command.trim()) throw new Error("command is required");
    if (mode !== "ssh" && mode !== "exec") throw new Error("mode must be ssh or exec");
    const to = Math.min(3600, Math.max(1, Number(timeout) || 120));
    const id = `bc-${this.now().toString(36)}-${(++this.seq).toString(36)}`;
    const job = {
      id, mode, command, timeout: to, startedAt: this.now(), finishedAt: null,
      done: false, cancelled: false, children: new Map(),
      sessions: Object.fromEntries(names.map((n) => [n, {
        status: "queued", exitCode: null, output: "", error: null, startedAt: null, endedAt: null,
      }])),
    };
    this.jobs.set(id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value);
    job.promise = this._run(job, names, Math.min(8, Math.max(1, Number(concurrency) || 4)));
    return this._publicJob(job);
  }

  async _run(job, names, concurrency) {
    await mapLimit(names, concurrency, (name) => this._runOne(job, name));
    job.done = true;
    job.finishedAt = this.now();
    this.emit("fleet:done", { id: job.id, job: this._publicJob(job) });
  }

  _setStatus(job, name, patch) {
    Object.assign(job.sessions[name], patch);
    this.emit("fleet:status", { id: job.id, session: name, status: job.sessions[name].status, exitCode: job.sessions[name].exitCode, error: job.sessions[name].error });
  }

  _runOne(job, name) {
    const rec = job.sessions[name];
    if (job.cancelled) {
      this._setStatus(job, name, { status: "cancelled", endedAt: this.now() });
      return Promise.resolve();
    }
    let planned;
    try {
      planned = plan(job.mode === "ssh"
        ? { type: "ssh", session: name, command: job.command }
        : { type: "exec", session: name, code: job.command, timeout: job.timeout });
    } catch (err) {
      this._setStatus(job, name, { status: "failed", error: err.message, endedAt: this.now() });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let finished = false;
      let timedOut = false;
      let child;
      const finish = (patch) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        job.children.delete(name);
        this._setStatus(job, name, { ...patch, endedAt: this.now() });
        resolve();
      };
      const onChunk = (stream) => (chunk) => {
        const text = String(chunk);
        if (rec.output.length < MAX_OUTPUT) rec.output += text.slice(0, MAX_OUTPUT - rec.output.length);
        this.emit("fleet:output", { id: job.id, session: name, stream, chunk: text });
      };
      let timer = null;
      try {
        child = this.spawnFn("colab", planned.argv, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        finish({ status: "failed", error: err.message });
        return;
      }
      job.children.set(name, child);
      rec.startedAt = this.now();
      this._setStatus(job, name, { status: "running" });
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500).unref?.();
      }, job.timeout * 1000);
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on("data", onChunk("stdout"));
      child.stderr?.on("data", onChunk("stderr"));
      child.on("error", (err) => finish({
        status: "failed", error: err.code === "ENOENT" ? "colab executable not found on PATH" : err.message,
      }));
      child.on("close", (code) => {
        if (job.cancelled) finish({ status: "cancelled", exitCode: code });
        else if (timedOut) finish({ status: "timeout", exitCode: code, error: `timeout after ${job.timeout}s` });
        else finish({ status: code === 0 ? "ok" : "failed", exitCode: code, error: code === 0 ? null : `exit ${code}` });
      });
      child.stdin?.on?.("error", () => {});
      try {
        if (planned.stdin) child.stdin.write(planned.stdin);
        child.stdin.end();
      } catch {}
    });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.cancelled = true;
    for (const child of job.children.values()) {
      try { child.kill("SIGTERM"); } catch {}
    }
    for (const [name, rec] of Object.entries(job.sessions)) {
      if (rec.status === "queued") this._setStatus(job, name, { status: "cancelled", endedAt: this.now() });
    }
    return this._publicJob(job);
  }

  rerunFailed(id, concurrency) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const failed = Object.entries(job.sessions)
      .filter(([, s]) => ["failed", "timeout", "cancelled"].includes(s.status))
      .map(([n]) => n);
    if (failed.length === 0) return { empty: true };
    return this.start({ sessions: failed, mode: job.mode, command: job.command, timeout: job.timeout, concurrency });
  }

  shutdown() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }
}

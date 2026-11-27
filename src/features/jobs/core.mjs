import { parseProgress } from "./progress.mjs";
import { deliver, maskEndpoint, validateEndpoint, KINDS, DEFAULT_TEMPLATE } from "./webhooks.mjs";

export const JOBS_ROOT = "/content/.colab-desk/jobs";
const ID_RE = /^[a-z0-9-]{6,40}$/;
const MAX_TAIL = 65536;
const MAX_KEEP_LOG = 200000;

export function assertJobId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error("Invalid job id");
  }
  return id;
}

export function buildLaunchScript(id, language, code) {
  assertJobId(id);
  const dir = `${JOBS_ROOT}/${id}`;
  const file = language === "bash" || language === "command" ? "job.sh" : "job.py";
  const runner = file === "job.sh" ? "bash" : "python3 -u";
  const b64 = Buffer.from(String(code), "utf8").toString("base64");
  return [
    "set -e",
    `mkdir -p ${dir}`,
    `echo '${b64}' | base64 -d > ${dir}/${file}`,
    "cd /content",
    `: > ${dir}/log`,
    `setsid nohup bash -c '${runner} ${dir}/${file} >> ${dir}/log 2>&1; echo $? > ${dir}/exit' >/dev/null 2>&1 < /dev/null &`,
    `echo $! > ${dir}/pid`,
    `echo "STARTED:$(cat ${dir}/pid)"`,
  ].join("\n");
}

export function buildPollScript(id, offset) {
  assertJobId(id);
  const dir = `${JOBS_ROOT}/${id}`;
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  return [
    `d=${dir}`,
    `if [ ! -d "$d" ]; then echo MISSING; exit 0; fi`,
    `p=$(cat "$d/pid" 2>/dev/null || true)`,
    `if [ -f "$d/exit" ]; then echo "EXIT:$(cat "$d/exit")"; elif [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo RUNNING; else echo DEAD; fi`,
    `echo "SIZE:$(stat -c %s "$d/log" 2>/dev/null || echo 0)"`,
    `echo "DATA:$(tail -c +${off + 1} "$d/log" 2>/dev/null | head -c ${MAX_TAIL} | base64 | tr -d '\\n')"`,
  ].join("\n");
}

export function buildKillScript(id) {
  assertJobId(id);
  const dir = `${JOBS_ROOT}/${id}`;
  return [
    `p=$(cat "${dir}/pid" 2>/dev/null || true)`,
    `if [ -n "$p" ]; then`,
    `  kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true`,
    `  sleep 1`,
    `  kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
    `fi`,
    "echo KILLED",
  ].join("\n");
}

export function parsePoll(stdout) {
  const out = { state: "unknown", exitCode: null, size: 0, chunk: "", byteLength: 0 };
  for (const line of String(stdout || "").split("\n")) {
    if (line.startsWith("EXIT:")) {
      out.state = "exited";
      const code = Number(line.slice(5).trim());
      out.exitCode = Number.isFinite(code) ? code : 1;
    } else if (line.startsWith("RUNNING")) {
      out.state = "running";
    } else if (line.startsWith("DEAD")) {
      out.state = "dead";
    } else if (line.startsWith("MISSING")) {
      out.state = "missing";
    } else if (line.startsWith("SIZE:")) {
      out.size = Number(line.slice(5).trim()) || 0;
    } else if (line.startsWith("DATA:")) {
      const b64 = line.slice(5).trim();
      if (b64) {
        const buf = Buffer.from(b64, "base64");
        out.byteLength = buf.length;
        out.chunk = buf.toString("utf8");
      }
    }
  }
  return out;
}

const DEFAULT_CONFIG = { notifyNative: true, sound: false, endpoints: [] };

export function createJobs({
  runScript,
  storage,
  pushEvent = () => {},
  bus = null,
  now = () => Date.now(),
  fetchImpl,
  sleep,
  rand = () => Math.random().toString(36).slice(2, 10),
}) {
  const store = storage("jobs");
  const saved = store.get("jobs", []);
  const jobs = new Map((Array.isArray(saved) ? saved : []).map((j) => [j.id, j]));

  const persist = () => store.set("jobs", [...jobs.values()].map(({ _busy, ...j }) => j));
  const emitUpdate = (j) => pushEvent("jobs:update", publicJob(j));

  function publicJob(j) {
    const { codeB64, _busy, ...rest } = j;
    return rest;
  }

  const getConfig = () => ({ ...DEFAULT_CONFIG, ...(store.get("config", {}) || {}) });
  const publicConfig = () => {
    const c = getConfig();
    return { ...c, endpoints: (c.endpoints || []).map(maskEndpoint) };
  };

  function setConfig(input = {}) {
    const cur = getConfig();
    const next = {
      notifyNative: input.notifyNative !== false,
      sound: !!input.sound,
      endpoints: [],
    };
    for (const ep of Array.isArray(input.endpoints) ? input.endpoints : []) {
      if (!ep || !KINDS.includes(ep.kind)) continue;
      const old = (cur.endpoints || []).find((e) => e.id === ep.id);
      const keep = (nv, ov) => (typeof nv === "string" && nv.includes("••••") ? ov || "" : nv ?? ov ?? "");
      next.endpoints.push({
        id: ep.id || `ep-${rand()}`,
        kind: ep.kind,
        name: String(ep.name || ep.kind).slice(0, 60),
        enabled: ep.enabled !== false,
        url: keep(ep.url, old?.url),
        token: keep(ep.token, old?.token),
        chatId: String(ep.chatId ?? old?.chatId ?? "").slice(0, 80),
        template: String(ep.template ?? old?.template ?? DEFAULT_TEMPLATE).slice(0, 500),
        onSuccess: ep.onSuccess !== false,
        onFailure: ep.onFailure !== false,
      });
    }
    store.set("config", next);
    return publicConfig();
  }

  async function submit({ session, language = "python", code, title }) {
    if (!session) return { ok: false, error: "No active session" };
    if (!String(code || "").trim()) return { ok: false, error: "Empty job" };
    const lang = ["bash", "command", "python"].includes(language) ? language : "python";
    const id = `j${now().toString(36)}-${rand()}`.replace(/[^a-z0-9-]/g, "").slice(0, 40);
    const res = await runScript({ session, runtime: "bash", script: buildLaunchScript(id, lang, code) });
    if (!res.ok || !/STARTED:\d+/.test(res.stdout || "")) {
      return { ok: false, error: res.error || res.stderr || "Failed to launch job" };
    }
    const job = {
      id,
      session,
      language: lang,
      title: String(title || String(code).trim().split("\n")[0]).slice(0, 80),
      status: "running",
      startedAt: now(),
      endedAt: null,
      exitCode: null,
      offset: 0,
      tail: "",
      progress: { percent: null, label: "", etaSec: null, rate: "" },
      codeB64: Buffer.from(String(code), "utf8").toString("base64"),
    };
    jobs.set(id, job);
    persist();
    emitUpdate(job);
    return { ok: true, job: publicJob(job) };
  }

  async function notify(job) {
    const cfg = getConfig();
    const vars = {
      job: job.title,
      status: job.status,
      duration: formatDuration(((job.endedAt || now()) - job.startedAt) / 1000),
      session: job.session,
    };
    pushEvent("jobs:notify", { id: job.id, ...vars, native: cfg.notifyNative, sound: cfg.sound });
    const ok = job.status === "succeeded";
    for (const ep of cfg.endpoints || []) {
      if (!ep.enabled || (ok && !ep.onSuccess) || (!ok && !ep.onFailure)) continue;
      const r = await deliver(ep, vars, { fetchImpl, sleep });
      if (!r.ok) pushEvent("jobs:webhook-error", { id: ep.id, name: ep.name, error: r.error });
    }
  }

  async function pollOne(job) {
    if (!job || job._busy || job.status !== "running") return job;
    job._busy = true;
    try {
      const res = await runScript({
        session: job.session,
        runtime: "bash",
        script: buildPollScript(job.id, job.offset),
      });
      if (!res.ok) return job; // transient; try again on next tick
      const p = parsePoll(res.stdout);
      let changed = false;

      if (p.size > 0 && p.size < job.offset) {
        job.offset = 0;
        changed = true;
      }
      if (p.chunk) {
        job.offset += p.byteLength;
        job.tail = (job.tail + p.chunk).slice(-MAX_KEEP_LOG);
        bus?.emit?.("jobs:log", {
          jobId: job.id,
          id: job.id,
          name: job.title,
          session: job.session,
          text: p.chunk,
          chunk: p.chunk,
          timestamp: now(),
        });
        const elapsedSec = Math.max(0, (now() - job.startedAt) / 1000);
        const prog = parseProgress(p.chunk, { elapsedSec });
        if (prog.percent != null) {
          job.progress = { ...prog, rate: prog.rate || job.progress.rate };
        } else if (prog.rate) {
          job.progress = { ...job.progress, rate: prog.rate };
        }
        changed = true;
      }

      if (p.state === "exited" || p.state === "dead" || p.state === "missing") {
        job.endedAt = now();
        job.exitCode = p.state === "exited" ? p.exitCode : null;
        job.status = job.cancelled
          ? "cancelled"
          : p.state === "exited" && p.exitCode === 0
            ? "succeeded"
            : "failed";
        if (job.status === "succeeded") {
          job.progress = { ...job.progress, percent: 100, etaSec: 0 };
        }
        persist();
        emitUpdate(job);
        if (!job.cancelled) await notify(job);
      } else if (changed) {
        persist();
        emitUpdate(job);
      }
    } finally {
      job._busy = false;
    }
    return job;
  }

  async function pollAll() {
    const running = [...jobs.values()].filter((j) => j.status === "running");
    await Promise.all(running.map(pollOne));
    return running.length;
  }

  async function cancel(id) {
    if (!ID_RE.test(String(id || ""))) return { ok: false, error: "Invalid job id" };
    const job = jobs.get(id);
    if (!job) return { ok: false, error: "Job not found" };
    if (job.status !== "running") return { ok: true, job: publicJob(job) };
    job.cancelled = true;
    const res = await runScript({ session: job.session, runtime: "bash", script: buildKillScript(id) });
    if (!res.ok) {
      job.cancelled = false;
      return { ok: false, error: res.error || "Cancel failed" };
    }
    job.status = "cancelled";
    job.endedAt = now();
    persist();
    emitUpdate(job);
    return { ok: true, job: publicJob(job) };
  }

  async function rerun(id) {
    if (!ID_RE.test(String(id || ""))) return { ok: false, error: "Invalid job id" };
    const job = jobs.get(id);
    if (!job) return { ok: false, error: "Job not found" };
    return submit({
      session: job.session,
      language: job.language,
      title: job.title,
      code: Buffer.from(job.codeB64 || "", "base64").toString("utf8"),
    });
  }

  function clearFinished(session) {
    for (const [id, j] of jobs) {
      if (j.status !== "running" && (!session || j.session === session)) {
        jobs.delete(id);
      }
    }
    persist();
    return { ok: true, jobs: list(session) };
  }

  const list = (session) =>
    [...jobs.values()]
      .filter((j) => !session || j.session === session)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(publicJob);

  const get = (id) => (ID_RE.test(String(id || "")) && jobs.has(id) ? publicJob(jobs.get(id)) : null);

  async function getLog(id, { lines = 0, poll = false } = {}) {
    if (!ID_RE.test(String(id || ""))) return { ok: false, error: "Invalid job id" };
    const job = jobs.get(id);
    if (!job) return { ok: false, error: "Job not found" };
    if (poll && job.status === "running") await pollOne(job);
    let text = job.tail || "";
    const n = Number(lines);
    if (Number.isFinite(n) && n > 0) {
      const split = text.split("\n");
      text = split.slice(-n).join("\n");
    }
    return { ok: true, log: text, job: publicJob(job) };
  }

  async function testEndpoint(id, override) {
    const ep = override || (getConfig().endpoints || []).find((e) => e.id === id);
    if (!ep) return { ok: false, error: "Endpoint not found" };
    const full = { ...ep };
    const saved = (getConfig().endpoints || []).find((e) => e.id === ep.id);
    for (const k of ["url", "token"]) {
      if (String(full[k] || "").includes("••••")) full[k] = saved?.[k] || "";
    }
    const bad = validateEndpoint(full);
    if (bad) return { ok: false, error: bad };
    return deliver(
      full,
      { job: "Colab Desk test", status: "succeeded", duration: "0s", session: "test" },
      { fetchImpl, sleep },
    );
  }

  return {
    submit,
    pollAll,
    pollOne,
    cancel,
    rerun,
    clearFinished,
    list,
    get,
    getLog,
    getConfig,
    publicConfig,
    setConfig,
    testEndpoint,
    notify,
  };
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h${m}m` : m ? `${m}m${s}s` : `${s}s`;
}

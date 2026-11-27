// Multi-accelerator priority queue for GPU/TPU sniping.
// Runs `colab new` (via injected runner) against ordered targets with per-target
// backoff + jitter, a global minimum gap between calls (Colab rate-limit safety),
// overall timeout / max attempts, and pause / resume / cancel.
import { isRetryableColabError, summarizeColabError } from "../../desk.mjs";
import { GPUS, TPUS } from "../../plan.mjs";

export const MIN_INTERVAL_SEC = 5;
export const MIN_GAP_SEC = 3;
export const DEFAULT_INTERVAL_SEC = 10;
export const DEFAULT_MAX_INTERVAL_SEC = 120;

export function targetLabel(t) {
  return (t.gpu || t.tpu || "CPU") + (t.highMem ? " + high-mem" : "");
}

export function normalizeTargets(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") continue;
    const gpu = GPUS.includes(raw.gpu) ? raw.gpu : null;
    const tpu = !gpu && TPUS.includes(raw.tpu) ? raw.tpu : null;
    const t = { gpu, tpu, highMem: !!raw.highMem && !tpu && gpu !== "L4" };
    const key = `${gpu}|${tpu}|${t.highMem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

export function createSnipeQueue(opts) {
  const {
    run,
    onChange = () => {},
    onAcquired = () => {},
    now = () => Date.now(),
    random = Math.random,
    minIntervalSec = MIN_INTERVAL_SEC,
    minGapSec = MIN_GAP_SEC,
  } = opts;
  const jobs = new Map();
  let seq = 0;
  let lastCallAt = 0;

  const snapshot = (j) => {
    const liveNext = j.targets.filter((t) => !t.disabled).map((t) => t.nextAt);
    const minNext = liveNext.length ? Math.min(...liveNext) : null;
    return {
      id: j.id,
      name: j.name,
      status: j.status,
      recipeId: j.recipeId || null,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt || null,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      timeoutSec: j.timeoutSec,
      intervalSec: j.intervalSec,
      maxIntervalSec: j.maxIntervalSec,
      lastError: j.lastError,
      acquired: j.acquired || null,
      pipeline: j.pipeline || null,
      nextAttemptAt: j.status === "running" ? minNext : null,
      targets: j.targets.map((t) => ({
        gpu: t.gpu,
        tpu: t.tpu,
        highMem: t.highMem,
        label: targetLabel(t),
        attempts: t.attempts,
        fails: t.fails,
        lastError: t.lastError,
        disabled: t.disabled,
        nextAt: t.nextAt,
        active: j.current === t,
      })),
    };
  };

  const emitChange = (j) => {
    try {
      onChange(snapshot(j));
    } catch {}
  };

  const finish = (j, status, error) => {
    if (["succeeded", "failed", "cancelled", "timeout"].includes(j.status)) return;
    j.status = status;
    j.finishedAt = now();
    if (error) j.lastError = error;
    clearTimeout(j.timer);
    emitChange(j);
  };

  function schedule(j, delayMs) {
    clearTimeout(j.timer);
    let capped = Math.max(0, delayMs);
    if (j.timeoutSec > 0) {
      const remaining = j.startedAt + j.timeoutSec * 1000 - now();
      if (remaining <= 0) {
        finish(j, "timeout", j.lastError || "timeout");
        return;
      }
      capped = Math.min(capped, remaining);
    }
    j.timer = setTimeout(() => step(j), capped);
    if (j.timer.unref) j.timer.unref();
  }

  async function step(j) {
    if (j.status !== "running" || j.busy) return;
    const t = now();
    if (j.timeoutSec && t - j.startedAt >= j.timeoutSec * 1000) {
      return finish(j, "timeout", j.lastError || "timeout");
    }
    if (j.maxAttempts && j.attempts >= j.maxAttempts) {
      return finish(j, "failed", j.lastError || "max attempts reached");
    }
    const live = j.targets.filter((x) => !x.disabled);
    if (!live.length) return finish(j, "failed", j.lastError || "no usable targets");
    const gapWait = lastCallAt > 0 ? lastCallAt + minGapSec * 1000 - t : 0;
    const ready = live.find((x) => x.nextAt <= t);
    if (!ready || gapWait > 0) {
      const nextAt = Math.min(...live.map((x) => x.nextAt));
      return schedule(j, Math.max(nextAt - t, gapWait, 25));
    }
    j.busy = true;
    j.current = ready;
    j.attempts += 1;
    ready.attempts += 1;
    lastCallAt = now();
    j.controller = new AbortController();
    emitChange(j);
    let result;
    try {
      result = await run(
        { type: "new", name: j.name, gpu: ready.gpu, tpu: ready.tpu, highMem: ready.highMem },
        { signal: j.controller.signal },
      );
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    j.busy = false;
    j.current = null;
    j.controller = null;
    if (j.status === "cancelled") return;
    if (result && result.ok) {
      j.acquired = {
        session: j.name,
        hardware: { gpu: ready.gpu, tpu: ready.tpu, highMem: ready.highMem },
        label: targetLabel(ready),
        elapsedSec: Math.max(0, Math.round((now() - j.startedAt) / 1000)),
      };
      finish(j, "succeeded");
      try {
        onAcquired(snapshot(j), j);
      } catch {}
      return;
    }
    const raw = (result && result.error) || "colab failed";
    const err = summarizeColabError(raw, "en");
    ready.lastError = err;
    j.lastError = `${targetLabel(ready)}: ${err}`;
    if (j.status === "paused") {
      emitChange(j);
      return;
    }
    if (isRetryableColabError(raw)) {
      ready.fails += 1;
      const base = Math.min(j.maxIntervalSec, j.intervalSec * Math.pow(1.6, ready.fails - 1));
      const jitter = 1 + (random() * 2 - 1) * 0.25;
      ready.nextAt = now() + Math.max(minIntervalSec, base * jitter) * 1000;
    } else {
      ready.disabled = true;
    }
    emitChange(j);
    schedule(j, 0);
  }

  return {
    start(spec) {
      const targets = normalizeTargets(spec.targets);
      if (!targets.length) throw new Error("at least one valid target is required");
      if (!spec.name || typeof spec.name !== "string" || !spec.name.trim()) {
        throw new Error("session name is required");
      }
      const t0 = now();
      const j = {
        id: `snipe-${++seq}-${t0.toString(36)}`,
        name: spec.name.trim(),
        recipeId: spec.recipeId || null,
        recipe: spec.recipe || null,
        status: "running",
        startedAt: t0,
        attempts: 0,
        maxAttempts: Math.floor(num(spec.maxAttempts, 0, 0, 10000)),
        timeoutSec: num(spec.timeoutSec, 0, 0, 7 * 86400),
        intervalSec: num(spec.intervalSec, DEFAULT_INTERVAL_SEC, minIntervalSec, 3600),
        maxIntervalSec: num(spec.maxIntervalSec, DEFAULT_MAX_INTERVAL_SEC, minIntervalSec, 3600),
        lastError: "",
        pipeline: null,
        busy: false,
        current: null,
        controller: null,
        timer: null,
        targets: targets.map((x) => ({
          ...x,
          attempts: 0,
          fails: 0,
          lastError: "",
          disabled: false,
          nextAt: t0,
        })),
      };
      if (j.maxIntervalSec < j.intervalSec) j.maxIntervalSec = j.intervalSec;
      jobs.set(j.id, j);
      emitChange(j);
      schedule(j, 0);
      return snapshot(j);
    },
    pause(id) {
      const j = jobs.get(id);
      if (!j || j.status !== "running") return null;
      j.status = "paused";
      clearTimeout(j.timer);
      emitChange(j);
      return snapshot(j);
    },
    resume(id) {
      const j = jobs.get(id);
      if (!j || j.status !== "paused") return null;
      j.status = "running";
      emitChange(j);
      schedule(j, 0);
      return snapshot(j);
    },
    cancel(id) {
      const j = jobs.get(id);
      if (!j) return null;
      const wasLive = j.status === "running" || j.status === "paused";
      if (wasLive) {
        j.status = "cancelled";
        j.finishedAt = now();
        clearTimeout(j.timer);
        if (j.controller) {
          try {
            j.controller.abort();
          } catch {}
        }
        emitChange(j);
      }
      return snapshot(j);
    },
    setPipeline(id, pipelineState) {
      const j = jobs.get(id);
      if (!j) return null;
      j.pipeline = pipelineState;
      emitChange(j);
      return snapshot(j);
    },
    remove(id) {
      const j = jobs.get(id);
      if (!j || j.status === "running" || j.status === "paused") return false;
      return jobs.delete(id);
    },
    get: (id) => (jobs.has(id) ? snapshot(jobs.get(id)) : null),
    getRaw: (id) => jobs.get(id) || null,
    list: () => [...jobs.values()].map(snapshot),
    shutdown() {
      for (const id of [...jobs.keys()]) this.cancel(id);
    },
  };
}

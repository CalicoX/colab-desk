// Session Guard engine: heartbeat keep-alive, disconnect detection + auto-reconnect,
// pre-recycle notices (max runtime & idle), one-click rebuild, and Compute Units budget guard.
// All Colab operations go through the injected `run(action)` (official colab CLI via runAction).

export const DEFAULTS = {
  heartbeatMinutes: 5,
  pollSeconds: 60,
  cuSampleMinutes: 5,
  maxReconnectAttempts: 5,
  reconnectBaseSeconds: 15,
  maxRuntimeHours: 12,
  idleTimeoutMinutes: 90,
  warnMinutes: 15,
  budgetCap: 0,
  hourlyCap: 0,
  autoDisconnect: false,
  autoDisconnectConfirmed: false,
};

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const HISTORY_LIMIT = 24 * 14;

export class GuardEngine {
  constructor({
    run,
    storage,
    bootstrapFn = null,
    syncFn = null,
    notify = () => {},
    emit = () => {},
    now = Date.now,
    setTimer = setInterval,
    clearTimer = clearInterval,
    setOnce = setTimeout,
    clearOnce = clearTimeout,
  } = {}) {
    this.run = run;
    this.storage = storage;
    this.bootstrapFn = bootstrapFn;
    this.syncFn = syncFn;
    this.notify = notify;
    this.emit = emit;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setOnce = setOnce;
    this.clearOnce = clearOnce;

    this.status = new Map(); // session -> runtime status
    this.hb = new Map(); // session -> { timer, failures }
    this.timers = [];
    this.alerts = new Set();
    this.started = false;
  }

  settings() {
    return { ...DEFAULTS, ...(this.storage.get("settings", {}) || {}) };
  }

  setSettings(patch = {}) {
    const prev = this.settings();
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (patch[k] === undefined) continue;
      if (typeof DEFAULTS[k] === "boolean") {
        clean[k] = Boolean(patch[k]);
      } else {
        const n = Number(patch[k]);
        clean[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k];
      }
    }
    // Enforce sane minimums for active intervals
    if (clean.heartbeatMinutes !== undefined && clean.heartbeatMinutes < 0.5) clean.heartbeatMinutes = 0.5;
    if (clean.pollSeconds !== undefined && clean.pollSeconds < 5) clean.pollSeconds = 5;
    if (clean.cuSampleMinutes !== undefined && clean.cuSampleMinutes < 1) clean.cuSampleMinutes = 1;
    if (clean.reconnectBaseSeconds !== undefined && clean.reconnectBaseSeconds < 1) clean.reconnectBaseSeconds = 1;

    // Auto-disconnect cannot be armed without explicit confirmation
    if (clean.autoDisconnect === false) {
      clean.autoDisconnectConfirmed = false;
    }

    if (clean.budgetCap !== undefined && clean.budgetCap !== prev.budgetCap) {
      this.storage.set("budgetBase", null);
      this.alerts.delete("cu80");
      this.alerts.delete("cu100");
    }

    const next = { ...prev, ...clean };
    this.storage.set("settings", next);

    if (this.started && (next.pollSeconds !== prev.pollSeconds || next.cuSampleMinutes !== prev.cuSampleMinutes)) {
      this.restartTimers();
    }
    if (next.heartbeatMinutes !== prev.heartbeatMinutes) {
      for (const name of [...this.hb.keys()]) {
        this.stopHeartbeat(name);
        this.startHeartbeat(name);
      }
    }
    this.publish();
    return next;
  }

  sessionCfg(name) {
    const all = this.storage.get("sessions", {}) || {};
    return {
      heartbeat: false,
      autoReconnect: true,
      autoRebuild: false,
      ...(all[name] || {}),
    };
  }

  setSessionCfg(name, patch = {}) {
    if (!name) return null;
    const all = { ...(this.storage.get("sessions", {}) || {}) };
    const cur = this.sessionCfg(name);
    for (const k of ["heartbeat", "autoReconnect", "autoRebuild"]) {
      if (patch[k] !== undefined) cur[k] = Boolean(patch[k]);
    }
    all[name] = { ...(all[name] || {}), ...cur };
    this.storage.set("sessions", all);
    this.syncHeartbeats();
    this.publish();
    return cur;
  }

  remember(name, config) {
    if (!name || !config || typeof config !== "object") return null;
    const all = { ...(this.storage.get("sessions", {}) || {}) };
    const lastConfig = {};
    for (const k of ["gpu", "tpu", "highMem", "startupScript", "envVars", "syncDir", "remoteSyncDir", "bootstrapConfig"]) {
      if (config[k] !== undefined) lastConfig[k] = config[k];
    }
    all[name] = {
      ...(all[name] || {}),
      lastConfig: { ...((all[name] || {}).lastConfig || {}), ...lastConfig },
    };
    this.storage.set("sessions", all);
    this.publish();
    return all[name].lastConfig;
  }

  getLastConfig(name) {
    const all = this.storage.get("sessions", {}) || {};
    return (all[name] && all[name].lastConfig) || null;
  }

  recordActivity(name, ts = this.now()) {
    const st = this.status.get(name);
    if (!st) return;
    st.lastActivityAt = ts;
    this.alerts.delete(`idle:${name}`);
  }

  snapshot() {
    const t = this.now();
    const stored = this.storage.get("sessions", {}) || {};
    const sessions = [...this.status.values()].map((s) => ({
      ...s,
      elapsedMinutes: Math.max(0, Math.round((t - s.startedAt) / MIN_MS)),
      idleMinutes: Math.max(0, Math.round((t - (s.lastActivityAt || s.startedAt)) / MIN_MS)),
      config: this.sessionCfg(s.name),
      lastConfig: (stored[s.name] && stored[s.name].lastConfig) || null,
      hasLastConfig: Boolean(stored[s.name] && stored[s.name].lastConfig),
      heartbeatFailures: (this.hb.get(s.name) || {}).failures || 0,
    }));
    return {
      settings: this.settings(),
      sessions,
      cu: this.cuSummary(),
      cuHistory: this.cuHistory(),
    };
  }

  publish() {
    this.emit("guard:state", this.snapshot());
  }

  alert(key, title, body, level = "warn") {
    if (this.alerts.has(key)) return false;
    this.alerts.add(key);
    this.notify({ title, body, key, level });
    return true;
  }

  hardwareConfigFrom(hardware = "") {
    const h = String(hardware).toUpperCase();
    for (const g of ["T4", "L4", "G4", "H100", "A100"]) {
      if (h.includes(g)) return { gpu: g };
    }
    if (/V5E1/.test(h)) return { tpu: "v5e1" };
    if (/V6E1/.test(h)) return { tpu: "v6e1" };
    return {};
  }

  async poll() {
    const res = await this.run({ type: "sessions" });
    if (!res || !res.ok) {
      this.publish();
      return;
    }
    const list = (res.state && Array.isArray(res.state.sessions)) ? res.state.sessions : [];
    const live = new Map(list.map((s) => [s.name, s]));
    const t = this.now();
    const s = this.settings();

    for (const [name, info] of live) {
      const prev = this.status.get(name);
      if (!prev || prev.state === "lost") {
        this.status.set(name, {
          name,
          state: "ok",
          startedAt: t,
          lastActivityAt: t,
          hardware: info.hardware,
          lastSeen: t,
          attempts: 0,
          heartbeatAt: null,
          heartbeatOk: null,
          remainingMinutes: null,
        });
        if (!this.getLastConfig(name)) {
          this.remember(name, this.hardwareConfigFrom(info.hardware));
        }
        this.alerts.delete(`recycle:${name}`);
        this.alerts.delete(`idle:${name}`);
      } else {
        prev.lastSeen = t;
        prev.hardware = info.hardware;
        if (prev.state === "reconnecting") {
          if (prev.retry) {
            this.clearOnce(prev.retry);
            prev.retry = null;
          }
          prev.state = "ok";
          prev.attempts = 0;
        }
      }

      const st = this.status.get(name);
      if (s.maxRuntimeHours > 0) {
        const left = s.maxRuntimeHours * 60 - (t - st.startedAt) / MIN_MS;
        st.remainingMinutes = Math.round(left);
        if (left <= s.warnMinutes) {
          this.alert(
            `recycle:${name}`,
            "Colab Desk — Session expiring",
            `Session "${name}" will likely be reclaimed in ~${Math.max(0, Math.round(left))} min (max runtime ${s.maxRuntimeHours}h).`,
            "warn",
          );
        }
      } else {
        st.remainingMinutes = null;
      }

      const cfg = this.sessionCfg(name);
      if (!cfg.heartbeat && s.idleTimeoutMinutes > 0) {
        const idleMin = (t - (st.lastActivityAt || st.startedAt)) / MIN_MS;
        const idleLeft = s.idleTimeoutMinutes - idleMin;
        if (idleLeft <= s.warnMinutes) {
          this.alert(
            `idle:${name}`,
            "Colab Desk — Idle timeout approaching",
            `Session "${name}" has been idle for ${Math.round(idleMin)} min (~${Math.max(0, Math.round(idleLeft))} min before idle reclamation).`,
            "warn",
          );
        }
      }
    }

    for (const st of this.status.values()) {
      if (!live.has(st.name) && st.state !== "lost" && st.state !== "reconnecting") {
        this.onLoss(st);
      }
    }

    this.syncHeartbeats();
    this.publish();
  }

  onLoss(st) {
    st.state = "reconnecting";
    st.attempts = 0;
    st.lostAt = this.now();
    this.notify({
      title: "Colab Desk — Session lost",
      body: `Session "${st.name}" disconnected unexpectedly.`,
      key: `lost:${st.name}`,
      level: "danger",
    });
    this.stopHeartbeat(st.name);
    if (this.sessionCfg(st.name).autoReconnect) {
      this.scheduleReconnect(st);
    } else {
      st.state = "lost";
    }
  }

  scheduleReconnect(st) {
    const s = this.settings();
    if (st.attempts >= s.maxReconnectAttempts) {
      this.giveUp(st);
      return;
    }
    const delay = s.reconnectBaseSeconds * 1000 * 2 ** st.attempts;
    st.nextRetryAt = this.now() + delay;
    st.retry = this.setOnce(() => this.reconnectAttempt(st), delay);
    if (st.retry && st.retry.unref) st.retry.unref();
  }

  async reconnectAttempt(st) {
    st.retry = null;
    st.attempts += 1;
    const res = await this.run({ type: "status", session: st.name });
    if (res && res.ok && res.state && res.state.sessions && res.state.sessions.length) {
      st.state = "ok";
      st.attempts = 0;
      st.lastSeen = this.now();
      this.syncHeartbeats();
      this.publish();
      return true;
    }
    if (st.attempts >= this.settings().maxReconnectAttempts) {
      await this.giveUp(st);
      return false;
    }
    this.scheduleReconnect(st);
    this.publish();
    return false;
  }

  async giveUp(st) {
    st.state = "lost";
    st.nextRetryAt = null;
    this.publish();
    if (this.sessionCfg(st.name).autoRebuild) {
      await this.rebuild(st.name);
    }
  }

  async rebuild(name) {
    const last = this.getLastConfig(name);
    if (!last) return { ok: false, error: "no remembered config" };
    const created = await this.run({
      type: "new",
      name,
      ...(last.gpu ? { gpu: last.gpu } : {}),
      ...(last.tpu ? { tpu: last.tpu } : {}),
      ...(last.highMem ? { highMem: true } : {}),
    });
    if (!created || !created.ok) {
      return { ok: false, error: (created && created.error) || "failed to create session" };
    }

    let bootstrap = null;
    if (this.bootstrapFn && (last.startupScript || (Array.isArray(last.envVars) && last.envVars.length) || last.bootstrapConfig)) {
      bootstrap = await this.bootstrapFn({
        session: name,
        envVars: last.envVars || [],
        config: { ...(last.bootstrapConfig || {}), ...(last.startupScript ? { startupScript: last.startupScript } : {}) },
      });
    }

    let sync = null;
    if (this.syncFn && last.syncDir) {
      const localDir = typeof last.syncDir === "string" ? last.syncDir : last.syncDir.localDir;
      const remoteDir = typeof last.syncDir === "string" ? last.remoteSyncDir : last.syncDir.remoteDir;
      if (localDir) {
        sync = await this.syncFn({ session: name, localDir, remoteDir });
      }
    }

    const t = this.now();
    const st = this.status.get(name);
    if (st) {
      st.state = "ok";
      st.startedAt = t;
      st.lastActivityAt = t;
      st.lastSeen = t;
      st.attempts = 0;
    } else {
      this.status.set(name, {
        name,
        state: "ok",
        startedAt: t,
        lastActivityAt: t,
        hardware: last.gpu || last.tpu || "CPU",
        lastSeen: t,
        attempts: 0,
        heartbeatAt: null,
        heartbeatOk: null,
        remainingMinutes: null,
      });
    }
    this.alerts.delete(`recycle:${name}`);
    this.alerts.delete(`idle:${name}`);
    this.syncHeartbeats();
    this.publish();
    return { ok: true, bootstrap, sync, syncDir: last.syncDir || null };
  }

  // ---- heartbeat keep-alive ----
  syncHeartbeats() {
    for (const st of this.status.values()) {
      const want = st.state === "ok" && this.sessionCfg(st.name).heartbeat;
      if (want && !this.hb.has(st.name)) this.startHeartbeat(st.name);
      if (!want && this.hb.has(st.name)) this.stopHeartbeat(st.name);
    }
    for (const name of [...this.hb.keys()]) {
      if (!this.status.has(name)) this.stopHeartbeat(name);
    }
  }

  startHeartbeat(name) {
    const rec = { failures: 0, timer: null };
    this.hb.set(name, rec);
    const schedule = () => {
      const base = this.settings().heartbeatMinutes * MIN_MS;
      const delay = base * Math.min(8, 2 ** rec.failures);
      rec.timer = this.setOnce(async () => {
        await this.beat(name);
        if (this.hb.get(name) === rec) schedule();
      }, delay);
      if (rec.timer && rec.timer.unref) rec.timer.unref();
    };
    schedule();
  }

  stopHeartbeat(name) {
    const rec = this.hb.get(name);
    if (rec && rec.timer) this.clearOnce(rec.timer);
    this.hb.delete(name);
  }

  async beat(name) {
    const rec = this.hb.get(name);
    const st = this.status.get(name);
    const res = await this.run({ type: "exec", session: name, code: "print('guard-heartbeat')", timeout: 30 });
    const ok = Boolean(res && res.ok);
    if (rec) rec.failures = ok ? 0 : rec.failures + 1;
    if (st) {
      st.heartbeatAt = this.now();
      st.heartbeatOk = ok;
      if (ok) {
        st.lastActivityAt = st.heartbeatAt;
        this.alerts.delete(`idle:${name}`);
      }
    }
    this.publish();
    return ok;
  }

  // ---- compute units budget guard ----
  async sampleCu() {
    const res = await this.run({ type: "usage" });
    const u = res && res.ok && res.state && res.state.usage;
    if (!u || u.balance == null) return null;
    const t = this.now();
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    const hist = [...(this.storage.get("cuHistory", []) || [])];
    const last = hist[hist.length - 1];
    if (last && last.hour === hour) {
      last.balance = u.balance;
      last.rate = u.ratePerHour;
      last.used = Math.max(0, +(last.open - u.balance).toFixed(3));
    } else {
      const open = last ? last.balance : u.balance;
      hist.push({
        hour,
        open,
        balance: u.balance,
        rate: u.ratePerHour,
        used: last ? Math.max(0, +(open - u.balance).toFixed(3)) : 0,
      });
    }
    while (hist.length > HISTORY_LIMIT) hist.shift();
    this.storage.set("cuHistory", hist);
    if (this.storage.get("budgetBase", null) == null) {
      this.storage.set("budgetBase", u.balance);
    }
    await this.checkBudget(u);
    this.publish();
    return u;
  }

  cuHistory() {
    return this.storage.get("cuHistory", []) || [];
  }

  cuSummary() {
    const hist = this.cuHistory();
    const s = this.settings();
    const base = this.storage.get("budgetBase", null);
    const last = hist[hist.length - 1];
    const spent = base != null && last ? Math.max(0, +(base - last.balance).toFixed(3)) : 0;
    return {
      balance: last ? last.balance : null,
      rate: last ? last.rate : null,
      spent,
      budgetCap: s.budgetCap,
      hourlyCap: s.hourlyCap,
      currentHourUsed: last ? last.used : 0,
    };
  }

  async checkBudget(u) {
    const s = this.settings();
    const { spent } = this.cuSummary();
    let over = false;
    if (s.budgetCap > 0) {
      const ratio = spent / s.budgetCap;
      if (ratio >= 1) {
        over = true;
        this.alert("cu100", "Colab Desk — CU budget reached", `Spent ${spent.toFixed(1)} of ${s.budgetCap} CU budget.`, "danger");
      } else if (ratio >= 0.8) {
        this.alert("cu80", "Colab Desk — CU budget 80%", `Spent ${spent.toFixed(1)} of ${s.budgetCap} CU budget.`, "warn");
      }
    }
    if (s.hourlyCap > 0 && u.ratePerHour != null && u.ratePerHour > s.hourlyCap) {
      over = true;
      this.alert(
        `hourly:${Math.floor(this.now() / HOUR_MS)}`,
        "Colab Desk — CU rate high",
        `Burning ${u.ratePerHour}/hr, above cap ${s.hourlyCap}/hr.`,
        "danger",
      );
    }
    if (over && s.autoDisconnect && s.autoDisconnectConfirmed) {
      for (const st of this.status.values()) {
        if (st.state === "ok") {
          await this.run({ type: "stop", session: st.name });
        }
      }
      await this.poll();
    }
  }

  restartTimers() {
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    const s = this.settings();
    this.timers.push(this.setTimer(() => this.poll().catch(() => {}), s.pollSeconds * 1000));
    this.timers.push(this.setTimer(() => this.sampleCu().catch(() => {}), s.cuSampleMinutes * MIN_MS));
    for (const t of this.timers) {
      if (t && t.unref) t.unref();
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.restartTimers();
  }

  stop() {
    this.started = false;
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    for (const name of [...this.hb.keys()]) this.stopHeartbeat(name);
    for (const st of this.status.values()) {
      if (st.retry) {
        this.clearOnce(st.retry);
        st.retry = null;
      }
    }
  }
}

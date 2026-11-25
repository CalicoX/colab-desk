function parseEnvPairs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

export function composeAction(input) {
  const command = input && input.command;
  const hardware = (input && input.hardware) || {};
  const fields = (input && input.fields) || {};
  const selected = input && input.selected;

  if (command === "usage" || command === "version" || command === "whoami") {
    return { action: { type: command } };
  }

  if (command === "run") {
    const script = String(fields.script || "").trim();
    if (!script) return { error: "script path is required" };
    const action = { type: "run", script };
    if (hardware.gpu) action.gpu = hardware.gpu;
    if (hardware.tpu) action.tpu = hardware.tpu;
    if (hardware.highMem) action.highMem = true;
    if (fields.keep) action.keep = true;
    const timeout = String(fields.timeout || "").trim();
    if (timeout) action.timeout = timeout;
    const env = parseEnvPairs(fields.env);
    if (env.length) action.env = env;
    const args = String(fields.args || "").trim().split(/\s+/).filter(Boolean);
    if (args.length) action.args = args;
    return { action };
  }

  if (!selected) return { error: "pick a session in the sidebar first" };
  const action = { type: command, session: selected };

  if (command === "exec") {
    const file = String(fields.file || "").trim();
    const timeout = String(fields.timeout || "").trim();
    if (timeout) action.timeout = timeout;
    const env = parseEnvPairs(fields.env);
    if (env.length) action.env = env;
    if (file) {
      action.file = file;
      return { action };
    }
    if (typeof input.code !== "string" || input.code.length === 0) {
      return { error: "exec needs code or a file" };
    }
    action.code = input.code;
    return { action };
  }

  if (command === "ssh") {
    const cmd = String(fields.command || input.code || "").trim();
    if (!cmd) return { error: "shell command is required" };
    action.command = cmd;
    return { action };
  }

  if (command === "ls" || command === "rm" || command === "drivemount") {
    const pathValue = String(fields.path || "").trim();
    if (pathValue) action.path = pathValue;
    if (command === "rm" && !action.path) return { error: "path is required" };
    return { action };
  }

  if (command === "upload" || command === "download") {
    action.local = String(fields.local || "").trim();
    action.remote = String(fields.remote || "").trim();
    return { action };
  }

  if (command === "install") {
    const requirements = String(fields.requirements || "").trim();
    if (requirements) {
      action.requirements = requirements;
      return { action };
    }
    action.packages = String(fields.packages || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return { action };
  }

  if (command === "log") {
    const lines = String(fields.lines || "").trim();
    if (lines) action.lines = lines;
    const eventType = String(fields.eventType || "").trim();
    if (eventType) action.eventType = eventType;
    const output = String(fields.output || "").trim();
    if (output) action.output = output;
    return { action };
  }

  return { action };
}

export function createDeskState() {
  return { view: null, bySession: Object.create(null) };
}

export function record(state, sessionName, entry) {
  const key = sessionName || "";
  const bucket = state.bySession[key] || [];
  bucket.push(entry);
  state.bySession[key] = bucket;
  return bucket;
}

export function showSession(state, sessionName) {
  state.view = sessionName || null;
  const bucket = state.bySession[state.view || ""];
  return bucket ? bucket.slice() : [];
}

// A failed `new` stays on the transcript already on screen. The new name only
// becomes the view after that session is actually in the list.
export function applyNewResult(state, input) {
  const names = Array.isArray(input.sessionNames) ? input.sessionNames : [];
  const created = !!input.ok && names.includes(input.requestedName);
  const stay = created ? input.requestedName : input.current || "";
  const entry = { ...(input.entry || {}) };
  if (!created) {
    entry.ok = false;
    if (!entry.error) entry.error = "session was not created";
  }
  record(state, stay, entry);
  return { view: stay, entries: showSession(state, stay) };
}

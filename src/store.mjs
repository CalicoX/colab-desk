import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultStoreData() {
  return {
    history: {},
    usageStats: null,
    settings: {},
  };
}

export function resolveStorePath() {
  const dir = process.env.COLAB_DESK_STATE_DIR || path.join(os.homedir(), ".config", "colab-desk");
  return path.join(dir, "state.json");
}

export function loadStore(filePath = resolveStorePath()) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultStoreData();
    return {
      history: parsed.history && typeof parsed.history === "object" ? parsed.history : {},
      usageStats: parsed.usageStats && typeof parsed.usageStats === "object" ? parsed.usageStats : null,
      settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
    };
  } catch {
    return defaultStoreData();
  }
}

export function saveStore(patch, filePath = resolveStorePath()) {
  const current = loadStore(filePath);
  const next = {
    history: patch && patch.history && typeof patch.history === "object" ? patch.history : current.history,
    usageStats: patch && patch.usageStats !== undefined ? patch.usageStats : current.usageStats,
    settings: patch && patch.settings && typeof patch.settings === "object"
      ? { ...current.settings, ...patch.settings }
      : current.settings,
  };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return next;
}

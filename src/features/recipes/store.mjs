// Recipe CRUD, normalization, secret-safe export/import backed by ctx.storage("recipes").
import crypto from "node:crypto";
import { GPUS, TPUS } from "../../plan.mjs";
import { DEFAULT_INTERVAL_SEC, DEFAULT_MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, normalizeTargets } from "./snipe.mjs";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function clampNum(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeEnvVarNames(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    // Accept either string names or { key } objects — NEVER retain values!
    const key = typeof item === "string"
      ? item.trim()
      : (item && typeof item === "object" ? String(item.key || item.name || "").trim() : "");
    if (!key || !ENV_KEY_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function normalizeHardware(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const gpu = GPUS.includes(src.gpu) ? src.gpu : null;
  const tpu = !gpu && TPUS.includes(src.tpu) ? src.tpu : null;
  const highMem = Boolean(src.highMem) && !tpu && gpu !== "L4";
  return { gpu, tpu, highMem };
}

export function normalizeRecipeInput(input, existing = null) {
  const src = input && typeof input === "object" ? input : {};
  const now = Date.now();
  const name = String(src.name ?? existing?.name ?? "").trim();
  if (!name) throw new Error("recipe name is required");

  const hw = normalizeHardware(
    src.hardware || (src.gpu !== undefined || src.tpu !== undefined ? src : existing?.hardware),
  );

  const rawSnipe = src.snipe && typeof src.snipe === "object" ? src.snipe : (existing?.snipe || {});
  const rawTargets = Array.isArray(rawSnipe.targets)
    ? rawSnipe.targets
    : (Array.isArray(src.targets) ? src.targets : (existing?.snipe?.targets || [hw]));
  const targets = normalizeTargets(rawTargets);
  const effectiveTargets = targets.length ? targets : [hw];
  const intervalSec = clampNum(rawSnipe.intervalSec, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, 3600);
  const maxIntervalSec = Math.max(
    intervalSec,
    clampNum(rawSnipe.maxIntervalSec, DEFAULT_MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, 3600),
  );

  const rawBoot = src.bootstrap && typeof src.bootstrap === "object" ? src.bootstrap : (existing?.bootstrap || {});
  const bootstrap = {
    autoMountDrive: Boolean(rawBoot.autoMountDrive),
    enableHfTransfer: rawBoot.enableHfTransfer !== undefined ? Boolean(rawBoot.enableHfTransfer) : true,
    hfCacheToDrive: Boolean(rawBoot.hfCacheToDrive),
    autoInstallUv: Boolean(rawBoot.autoInstallUv),
    autoInjectEnv: rawBoot.autoInjectEnv !== undefined ? Boolean(rawBoot.autoInjectEnv) : true,
    customScript: typeof rawBoot.customScript === "string" ? rawBoot.customScript : "",
  };

  // Strictly store only variable names — never secret values!
  const envVarNames = sanitizeEnvVarNames(
    src.envVarNames !== undefined
      ? src.envVarNames
      : (src.envVars !== undefined ? src.envVars : existing?.envVarNames),
  );

  const rawSync = src.sync && typeof src.sync === "object" ? src.sync : (existing?.sync || {});
  const sync = {
    enabled: Boolean(rawSync.enabled),
    localDir: typeof rawSync.localDir === "string" ? rawSync.localDir.trim() : "",
    remoteDir: typeof rawSync.remoteDir === "string" && rawSync.remoteDir.trim()
      ? rawSync.remoteDir.trim()
      : "/content/project",
  };

  const rawScript = src.startupScript && typeof src.startupScript === "object"
    ? src.startupScript
    : (existing?.startupScript || {});
  const params = {};
  if (rawScript.params && typeof rawScript.params === "object" && !Array.isArray(rawScript.params)) {
    for (const [k, v] of Object.entries(rawScript.params)) {
      if (typeof k === "string" && k.trim()) params[k.trim()] = String(v ?? "");
    }
  }
  const startupScript = {
    enabled: Boolean(rawScript.enabled),
    title: typeof rawScript.title === "string" ? rawScript.title.trim() : "",
    runtime: rawScript.runtime === "bash" ? "bash" : "python",
    code: typeof rawScript.code === "string" ? rawScript.code : "",
    params,
    background: Boolean(rawScript.background),
  };

  return {
    id: existing?.id || `rcp-${crypto.randomBytes(6).toString("hex")}`,
    name: name.slice(0, 120),
    description: typeof src.description === "string"
      ? src.description.trim().slice(0, 500)
      : (existing?.description || ""),
    sessionNamePrefix: typeof src.sessionNamePrefix === "string"
      ? src.sessionNamePrefix.trim().slice(0, 64)
      : (existing?.sessionNamePrefix || ""),
    hardware: hw,
    snipe: {
      enabled: rawSnipe.enabled !== undefined ? Boolean(rawSnipe.enabled) : effectiveTargets.length > 1,
      targets: effectiveTargets,
      intervalSec,
      maxIntervalSec,
      maxAttempts: Math.floor(clampNum(rawSnipe.maxAttempts, 0, 0, 10000)),
      timeoutSec: Math.floor(clampNum(rawSnipe.timeoutSec, 0, 0, 7 * 86400)),
    },
    bootstrap,
    envVarNames,
    sync,
    startupScript,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

/** Produce a clean export object guaranteed free of secret values. */
export function exportRecipeSafe(recipe) {
  const clean = normalizeRecipeInput(recipe, recipe);
  return {
    id: clean.id,
    name: clean.name,
    description: clean.description,
    sessionNamePrefix: clean.sessionNamePrefix,
    hardware: clean.hardware,
    snipe: clean.snipe,
    bootstrap: clean.bootstrap,
    envVarNames: [...clean.envVarNames],
    sync: clean.sync,
    startupScript: clean.startupScript,
    createdAt: clean.createdAt,
    updatedAt: clean.updatedAt,
  };
}

export function createRecipeStore(storage) {
  const loadList = () => {
    const raw = storage.get("recipes", []);
    return Array.isArray(raw) ? raw : [];
  };
  const saveList = (list) => {
    storage.set("recipes", list);
    return list;
  };

  return {
    list() {
      return loadList().map(exportRecipeSafe);
    },
    get(id) {
      const found = loadList().find((r) => r.id === id);
      return found ? exportRecipeSafe(found) : null;
    },
    create(input) {
      const list = loadList();
      const recipe = normalizeRecipeInput(input, null);
      list.unshift(recipe);
      saveList(list);
      return exportRecipeSafe(recipe);
    },
    update(id, patch) {
      const list = loadList();
      const idx = list.findIndex((r) => r.id === id);
      if (idx < 0) return null;
      const updated = normalizeRecipeInput(patch, list[idx]);
      list[idx] = updated;
      saveList(list);
      return exportRecipeSafe(updated);
    },
    remove(id) {
      const list = loadList();
      const next = list.filter((r) => r.id !== id);
      if (next.length === list.length) return false;
      saveList(next);
      return true;
    },
    duplicate(id, copyName) {
      const existing = this.get(id);
      if (!existing) return null;
      const name = typeof copyName === "string" && copyName.trim()
        ? copyName.trim()
        : `${existing.name} (Copy)`;
      const copy = normalizeRecipeInput({ ...existing, id: undefined, name }, null);
      const list = loadList();
      list.unshift(copy);
      saveList(list);
      return exportRecipeSafe(copy);
    },
    exportAll(ids = null) {
      const all = this.list();
      const filtered = Array.isArray(ids) && ids.length
        ? all.filter((r) => ids.includes(r.id))
        : all;
      return {
        format: "colab-desk-recipes",
        version: 1,
        exportedAt: new Date().toISOString(),
        note: "Environment variable secret values are never exported; only variable names are included.",
        recipes: filtered.map(exportRecipeSafe),
      };
    },
    importPayload(payload) {
      const items = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.recipes)
          ? payload.recipes
          : (payload && typeof payload === "object" && payload.name ? [payload] : null));
      if (!items || !items.length) throw new Error("no valid recipes found in import payload");
      const list = loadList();
      const imported = [];
      for (const item of items) {
        // Always assign a fresh ID on import to avoid colliding with existing recipes
        const normalized = normalizeRecipeInput({ ...item, id: undefined }, null);
        list.unshift(normalized);
        imported.push(exportRecipeSafe(normalized));
      }
      saveList(list);
      return imported;
    },
  };
}

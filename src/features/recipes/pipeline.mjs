// Post-acquire pipeline: bootstrap -> env vault injection -> folder sync push -> startup script (direct or background job).
import { bootstrapSession, renderParameterizedScript, runDirectScript } from "../../cloud/runner.mjs";
import { syncPushFolder } from "../../cloud/files.mjs";
import { loadStore } from "../../store.mjs";

function resolveVaultEnvVars(envVarNames = [], vaultOverride = null) {
  let vault = Array.isArray(vaultOverride) ? vaultOverride : null;
  if (!vault) {
    try {
      const store = loadStore();
      vault = Array.isArray(store?.settings?.envVars) ? store.settings.envVars : [];
    } catch {
      vault = [];
    }
  }
  const map = new Map();
  for (const item of vault) {
    const k = String(item?.key || "").trim();
    if (k) map.set(k, String(item.value ?? ""));
  }
  const names = Array.isArray(envVarNames) ? envVarNames : [];
  if (!names.length) {
    // If recipe doesn't restrict envVarNames, return all vault entries when autoInjectEnv is on
    return vault
      .filter((item) => item && String(item.key || "").trim())
      .map((item) => ({ key: String(item.key).trim(), value: String(item.value ?? "") }));
  }
  const resolved = [];
  const missing = [];
  for (const name of names) {
    if (map.has(name)) {
      resolved.push({ key: name, value: map.get(name) });
    } else {
      missing.push(name);
    }
  }
  return { resolved, missing };
}

export async function runPostAcquirePipeline({
  session,
  recipe,
  vaultEnvVars = null,
  signal = null,
  onProgress = () => {},
  onBackgroundJob = () => {},
  deps = {},
}) {
  if (!session) return { ok: false, error: "session is required", steps: [] };
  const doBootstrap = deps.bootstrapSession || bootstrapSession;
  const doSyncPush = deps.syncPushFolder || syncPushFolder;
  const doDirectScript = deps.runDirectScript || runDirectScript;

  const steps = [];
  const boot = recipe?.bootstrap || {};
  const envNames = Array.isArray(recipe?.envVarNames) ? recipe.envVarNames : [];
  const envLookup = envNames.length
    ? resolveVaultEnvVars(envNames, vaultEnvVars)
    : { resolved: resolveVaultEnvVars([], vaultEnvVars), missing: [] };
  const envVars = envLookup.resolved;
  const missingEnv = envLookup.missing;

  const report = (stepName, status, detail = "") => {
    const entry = { step: stepName, status, detail, ts: Date.now() };
    const idx = steps.findIndex((s) => s.step === stepName);
    if (idx >= 0) steps[idx] = entry;
    else steps.push(entry);
    try {
      onProgress({ session, steps: [...steps], missingEnv });
    } catch {}
  };

  // 1. Bootstrap + Env Vault Injection
  const needsBootstrap = Boolean(
    boot.autoMountDrive
    || boot.enableHfTransfer
    || boot.hfCacheToDrive
    || boot.autoInstallUv
    || (boot.autoInjectEnv !== false && envVars.length > 0)
    || (boot.customScript && String(boot.customScript).trim()),
  );
  if (needsBootstrap) {
    report("bootstrap", "running");
    try {
      const res = await doBootstrap({ session, envVars, config: boot, signal });
      if (!res || !res.ok) {
        report("bootstrap", "error", res?.error || "bootstrap failed");
      } else {
        report("bootstrap", "done", res.log || "ok");
      }
    } catch (err) {
      report("bootstrap", "error", err?.message || String(err));
    }
  }

  // 2. Optional Local -> Cloud Folder Sync Push
  const sync = recipe?.sync || {};
  if (sync.enabled && sync.localDir && sync.remoteDir) {
    report("sync", "running", `${sync.localDir} -> ${sync.remoteDir}`);
    try {
      const res = await doSyncPush({
        session,
        localDir: sync.localDir,
        remoteDir: sync.remoteDir,
        signal,
      });
      if (!res || !res.ok) {
        report("sync", "error", res?.error || "sync push failed");
      } else {
        report("sync", "done", res.message || "synced");
      }
    } catch (err) {
      report("sync", "error", err?.message || String(err));
    }
  }

  // 3. Optional Startup Script (Direct Runner or Background Job via jobs:submit)
  const script = recipe?.startupScript || {};
  if (script.enabled && script.code && String(script.code).trim()) {
    const rendered = renderParameterizedScript(script.code, script.params || {});
    const runtime = script.runtime === "bash" ? "bash" : "python";
    const title = script.title || recipe?.name || "Startup Script";

    if (script.background) {
      report("script", "running", `background:${title}`);
      const jobPayload = {
        session,
        language: runtime,
        code: rendered,
        title,
      };
      try {
        await onBackgroundJob(jobPayload);
        report("script", "done", `queued background job: ${title}`);
      } catch (err) {
        report("script", "error", err?.message || String(err));
      }
    } else {
      report("script", "running", title);
      try {
        const res = await doDirectScript({
          session,
          runtime,
          script: rendered,
          params: script.params || {},
          envVars,
          signal,
        });
        if (!res || !res.ok) {
          report("script", "error", res?.error || "startup script failed");
        } else {
          report("script", "done", (res.stdout || "").slice(0, 400) || "ok");
        }
      } catch (err) {
        report("script", "error", err?.message || String(err));
      }
    }
  }

  const hasError = steps.some((s) => s.status === "error");
  return {
    ok: !hasError,
    session,
    steps,
    missingEnv,
  };
}

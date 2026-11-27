import path from "node:path";
import { runAction } from "../run.mjs";

export function extractTemplateParams(template) {
  const names = [];
  const seen = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(template || ""))) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  }
  return names;
}

export function renderParameterizedScript(template, values = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const val = values[key];
    return val == null ? "" : String(val);
  });
}

export async function runDirectScript({ session, runtime = "python", script = "", params = {}, envVars = [], signal }) {
  if (!session) return { ok: false, error: "请先选择一个活跃的 Colab 会话" };
  const rendered = renderParameterizedScript(script, params);
  if (!rendered.trim()) return { ok: false, error: "脚本内容为空" };

  const envMap = {};
  for (const item of Array.isArray(envVars) ? envVars : []) {
    if (item && /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(item.key || "").trim())) {
      envMap[String(item.key).trim()] = String(item.value ?? "");
    }
  }
  for (const [k, v] of Object.entries(params || {})) {
    const safeKey = `COLAB_PARAM_${String(k).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
    envMap[safeKey] = String(v ?? "");
  }

  let res;
  if (runtime === "bash") {
    const b64 = Buffer.from(rendered, "utf8").toString("base64");
    const envPrefix = Object.entries(envMap)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("; ");
    const cmd = `${envPrefix ? `${envPrefix}; ` : ""}echo '${b64}' | base64 -d | bash`;
    res = await runAction({ type: "ssh", session, command: cmd }, { signal });
  } else {
    const envLines = Object.entries(envMap)
      .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(v)}`)
      .join("\n");
    const code = envLines ? `import os\n${envLines}\n\n${rendered}` : rendered;
    res = await runAction({ type: "exec", session, code }, { signal });
  }

  // Detect any media paths mentioned in stdout for instant inline preview
  const mediaMatches = [];
  const seen = new Set();
  const pathRe = /(\/content\/[^\s"'`<>]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov))/gi;
  let m;
  while ((m = pathRe.exec(`${res.stdout || ""}\n${res.stderr || ""}`)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      const ext = path.extname(m[1]).toLowerCase();
      mediaMatches.push({
        path: m[1],
        name: path.basename(m[1]),
        kind: [".mp4", ".webm", ".mov"].includes(ext) ? "video" : "image",
        url: `/api/files/media?session=${encodeURIComponent(session)}&path=${encodeURIComponent(m[1])}`,
      });
    }
  }

  return {
    ok: res.ok,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.ok ? null : (res.error || "执行失败"),
    media: mediaMatches,
  };
}

export async function bootstrapSession({ session, envVars = [], config = {}, signal }) {
  if (!session) return { ok: false, error: "请先选择一个活跃的 Colab 会话", log: "" };
  const logs = [];

  if (config.autoMountDrive) {
    const drv = await runAction({ type: "drivemount", session }, { signal });
    logs.push(`[drivemount] ${drv.ok ? "ok" : (drv.error || "failed")}`);
  }

  const effectiveEnv = [];
  for (const item of Array.isArray(envVars) ? envVars : []) {
    const k = String(item?.key || "").trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      effectiveEnv.push([k, String(item.value ?? "")]);
    }
  }
  if (config.enableHfTransfer && !effectiveEnv.some(([k]) => k === "HF_HUB_ENABLE_HF_TRANSFER")) {
    effectiveEnv.push(["HF_HUB_ENABLE_HF_TRANSFER", "1"]);
  }
  if (config.hfCacheToDrive && !effectiveEnv.some(([k]) => k === "HF_HOME")) {
    effectiveEnv.push(["HF_HOME", "/content/drive/MyDrive/.cache/huggingface"]);
  }

  const shellSteps = ["set -e"];
  if (config.autoInjectEnv !== false && effectiveEnv.length > 0) {
    const exportLines = effectiveEnv.map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n");
    const envB64 = Buffer.from(exportLines + "\n", "utf8").toString("base64");
    shellSteps.push(`echo '${envB64}' | base64 -d > /etc/profile.d/colab-desk-env.sh`);
    shellSteps.push(`grep -q 'colab-desk-env.sh' /root/.bashrc 2>/dev/null || echo 'source /etc/profile.d/colab-desk-env.sh' >> /root/.bashrc`);
    shellSteps.push(`source /etc/profile.d/colab-desk-env.sh`);
    shellSteps.push(`echo "[env] injected ${effectiveEnv.length} vars"`);
  }
  if (config.hfCacheToDrive) {
    shellSteps.push(`mkdir -p /content/drive/MyDrive/.cache/huggingface 2>/dev/null || true`);
  }
  if (config.autoInstallUv) {
    shellSteps.push(`command -v uv >/dev/null 2>&1 || pip install -q uv`);
    shellSteps.push(`echo "[uv] ready"`);
  }
  if (config.enableHfTransfer) {
    shellSteps.push(`python3 -c "import hf_transfer" 2>/dev/null || (command -v uv >/dev/null 2>&1 && uv pip install --system -q hf_transfer || pip install -q hf_transfer)`);
    shellSteps.push(`echo "[hf_transfer] ready"`);
  }
  if (config.customScript && String(config.customScript).trim()) {
    const customB64 = Buffer.from(String(config.customScript), "utf8").toString("base64");
    shellSteps.push(`echo '${customB64}' | base64 -d | bash`);
  }

  if (shellSteps.length > 1) {
    const scriptB64 = Buffer.from(shellSteps.join("\n") + "\n", "utf8").toString("base64");
    const res = await runAction({
      type: "ssh",
      session,
      command: `echo '${scriptB64}' | base64 -d | bash`,
    }, { signal });
    if (res.stdout) logs.push(res.stdout.trim());
    if (!res.ok) {
      return { ok: false, error: res.error || res.stderr || "bootstrap failed", log: logs.join("\n") };
    }
  }

  return { ok: true, log: logs.join("\n") || "ok" };
}

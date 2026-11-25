import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, IMAGE_DIR } from "./agent.mjs";
import { runAction } from "./run.mjs";

const EXPORT_DIR = path.join(os.tmpdir(), "colab-desk-exports");
const DOWNLOAD_DIR = path.join(os.tmpdir(), "colab-desk-downloads");
const MEDIA_DIR = path.join(os.tmpdir(), "colab-desk-media");
const SYNC_DIR = path.join(os.tmpdir(), "colab-desk-sync");

export const MEDIA_MIME_MAP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function parseNvidiaSmi(text) {
  const gpus = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /not found|failed|error/i.test(line)) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 4) continue;
    const memUsedMb = Number(parts[1]);
    const memTotalMb = Number(parts[2]);
    const utilPct = Number(parts[3]);
    const tempC = parts.length >= 5 ? Number(parts[4]) : null;
    if (!Number.isFinite(memUsedMb) || !Number.isFinite(memTotalMb) || memTotalMb <= 0) continue;
    gpus.push({
      name: parts[0],
      memUsedMb,
      memTotalMb,
      utilPct: Number.isFinite(utilPct) ? utilPct : 0,
      tempC: Number.isFinite(tempC) ? tempC : null,
    });
  }
  return gpus;
}

export function parseGpuProcesses(text) {
  const procs = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /not found|failed|error|no running/i.test(line)) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const memMb = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    procs.push({
      pid,
      name: path.basename(parts[1] || "python"),
      memMb: Number.isFinite(memMb) ? memMb : 0,
    });
  }
  return procs;
}

export function parseListeningPorts(text) {
  const ports = new Set();
  const ignore = new Set([22, 6000, 9000, 9001, 9002]);
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const m = rawLine.trim().match(/^(\d+)$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (port >= 1024 && port <= 65535 && !ignore.has(port) && port < 30000) {
      ports.add(port);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

export async function fetchGpuTelemetry(session, signal) {
  if (!session) return { ok: true, available: false, gpus: [], processes: [], listeningPorts: [] };
  const parsePayload = (out) => {
    const text = String(out || "");
    const gpuSec = text.split("===GPU===")[1]?.split("===PROCS===")[0] || text;
    const procSec = text.split("===PROCS===")[1]?.split("===PORTS===")[0] || "";
    const portSec = text.split("===PORTS===")[1] || "";
    return {
      gpus: parseNvidiaSmi(gpuSec),
      processes: parseGpuProcesses(procSec),
      listeningPorts: parseListeningPorts(portSec),
    };
  };
  const cmd = [
    "echo '===GPU==='",
    "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true",
    "echo '===PROCS==='",
    "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true",
    "echo '===PORTS==='",
    "python3 -c \"import glob; ps=set(); [ps.add(int(l.split()[1].split(':')[1],16)) for fn in ('/proc/net/tcp','/proc/net/tcp6') for l in (open(fn).read().splitlines()[1:] if glob.glob(fn) else []) if len(l.split())>3 and l.split()[3]=='0A']; print('\\n'.join(str(p) for p in sorted(ps)))\" 2>/dev/null || true",
  ].join("; ");
  const res = await runAction({ type: "ssh", session, command: cmd }, { signal });
  if (res.ok) {
    const parsed = parsePayload(res.stdout);
    if (parsed.gpus.length > 0 || parsed.listeningPorts.length > 0) {
      return { ok: true, available: parsed.gpus.length > 0, ...parsed };
    }
  }
  // Fallback to `colab exec` when SSH daemon is not ready yet
  const pyFallback = [
    "import subprocess, glob",
    "def sh(a):",
    "  try: return subprocess.check_output(a, stderr=subprocess.DEVNULL, text=True)",
    "  except Exception: return ''",
    "print('===GPU===')",
    "print(sh(['nvidia-smi','--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits']))",
    "print('===PROCS===')",
    "print(sh(['nvidia-smi','--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader,nounits']))",
    "print('===PORTS===')",
    "ps=set()",
    "for fn in ('/proc/net/tcp','/proc/net/tcp6'):",
    "  if glob.glob(fn):",
    "    for l in open(fn).read().splitlines()[1:]:",
    "      p=l.split()",
    "      if len(p)>3 and p[3]=='0A': ps.add(int(p[1].split(':')[1],16))",
    "print('\\n'.join(str(x) for x in sorted(ps)))",
  ].join("\n");
  const execRes = await runAction({ type: "exec", session, code: pyFallback, timeout: 15 }, { signal });
  if (!execRes.ok) {
    return { ok: false, available: false, gpus: [], processes: [], listeningPorts: [], error: res.error || execRes.error || "telemetry failed" };
  }
  const parsed = parsePayload(execRes.stdout);
  return { ok: true, available: parsed.gpus.length > 0, ...parsed };
}

export async function killRemoteProcess(session, pid, signal) {
  const numPid = Number(pid);
  if (!session || !Number.isInteger(numPid) || numPid <= 1) {
    return { ok: false, error: "invalid session or pid" };
  }
  const res = await runAction({ type: "ssh", session, command: `kill -9 ${numPid} 2>&1 || true` }, { signal });
  return { ok: res.ok, error: res.ok ? null : (res.error || "kill failed") };
}

export async function listRemoteFiles(session, remotePath = "/content", signal) {
  if (!session) return { ok: false, error: "no session selected", path: remotePath, entries: [] };
  const target = String(remotePath || "/content").trim() || "/content";
  const b64 = Buffer.from(target, "utf8").toString("base64");
  const py = [
    "import os, json, base64",
    `p = base64.b64decode('${b64}').decode('utf-8')`,
    "p = os.path.abspath(p)",
    "out = {'path': p, 'parent': os.path.dirname(p) if p != '/' else None, 'driveMounted': os.path.isdir('/content/drive/MyDrive'), 'entries': []}",
    "try:",
    "  for e in os.scandir(p):",
    "    try:",
    "      st = e.stat(follow_symlinks=False)",
    "      out['entries'].append({'name': e.name, 'path': os.path.join(p, e.name), 'isDir': e.is_dir(follow_symlinks=False), 'size': st.st_size, 'mtime': int(st.st_mtime * 1000)})",
    "    except Exception: pass",
    "  out['entries'].sort(key=lambda x: (not x['isDir'], x['name'].lower()))",
    "except Exception as ex:",
    "  out['error'] = str(ex)",
    "print(json.dumps(out))",
  ].join("\n");
  const pyB64 = Buffer.from(py, "utf8").toString("base64");
  const cmd = `python3 -c "import base64; exec(base64.b64decode('${pyB64}').decode())"`;
  const res = await runAction({ type: "ssh", session, command: cmd }, { signal });
  if (!res.ok) {
    return { ok: false, error: res.error || "failed to list files", path: target, entries: [] };
  }
  const lines = String(res.stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && Array.isArray(parsed.entries)) {
        return { ok: !parsed.error, ...parsed };
      }
    } catch {}
  }
  return { ok: false, error: "invalid directory response", path: target, entries: [] };
}

export async function previewRemoteFile(session, remotePath, signal) {
  if (!session || !remotePath) return { ok: false, error: "session and path required" };
  const ext = path.extname(remotePath).toLowerCase();
  const name = path.basename(remotePath);
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const safeName = name.replace(/[^\w.-]+/g, "_");
    const localPath = path.join(IMAGE_DIR, `preview-${Date.now().toString(36)}-${safeName}`);
    const res = await runAction({ type: "download", session, remote: remotePath, local: localPath }, { signal });
    if (!res.ok || !fs.existsSync(localPath)) {
      return { ok: false, error: res.error || "failed to download image preview" };
    }
    return {
      ok: true,
      kind: "image",
      name,
      path: remotePath,
      url: `/api/image?path=${encodeURIComponent(localPath)}`,
    };
  }
  if ([".mp4", ".webm", ".mov", ".m4v"].includes(ext)) {
    return {
      ok: true,
      kind: "video",
      name,
      path: remotePath,
      url: `/api/files/media?session=${encodeURIComponent(session)}&path=${encodeURIComponent(remotePath)}`,
    };
  }

  const b64 = Buffer.from(remotePath, "utf8").toString("base64");
  const py = [
    "import os, json, base64",
    `p = base64.b64decode('${b64}').decode('utf-8')`,
    "try:",
    "  st = os.stat(p)",
    "  with open(p, 'rb') as f: raw = f.read(65536)",
    "  if b'\\x00' in raw[:4096]:",
    "    print(json.dumps({'ok': True, 'kind': 'binary', 'size': st.st_size}))",
    "  else:",
    "    print(json.dumps({'ok': True, 'kind': 'text', 'size': st.st_size, 'truncated': st.st_size > 65536, 'content': raw.decode('utf-8', errors='replace')}))",
    "except Exception as ex:",
    "  print(json.dumps({'ok': False, 'error': str(ex)}))",
  ].join("\n");
  const pyB64 = Buffer.from(py, "utf8").toString("base64");
  const cmd = `python3 -c "import base64; exec(base64.b64decode('${pyB64}').decode())"`;
  const res = await runAction({ type: "ssh", session, command: cmd }, { signal });
  if (!res.ok) return { ok: false, error: res.error || "preview failed" };
  const lines = String(res.stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed.ok === "boolean") {
        return { ...parsed, name, path: remotePath };
      }
    } catch {}
  }
  return { ok: false, error: "failed to parse preview" };
}

export async function downloadRemoteFile(session, remotePath, signal) {
  if (!session || !remotePath) return { ok: false, error: "session and path required" };
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const name = path.basename(remotePath) || "download.bin";
  const safeName = name.replace(/[^\w.-]+/g, "_");
  const localPath = path.join(DOWNLOAD_DIR, `${Date.now().toString(36)}-${safeName}`);
  const res = await runAction({ type: "download", session, remote: remotePath, local: localPath }, { signal });
  if (!res.ok || !fs.existsSync(localPath)) {
    return { ok: false, error: res.error || "download failed" };
  }
  return { ok: true, localPath, name };
}

export async function uploadRemoteFile(session, localPath, remoteDir, fileName, signal) {
  if (!session || !localPath) return { ok: false, error: "session and file required" };
  const cleanDir = String(remoteDir || "/content").replace(/\/+$/, "") || "/content";
  const cleanName = path.basename(String(fileName || path.basename(localPath)));
  const remotePath = `${cleanDir}/${cleanName}`;
  const res = await runAction({ type: "upload", session, local: localPath, remote: remotePath }, { signal });
  return { ok: res.ok, path: remotePath, error: res.ok ? null : (res.error || "upload failed") };
}

export async function deleteRemoteFile(session, remotePath, signal) {
  if (!session || !remotePath) return { ok: false, error: "session and path required" };
  const res = await runAction({ type: "rm", session, path: remotePath }, { signal });
  return { ok: res.ok, error: res.ok ? null : (res.error || "delete failed") };
}

export async function ensureRemoteMedia(session, remotePath, signal) {
  if (!session || !remotePath) return { ok: false, error: "session and path required" };
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = path.extname(remotePath).toLowerCase();
  const mime = MEDIA_MIME_MAP[ext] || "application/octet-stream";
  const name = path.basename(remotePath) || "media.bin";
  const safeKey = Buffer.from(`${session}:${remotePath}`).toString("base64url").slice(0, 64);
  const localPath = path.join(MEDIA_DIR, `${safeKey}${ext}`);
  // Reuse recent cached download within 45s for smooth video range scrubbing
  try {
    const st = fs.statSync(localPath);
    if (st.size > 0 && Date.now() - st.mtimeMs < 45_000) {
      return { ok: true, localPath, mime, size: st.size, name };
    }
  } catch {}
  const res = await runAction({ type: "download", session, remote: remotePath, local: localPath }, { signal });
  if (!res.ok || !fs.existsSync(localPath)) {
    return { ok: false, error: res.error || "failed to fetch media" };
  }
  const st = fs.statSync(localPath);
  return { ok: true, localPath, mime, size: st.size, name };
}

export async function copyFilesToDrive(session, paths = [], targetDir = "/content/drive/MyDrive/ColabDesk_Exports", signal) {
  if (!session || !Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: "session and paths required" };
  }
  const payloadB64 = Buffer.from(JSON.stringify({ paths, targetDir }), "utf8").toString("base64");
  const py = [
    "import os, shutil, json, base64",
    `cfg = json.loads(base64.b64decode('${payloadB64}').decode('utf-8'))`,
    "if not os.path.isdir('/content/drive/MyDrive'): raise RuntimeError('Google Drive 未挂载，请先挂载 Drive')",
    "os.makedirs(cfg['targetDir'], exist_ok=True)",
    "copied = []",
    "for src in cfg['paths']:",
    "  dst = os.path.join(cfg['targetDir'], os.path.basename(src.rstrip('/')))",
    "  if os.path.isdir(src): shutil.copytree(src, dst, dirs_exist_ok=True)",
    "  else: shutil.copy2(src, dst)",
    "  copied.append(dst)",
    "print(json.dumps({'ok': True, 'copied': copied}))",
  ].join("\n");
  const pyB64 = Buffer.from(py, "utf8").toString("base64");
  const res = await runAction({
    type: "ssh",
    session,
    command: `python3 -c "import base64; exec(base64.b64decode('${pyB64}').decode())"`,
  }, { signal });
  if (!res.ok) return { ok: false, error: res.error || res.stderr || "copy to Drive failed" };
  return { ok: true, output: res.stdout };
}

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

function runLocalCommand(exe, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve({ ok: false, stdout, stderr: "timeout" });
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
  });
}

export async function syncPushFolder({ session, localDir, remoteDir, signal }) {
  if (!session || !localDir) return { ok: false, error: "需要指定会话与本地目录" };
  const resolvedLocal = path.resolve(localDir.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(resolvedLocal) || !fs.statSync(resolvedLocal).isDirectory()) {
    return { ok: false, error: `本地目录不存在: ${resolvedLocal}` };
  }
  const targetRemote = String(remoteDir || `/content/${path.basename(resolvedLocal)}`).trim();
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const archiveLocal = path.join(SYNC_DIR, `push-${Date.now().toString(36)}.tar.gz`);
  const archiveRemote = `/tmp/colab-desk-push-${Date.now().toString(36)}.tar.gz`;

  const tarRes = await runLocalCommand("tar", [
    "-czf", archiveLocal,
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=__pycache__",
    "--exclude=.DS_Store",
    "--exclude=.venv",
    "--exclude=dist",
    "-C", resolvedLocal,
    ".",
  ]);
  if (!tarRes.ok) {
    try { fs.unlinkSync(archiveLocal); } catch {}
    return { ok: false, error: `打包本地目录失败: ${tarRes.stderr}` };
  }
  const size = fs.statSync(archiveLocal).size;
  const upRes = await runAction({ type: "upload", session, local: archiveLocal, remote: archiveRemote }, { signal });
  try { fs.unlinkSync(archiveLocal); } catch {}
  if (!upRes.ok) return { ok: false, error: `上传失败: ${upRes.error}` };

  const remoteB64 = Buffer.from(targetRemote, "utf8").toString("base64");
  const extractCmd = `R=$(echo '${remoteB64}' | base64 -d); mkdir -p "$R" && tar -xzf "${archiveRemote}" -C "$R" && rm -f "${archiveRemote}" && echo "synced:$R"`;
  const exRes = await runAction({ type: "ssh", session, command: extractCmd }, { signal });
  if (!exRes.ok) return { ok: false, error: `云端解压失败: ${exRes.error}` };
  return { ok: true, localDir: resolvedLocal, remoteDir: targetRemote, bytes: size };
}

export async function syncPullFolder({ session, localDir, remoteDir, signal }) {
  if (!session || !localDir || !remoteDir) return { ok: false, error: "需要指定会话、远程目录和本地目录" };
  const resolvedLocal = path.resolve(localDir.replace(/^~(?=\/|$)/, os.homedir()));
  fs.mkdirSync(resolvedLocal, { recursive: true });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const archiveLocal = path.join(SYNC_DIR, `pull-${Date.now().toString(36)}.tar.gz`);
  const archiveRemote = `/tmp/colab-desk-pull-${Date.now().toString(36)}.tar.gz`;
  const remoteB64 = Buffer.from(String(remoteDir).trim(), "utf8").toString("base64");

  const packCmd = `R=$(echo '${remoteB64}' | base64 -d); tar -czf "${archiveRemote}" --exclude='__pycache__' --exclude='.git' -C "$R" .`;
  const packRes = await runAction({ type: "ssh", session, command: packCmd }, { signal });
  if (!packRes.ok) return { ok: false, error: `云端打包失败: ${packRes.error}` };

  const dlRes = await runAction({ type: "download", session, remote: archiveRemote, local: archiveLocal }, { signal });
  await runAction({ type: "ssh", session, command: `rm -f "${archiveRemote}"` }).catch(() => {});
  if (!dlRes.ok || !fs.existsSync(archiveLocal)) {
    return { ok: false, error: `下载失败: ${dlRes.error}` };
  }
  const size = fs.statSync(archiveLocal).size;
  const untarRes = await runLocalCommand("tar", ["-xzf", archiveLocal, "-C", resolvedLocal]);
  try { fs.unlinkSync(archiveLocal); } catch {}
  if (!untarRes.ok) return { ok: false, error: `本地解压失败: ${untarRes.stderr}` };
  return { ok: true, localDir: resolvedLocal, remoteDir, bytes: size };
}

export function parseReleaseTagFromUrl(url) {
  const m = String(url || "").match(/\/releases\/tag\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/^v/i, "") : "";
}

export function compareSemver(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export async function checkForUpdates(currentVersion = "0.4.9") {
  const repo = "CalicoX/colab-desk";
  const latestWebUrl = `https://github.com/${repo}/releases/latest`;
  const releasesFallbackUrl = `https://github.com/${repo}/releases`;

  // Primary: use github.com/releases/latest 302 redirect (no 60/hr GitHub REST API rate limit)
  try {
    const res = await fetch(latestWebUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "colab-desk" },
      signal: AbortSignal.timeout(6000),
    });
    const loc = res.headers.get("location") || "";
    const tagFromLoc = parseReleaseTagFromUrl(loc);
    if (tagFromLoc) {
      return {
        ok: true,
        currentVersion,
        latestVersion: tagFromLoc,
        hasUpdate: compareSemver(tagFromLoc, currentVersion) > 0,
        releaseUrl: loc.startsWith("http") ? loc : `https://github.com${loc}`,
        publishedAt: null,
        source: "github-redirect",
      };
    }
    if (res.ok) {
      const tagFromFinalUrl = parseReleaseTagFromUrl(res.url);
      if (tagFromFinalUrl) {
        return {
          ok: true,
          currentVersion,
          latestVersion: tagFromFinalUrl,
          hasUpdate: compareSemver(tagFromFinalUrl, currentVersion) > 0,
          releaseUrl: res.url || releasesFallbackUrl,
          publishedAt: null,
          source: "github-web",
        };
      }
    }
  } catch {
    // Fall through to GitHub API fallback
  }

  // Fallback: GitHub REST API (uses optional GITHUB_TOKEN / GH_TOKEN when available)
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "colab-desk" };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, currentVersion, error: `HTTP ${res.status}` };
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/i, "");
    const hasUpdate = Boolean(latest && compareSemver(latest, currentVersion) > 0);
    return {
      ok: true,
      currentVersion,
      latestVersion: latest || currentVersion,
      hasUpdate,
      releaseUrl: data.html_url || releasesFallbackUrl,
      publishedAt: data.published_at || null,
      source: "github-api",
    };
  } catch (err) {
    return { ok: false, currentVersion, error: err.message || String(err) };
  }
}

export function buildNotebookFromHistory(sessionName, entries = []) {
  const cells = [
    {
      cell_type: "markdown",
      metadata: {},
      source: [`# Colab Desk Export — ${sessionName || "session"}\n`],
    },
  ];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.kind === "agent") {
      if (entry.prompt) {
        cells.push({
          cell_type: "markdown",
          metadata: {},
          source: [`### User\n\n${entry.prompt}\n`],
        });
      }
      if (Array.isArray(entry.tools)) {
        for (const tool of entry.tools) {
          const input = String(tool.input || "");
          const output = String(tool.output || "");
          if (input.trim()) {
            cells.push({
              cell_type: "code",
              execution_count: null,
              metadata: {},
              source: [`# ${tool.title || "tool"}\n`, `${input}\n`],
              outputs: output
                ? [{ output_type: "stream", name: "stdout", text: [output] }]
                : [],
            });
          }
        }
      }
      if (entry.text) {
        cells.push({
          cell_type: "markdown",
          metadata: {},
          source: [`### ${entry.providerName || "Agent"}\n\n${entry.text}\n`],
        });
      }
    } else {
      const src = entry.argv?.length ? `# $ colab ${entry.argv.join(" ")}\n` : `# ${entry.label || "cli"}\n`;
      cells.push({
        cell_type: "code",
        execution_count: null,
        metadata: {},
        source: [src],
        outputs: entry.text
          ? [{ output_type: "stream", name: "stdout", text: [entry.text] }]
          : [],
      });
    }
  }
  return JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
        language_info: { name: "python" },
      },
      cells,
    },
    null,
    2,
  );
}

export function buildMarkdownFromHistory(sessionName, entries = []) {
  const lines = [`# Colab Desk Export — ${sessionName || "session"}`, ""];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.kind === "agent") {
      lines.push(`## User`, "", entry.prompt || "", "");
      if (Array.isArray(entry.tools) && entry.tools.length > 0) {
        lines.push(`### Tool Calls (${entry.tools.length})`, "");
        for (const tool of entry.tools) {
          lines.push(`- **${tool.title || "tool"}** (${tool.status || "done"})`);
          if (tool.output) {
            lines.push("", "```text", String(tool.output).slice(0, 4000), "```", "");
          }
        }
      }
      if (entry.text) {
        lines.push(`## ${entry.providerName || "Agent"}`, "", entry.text, "");
      }
    } else {
      lines.push(`## CLI: \`${entry.label || ""}\``, "");
      if (entry.argv?.length) lines.push("```bash", `colab ${entry.argv.join(" ")}`, "```", "");
      if (entry.text) lines.push("```text", entry.text, "```", "");
    }
  }
  return lines.join("\n");
}

export async function exportSession(sessionName, format = "ipynb", entries = [], signal) {
  const ext = format === "md" ? "md" : "ipynb";
  const safeSession = String(sessionName || "colab-desk").replace(/[^\w.-]+/g, "_");
  const filename = `${safeSession}-${Date.now().toString(36)}.${ext}`;

  if (sessionName && (!Array.isArray(entries) || entries.length === 0)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const outPath = path.join(EXPORT_DIR, filename);
    const res = await runAction({ type: "log", session: sessionName, output: outPath }, { signal });
    if (res.ok && fs.existsSync(outPath)) {
      const content = fs.readFileSync(outPath, "utf8");
      try { fs.unlinkSync(outPath); } catch {}
      if (content.trim()) {
        return { ok: true, filename, content, source: "colab-log" };
      }
    }
  }

  // If sessionName is present, try colab log first for pure CLI execution log when requested, else export full conversation + code
  if (sessionName && ext === "ipynb") {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const outPath = path.join(EXPORT_DIR, filename);
    const res = await runAction({ type: "log", session: sessionName, output: outPath }, { signal });
    if (res.ok && fs.existsSync(outPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
        fs.unlinkSync(outPath);
        if (parsed && Array.isArray(parsed.cells) && parsed.cells.length > 0 && (!entries || entries.length === 0)) {
          return { ok: true, filename, content: JSON.stringify(parsed, null, 2), source: "colab-log" };
        }
      } catch {
        try { fs.unlinkSync(outPath); } catch {}
      }
    }
  }

  const content = ext === "md"
    ? buildMarkdownFromHistory(sessionName, entries)
    : buildNotebookFromHistory(sessionName, entries);
  return { ok: true, filename, content, source: "transcript" };
}

export class TunnelManager {
  constructor() {
    this.tunnels = new Map();
  }

  list(session = null) {
    const items = [];
    for (const t of this.tunnels.values()) {
      if (session && t.session !== session) continue;
      items.push({
        id: t.id,
        session: t.session,
        remotePort: t.remotePort,
        localPort: t.localPort,
        label: t.label,
        url: `http://127.0.0.1:${t.localPort}`,
        status: t.status,
        startedAt: t.startedAt,
        error: t.error,
      });
    }
    return items;
  }

  async open({ session, remotePort, localPort, label }) {
    if (!session) return { ok: false, error: "请先选择一个活跃会话" };
    const rPort = Number(remotePort);
    const lPort = Number(localPort || remotePort);
    if (!Number.isInteger(rPort) || rPort < 1 || rPort > 65535) {
      return { ok: false, error: "无效的远程端口号" };
    }
    if (!Number.isInteger(lPort) || lPort < 1024 || lPort > 65535) {
      return { ok: false, error: "本地端口号需在 1024–65535 之间" };
    }

    for (const existing of this.tunnels.values()) {
      if (existing.status === "open" && existing.localPort === lPort) {
        if (existing.session === session && existing.remotePort === rPort) {
          return { ok: true, tunnel: this._publicView(existing) };
        }
        return { ok: false, error: `本地端口 ${lPort} 已被其他转发占用` };
      }
    }

    const sshExe = findExecutable("ssh");
    const colabExe = findExecutable("colab");
    if (!sshExe) return { ok: false, error: "未找到本机 ssh 命令" };
    if (!colabExe) return { ok: false, error: "未找到本机 colab 命令" };

    const safeSession = String(session).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeSession) return { ok: false, error: "无效会话名称" };

    const id = `tun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const proxyCmd = `"${colabExe}" ssh --proxy-mode -s ${safeSession}`;
    const args = [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ServerAliveInterval=30",
      "-o", "BatchMode=yes",
      "-o", `ProxyCommand=${proxyCmd}`,
      "-L", `127.0.0.1:${lPort}:127.0.0.1:${rPort}`,
      "root@colab",
    ];

    const child = spawn(sshExe, args, { stdio: ["ignore", "pipe", "pipe"] });
    const rec = {
      id,
      session: safeSession,
      remotePort: rPort,
      localPort: lPort,
      label: String(label || `:${rPort}`),
      status: "connecting",
      startedAt: Date.now(),
      error: null,
      child,
    };
    this.tunnels.set(id, rec);

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; });

    const ready = await new Promise((resolve) => {
      let settled = false;
      const done = (ok, errMsg = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          rec.status = "open";
          resolve({ ok: true });
        } else {
          rec.status = "error";
          rec.error = errMsg;
          this.tunnels.delete(id);
          resolve({ ok: false, error: errMsg });
        }
      };
      child.on("error", (err) => done(false, err.message));
      child.on("close", (code) => {
        if (!settled) {
          done(false, stderr.trim() || `SSH 隧道退出 (code ${code})`);
        } else {
          this.tunnels.delete(id);
        }
      });
      const timer = setTimeout(() => done(true), 1400);
      timer.unref();
    });

    if (!ready.ok) return { ok: false, error: ready.error };
    return { ok: true, tunnel: this._publicView(rec) };
  }

  close(id) {
    const rec = this.tunnels.get(id);
    if (!rec) return false;
    this.tunnels.delete(id);
    try { rec.child.kill("SIGTERM"); } catch {}
    return true;
  }

  shutdown() {
    for (const rec of this.tunnels.values()) {
      try { rec.child.kill("SIGTERM"); } catch {}
    }
    this.tunnels.clear();
  }

  _publicView(rec) {
    return {
      id: rec.id,
      session: rec.session,
      remotePort: rec.remotePort,
      localPort: rec.localPort,
      label: rec.label,
      url: `http://127.0.0.1:${rec.localPort}`,
      status: rec.status,
      startedAt: rec.startedAt,
      error: rec.error,
    };
  }
}

/* ── Native Colab Notebook Mode (100% official `colab` CLI) ── */

function joinIpynbLines(src) {
  if (typeof src === "string") return src;
  if (Array.isArray(src)) return src.map((s) => String(s ?? "")).join("");
  return "";
}

function splitIpynbLines(text) {
  const s = String(text || "");
  if (!s) return [];
  const lines = s.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

export function parseIpynb(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const rawCells = Array.isArray(parsed?.cells) ? parsed.cells : [];
  const cells = rawCells.map((cell, idx) => {
    const type = cell?.cell_type === "markdown" ? "markdown" : "code";
    const source = joinIpynbLines(cell?.source);
    const executionCount = typeof cell?.execution_count === "number" ? cell.execution_count : null;
    const stdoutParts = [];
    const stderrParts = [];
    const images = [];
    if (Array.isArray(cell?.outputs)) {
      for (const out of cell.outputs) {
        if (!out || typeof out !== "object") continue;
        if (out.output_type === "stream") {
          const txt = joinIpynbLines(out.text);
          if (out.name === "stderr") stderrParts.push(txt);
          else stdoutParts.push(txt);
        } else if (out.output_type === "error") {
          const tb = Array.isArray(out.traceback) && out.traceback.length
            ? out.traceback.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
            : `${out.ename || "Error"}: ${out.evalue || ""}`;
          stderrParts.push(tb);
        } else if (out.output_type === "display_data" || out.output_type === "execute_result") {
          const data = out.data || {};
          if (data["image/png"]) {
            const b64 = joinIpynbLines(data["image/png"]).replace(/\s+/g, "");
            if (b64) images.push({ dataUrl: `data:image/png;base64,${b64}` });
          } else if (data["image/jpeg"]) {
            const b64 = joinIpynbLines(data["image/jpeg"]).replace(/\s+/g, "");
            if (b64) images.push({ dataUrl: `data:image/jpeg;base64,${b64}` });
          } else if (data["text/plain"]) {
            stdoutParts.push(joinIpynbLines(data["text/plain"]));
          }
        }
      }
    }
    return {
      id: String(cell?.id || `cell-${Date.now().toString(36)}-${idx}`),
      type,
      source,
      executionCount,
      stdout: stdoutParts.join(""),
      stderr: stderrParts.join("\n").trim(),
      images,
      ok: stderrParts.length === 0,
      durationMs: null,
    };
  });
  return {
    cells: cells.length > 0 ? cells : [{
      id: `cell-${Date.now().toString(36)}-0`,
      type: "code",
      source: "",
      executionCount: null,
      stdout: "",
      stderr: "",
      images: [],
      ok: true,
      durationMs: null,
    }],
    metadata: parsed?.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {},
  };
}

export function serializeIpynb(cells, metadata = {}) {
  const nbCells = (Array.isArray(cells) ? cells : []).map((cell) => {
    const type = cell?.type === "markdown" ? "markdown" : "code";
    const source = splitIpynbLines(cell?.source || "");
    if (type === "markdown") {
      return {
        cell_type: "markdown",
        metadata: {},
        source,
      };
    }
    const outputs = [];
    if (cell.stdout) {
      outputs.push({
        output_type: "stream",
        name: "stdout",
        text: splitIpynbLines(cell.stdout),
      });
    }
    if (cell.stderr) {
      outputs.push({
        output_type: "stream",
        name: "stderr",
        text: splitIpynbLines(cell.stderr),
      });
    }
    if (Array.isArray(cell.images)) {
      for (const img of cell.images) {
        const dataUrl = String(img?.dataUrl || "");
        const m = dataUrl.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/i);
        if (m) {
          outputs.push({
            output_type: "display_data",
            data: { [m[1].toLowerCase()]: m[2] },
            metadata: {},
          });
        }
      }
    }
    return {
      cell_type: "code",
      execution_count: typeof cell.executionCount === "number" ? cell.executionCount : null,
      metadata: {},
      source,
      outputs,
    };
  });
  return JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
        language_info: { name: "python" },
        ...metadata,
      },
      cells: nbCells,
    },
    null,
    2,
  );
}

const NOTEBOOK_DIR = path.join(os.tmpdir(), "colab-desk-notebooks");

export async function execNotebookCell({ session, code, timeout = 300, signal }) {
  if (!session) return { ok: false, stdout: "", stderr: "", error: "请先连接一台 Colab 会话", images: [], durationMs: 0 };
  const src = String(code || "");
  if (!src.trim()) return { ok: true, stdout: "", stderr: "", error: "", images: [], durationMs: 0 };
  fs.mkdirSync(NOTEBOOK_DIR, { recursive: true });
  const imgFile = path.join(NOTEBOOK_DIR, `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.png`);
  const started = Date.now();
  try {
    const res = await runAction(
      {
        type: "exec",
        session,
        code: src,
        timeout,
        outputImage: imgFile,
      },
      { signal },
    );
    const durationMs = Date.now() - started;
    const images = [];
    if (fs.existsSync(imgFile)) {
      try {
        const bytes = fs.readFileSync(imgFile);
        if (bytes.length > 0) {
          images.push({ dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
        }
      } catch {}
      try { fs.unlinkSync(imgFile); } catch {}
    }
    // Check numbered images if colab CLI wrote imgFile_1.png etc.
    const baseNoExt = imgFile.replace(/\.png$/i, "");
    for (let k = 1; k <= 6; k += 1) {
      const extra = `${baseNoExt}_${k}.png`;
      if (fs.existsSync(extra)) {
        try {
          const bytes = fs.readFileSync(extra);
          if (bytes.length > 0) {
            images.push({ dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
          }
        } catch {}
        try { fs.unlinkSync(extra); } catch {}
      }
    }
    return {
      ok: !!res.ok,
      stdout: String(res.stdout || ""),
      stderr: String(res.stderr || ""),
      error: res.ok ? "" : String(res.error || res.stderr || "Execution failed"),
      images,
      durationMs,
    };
  } catch (err) {
    try { fs.unlinkSync(imgFile); } catch {}
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: err.message || String(err),
      images: [],
      durationMs: Date.now() - started,
    };
  }
}

export async function inspectKernelVariables(session, signal) {
  if (!session) return { ok: false, variables: [], error: "No active Colab session" };
  const probe = `
import json, types, sys
_cd_out = []
for _k, _v in list(globals().items()):
    if _k.startswith("_") or _k in ("In", "Out", "get_ipython", "exit", "quit", "open"):
        continue
    if isinstance(_v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
        continue
    _t = type(_v).__name__
    _shape = ""
    _preview = ""
    try:
        if hasattr(_v, "shape"):
            _sh = getattr(_v, "shape")
            _dt = getattr(_v, "dtype", "")
            _dev = getattr(_v, "device", "")
            _shape = f"{tuple(_sh)}" + (f" · {str(_dt).replace('torch.', '')}" if _dt else "") + (f" · {_dev}" if _dev else "")
        elif isinstance(_v, (list, tuple, dict, set)):
            _shape = f"len={len(_v)}"
        elif isinstance(_v, str):
            _shape = f"len={len(_v)}"
        _p = repr(_v)
        _preview = _p[:80] + ("…" if len(_p) > 80 else "")
    except Exception:
        _preview = "<unreadable>"
    _cd_out.append({"name": _k, "type": _t, "shape": _shape, "preview": _preview})
print("__CD_VARS__" + json.dumps(_cd_out[:80], ensure_ascii=False))
`.trim();
  const res = await runAction({ type: "exec", session, code: probe, timeout: 15 }, { signal });
  if (!res.ok) {
    return { ok: false, variables: [], error: res.error || res.stderr || "Inspect failed" };
  }
  const line = String(res.stdout || "").split(/\r?\n/).find((l) => l.includes("__CD_VARS__"));
  if (!line) return { ok: true, variables: [] };
  try {
    const vars = JSON.parse(line.split("__CD_VARS__")[1]);
    return { ok: true, variables: Array.isArray(vars) ? vars : [] };
  } catch {
    return { ok: true, variables: [] };
  }
}

export async function readCloudNotebook(session, remotePath) {
  if (!session || !remotePath) return { ok: false, error: "session and remotePath are required" };
  const dl = await downloadRemoteFile(session, remotePath);
  if (!dl.ok) return { ok: false, error: dl.error || "Failed to download notebook" };
  try {
    const raw = fs.readFileSync(dl.localPath, "utf8");
    try { fs.unlinkSync(dl.localPath); } catch {}
    const notebook = parseIpynb(raw);
    return { ok: true, name: path.basename(remotePath), remotePath, notebook };
  } catch (err) {
    try { fs.unlinkSync(dl.localPath); } catch {}
    return { ok: false, error: `Invalid .ipynb file: ${err.message}` };
  }
}

export async function saveCloudNotebook(session, remotePath, cells, metadata = {}) {
  if (!session || !remotePath) return { ok: false, error: "session and remotePath are required" };
  fs.mkdirSync(NOTEBOOK_DIR, { recursive: true });
  const name = path.basename(remotePath) || "notebook.ipynb";
  const dir = path.posix.dirname(remotePath) || "/content";
  const localTmp = path.join(NOTEBOOK_DIR, `save-${Date.now().toString(36)}-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  try {
    fs.writeFileSync(localTmp, serializeIpynb(cells, metadata), "utf8");
    const up = await uploadRemoteFile(session, localTmp, dir, name);
    try { fs.unlinkSync(localTmp); } catch {}
    return up;
  } catch (err) {
    try { fs.unlinkSync(localTmp); } catch {}
    return { ok: false, error: err.message || String(err) };
  }
}

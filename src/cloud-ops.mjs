import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, IMAGE_DIR } from "./agent.mjs";
import { runAction } from "./run.mjs";

const EXPORT_DIR = path.join(os.tmpdir(), "colab-desk-exports");
const DOWNLOAD_DIR = path.join(os.tmpdir(), "colab-desk-downloads");

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

export async function fetchGpuTelemetry(session, signal) {
  if (!session) return { ok: true, available: false, gpus: [] };
  const cmd = "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true";
  const res = await runAction({ type: "ssh", session, command: cmd }, { signal });
  if (!res.ok) {
    return { ok: false, available: false, gpus: [], error: res.error || "telemetry failed" };
  }
  const gpus = parseNvidiaSmi(res.stdout);
  return { ok: true, available: gpus.length > 0, gpus };
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

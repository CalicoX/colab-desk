import { spawn } from "node:child_process";
import net from "node:net";
import { findExecutable } from "../agent.mjs";
import { parseLastJsonLine, runRemotePython } from "./shared.mjs";

export function extractTryCloudflareUrl(text) {
  const m = String(text || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return m ? m[0] : null;
}

function probeLocalTcpPort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export class TunnelManager {
  constructor() {
    this.tunnels = new Map();
  }

  list(session = null) {
    const items = [];
    for (const t of this.tunnels.values()) {
      if (session && t.session !== session) continue;
      items.push(this._publicView(t));
    }
    return items;
  }

  async open({ session, remotePort, localPort, label, mode = "cloudflared" }) {
    if (!session) return { ok: false, error: "请先选择一个活跃会话" };
    const rPort = Number(remotePort);
    if (!Number.isInteger(rPort) || rPort < 1 || rPort > 65535) {
      return { ok: false, error: "无效的远程端口号" };
    }
    const safeSession = String(session).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeSession) return { ok: false, error: "无效会话名称" };
    const tunMode = mode === "ssh" ? "ssh" : "cloudflared";

    if (tunMode === "cloudflared") {
      return this._openCloudflared({ session: safeSession, rPort, label });
    }
    return this._openSsh({ session: safeSession, rPort, localPort, label });
  }

  async _openCloudflared({ session, rPort, label }) {
    for (const existing of this.tunnels.values()) {
      if (
        existing.status === "open" &&
        existing.mode === "cloudflared" &&
        existing.session === session &&
        existing.remotePort === rPort &&
        existing.url
      ) {
        return { ok: true, tunnel: this._publicView(existing) };
      }
    }

    const py = [
      "import json, os, platform, re, shutil, signal, subprocess, time, urllib.request",
      `PORT = ${rPort}`,
      "LOG_PATH = f'/tmp/colab-desk-cf-{PORT}.log'",
      "PID_PATH = f'/tmp/colab-desk-cf-{PORT}.pid'",
      "URL_RE = re.compile(r'https://[a-z0-9-]+\\.trycloudflare\\.com', re.I)",
      "def find_url(path):",
      "  try:",
      "    txt = open(path, 'r', errors='ignore').read()",
      "    m = URL_RE.search(txt)",
      "    return m.group(0) if m else None",
      "  except Exception:",
      "    return None",
      "def pid_is_cf(pid):",
      "  try:",
      "    cmd = open(f'/proc/{pid}/cmdline', 'rb').read().decode('utf-8', errors='ignore')",
      "    return 'cloudflared' in cmd",
      "  except Exception:",
      "    return False",
      "# Reuse active cloudflared for this port if already running",
      "if os.path.exists(PID_PATH):",
      "  try:",
      "    old_pid = int(open(PID_PATH).read().strip())",
      "    if pid_is_cf(old_pid):",
      "      u = find_url(LOG_PATH)",
      "      if u:",
      "        print(json.dumps({'ok': True, 'url': u, 'pid': old_pid, 'reused': True}))",
      "        raise SystemExit(0)",
      "      try: os.kill(old_pid, signal.SIGTERM)",
      "      except Exception: pass",
      "  except SystemExit: raise",
      "  except Exception: pass",
      "cf_bin = shutil.which('cloudflared')",
      "for cand in ('/usr/local/bin/cloudflared', '/tmp/cloudflared'):",
      "  if not cf_bin and os.path.isfile(cand) and os.access(cand, os.X_OK):",
      "    cf_bin = cand",
      "if not cf_bin:",
      "  arch = 'arm64' if platform.machine().lower() in ('aarch64', 'arm64') else 'amd64'",
      "  dl_url = f'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}'",
      "  tmp_bin = '/tmp/cloudflared.download'",
      "  dst_bin = '/tmp/cloudflared'",
      "  try:",
      "    if shutil.which('curl'):",
      "      subprocess.check_call(['curl', '-fsSL', '--connect-timeout', '15', '-o', tmp_bin, dl_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
      "    else:",
      "      urllib.request.urlretrieve(dl_url, tmp_bin)",
      "    os.chmod(tmp_bin, 0o755)",
      "    os.replace(tmp_bin, dst_bin)",
      "    cf_bin = dst_bin",
      "  except Exception as ex:",
      "    print(json.dumps({'ok': False, 'error': f'下载 cloudflared 失败: {ex}'}))",
      "    raise SystemExit(0)",
      "try: os.remove(LOG_PATH)",
      "except OSError: pass",
      "logf = open(LOG_PATH, 'wb')",
      "proc = subprocess.Popen(",
      "  [cf_bin, 'tunnel', '--no-autoupdate', '--url', f'http://127.0.0.1:{PORT}'],",
      "  stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True",
      ")",
      "logf.close()",
      "with open(PID_PATH, 'w') as pf: pf.write(str(proc.pid))",
      "deadline = time.time() + 26.0",
      "found_url = None",
      "while time.time() < deadline:",
      "  found_url = find_url(LOG_PATH)",
      "  if found_url: break",
      "  if proc.poll() is not None: break",
      "  time.sleep(0.3)",
      "if found_url:",
      "  print(json.dumps({'ok': True, 'url': found_url, 'pid': proc.pid}))",
      "else:",
      "  tail = ''",
      "  try: tail = open(LOG_PATH, 'r', errors='ignore').read()[-400:].strip()",
      "  except Exception: pass",
      "  print(json.dumps({'ok': False, 'error': tail or '未能获取 Cloudflare 临时隧道链接'}))",
    ].join("\n");

    const res = await runRemotePython(session, py, 45);
    if (!res.ok) {
      return { ok: false, error: res.error || res.stderr || "启动 Cloudflare 临时隧道失败" };
    }
    let parsed = parseLastJsonLine(res.stdout, (obj) => obj && typeof obj.ok === "boolean");
    if (!parsed) {
      const fallbackUrl = extractTryCloudflareUrl(res.stdout);
      if (fallbackUrl) {
        parsed = { ok: true, url: fallbackUrl, pid: null };
      } else {
        return { ok: false, error: (res.stdout || res.stderr || "无法解析 Cloudflare 隧道结果").slice(0, 240) };
      }
    }
    if (!parsed.ok || !parsed.url) {
      return { ok: false, error: parsed.error || "Cloudflare 临时隧道创建失败" };
    }

    const id = `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const rec = {
      id,
      mode: "cloudflared",
      session,
      remotePort: rPort,
      localPort: null,
      remotePid: Number.isInteger(parsed.pid) ? parsed.pid : null,
      label: String(label || `:${rPort}`),
      url: parsed.url,
      status: "open",
      startedAt: Date.now(),
      error: null,
      child: null,
    };
    this.tunnels.set(id, rec);
    return { ok: true, tunnel: this._publicView(rec) };
  }

  async _openSsh({ session, rPort, localPort, label }) {
    const lPort = Number(localPort || rPort);
    if (!Number.isInteger(lPort) || lPort < 1024 || lPort > 65535) {
      return { ok: false, error: "本地端口号需在 1024–65535 之间" };
    }

    for (const existing of this.tunnels.values()) {
      if (existing.status === "open" && existing.mode === "ssh" && existing.localPort === lPort) {
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

    const id = `tun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const proxyCmd = `"${colabExe}" ssh --proxy-mode -s ${session}`;
    const args = [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ServerAliveInterval=30",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
      "-o", `ProxyCommand=${proxyCmd}`,
      "-L", `127.0.0.1:${lPort}:127.0.0.1:${rPort}`,
      "root@colab",
    ];

    const child = spawn(sshExe, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const rec = {
      id,
      mode: "ssh",
      session,
      remotePort: rPort,
      localPort: lPort,
      remotePid: null,
      label: String(label || `:${rPort}`),
      url: `http://127.0.0.1:${lPort}`,
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
      let probeTimer = null;
      const done = (ok, errMsg = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (probeTimer) clearTimeout(probeTimer);
        if (ok) {
          rec.status = "open";
          resolve({ ok: true });
        } else {
          rec.status = "error";
          rec.error = errMsg;
          this.tunnels.delete(id);
          try { child.kill("SIGTERM"); } catch {}
          resolve({ ok: false, error: errMsg });
        }
      };

      const checkPort = async () => {
        if (settled) return;
        const listening = await probeLocalTcpPort(lPort, 350);
        if (settled) return;
        if (listening) {
          done(true);
          return;
        }
        probeTimer = setTimeout(checkPort, 250);
        probeTimer.unref();
      };

      child.on("error", (err) => done(false, err.message));
      child.on("close", (code) => {
        if (!settled) {
          const cleanErr = stderr
            .split(/\r?\n/)
            .filter((line) => line.trim() && !/Warning: Permanently added/i.test(line))
            .join(" ")
            .trim();
          done(false, cleanErr || `SSH 隧道退出 (code ${code})，建议使用 CF 公网隧道`);
        } else {
          this.tunnels.delete(id);
        }
      });

      const deadlineTimer = setTimeout(() => {
        const cleanErr = stderr
          .split(/\r?\n/)
          .filter((line) => line.trim() && !/Warning: Permanently added/i.test(line))
          .join(" ")
          .trim();
        done(false, cleanErr || `等待本地端口 127.0.0.1:${lPort} 就绪超时，建议改用 CF 公网隧道`);
      }, 12_000);
      deadlineTimer.unref();

      probeTimer = setTimeout(checkPort, 350);
      probeTimer.unref();
    });

    if (!ready.ok) return { ok: false, error: ready.error };
    return { ok: true, tunnel: this._publicView(rec) };
  }

  close(id) {
    const rec = this.tunnels.get(id);
    if (!rec) return false;
    this.tunnels.delete(id);
    if (rec.child) {
      try { rec.child.kill("SIGTERM"); } catch {}
    }
    if (rec.mode === "cloudflared" && rec.session) {
      const stopPy = [
        "import os, signal",
        `pid_path = '/tmp/colab-desk-cf-${rec.remotePort}.pid'`,
        `pid = ${rec.remotePid ? rec.remotePid : "None"}`,
        "if pid is None and os.path.exists(pid_path):",
        "  try: pid = int(open(pid_path).read().strip())",
        "  except Exception: pid = None",
        "if pid:",
        "  try: os.kill(pid, signal.SIGTERM)",
        "  except Exception: pass",
        "try: os.remove(pid_path)",
        "except OSError: pass",
      ].join("\n");
      runRemotePython(rec.session, stopPy, 10).catch(() => {});
    }
    return true;
  }

  shutdown() {
    for (const rec of this.tunnels.values()) {
      if (rec.child) {
        try { rec.child.kill("SIGTERM"); } catch {}
      }
    }
    this.tunnels.clear();
  }

  _publicView(rec) {
    return {
      id: rec.id,
      mode: rec.mode || "ssh",
      session: rec.session,
      remotePort: rec.remotePort,
      localPort: rec.localPort,
      label: rec.label,
      url: rec.url || `http://127.0.0.1:${rec.localPort}`,
      status: rec.status,
      startedAt: rec.startedAt,
      error: rec.error,
    };
  }
}

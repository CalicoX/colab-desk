import path from "node:path";
import { runAction } from "../run.mjs";

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
  const ignore = new Set([22, 2222, 6000, 9000, 9001, 9002]);
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

import fs from "node:fs";
import path from "node:path";
import { IMAGE_DIR } from "../agent.mjs";
import { runAction } from "../run.mjs";
import {
  DOWNLOAD_DIR,
  expandHomePath,
  MEDIA_DIR,
  parseLastJsonLine,
  runLocalCommand,
  runRemotePythonSsh,
  sanitizeFilename,
  SYNC_DIR,
} from "./shared.mjs";

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
  const res = await runRemotePythonSsh(session, py, { signal });
  if (!res.ok) {
    return { ok: false, error: res.error || "failed to list files", path: target, entries: [] };
  }
  const parsed = parseLastJsonLine(res.stdout, (obj) => obj && Array.isArray(obj.entries));
  if (parsed) {
    return { ok: !parsed.error, ...parsed };
  }
  return { ok: false, error: "invalid directory response", path: target, entries: [] };
}

export async function previewRemoteFile(session, remotePath, signal) {
  if (!session || !remotePath) return { ok: false, error: "session and path required" };
  const ext = path.extname(remotePath).toLowerCase();
  const name = path.basename(remotePath);
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const safeName = sanitizeFilename(name);
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
  const res = await runRemotePythonSsh(session, py, { signal });
  if (!res.ok) return { ok: false, error: res.error || "preview failed" };
  const parsed = parseLastJsonLine(res.stdout, (obj) => obj && typeof obj.ok === "boolean");
  if (parsed) {
    return { ...parsed, name, path: remotePath };
  }
  return { ok: false, error: "failed to parse preview" };
}

export async function downloadRemoteFile(session, remotePath, signal) {
  if (!session || !remotePath) return { ok: false, error: "session and path required" };
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const name = path.basename(remotePath) || "download.bin";
  const safeName = sanitizeFilename(name, "download.bin");
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
  const res = await runRemotePythonSsh(session, py, { signal });
  if (!res.ok) return { ok: false, error: res.error || res.stderr || "copy to Drive failed" };
  return { ok: true, output: res.stdout };
}

export async function syncPushFolder({ session, localDir, remoteDir, signal }) {
  if (!session || !localDir) return { ok: false, error: "需要指定会话与本地目录" };
  const resolvedLocal = expandHomePath(localDir);
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
  const resolvedLocal = expandHomePath(localDir);
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

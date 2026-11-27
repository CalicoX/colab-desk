import fs from "node:fs";
import path from "node:path";
import { runAction } from "../run.mjs";
import { downloadRemoteFile, uploadRemoteFile } from "./files.mjs";
import { EXPORT_DIR, NOTEBOOK_DIR, sanitizeFilename } from "./shared.mjs";

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
  const safeSession = sanitizeFilename(sessionName || "colab-desk", "colab-desk");
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

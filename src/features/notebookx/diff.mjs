// Pure notebook diff helpers (no I/O, no dependencies).

const LCS_CELL_LIMIT = 4_000_000;

function splitLines(text) {
  const s = String(text ?? "");
  return s === "" ? [] : s.split("\n");
}

/** Line-based diff via LCS. Returns ops [{ type: "eq"|"add"|"del", text }]. */
export function diffSequences(a, b, eq = (x, y) => x === y) {
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) { endA -= 1; endB -= 1; }
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: "eq", text: a[i], ai: i, bi: i });
  const n = endA - start;
  const m = endB - start;
  if (n === 0) {
    for (let j = 0; j < m; j += 1) ops.push({ type: "add", text: b[start + j], bi: start + j });
  } else if (m === 0) {
    for (let i = 0; i < n; i += 1) ops.push({ type: "del", text: a[start + i], ai: start + i });
  } else if (n * m > LCS_CELL_LIMIT) {
    for (let i = 0; i < n; i += 1) ops.push({ type: "del", text: a[start + i], ai: start + i });
    for (let j = 0; j < m; j += 1) ops.push({ type: "add", text: b[start + j], bi: start + j });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] = eq(a[start + i], b[start + j])
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(a[start + i], b[start + j])) {
        ops.push({ type: "eq", text: a[start + i], ai: start + i, bi: start + j });
        i += 1; j += 1;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ type: "del", text: a[start + i], ai: start + i });
        i += 1;
      } else {
        ops.push({ type: "add", text: b[start + j], bi: start + j });
        j += 1;
      }
    }
    while (i < n) { ops.push({ type: "del", text: a[start + i], ai: start + i }); i += 1; }
    while (j < m) { ops.push({ type: "add", text: b[start + j], bi: start + j }); j += 1; }
  }
  for (let k = 0; k < a.length - endA; k += 1) {
    ops.push({ type: "eq", text: a[endA + k], ai: endA + k, bi: endB + k });
  }
  return ops;
}

export function diffLines(textA, textB) {
  return diffSequences(splitLines(textA), splitLines(textB));
}

export function joinSource(src) {
  if (typeof src === "string") return src;
  if (Array.isArray(src)) return src.map((s) => String(s ?? "")).join("");
  return "";
}

/** Textual rendering of a raw ipynb output list (images summarised, never inlined). */
export function outputsToText(outputs) {
  if (!Array.isArray(outputs)) return "";
  const parts = [];
  for (const out of outputs) {
    if (!out || typeof out !== "object") continue;
    if (out.output_type === "stream") {
      parts.push(`[${out.name || "stdout"}] ${joinSource(out.text)}`.replace(/\n$/, ""));
    } else if (out.output_type === "error") {
      parts.push(`[error] ${out.ename || "Error"}: ${out.evalue || ""}`);
    } else if (out.output_type === "display_data" || out.output_type === "execute_result") {
      const d = out.data || {};
      for (const mime of ["image/png", "image/jpeg"]) {
        if (d[mime]) parts.push(`[${mime} ${joinSource(d[mime]).replace(/\s+/g, "").length} b64 chars]`);
      }
      if (d["text/plain"]) parts.push(joinSource(d["text/plain"]).replace(/\n$/, ""));
    }
  }
  return parts.join("\n");
}

/** Normalise a raw notebook (object or JSON string) into comparable cells. */
export function normalizeNotebook(raw, opts = {}) {
  const nb = typeof raw === "string" ? JSON.parse(raw) : raw;
  const cells = Array.isArray(nb?.cells) ? nb.cells : [];
  return cells.map((c) => {
    const type = c?.cell_type === "markdown" ? "markdown" : c?.cell_type === "raw" ? "raw" : "code";
    const cell = {
      type,
      source: joinSource(c?.source).replace(/\s+$/, ""),
      outputs: type === "code" ? outputsToText(c?.outputs) : "",
    };
    if (opts.ignoreMetadata === false) {
      cell.meta = JSON.stringify({ execution_count: c?.execution_count ?? null, metadata: c?.metadata || {} }, null, 2);
    }
    return cell;
  });
}

const keyOf = (c) => `${c.type}\u0000${c.source}`;

/**
 * Cell-level diff of two notebooks.
 * opts: { includeOutputs=false, ignoreMetadata=true }
 * returns { summary, cells: [{ status, type, aIndex, bIndex, sourceDiff, outputsDiff?, metaDiff? }] }
 */
export function diffNotebooks(rawA, rawB, opts = {}) {
  const includeOutputs = !!opts.includeOutputs;
  const A = normalizeNotebook(rawA, opts);
  const B = normalizeNotebook(rawB, opts);
  const anchors = diffSequences(A.map(keyOf), B.map(keyOf));
  const result = [];
  let delBuf = [];
  let addBuf = [];
  const flush = () => {
    const pairs = Math.min(delBuf.length, addBuf.length);
    for (let k = 0; k < pairs; k += 1) {
      const ai = delBuf[k];
      const bi = addBuf[k];
      result.push({
        status: "changed",
        type: B[bi].type,
        aIndex: ai,
        bIndex: bi,
        typeChanged: A[ai].type !== B[bi].type,
        sourceDiff: diffLines(A[ai].source, B[bi].source),
        ...(includeOutputs ? { outputsDiff: diffLines(A[ai].outputs, B[bi].outputs) } : {}),
      });
    }
    for (let k = pairs; k < delBuf.length; k += 1) {
      const ai = delBuf[k];
      result.push({ status: "removed", type: A[ai].type, aIndex: ai, bIndex: null, sourceDiff: diffLines(A[ai].source, ""), ...(includeOutputs ? { outputsDiff: diffLines(A[ai].outputs, "") } : {}) });
    }
    for (let k = pairs; k < addBuf.length; k += 1) {
      const bi = addBuf[k];
      result.push({ status: "added", type: B[bi].type, aIndex: null, bIndex: bi, sourceDiff: diffLines("", B[bi].source), ...(includeOutputs ? { outputsDiff: diffLines("", B[bi].outputs) } : {}) });
    }
    delBuf = [];
    addBuf = [];
  };
  for (const op of anchors) {
    if (op.type === "del") delBuf.push(op.ai);
    else if (op.type === "add") addBuf.push(op.bi);
    else {
      flush();
      const a = A[op.ai];
      const b = B[op.bi];
      const outputsDiff = includeOutputs ? diffLines(a.outputs, b.outputs) : null;
      const outChanged = outputsDiff ? outputsDiff.some((o) => o.type !== "eq") : false;
      const metaChanged = opts.ignoreMetadata === false && a.meta !== b.meta;
      result.push({
        status: outChanged || metaChanged ? "changed" : "same",
        type: b.type,
        aIndex: op.ai,
        bIndex: op.bi,
        sourceDiff: diffLines(a.source, b.source),
        ...(outputsDiff ? { outputsDiff } : {}),
        ...(metaChanged ? { metaDiff: diffLines(a.meta, b.meta) } : {}),
      });
    }
  }
  flush();
  const summary = { added: 0, removed: 0, changed: 0, same: 0, cellsA: A.length, cellsB: B.length };
  for (const r of result) summary[r.status] += 1;
  summary.identical = summary.added + summary.removed + summary.changed === 0;
  return { summary, cells: result };
}

/** Unified-diff style text for a cell diff (used by the UI's unified mode / copy). */
export function unifiedText(sourceDiff) {
  return sourceDiff.map((o) => `${o.type === "add" ? "+" : o.type === "del" ? "-" : " "}${o.text}`).join("\n");
}

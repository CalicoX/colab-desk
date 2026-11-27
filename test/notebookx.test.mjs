import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  executionMetadata,
  readExecutionMetadata,
  parseIpynb,
  serializeIpynb,
} from "../src/cloud/notebook.mjs";
import {
  diffLines,
  diffNotebooks,
  outputsToText,
  unifiedText,
} from "../src/features/notebookx/diff.mjs";
import {
  resolveDir,
  resolveNotebookPath,
  runGit,
  gitStatus,
  gitShowFile,
  gitCommitNotebook,
} from "../src/features/notebookx/git.mjs";
import { handleNotebookxRoute } from "../src/features/notebookx/index.mjs";

function makeNb(cells) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: cells.map((c) => ({
      cell_type: c.type || "code",
      execution_count: c.execution_count ?? null,
      metadata: c.metadata || {},
      source: typeof c.source === "string" ? c.source.split("\n").map((l, i, a) => (i < a.length - 1 ? `${l}\n` : l)) : (c.source || []),
      ...(c.type === "markdown" ? {} : { outputs: c.outputs || [] }),
    })),
  };
}

test("executionMetadata & readExecutionMetadata round-trip through serializeIpynb/parseIpynb", () => {
  const startedAt = "2026-11-27T06:00:00.000Z";
  const meta = executionMetadata({ startedAt, durationMs: 2500 });
  assert.equal(meta.execution["iopub.execute_input"], "2026-11-27T06:00:00.000Z");
  assert.equal(meta.execution["shell.execute_reply"], "2026-11-27T06:00:02.500Z");
  assert.equal(meta.execution["iopub.status.idle"], "2026-11-27T06:00:02.500Z");

  const parsedTiming = readExecutionMetadata(meta);
  assert.equal(parsedTiming.startedAt, startedAt);
  assert.equal(parsedTiming.durationMs, 2500);

  const raw = serializeIpynb([
    { type: "code", source: "print(1)", executionCount: 3, stdout: "1\n", stderr: "", images: [], startedAt, durationMs: 1250 },
    { type: "markdown", source: "# Hi" },
  ]);
  const nb = parseIpynb(raw);
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[0].executionCount, 3);
  assert.equal(nb.cells[0].startedAt, startedAt);
  assert.equal(nb.cells[0].durationMs, 1250);
  assert.equal(nb.cells[1].startedAt, null);
  assert.equal(nb.cells[1].durationMs, null);
});

test("diffLines LCS produces minimal add/del/eq ops and unifiedText", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nx\nc\nd\ne");
  assert.deepEqual(
    ops.map((o) => [o.type, o.text]),
    [
      ["eq", "a"],
      ["del", "b"],
      ["add", "x"],
      ["eq", "c"],
      ["eq", "d"],
      ["add", "e"],
    ],
  );
  assert.equal(unifiedText(ops), " a\n-b\n+x\n c\n d\n+e");
});

test("diffNotebooks detects added, removed, changed, same cells and ignores metadata noise by default", () => {
  const nbA = makeNb([
    { type: "markdown", source: "# Title" },
    { type: "code", source: "x = 1\nprint(x)", execution_count: 1, metadata: { execution: { "iopub.execute_input": "2026-01-01T00:00:00Z" } }, outputs: [{ output_type: "stream", name: "stdout", text: ["1\n"] }] },
    { type: "code", source: "old_fn()" },
  ]);
  const nbB = makeNb([
    { type: "markdown", source: "# Title" },
    { type: "code", source: "x = 1\nprint(x)", execution_count: 9, metadata: { execution: { "iopub.execute_input": "2026-02-01T00:00:00Z" } }, outputs: [{ output_type: "stream", name: "stdout", text: ["2\n"] }] },
    { type: "code", source: "new_fn()\nreturn 42" },
    { type: "code", source: "extra = True" },
  ]);

  // Default: ignoreMetadata=true, includeOutputs=false -> cell 1 is 'same' despite exec_count & output diff
  const d1 = diffNotebooks(nbA, nbB);
  assert.equal(d1.summary.same, 2);
  assert.equal(d1.summary.changed, 1);
  assert.equal(d1.summary.added, 1);
  assert.equal(d1.summary.removed, 0);
  assert.equal(d1.summary.identical, false);

  // With includeOutputs=true -> cell 1 becomes 'changed' with outputsDiff
  const d2 = diffNotebooks(nbA, nbB, { includeOutputs: true });
  assert.equal(d2.summary.same, 1);
  assert.equal(d2.summary.changed, 2);
  assert.ok(d2.cells[1].outputsDiff.some((o) => o.type === "add" && o.text.includes("2")));

  // With ignoreMetadata=false -> execution_count difference marks cell changed with metaDiff
  const d3 = diffNotebooks(
    makeNb([{ type: "code", source: "a = 1", execution_count: 1 }]),
    makeNb([{ type: "code", source: "a = 1", execution_count: 2 }]),
    { ignoreMetadata: false },
  );
  assert.equal(d3.summary.changed, 1);
  assert.ok(Array.isArray(d3.cells[0].metaDiff));

  // outputsToText summarizes images cleanly
  const imgTxt = outputsToText([{ output_type: "display_data", data: { "image/png": "AAAA" } }]);
  assert.match(imgTxt, /image\/png 4 b64 chars/);
});

test("git helper validates paths, blocks disallowed subcommands, and commits/diffs in a temp repo", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colab-nbx-git-"));
  try {
    const dir = resolveDir(tmp);

    // Path validation security checks
    assert.throws(() => resolveNotebookPath(dir, "../escape.ipynb"), /Invalid/);
    assert.throws(() => resolveNotebookPath(dir, "/etc/passwd.ipynb"), /Invalid/);
    assert.throws(() => resolveNotebookPath(dir, ".git/config.ipynb"), /Invalid/);
    assert.throws(() => resolveNotebookPath(dir, "-flag.ipynb"), /Invalid/);
    assert.throws(() => resolveNotebookPath(dir, "script.py"), /Only \.ipynb/);
    assert.equal(resolveNotebookPath(dir, "sub/demo.ipynb").rel, "sub/demo.ipynb");

    // Allowlist blocks dangerous commands (no push/force/etc.)
    const blocked = await runGit(dir, ["push", "--force"]);
    assert.equal(blocked.ok, false);
    assert.match(blocked.stderr, /not allowed/);

    // Not a repo yet
    const st0 = await gitStatus(dir);
    assert.equal(st0.ok, true);
    assert.equal(st0.isRepo, false);

    // Initialize temp git repo
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });

    // Commit notebook v1
    const nbV1 = serializeIpynb([{ type: "code", source: "a = 1" }]);
    const c1 = await gitCommitNotebook(dir, "notebooks/demo.ipynb", nbV1, "Add demo notebook");
    assert.equal(c1.ok, true);
    assert.equal(c1.committed, true);
    assert.match(c1.commit, /Add demo notebook/);

    // Status should be clean on branch main
    const st1 = await gitStatus(dir);
    assert.equal(st1.ok, true);
    assert.equal(st1.isRepo, true);
    assert.equal(st1.branch, "main");
    assert.equal(st1.clean, true);

    // Repeating identical commit reports no changes
    const cSame = await gitCommitNotebook(dir, "notebooks/demo.ipynb", nbV1, "No-op");
    assert.equal(cSame.ok, true);
    assert.equal(cSame.committed, false);

    // gitShowFile reads HEAD content
    const shown = await gitShowFile(dir, "notebooks/demo.ipynb", "HEAD");
    assert.equal(shown.ok, true);
    assert.equal(JSON.parse(shown.content).cells[0].source.join(""), "a = 1");

    // Route handler end-to-end: /api/notebookx/git/diff-head and /api/notebookx/diff
    const callRoute = async (pathname, body) => {
      let status = 0;
      let payload = null;
      const handled = await handleNotebookxRoute(
        { method: "POST" },
        {},
        new URL(`http://localhost${pathname}`),
        {
          sendJson: (_res, code, data) => { status = code; payload = data; },
          readJsonBodySafe: async () => body,
        },
        null,
      );
      return { handled, status, payload };
    };

    const diffHead = await callRoute("/api/notebookx/git/diff-head", {
      dir,
      file: "notebooks/demo.ipynb",
      cells: [{ type: "code", source: "a = 2" }],
    });
    assert.equal(diffHead.handled, true);
    assert.equal(diffHead.status, 200);
    assert.equal(diffHead.payload.ok, true);
    assert.equal(diffHead.payload.summary.changed, 1);

    const diffApi = await callRoute("/api/notebookx/diff", {
      a: { cells: [{ type: "code", source: "x = 1" }] },
      b: { cells: [{ type: "code", source: "x = 1" }, { type: "markdown", source: "hi" }] },
    });
    assert.equal(diffApi.handled, true);
    assert.equal(diffApi.payload.ok, true);
    assert.equal(diffApi.payload.summary.added, 1);
    assert.equal(diffApi.payload.summary.same, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-agentx-test-"));
process.env.COLAB_DESK_STATE_DIR = tmpDir;

const fixtureServerPath = path.resolve(process.cwd(), "test/fixtures/fake-mcp-server.mjs");

const { McpStdioClient, McpManager, formatMcpResult, loadAgentx, mcpManager, saveAgentx, validateServer } =
  await import("../src/agent/mcp.mjs");
const {
  BUILTIN_TEMPLATES,
  createTemplate,
  deleteTemplate,
  listTemplates,
  setAssignedTemplate,
  updateTemplate,
} = await import("../src/agent/templates.mjs");
const { buildColabSystemRules } = await import("../src/agent/prompts.mjs");
const { executeColabTool } = await import("../src/agent/tools.mjs");
const { runOpenAiCompatTurn } = await import("../src/agent/openai-compat.mjs");
const { feature, maskSecretMap, mergeSecretMap } = await import("../src/features/agentx/index.mjs");
const { buildThreadIndex, rankThreadSearch, searchWithinEntries } =
  await import("../public/js/features/agentx/search-index.js");
const { AGENTX_STRINGS } = await import("../public/js/features/agentx/strings.js");

after(() => {
  mcpManager.shutdown();
  feature.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentx MCP stdio client", () => {
  it("initializes, lists tools, calls echo, handles timeouts, and shuts down", async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [fixtureServerPath],
      timeoutMs: 3000,
    });
    try {
      await client.start();
      const tools = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "echo");

      const res = await client.callTool("echo", { text: "hello-mcp" });
      assert.deepEqual(formatMcpResult(res), { ok: true, output: "echo:hello-mcp" });

      await assert.rejects(() => client.callTool("hang", {}, 120), /timed out/i);
    } finally {
      client.stop();
    }
  });

  it("truncates oversized MCP tool outputs safely", () => {
    const big = "x".repeat(20_000);
    const out = formatMcpResult({ content: [{ type: "text", text: big }] });
    assert.equal(out.ok, true);
    assert.ok(out.output.length < 16_050);
    assert.ok(out.output.endsWith("…[truncated]"));
  });

  it("defaults enabled to false and only exposes enabled servers to OpenAI tools", async () => {
    const srv = validateServer({
      id: "fake1",
      name: "Fake Stdio",
      type: "stdio",
      command: process.execPath,
      args: [fixtureServerPath],
    });
    assert.equal(srv.enabled, false);

    saveAgentx({ mcpServers: [srv], templates: [], assignments: {} });
    const mgr = new McpManager();
    try {
      assert.equal((await mgr.getOpenAiTools()).length, 0);

      srv.enabled = true;
      saveAgentx({ mcpServers: [srv], templates: [], assignments: {} });
      const tools = await mgr.getOpenAiTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].function.name, "mcp__fake1__echo");

      const callRes = await mgr.callByName("mcp__fake1__echo", { text: "via-manager" });
      assert.deepEqual(callRes, { ok: true, output: "echo:via-manager" });
    } finally {
      mgr.shutdown();
      saveAgentx({ mcpServers: [], templates: [], assignments: {} });
    }
  });

  it("merges MCP tools into OpenAI-compat turns and enforces ask approval mode", async () => {
    const srv = validateServer({
      id: "fake2",
      name: "Fake Turn",
      type: "stdio",
      command: process.execPath,
      args: [fixtureServerPath],
      enabled: true,
    });
    saveAgentx({ mcpServers: [srv], templates: [], assignments: {} });

    let round = 0;
    let seenToolNames = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (round === 0) {
        seenToolNames = (body.tools || []).map((t) => t.function?.name);
        round += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "tc_1",
                type: "function",
                function: { name: "mcp__fake2__echo", arguments: JSON.stringify({ text: "approved!" }) },
              }],
            },
          }],
        }));
        return;
      }
      const toolMsg = body.messages.find((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: `Final: ${toolMsg?.content || ""}` } }],
      }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
      const events = [];
      const pendingPermissions = new Map();
      const threads = new Map();

      await runOpenAiCompatTurn({
        api: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        threads,
        pendingPermissions,
        executeTool: executeColabTool,
        provider: { id: "api", name: "API", label: "API" },
        providerId: "api",
        threadKey: "t1:api",
        promptText: "call echo",
        model: "test-model",
        approvalMode: "ask",
        context: { colabSession: null },
        emit: (ev) => {
          events.push(ev);
          if (ev.type === "permission_request") {
            const resolve = pendingPermissions.get(ev.requestId);
            pendingPermissions.delete(ev.requestId);
            resolve(true);
          }
        },
      });

      assert.ok(seenToolNames.includes("colab_exec"), "built-in colab tools kept");
      assert.ok(seenToolNames.includes("mcp__fake2__echo"), "MCP tool merged into payload.tools");
      assert.ok(events.some((e) => e.type === "permission_request" && e.title === "mcp__fake2__echo"));
      const finalText = events.filter((e) => e.type === "text").map((e) => e.text).join("");
      assert.ok(finalText.includes("echo:approved!"));
    } finally {
      server.close();
      mcpManager.shutdown();
      saveAgentx({ mcpServers: [], templates: [], assignments: {} });
    }
  });
});

describe("agentx prompt templates & injection", () => {
  it("ships 4 bilingual built-in templates and supports CRUD + per-thread injection", () => {
    assert.equal(BUILTIN_TEMPLATES.length, 4);
    for (const tpl of BUILTIN_TEMPLATES) {
      assert.ok(tpl.name && tpl.nameEn && tpl.content && tpl.contentEn);
    }

    const created = createTemplate({
      name: "My Custom Role",
      description: "Test desc",
      content: "Always reply with BENCHMARK_OK.",
    });
    assert.ok(listTemplates().some((t) => t.id === created.id));

    const updated = updateTemplate(created.id, { content: "Always reply with UPDATED_OK." });
    assert.equal(updated.content, "Always reply with UPDATED_OK.");

    assert.throws(() => updateTemplate("builtin:gpu-training", { name: "x" }));
    assert.throws(() => deleteTemplate("builtin:gpu-training"));

    setAssignedTemplate("thread-42", created.id);
    const rules = buildColabSystemRules({ threadId: "thread-42", lang: "zh-CN" });
    assert.ok(rules.includes("UPDATED_OK"));
    assert.ok(rules.includes("My Custom Role"));

    const enBuiltinRules = buildColabSystemRules({ templateId: "builtin:concise-reviewer", lang: "en" });
    assert.ok(enBuiltinRules.includes("senior code reviewer"));

    deleteTemplate(created.id);
    assert.ok(!listTemplates().some((t) => t.id === created.id));
    const afterDelete = buildColabSystemRules({ threadId: "thread-42" });
    assert.ok(!afterDelete.includes("UPDATED_OK"));
  });
});

describe("agentx conversation search & ranking", () => {
  const now = Date.now();
  const threads = [
    { id: "t-title", title: "PyTorch OOM troubleshooting", sessionName: "gpu-a100", lastProvider: "agy", updatedAt: now - 3600_000, pinned: false },
    { id: "t-body", title: "Random session", sessionName: "cpu-1", lastProvider: "grok", updatedAt: now - 1000, pinned: false },
    { id: "t-old", title: "PyTorch old experiment", sessionName: "", lastProvider: "api:mygw", updatedAt: now - 40 * 86_400_000, pinned: false },
  ];
  const bySession = {
    "t-title": [{ kind: "agent", label: "Help with CUDA memory", text: "Reduce batch size" }],
    "t-body": [
      { kind: "agent", label: "First message", text: "Nothing here" },
      { kind: "agent", label: "PyTorch OOM happened", text: "Try gradient checkpointing" },
    ],
    "t-old": [{ kind: "agent", label: "Run PyTorch", text: "Done" }],
  };

  it("ranks title matches above body-only matches and filters by provider & date", () => {
    const index = buildThreadIndex(threads, bySession);
    const res = rankThreadSearch(index, "PyTorch OOM");
    assert.equal(res.total, 2);
    assert.equal(res.items[0].threadId, "t-title");
    assert.equal(res.items[1].threadId, "t-body");
    assert.equal(res.items[1].matches[0].entryIndex, 1);

    const apiOnly = rankThreadSearch(index, "PyTorch", { provider: "api" });
    assert.equal(apiOnly.total, 1);
    assert.equal(apiOnly.items[0].threadId, "t-old");

    const recentOnly = rankThreadSearch(index, "PyTorch", { sinceMs: now - 7 * 86_400_000 });
    assert.equal(recentOnly.total, 2);
    assert.ok(!recentOnly.items.some((x) => x.threadId === "t-old"));

    const paged = rankThreadSearch(index, "PyTorch", { limit: 1, offset: 1 });
    assert.equal(paged.total, 3);
    assert.equal(paged.items.length, 1);
  });

  it("finds matches within a single thread", () => {
    const hits = searchWithinEntries(bySession["t-body"], "checkpointing");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].entryIndex, 1);
    assert.ok(hits[0].snippet.includes("checkpointing"));
  });
});

describe("agentx routes, secret masking & i18n parity", () => {
  it("masks secrets in env/headers and preserves them on update", () => {
    const masked = maskSecretMap({ API_KEY: "super-secret", PUBLIC_VAR: "hello" });
    assert.equal(masked.API_KEY, "••••••••");
    assert.equal(masked.PUBLIC_VAR, "hello");

    const merged = mergeSecretMap({ API_KEY: "super-secret" }, { API_KEY: "••••••••", NEW_VAR: "1" });
    assert.equal(merged.API_KEY, "super-secret");
    assert.equal(merged.NEW_VAR, "1");
  });

  it("handles /api/agentx/mcp/servers and /api/agentx/templates routes", async () => {
    const callRoute = async (method, pathname, body = null) => {
      const req = {
        method,
        async *[Symbol.asyncIterator]() {
          if (body != null) yield Buffer.from(JSON.stringify(body));
        },
      };
      let statusCode = 0;
      let raw = "";
      const res = {
        writeHead(code) { statusCode = code; },
        end(chunk) { raw += chunk || ""; },
      };
      const handled = await feature.handleRoutes(req, res, new URL(`http://127.0.0.1${pathname}`), {});
      assert.equal(handled, true);
      return { statusCode, data: JSON.parse(raw) };
    };

    const created = await callRoute("POST", "/api/agentx/mcp/servers", {
      name: "Route Test",
      type: "stdio",
      command: process.execPath,
      args: [fixtureServerPath],
      env: { SECRET_TOKEN: "top-secret" },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.data.server.enabled, false);
    assert.equal(created.data.server.env.SECRET_TOKEN, "••••••••");

    const id = created.data.server.id;
    const tested = await callRoute("POST", `/api/agentx/mcp/servers/${id}/test`);
    assert.equal(tested.data.ok, true);
    assert.equal(tested.data.tools[0].name, "echo");

    const toggled = await callRoute("POST", `/api/agentx/mcp/servers/${id}/toggle`, { enabled: true });
    assert.equal(toggled.data.server.enabled, true);

    const deleted = await callRoute("DELETE", `/api/agentx/mcp/servers/${id}`);
    assert.equal(deleted.data.ok, true);

    const tpls = await callRoute("GET", "/api/agentx/templates");
    assert.equal(tpls.data.ok, true);
    assert.ok(tpls.data.templates.length >= 4);
  });

  it("has complete zh-CN and en i18n key parity under agentx.* namespace", () => {
    const zhKeys = Object.keys(AGENTX_STRINGS["zh-CN"]).sort();
    const enKeys = Object.keys(AGENTX_STRINGS.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    for (const k of zhKeys) {
      assert.ok(k.startsWith("agentx."), `key must be namespaced: ${k}`);
      assert.ok(AGENTX_STRINGS["zh-CN"][k].trim().length > 0);
      assert.ok(AGENTX_STRINGS.en[k].trim().length > 0);
    }
  });
});

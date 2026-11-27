import { loadStore } from "../../store.mjs";
import { sendJson as defaultSendJson, readJsonBodySafe as defaultReadBody } from "../../routes/http.mjs";
import { SearchIndex } from "./indexer.mjs";

let index = null;
let busUnsub = [];

function extractEntryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  for (const field of ["prompt", "text", "reply", "command", "stdout", "stderr", "output", "summary", "error"]) {
    if (typeof entry[field] === "string" && entry[field].trim()) parts.push(entry[field]);
  }
  if (Array.isArray(entry.toolCalls)) {
    for (const tc of entry.toolCalls) {
      if (tc?.name) parts.push(String(tc.name));
      if (typeof tc?.output === "string") parts.push(tc.output);
      if (typeof tc?.result === "string") parts.push(tc.result);
    }
  }
  return parts.join("\n");
}

function classifyScope(key, entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind.includes("notebook") || kind === "cell") return "notebook";
  if (kind === "runner" || kind === "exec" || kind === "cli" || kind === "direct") return "notebook";
  return "chat";
}

export function ingestStoreHistory(idx, storeData) {
  const data = storeData || loadStore();
  const history = data?.history || {};
  const threads = Array.isArray(data?.settings?.chatThreads) ? data.settings.chatThreads : [];
  const threadMeta = new Map(threads.map((t) => [t.id, t]));

  // Refresh store-derived chat/notebook docs
  for (const [key, list] of Object.entries(history)) {
    if (!Array.isArray(list)) continue;
    const isThread = key.startsWith("thread:");
    const threadId = isThread ? key.slice("thread:".length) : null;
    const meta = threadId ? threadMeta.get(threadId) : null;
    const session = meta?.session || (!isThread && key !== "__global__" ? key : null);

    list.forEach((entry, i) => {
      const text = extractEntryText(entry);
      if (!text.trim()) return;
      const scope = classifyScope(key, entry);
      const entryId = entry.id || `${i}`;
      const title = meta?.title
        || entry.title
        || (typeof entry.prompt === "string" && entry.prompt.trim().slice(0, 80))
        || (session ? `${session}` : key);
      const ts = Number(entry.timestamp || entry.createdAt || meta?.updatedAt) || Date.now();
      idx.upsert({
        id: `store:${key}:${entryId}`,
        scope,
        session,
        title,
        text,
        timestamp: ts,
        ephemeral: true,
        target: isThread
          ? { type: "thread", threadId, session, entryIndex: i }
          : { type: scope === "notebook" ? "notebook" : "session", session: session || key, entryIndex: i },
      });
    });
  }

  // Also index saved directScripts metadata if present
  const scripts = Array.isArray(data?.settings?.directScripts) ? data.settings.directScripts : [];
  for (const sc of scripts) {
    if (!sc?.id && !sc?.name) continue;
    const text = [sc.name, sc.code, sc.lastOutput].filter(Boolean).join("\n");
    if (!text.trim()) continue;
    idx.upsert({
      id: `runner:${sc.id || sc.name}`,
      scope: "notebook",
      session: sc.session || null,
      title: sc.name || "Direct Runner",
      text,
      timestamp: Number(sc.updatedAt) || Date.now(),
      ephemeral: true,
      target: { type: "runner", scriptId: sc.id || sc.name, session: sc.session || null },
    });
  }
}

export function ingestTerminals(idx, terminals) {
  if (!terminals || !(terminals.sessions instanceof Map)) return;
  idx.clearScope("terminal", { onlyEphemeral: true });
  for (const [termId, rec] of terminals.sessions.entries()) {
    if (!rec || !Array.isArray(rec.scrollback) || rec.scrollback.length === 0) continue;
    let raw = "";
    try {
      raw = Buffer.concat(rec.scrollback).toString("utf8");
    } catch {
      continue;
    }
    if (!raw.trim()) continue;
    idx.upsert({
      id: `term:${termId}`,
      scope: "terminal",
      session: rec.session || null,
      title: rec.title || `Terminal (${rec.session || termId})`,
      text: raw,
      timestamp: Number(rec.createdAt) || Date.now(),
      ephemeral: true,
      target: { type: "terminal", terminalId: termId, session: rec.session || null },
    });
  }
}

function attachBusListeners(idx, bus) {
  if (!bus || typeof bus.on !== "function") return;
  const onJobLog = (ev) => {
    if (!ev) return;
    const jobId = String(ev.jobId || ev.id || "job");
    const text = String(ev.text ?? ev.line ?? ev.chunk ?? ev.output ?? "");
    if (!text.trim()) return;
    idx.append(`job:${jobId}`, text, {
      scope: "jobs",
      session: ev.session || null,
      title: ev.name || ev.title || `Job ${jobId}`,
      timestamp: Number(ev.timestamp) || Date.now(),
      ephemeral: false,
      target: { type: "job", jobId, session: ev.session || null },
    }, { persist: true });
  };

  const onNotebookOutput = (ev) => {
    if (!ev) return;
    const cellId = String(ev.cellId || ev.cellIndex || Date.now());
    const text = String(ev.text ?? ev.output ?? ev.stdout ?? "");
    if (!text.trim()) return;
    idx.upsert({
      id: `nb:${ev.session || "local"}:${ev.path || "notebook"}:${cellId}`,
      scope: "notebook",
      session: ev.session || null,
      title: ev.title || ev.path || "Notebook Cell",
      text,
      timestamp: Number(ev.timestamp) || Date.now(),
      ephemeral: false,
      target: { type: "notebook", session: ev.session || null, path: ev.path || null, cellIndex: ev.cellIndex ?? null },
    }, { persist: true });
  };

  const onAgentIndex = (ev) => {
    if (!ev || !ev.id) return;
    idx.upsert({
      id: `agentx:${ev.id}`,
      scope: "chat",
      session: ev.session || null,
      title: ev.title || "Chat",
      text: String(ev.text || ""),
      timestamp: Number(ev.timestamp) || Date.now(),
      ephemeral: false,
      target: { type: "thread", threadId: ev.threadId || null, session: ev.session || null },
    }, { persist: true });
  };

  bus.on("jobs:log", onJobLog);
  bus.on("notebook:output", onNotebookOutput);
  bus.on("notebookx:output", onNotebookOutput);
  bus.on("runner:output", onNotebookOutput);
  bus.on("agentx:index", onAgentIndex);

  busUnsub.push(
    () => bus.off?.("jobs:log", onJobLog),
    () => bus.off?.("notebook:output", onNotebookOutput),
    () => bus.off?.("notebookx:output", onNotebookOutput),
    () => bus.off?.("runner:output", onNotebookOutput),
    () => bus.off?.("agentx:index", onAgentIndex),
  );
}

export function createSearchEngine(ctx = {}) {
  const storage = typeof ctx.storage === "function" ? ctx.storage("search") : null;
  const idx = new SearchIndex({ storage });
  idx.loadPersisted();
  attachBusListeners(idx, ctx.bus);
  return idx;
}

export const feature = {
  id: "search",
  init(ctx) {
    this.shutdown();
    index = createSearchEngine(ctx);
  },
  async handleRoutes(req, res, url, ctx) {
    const p = url.pathname;
    if (p !== "/api/search" && !p.startsWith("/api/search/")) return false;
    const sendJson = ctx.http?.sendJson || defaultSendJson;
    const readBody = ctx.http?.readJsonBodySafe || defaultReadBody;
    if (!index) this.init(ctx);

    if (req.method === "GET" && p === "/api/search") {
      // Refresh dynamic sources (store history + live terminal scrollback) lazily on query
      ingestStoreHistory(index, ctx.storeData);
      ingestTerminals(index, ctx.terminals);
      const result = index.search({
        q: url.searchParams.get("q") || "",
        scope: url.searchParams.get("scope") || "all",
        session: url.searchParams.get("session") || "",
        limit: url.searchParams.get("limit") || 30,
      });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (req.method === "GET" && p === "/api/search/stats") {
      ingestStoreHistory(index, ctx.storeData);
      ingestTerminals(index, ctx.terminals);
      sendJson(res, 200, { ok: true, ...index.stats() });
      return true;
    }

    if (req.method === "POST" && p === "/api/search/reindex") {
      ingestStoreHistory(index, ctx.storeData);
      ingestTerminals(index, ctx.terminals);
      index.persistNow();
      sendJson(res, 200, { ok: true, ...index.stats() });
      return true;
    }

    if (req.method === "POST" && p === "/api/search/ingest") {
      const body = await readBody(req);
      const items = Array.isArray(body.docs) ? body.docs : (body.id ? [body] : []);
      let added = 0;
      for (const item of items) {
        if (index.upsert(item, { persist: !item.ephemeral })) added++;
      }
      sendJson(res, 200, { ok: true, added, ...index.stats() });
      return true;
    }

    return false;
  },
  shutdown() {
    for (const fn of busUnsub) {
      try { fn(); } catch {}
    }
    busUnsub = [];
    index?.persistNow();
    index = null;
  },
};

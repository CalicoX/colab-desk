// Pure, zero-dependency conversation index & full-text search engine.
// Shared by the chat sidebar, in-thread search (⌘F), and @multi's global search.

export function normalizeQuery(q) {
  return String(q || "").trim().toLowerCase();
}

export function tokenizeQuery(q) {
  const norm = normalizeQuery(q);
  if (!norm) return [];
  return Array.from(new Set(norm.split(/\s+/).filter(Boolean))).slice(0, 8);
}

/**
 * Build a flat, serializable thread index from state.chatThreads + desk.bySession.
 */
export function buildThreadIndex(chatThreads = [], bySession = {}) {
  const out = [];
  for (const t of chatThreads) {
    if (!t || !t.id) continue;
    const entries = Array.isArray(bySession[t.id]) ? bySession[t.id] : [];
    const messages = [];
    const providers = new Set();
    if (t.lastProvider) providers.add(t.lastProvider);
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (!e) continue;
      if (e.provider) providers.add(e.provider);
      const parts = [];
      if (e.label) parts.push(String(e.label));
      if (e.text) parts.push(String(e.text));
      if (e.error) parts.push(String(e.error));
      const combined = parts.join("\n").trim();
      messages.push({
        index: i,
        role: e.kind === "agent" ? "agent" : "cli",
        label: String(e.label || ""),
        text: combined,
        provider: e.provider || t.lastProvider || "",
        timestamp: Number(e.timestamp || t.updatedAt || t.createdAt || 0),
      });
    }
    out.push({
      id: t.id,
      title: String(t.title || ""),
      sessionName: String(t.sessionName || ""),
      provider: t.lastProvider || Array.from(providers)[0] || "",
      providers: Array.from(providers),
      pinned: Boolean(t.pinned),
      createdAt: Number(t.createdAt || 0),
      updatedAt: Number(t.updatedAt || t.createdAt || 0),
      messageCount: entries.length,
      messages,
    });
  }
  return out;
}

export function extractSnippet(text, queryOrTokens, radius = 48) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { snippet: "", matchStart: -1, matchEnd: -1 };
  const lower = raw.toLowerCase();
  const tokens = Array.isArray(queryOrTokens) ? queryOrTokens : tokenizeQuery(queryOrTokens);
  let bestPos = -1;
  let bestLen = 0;
  for (const tok of tokens) {
    const pos = lower.indexOf(tok);
    if (pos >= 0 && (bestPos < 0 || pos < bestPos)) {
      bestPos = pos;
      bestLen = tok.length;
    }
  }
  if (bestPos < 0) {
    const cut = raw.slice(0, radius * 2);
    return { snippet: cut.length < raw.length ? `${cut}…` : cut, matchStart: -1, matchEnd: -1 };
  }
  const start = Math.max(0, bestPos - radius);
  const end = Math.min(raw.length, bestPos + bestLen + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < raw.length ? "…" : "";
  const snippet = `${prefix}${raw.slice(start, end)}${suffix}`;
  const matchStart = prefix.length + (bestPos - start);
  return { snippet, matchStart, matchEnd: matchStart + bestLen };
}

/**
 * Full-text search and ranking across indexed threads.
 * Supports provider filter, date filter (sinceMs), and incremental pagination (offset, limit).
 */
export function rankThreadSearch(index = [], query = "", opts = {}) {
  const tokens = tokenizeQuery(query);
  const providerFilter = String(opts.provider || "").trim().toLowerCase();
  const sinceMs = Number(opts.sinceMs || 0);
  const limit = Math.max(1, Math.min(200, Number(opts.limit || 40)));
  const offset = Math.max(0, Number(opts.offset || 0));
  const now = Date.now();

  const scored = [];
  for (const thread of index) {
    if (providerFilter) {
      const pList = Array.isArray(thread.providers) ? thread.providers : [thread.provider];
      const hasProvider = pList.some((p) => {
        const lp = String(p || "").toLowerCase();
        return lp === providerFilter || (providerFilter === "api" && lp.startsWith("api"));
      });
      if (!hasProvider) continue;
    }
    if (sinceMs > 0 && (thread.updatedAt || 0) < sinceMs) continue;

    if (tokens.length === 0) {
      scored.push({
        threadId: thread.id,
        title: thread.title,
        sessionName: thread.sessionName,
        provider: thread.provider,
        pinned: thread.pinned,
        updatedAt: thread.updatedAt,
        messageCount: thread.messageCount,
        score: (thread.pinned ? 1000 : 0) + (thread.updatedAt ? thread.updatedAt / 1e12 : 0),
        titleMatch: false,
        matches: [],
      });
      continue;
    }

    const titleLower = thread.title.toLowerCase();
    const sessionLower = thread.sessionName.toLowerCase();
    let score = 0;
    let matchedTokens = new Set();
    let titleMatch = false;

    const fullQuery = tokens.join(" ");
    if (titleLower.includes(fullQuery)) {
      score += 120;
      titleMatch = true;
    }
    for (const tok of tokens) {
      if (titleLower.includes(tok)) {
        score += 45;
        matchedTokens.add(tok);
        titleMatch = true;
      }
      if (sessionLower.includes(tok)) {
        score += 20;
        matchedTokens.add(tok);
      }
    }

    const matches = [];
    for (const msg of thread.messages || []) {
      const textLower = msg.text.toLowerCase();
      let msgScore = 0;
      for (const tok of tokens) {
        if (textLower.includes(tok)) {
          msgScore += 18;
          matchedTokens.add(tok);
        }
      }
      if (msgScore > 0) {
        if (textLower.includes(fullQuery)) msgScore += 25;
        score += msgScore;
        if (matches.length < 4) {
          const snip = extractSnippet(msg.text, tokens);
          matches.push({
            entryIndex: msg.index,
            role: msg.role,
            ...snip,
          });
        }
      }
    }

    // Require all query tokens to match somewhere in the thread
    if (matchedTokens.size < tokens.length) continue;

    // Mild recency boost (up to +10 for threads updated within the last 7 days)
    const ageDays = Math.max(0, (now - (thread.updatedAt || 0)) / 86_400_000);
    score += Math.max(0, 10 - ageDays);
    if (thread.pinned) score += 5;

    scored.push({
      threadId: thread.id,
      title: thread.title,
      sessionName: thread.sessionName,
      provider: thread.provider,
      pinned: thread.pinned,
      updatedAt: thread.updatedAt,
      messageCount: thread.messageCount,
      score,
      titleMatch,
      matches,
    });
  }

  scored.sort((a, b) => {
    if (tokens.length === 0) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }
    if (b.score !== a.score) return b.score - a.score;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  return {
    total: scored.length,
    offset,
    limit,
    items: scored.slice(offset, offset + limit),
  };
}

/**
 * Lightweight search within a single thread's entries (⌘F-like).
 */
export function searchWithinEntries(entries = [], query = "") {
  const norm = normalizeQuery(query);
  if (!norm) return [];
  const hits = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) continue;
    const text = [e.label, e.text, e.error].filter(Boolean).join("\n");
    const lower = text.toLowerCase();
    let from = 0;
    let count = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(norm, from);
      if (idx < 0) break;
      count += 1;
      from = idx + norm.length;
    }
    if (count > 0) {
      const snip = extractSnippet(text, [norm], 36);
      hits.push({ entryIndex: i, count, ...snip });
    }
  }
  return hits;
}

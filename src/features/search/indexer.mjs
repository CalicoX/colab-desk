import { sanitizeText } from "./redact.mjs";

const MAX_DOC_TEXT = 16_000;
const MAX_DOCS = 800;
const MAX_PERSIST_BYTES = 512_000;
const SNIPPET_LEN = 180;

export function tokenize(text) {
  const lower = String(text || "").toLowerCase();
  const matches = lower.match(/[a-z0-9_./:-]{2,}|[\u4e00-\u9fff]/g);
  return matches ? Array.from(new Set(matches)) : [];
}

function buildSnippet(text, queryLower, terms) {
  const lower = text.toLowerCase();
  let matchIdx = lower.indexOf(queryLower);
  let matchLen = queryLower.length;
  if (matchIdx === -1) {
    for (const t of terms) {
      const idx = lower.indexOf(t);
      if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
        matchIdx = idx;
        matchLen = t.length;
      }
    }
  }
  if (matchIdx === -1) matchIdx = 0;

  const half = Math.floor((SNIPPET_LEN - matchLen) / 2);
  let start = Math.max(0, matchIdx - half);
  let end = Math.min(text.length, start + SNIPPET_LEN);
  if (end - start < SNIPPET_LEN && start > 0) {
    start = Math.max(0, end - SNIPPET_LEN);
  }

  let slice = text.slice(start, end).replace(/\s+/g, " ");
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = prefix + slice + suffix;

  // Compute non-overlapping highlight spans on the normalized snippet.
  const snipLower = snippet.toLowerCase();
  const needles = queryLower.length >= 2 ? [queryLower, ...terms] : terms;
  const spans = [];
  for (const needle of needles) {
    if (!needle) continue;
    let pos = 0;
    while (pos < snipLower.length) {
      const idx = snipLower.indexOf(needle, pos);
      if (idx === -1) break;
      spans.push([idx, idx + needle.length]);
      pos = idx + needle.length;
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const highlights = [];
  for (const [s, e] of spans) {
    const prev = highlights[highlights.length - 1];
    if (prev && s <= prev.end) {
      prev.end = Math.max(prev.end, e);
    } else {
      highlights.push({ start: s, end: e });
    }
  }
  return { snippet, highlights };
}

export class SearchIndex {
  constructor({ storage = null, maxDocs = MAX_DOCS } = {}) {
    this.storage = storage;
    this.maxDocs = maxDocs;
    this.docs = new Map(); // id -> doc
    this.inverted = new Map(); // token -> Set<id>
    this._persistTimer = null;
  }

  _addTokens(doc) {
    const tokens = tokenize(`${doc.title} ${doc.text}`);
    doc._tokens = tokens;
    for (const tok of tokens) {
      let set = this.inverted.get(tok);
      if (!set) {
        set = new Set();
        this.inverted.set(tok, set);
      }
      set.add(doc.id);
    }
  }

  _removeTokens(doc) {
    if (!doc?._tokens) return;
    for (const tok of doc._tokens) {
      const set = this.inverted.get(tok);
      if (!set) continue;
      set.delete(doc.id);
      if (set.size === 0) this.inverted.delete(tok);
    }
  }

  upsert(rawDoc, { persist = false } = {}) {
    if (!rawDoc || !rawDoc.id) return false;
    const cleanText = sanitizeText(rawDoc.text || "").trim().slice(0, MAX_DOC_TEXT);
    const cleanTitle = sanitizeText(rawDoc.title || "").trim().slice(0, 200);
    if (!cleanText && !cleanTitle) return false;

    const existing = this.docs.get(rawDoc.id);
    if (existing) this._removeTokens(existing);

    const doc = {
      id: String(rawDoc.id),
      scope: String(rawDoc.scope || "chat"),
      session: rawDoc.session ? String(rawDoc.session) : null,
      title: cleanTitle,
      text: cleanText,
      timestamp: Number(rawDoc.timestamp) || Date.now(),
      target: rawDoc.target && typeof rawDoc.target === "object" ? rawDoc.target : {},
      ephemeral: !!rawDoc.ephemeral,
      _tokens: [],
    };
    this.docs.set(doc.id, doc);
    this._addTokens(doc);
    this._evictIfNeeded();
    if (persist) this.schedulePersist();
    return true;
  }

  append(id, extraText, meta = {}, { persist = false } = {}) {
    const existing = this.docs.get(id);
    if (!existing) {
      return this.upsert({ id, ...meta, text: extraText }, { persist });
    }
    const merged = `${existing.text}\n${extraText}`.slice(-MAX_DOC_TEXT);
    return this.upsert({
      ...existing,
      ...meta,
      id,
      text: merged,
      timestamp: Number(meta.timestamp) || Date.now(),
    }, { persist });
  }

  remove(id) {
    const existing = this.docs.get(id);
    if (!existing) return false;
    this._removeTokens(existing);
    this.docs.delete(id);
    return true;
  }

  clearScope(scope, { onlyEphemeral = false } = {}) {
    for (const [id, doc] of Array.from(this.docs.entries())) {
      if (doc.scope !== scope) continue;
      if (onlyEphemeral && !doc.ephemeral) continue;
      this.remove(id);
    }
  }

  _evictIfNeeded() {
    if (this.docs.size <= this.maxDocs) return;
    const sorted = Array.from(this.docs.values()).sort((a, b) => a.timestamp - b.timestamp);
    const excess = this.docs.size - this.maxDocs;
    for (let i = 0; i < excess; i++) {
      this.remove(sorted[i].id);
    }
  }

  loadPersisted() {
    if (!this.storage) return 0;
    try {
      const saved = this.storage.get("docs", []);
      if (!Array.isArray(saved)) return 0;
      let count = 0;
      for (const item of saved) {
        if (this.upsert({ ...item, ephemeral: false }, { persist: false })) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  schedulePersist() {
    if (!this.storage) return;
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this.persistNow(), 400);
    this._persistTimer.unref?.();
  }

  persistNow() {
    if (!this.storage) return;
    clearTimeout(this._persistTimer);
    this._persistTimer = null;
    const keep = Array.from(this.docs.values())
      .filter((d) => !d.ephemeral)
      .sort((a, b) => b.timestamp - a.timestamp);
    const out = [];
    let bytes = 2;
    for (const d of keep) {
      const entry = {
        id: d.id,
        scope: d.scope,
        session: d.session,
        title: d.title,
        text: d.text.slice(0, 4000),
        timestamp: d.timestamp,
        target: d.target,
      };
      const len = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes + len > MAX_PERSIST_BYTES) break;
      bytes += len;
      out.push(entry);
    }
    try {
      this.storage.set("docs", out);
    } catch {}
  }

  stats() {
    const byScope = {};
    for (const doc of this.docs.values()) {
      byScope[doc.scope] = (byScope[doc.scope] || 0) + 1;
    }
    return { totalDocs: this.docs.size, byScope };
  }

  search({ q = "", scope = "all", session = "", limit = 30 } = {}) {
    const query = String(q || "").trim();
    const maxResults = Math.min(100, Math.max(1, Number(limit) || 30));
    const scopeSet = (!scope || scope === "all")
      ? null
      : new Set(String(scope).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const sessionFilter = String(session || "").trim();

    if (!query) {
      // Return most recent docs matching filters when query is empty.
      const recent = Array.from(this.docs.values())
        .filter((d) => (!scopeSet || scopeSet.has(d.scope)) && (!sessionFilter || d.session === sessionFilter))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxResults)
        .map((d) => ({
          id: d.id,
          scope: d.scope,
          session: d.session,
          title: d.title,
          timestamp: d.timestamp,
          score: 0,
          snippet: d.text.slice(0, SNIPPET_LEN).replace(/\s+/g, " ") + (d.text.length > SNIPPET_LEN ? "…" : ""),
          highlights: [],
          target: d.target,
        }));
      return { query, total: recent.length, indexedDocs: this.docs.size, results: recent };
    }

    const queryLower = query.toLowerCase();
    const terms = Array.from(new Set(queryLower.split(/\s+/).filter(Boolean)));
    const indexTokens = tokenize(queryLower);

    // Use inverted index to gather candidate IDs, falling back to full scan for short/substring queries.
    let candidates = null;
    if (indexTokens.length > 0 && indexTokens.every((t) => t.length >= 2)) {
      const union = new Set();
      for (const tok of indexTokens) {
        // Exact token hit + prefix hit in inverted index
        const exact = this.inverted.get(tok);
        if (exact) for (const id of exact) union.add(id);
        for (const [k, set] of this.inverted.entries()) {
          if (k !== tok && k.includes(tok)) {
            for (const id of set) union.add(id);
          }
        }
      }
      candidates = union;
    }

    const iterable = candidates
      ? Array.from(candidates).map((id) => this.docs.get(id)).filter(Boolean)
      : Array.from(this.docs.values());

    const now = Date.now();
    const scored = [];
    for (const doc of iterable) {
      if (scopeSet && !scopeSet.has(doc.scope)) continue;
      if (sessionFilter && doc.session !== sessionFilter) continue;

      const titleLower = doc.title.toLowerCase();
      const textLower = doc.text.toLowerCase();
      const combined = `${titleLower}\n${textLower}`;

      // Require every whitespace-separated term to appear somewhere
      let allMatch = true;
      let score = 0;
      for (const term of terms) {
        const inTitle = titleLower.includes(term);
        const inText = textLower.includes(term);
        if (!inTitle && !inText) {
          allMatch = false;
          break;
        }
        if (inTitle) score += 6;
        if (inText) {
          // Count up to 5 occurrences
          let count = 0;
          let pos = 0;
          while (count < 5) {
            const idx = textLower.indexOf(term, pos);
            if (idx === -1) break;
            count++;
            pos = idx + term.length;
          }
          score += 2 + count;
        }
      }
      if (!allMatch) continue;

      if (combined.includes(queryLower)) score += 10;
      // Gentle recency boost (up to +2 for last 24h)
      const ageHours = Math.max(0, (now - doc.timestamp) / 3_600_000);
      score += Math.max(0, 2 - ageHours / 12);

      const { snippet, highlights } = buildSnippet(doc.text || doc.title, queryLower, terms);
      scored.push({
        id: doc.id,
        scope: doc.scope,
        session: doc.session,
        title: doc.title,
        timestamp: doc.timestamp,
        score: Math.round(score * 100) / 100,
        snippet,
        highlights,
        target: doc.target,
      });
    }

    scored.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
    return {
      query,
      total: scored.length,
      indexedDocs: this.docs.size,
      results: scored.slice(0, maxResults),
    };
  }
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable } from "./constants.mjs";

export function parseGrokBillingPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload.config && typeof payload.config === "object" ? payload.config : payload;
  const rawUsed = typeof cfg.creditUsagePercent === "number"
    ? cfg.creditUsagePercent
    : typeof cfg.percent === "number"
      ? cfg.percent
      : null;
  if (rawUsed === null || !Number.isFinite(rawUsed)) return null;
  const usedPct = Math.max(0, Math.min(100, Math.round(rawUsed * 10) / 10));
  const remainingPct = Math.max(0, Math.min(100, Math.round(100 - rawUsed)));
  const periodObj = cfg.currentPeriod && typeof cfg.currentPeriod === "object" ? cfg.currentPeriod : {};
  const rawType = String(periodObj.type || "WEEKLY").toUpperCase();
  const windowLabel = rawType.includes("WEEK") ? "Weekly" : rawType.includes("DAY") ? "Daily" : rawType.includes("MONTH") ? "Monthly" : "Plan";
  const resetTime = periodObj.end || periodObj.End || cfg.billingPeriodEnd || cfg.period_end || null;
  const products = Array.isArray(cfg.productUsage)
    ? cfg.productUsage
        .filter((p) => p && typeof p.usagePercent === "number" && p.usagePercent > 0)
        .map((p) => ({ product: String(p.product || ""), usagePercent: p.usagePercent }))
    : [];
  return {
    usedPct,
    remainingPct,
    window: windowLabel,
    resetTime,
    products,
  };
}

export function parseAgyQuotaJson(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const data = parsed?.command?.data;
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const buckets = [];
    for (const g of groups) {
      const groupName = g?.name || "";
      for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
        const frac = typeof b?.remaining_fraction === "number" ? b.remaining_fraction : null;
        buckets.push({
          id: b?.id || `${groupName}-${b?.window || ""}`,
          group: groupName,
          name: b?.name || "",
          window: b?.window || "",
          remainingPct: frac === null ? null : Math.max(0, Math.min(100, Math.round(frac * 100))),
          resetTime: b?.reset_time || null,
          description: b?.description || "",
        });
      }
    }
    return {
      ok: buckets.length > 0,
      description: data?.description || "",
      buckets,
    };
  } catch {
    return { ok: false, description: "", buckets: [] };
  }
}

export function execCapture(cwd, command, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const exe = findExecutable(command);
    if (!exe) {
      resolve({ available: false, ok: false, stdout: "", stderr: `${command} 未安装` });
      return;
    }
    const child = spawn(exe, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      done({ available: true, ok: false, stdout, stderr: "查询超时" });
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => done({ available: true, ok: false, stdout, stderr: err.message }));
    child.on("close", (code) => done({ available: true, ok: code === 0, stdout, stderr }));
  });
}

export async function fetchGrokBilling() {
  const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  let token = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(grokHome, "auth.json"), "utf8"));
    if (raw && typeof raw === "object") {
      let bestExp = "";
      for (const val of Object.values(raw)) {
        if (!val || typeof val !== "object" || typeof val.key !== "string" || !val.key) continue;
        const exp = String(val.expires_at || "");
        if (!token || exp > bestExp) {
          bestExp = exp;
          token = val.key;
        }
      }
    }
  } catch {}

  if (token) {
    try {
      const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "x-xai-token-auth": "xai-grok-cli",
          "User-Agent": "xai-grok-cli",
        },
        signal: AbortSignal.timeout(4500),
      });
      if (res.ok) {
        const payload = await res.json();
        const parsed = parseGrokBillingPayload(payload);
        if (parsed) return { ok: true, source: "live", ...parsed };
      }
    } catch {}
  }

  // Fallback to Grok statusline cache file
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(grokHome, "statusline-billing.json"), "utf8"));
    const parsed = parseGrokBillingPayload(cached);
    if (parsed) return { ok: true, source: "cache", ...parsed };
  } catch {}

  return { ok: false };
}

export function parseOpenCodeStats(rawOut) {
  try {
    const parsed = JSON.parse(rawOut);
    const tok = parsed.tokens || {};
    const topModels = Array.isArray(parsed.models)
      ? parsed.models
          .map((m) => {
            const mt = m.tokens || {};
            const sum = (mt.input || 0) + (mt.output || 0) + (mt.reasoning || 0);
            return { id: m.model?.id || "", provider: m.model?.providerID || "", tokens: sum, cost: m.cost || 0 };
          })
          .filter((m) => m.id && m.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 3)
      : [];
    return {
      sessions: parsed.sessions ?? 0,
      prompts: parsed.prompts ?? 0,
      steps: parsed.steps ?? 0,
      inputTokens: tok.input ?? 0,
      outputTokens: tok.output ?? 0,
      reasoningTokens: tok.reasoning ?? 0,
      cacheReadTokens: tok.cache?.read ?? 0,
      costUsd: typeof parsed.cost === "number" ? parsed.cost : 0,
      topModels,
    };
  } catch {
    return null;
  }
}

export async function fetchAllQuotas({ cwd, exec = execCapture, getGrokBilling = fetchGrokBilling }) {
  const grokAvailable = Boolean(findExecutable("grok"));
  const [agyRaw, grokBilling, oc30Raw, ocAllRaw] = await Promise.all([
    exec(cwd, "agy", ["-p", "/quota", "--output-format", "json"], 12_000),
    grokAvailable ? getGrokBilling() : Promise.resolve({ ok: false }),
    exec(cwd, "opencode", ["stats", "--days", "30", "--cost", "--json"], 8_000),
    exec(cwd, "opencode", ["stats", "--all", "--cost", "--models", "--json"], 8_000),
  ]);

  const agyParsed = agyRaw.ok ? parseAgyQuotaJson(agyRaw.stdout) : { ok: false, description: "", buckets: [] };
  const agy = {
    available: agyRaw.available,
    ok: agyParsed.ok,
    buckets: agyParsed.buckets,
    description: agyParsed.description,
    error: agyParsed.ok ? null : (agyRaw.stderr || agyRaw.stdout || "无法获取 AGY 额度").trim(),
  };

  const grok = {
    available: grokAvailable,
    ok: Boolean(grokBilling?.ok),
    source: grokBilling?.source || null,
    billing: grokBilling?.ok ? grokBilling : null,
    note: grokAvailable && !grokBilling?.ok ? "未检测到 Grok 登录凭证（~/.grok/auth.json）" : null,
  };

  const ocAvailable = ocAllRaw.available || oc30Raw.available;
  const statsAll = ocAllRaw.ok && ocAllRaw.stdout.trim() ? parseOpenCodeStats(ocAllRaw.stdout) : null;
  const stats30d = oc30Raw.ok && oc30Raw.stdout.trim() ? parseOpenCodeStats(oc30Raw.stdout) : null;
  const opencode = {
    available: ocAvailable,
    ok: Boolean(statsAll || stats30d),
    stats: stats30d || statsAll,
    stats30d,
    statsAll,
    note: ocAvailable && !statsAll && !stats30d ? (ocAllRaw.stderr || "暂无法获取 OpenCode 统计").trim() : null,
  };

  return { fetchedAt: Date.now(), agy, grok, opencode };
}

import { closeDialog, dom, openDialog } from "./dom.js";
import { saveJsonStorage, state } from "./state.js";
import { L, formatCompactNum, formatResetCountdown, tr } from "./utils.js";
import { scheduleStoreSync } from "./store.js";
import { renderInspector } from "./sessions.js";

export function recordAgentUsage(providerId, providerName, usage, costUsd, ctxUsed, ctxSize) {
  const inp = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0) || 0;
  const out = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0) || 0;
  const tht = Number(usage?.thoughtTokens ?? usage?.reasoning_tokens ?? 0) || 0;
  const cac = Number(usage?.cachedReadTokens ?? usage?.cache_read_input_tokens ?? 0) || 0;
  const cost = Number(costUsd || 0) || 0;

  state.agentUsageStats.turns += 1;
  state.agentUsageStats.inputTokens += inp;
  state.agentUsageStats.outputTokens += out;
  state.agentUsageStats.thoughtTokens += tht;
  state.agentUsageStats.cachedTokens += cac;
  state.agentUsageStats.costUsd += cost;
  if (ctxUsed != null) state.agentUsageStats.lastContextUsed = ctxUsed;
  if (ctxSize != null) state.agentUsageStats.lastContextSize = ctxSize;

  const pKey = providerId || "unknown";
  const prev = state.agentUsageStats.byProvider[pKey] || { name: providerName || pKey, turns: 0, tokens: 0, costUsd: 0 };
  prev.name = providerName || prev.name;
  prev.turns += 1;
  prev.tokens += inp + out;
  prev.costUsd += cost;
  state.agentUsageStats.byProvider[pKey] = prev;

  saveJsonStorage("colab-desk.agent-usage-stats", state.agentUsageStats);
  renderUsageBadge();
  scheduleStoreSync();
}

export function shortBucketLabel(b) {
  const g = /claude|gpt|3p/i.test(`${b.group} ${b.id}`) ? "Claude & GPT" : "Gemini";
  const w = b.window === "5h"
    ? L("5小时", "5-hour")
    : b.window === "weekly"
      ? L("每周", "Weekly")
      : (b.name || "");
  return `${g} · ${w}`;
}

export function renderUsageBadge() {
  const buckets = state.latestAgentQuota?.agy?.buckets;
  if (Array.isArray(buckets) && buckets.length > 0) {
    const primary = buckets.find((b) => b.id === "gemini-5h") || buckets[0];
    if (primary && primary.remainingPct != null) {
      dom.sidebarUsageBadge.textContent = `${primary.remainingPct}%`;
      return;
    }
  }
  dom.sidebarUsageBadge.textContent = "—";
}

export function renderQuotaBarsCard(title, providerKey, subtitle, contentBuilder) {
  const section = document.createElement("div");
  section.className = "quota-section";
  const head = document.createElement("div");
  head.className = "quota-section-head";
  const titleEl = document.createElement("span");
  titleEl.className = "quota-section-title";
  const dot = document.createElement("span");
  dot.className = `agent-dot p-${providerKey}`;
  titleEl.append(dot, document.createTextNode(title));
  const subEl = document.createElement("span");
  subEl.className = "quota-section-sub";
  subEl.textContent = subtitle || "";
  head.append(titleEl, subEl);
  const card = document.createElement("div");
  card.className = "quota-card";
  contentBuilder(card);
  section.append(head, card);
  return section;
}

export function renderUsageModal() {
  const s = state.agentUsageStats;
  const total = s.inputTokens + s.outputTokens;
  const costPart = s.costUsd > 0 ? ` · $${s.costUsd.toFixed(4)}` : "";
  dom.statLocalSummary.textContent = L(
    `${s.turns} 轮 · ${formatCompactNum(total)} tok${costPart}`,
    `${s.turns} turns · ${formatCompactNum(total)} tok${costPart}`,
  );

  dom.agentQuotaBody.replaceChildren();
  if (!state.latestAgentQuota) {
    const loading = document.createElement("p");
    loading.className = "quota-note";
    loading.textContent = L("正在查询 AGY / Grok / OpenCode 剩余额度…", "Checking AGY / Grok / OpenCode quotas…");
    dom.agentQuotaBody.append(loading);
    return;
  }

  // 1. AGY Remaining Quota Bars
  const agy = state.latestAgentQuota.agy || {};
  dom.agentQuotaBody.append(
    renderQuotaBarsCard(
      L("AGY 剩余额度", "AGY Quota"),
      "agy",
      agy.ok ? L("实时配额", "Live quota") : (agy.available ? L("获取失败", "Failed") : L("未安装", "Not installed")),
      (card) => {
        if (agy.ok && Array.isArray(agy.buckets) && agy.buckets.length > 0) {
          for (const b of agy.buckets) {
            const pct = b.remainingPct ?? 0;
            const row = document.createElement("div");
            row.className = "quota-row";
            const main = document.createElement("div");
            main.className = "quota-row-main";
            const lbl = document.createElement("span");
            lbl.className = "quota-row-label";
            lbl.textContent = shortBucketLabel(b);
            const track = document.createElement("div");
            track.className = "meter-track";
            const fill = document.createElement("div");
            fill.className = "meter-fill" + (pct <= 10 ? " is-low" : pct <= 35 ? " is-warn" : "");
            fill.style.width = `${pct}%`;
            track.append(fill);
            const val = document.createElement("span");
            val.className = "quota-row-pct" + (pct <= 10 ? " is-low" : pct <= 35 ? " is-mid" : "");
            val.textContent = `${pct}%`;
            main.append(lbl, track, val);
            row.append(main);
            const resetTxt = formatResetCountdown(b.resetTime);
            if (resetTxt) {
              const sub = document.createElement("span");
              sub.className = "quota-row-sub";
              sub.textContent = resetTxt;
              row.append(sub);
            }
            card.append(row);
          }
        } else {
          const p = document.createElement("p");
          p.className = "quota-note";
          p.textContent = agy.error || L("未获取到 AGY 剩余额度", "Unable to fetch AGY quota");
          card.append(p);
        }
      },
    ),
  );

  // 2. Grok Real Plan Quota (live billing API / statusline cache)
  const grok = state.latestAgentQuota.grok || {};
  const grokLocal = s.byProvider?.grok;
  const grokSub = !grok.available
    ? (state.activeLang === "en" ? "Not installed" : "未安装")
    : grok.ok
      ? (grok.source === "cache" ? (state.activeLang === "en" ? "Cached quota" : "缓存配额") : (state.activeLang === "en" ? "Live quota" : "实时配额"))
      : (state.activeLang === "en" ? "Unavailable" : "暂未获取");
  dom.agentQuotaBody.append(
    renderQuotaBarsCard(state.activeLang === "en" ? "Grok Quota" : "Grok 剩余额度", "grok", grokSub, (card) => {
      if (grok.ok && grok.billing) {
        const b = grok.billing;
        const pct = b.remainingPct ?? 0;
        const row = document.createElement("div");
        row.className = "quota-row";
        const main = document.createElement("div");
        main.className = "quota-row-main";
        const lbl = document.createElement("span");
        lbl.className = "quota-row-label";
        lbl.textContent = `Grok · ${b.window || "Weekly"}`;
        const track = document.createElement("div");
        track.className = "meter-track";
        const fill = document.createElement("div");
        fill.className = "meter-fill" + (pct <= 10 ? " is-low" : pct <= 35 ? " is-warn" : "");
        fill.style.width = `${pct}%`;
        track.append(fill);
        const val = document.createElement("span");
        val.className = "quota-row-pct" + (pct <= 10 ? " is-low" : pct <= 35 ? " is-mid" : "");
        val.textContent = `${pct}%`;
        main.append(lbl, track, val);
        row.append(main);

        const resetTxt = formatResetCountdown(b.resetTime);
        const prodTxt = Array.isArray(b.products) && b.products.length > 0
          ? b.products.map((p) => `${p.product} ${Math.round(p.usagePercent)}%`).join(" · ")
          : "";
        const subParts = [];
        if (resetTxt) subParts.push(resetTxt);
        subParts.push(state.activeLang === "en" ? `Used ${b.usedPct}%` : `已用 ${b.usedPct}%`);
        if (prodTxt) subParts.push(prodTxt);
        const sub = document.createElement("span");
        sub.className = "quota-row-sub";
        sub.textContent = subParts.join(" · ");
        row.append(sub);
        card.append(row);
      } else {
        const p = document.createElement("p");
        p.className = "quota-note";
        const localTxt = grokLocal
          ? L(
            `本应用已用 ${grokLocal.turns} 轮 · ${formatCompactNum(grokLocal.tokens)} tok · $${(grokLocal.costUsd || 0).toFixed(4)}`,
            `Local app: ${grokLocal.turns} turns · ${formatCompactNum(grokLocal.tokens)} tok · $${(grokLocal.costUsd || 0).toFixed(4)}`,
          )
          : L("本应用暂无 Grok 对话记录", "No Grok turns recorded yet");
        p.textContent = grok.note ? `${grok.note}。${localTxt}` : localTxt;
        card.append(p);
      }
    }),
  );

  // 3. OpenCode Usage (30d + Lifetime + Top Models)
  const oc = state.latestAgentQuota.opencode || {};
  dom.agentQuotaBody.append(
    renderQuotaBarsCard(
      state.activeLang === "en" ? "OpenCode Usage" : "OpenCode 用量统计",
      "opencode",
      oc.available ? (oc.ok ? (state.activeLang === "en" ? "CLI Stats" : "CLI 统计") : (state.activeLang === "en" ? "Failed" : "获取失败")) : (state.activeLang === "en" ? "Not installed" : "未安装"),
      (card) => {
        if (oc.ok && (oc.stats30d || oc.statsAll || oc.stats)) {
          const s30 = oc.stats30d;
          const sAll = oc.statsAll || oc.stats;
          if (s30) {
            const tok30 = (s30.inputTokens || 0) + (s30.outputTokens || 0) + (s30.reasoningTokens || 0);
            const cache30 = s30.cacheReadTokens || 0;
            const p30 = document.createElement("p");
            p30.className = "quota-note";
            p30.textContent = state.activeLang === "en"
              ? `30d: ${s30.sessions} sessions · ${s30.prompts} prompts · ${formatCompactNum(tok30)} tok${cache30 ? ` (+${formatCompactNum(cache30)} cache)` : ""}`
              : `近 30 天：${s30.sessions} 会话 · ${s30.prompts} 提问 · ${formatCompactNum(tok30)} tok${cache30 ? `（含缓存 ${formatCompactNum(cache30)}）` : ""}`;
            card.append(p30);
          }
          if (sAll) {
            const tokAll = (sAll.inputTokens || 0) + (sAll.outputTokens || 0) + (sAll.reasoningTokens || 0);
            const cacheAll = sAll.cacheReadTokens || 0;
            const pAll = document.createElement("p");
            pAll.className = "quota-note";
            pAll.textContent = state.activeLang === "en"
              ? `Lifetime: ${sAll.sessions} sessions · ${sAll.prompts} prompts · ${formatCompactNum(tokAll)} tok${cacheAll ? ` (+${formatCompactNum(cacheAll)} cache)` : ""} · $${(sAll.costUsd || 0).toFixed(2)}`
              : `累计：${sAll.sessions} 会话 · ${sAll.prompts} 提问 · ${formatCompactNum(tokAll)} tok${cacheAll ? `（缓存 ${formatCompactNum(cacheAll)}）` : ""} · 费用 $${(sAll.costUsd || 0).toFixed(2)}`;
            card.append(pAll);
            if (Array.isArray(sAll.topModels) && sAll.topModels.length > 0) {
              const sub = document.createElement("span");
              sub.className = "quota-row-sub";
              sub.textContent = `Top: ${sAll.topModels.map((m) => `${m.id} (${formatCompactNum(m.tokens)})`).join(" · ")}`;
              card.append(sub);
            }
          }
        } else {
          const p = document.createElement("p");
          p.className = "quota-note";
          p.textContent = oc.note || (state.activeLang === "en" ? "Unable to read OpenCode stats" : "未获取到 OpenCode 用量");
          card.append(p);
        }
      },
    ),
  );
}

export async function refreshAgentQuota(force = false) {
  const btn = document.querySelector("#refresh-agent-quota");
  if (btn) {
    btn.disabled = true;
    btn.textContent = L("查询中…", "Checking…");
  }
  try {
    const res = await fetch(`/api/agent/quota${force ? "?refresh=1" : ""}`);
    const json = await res.json();
    if (json.ok && json.quota) {
      state.latestAgentQuota = json.quota;
      renderUsageBadge();
      if (dom.usageModal.open) renderUsageModal();
    }
  } catch {}
  finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = tr("modal.usage.refresh");
    }
  }
}

export async function openColabCuModal() {
  openDialog(dom.cuModal);
  dom.cuRawEl.textContent = L("正在查询 colab usage…", "Querying colab usage…");
  if (state.usageInfo) paintCuModal(state.usageInfo, null);
  await refreshColabCuModal();
}

export function paintCuModal(info, rawText) {
  if (info && info.balance != null) {
    dom.cuBalanceEl.textContent = `${info.balance.toFixed(2)} CU`;
  } else {
    dom.cuBalanceEl.textContent = "—";
  }
  if (info && info.ratePerHour != null) {
    dom.cuRateEl.textContent = `${info.ratePerHour.toFixed(2)} /hr`;
    dom.cuEstHoursEl.textContent = info.ratePerHour > 0 && info.balance != null
      ? L(`预计可用：约 ${(info.balance / info.ratePerHour).toFixed(1)} 小时`, `Est. remaining: ~${(info.balance / info.ratePerHour).toFixed(1)}h`)
      : L("当前无计费消耗", "No active burn");
  } else {
    dom.cuRateEl.textContent = "—";
    dom.cuEstHoursEl.textContent = L("预计可用时长：—", "Est. remaining: —");
  }
  dom.cuActiveEl.textContent = tr("rail.activeCount", { count: info && info.activeAssignments != null ? info.activeAssignments : "—" });
  if (rawText != null) dom.cuRawEl.textContent = rawText;
}

export async function refreshColabCuModal() {
  const btn = document.querySelector("#refresh-cu-modal");
  if (btn) { btn.disabled = true; btn.textContent = L("刷新中…", "Refreshing…"); }
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    if (data.ok) {
      if (data.state && data.state.usage) {
        state.usageInfo = data.state.usage;
        renderInspector();
      }
      paintCuModal(state.usageInfo, (data.stdout || "").trim() || L("无输出", "(no output)"));
    } else {
      paintCuModal(state.usageInfo, data.error || L("查询 colab usage 失败", "Failed to query colab usage"));
    }
  } catch (err) {
    paintCuModal(state.usageInfo, (err && err.message) || L("查询失败", "Query failed"));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = tr("modal.cu.refresh"); }
  }
}

export function initUsageModals() {
  document.querySelector("#quick-usage").addEventListener("click", openColabCuModal);
  document.querySelector("#close-cu-modal").addEventListener("click", () => closeDialog(dom.cuModal));
  document.querySelector("#done-cu-modal").addEventListener("click", () => closeDialog(dom.cuModal));
  document.querySelector("#refresh-cu-modal").addEventListener("click", refreshColabCuModal);
  dom.cuModal.addEventListener("click", (e) => { if (e.target === dom.cuModal) closeDialog(dom.cuModal); });

  document.querySelector("#open-usage-modal").addEventListener("click", () => {
    renderUsageModal();
    openDialog(dom.usageModal);
    refreshAgentQuota(false);
  });
  document.querySelector("#close-usage-modal").addEventListener("click", () => closeDialog(dom.usageModal));
  document.querySelector("#done-usage-modal").addEventListener("click", () => closeDialog(dom.usageModal));
  document.querySelector("#refresh-agent-quota").addEventListener("click", () => refreshAgentQuota(true));
  dom.usageModal.addEventListener("click", (e) => { if (e.target === dom.usageModal) closeDialog(dom.usageModal); });
}

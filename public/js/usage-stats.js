import { dom } from "./dom.js";
import { saveJsonStorage, state } from "./state.js";
import { L, tr } from "./utils.js";
import { emit } from "./events.js";
import { scheduleStoreSync } from "./store.js";

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

export function renderUsageBadge() {
  if (!dom.sidebarUsageBadge) return;
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
      emit("usage:quota-updated");
    }
  } catch {}
  finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = tr("modal.usage.refresh");
    }
  }
}

import { loadStore } from "../store.mjs";
import { COLAB_OPENAI_TOOLS, formatCompact } from "./constants.mjs";
import { buildColabSystemRules, buildOpenAiUserContent, formatTurnPrompt } from "./prompts.mjs";
import { executeColabTool } from "./tools.mjs";

export function resolveOpenAiModelsEndpoints(baseUrl) {
  let clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) return [];
  clean = clean.replace(/\/chat\/completions$/i, "");
  if (/\/models$/i.test(clean)) return [clean];
  try {
    const parsed = new URL(clean);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname) {
      return [`${clean}/v1/models`, `${clean}/models`];
    }
    if (/\/v\d+(?:beta|alpha)?$/i.test(pathname)) {
      return [`${clean}/models`];
    }
    return [`${clean}/models`, `${clean}/v1/models`];
  } catch {
    return [`${clean}/v1/models`, `${clean}/models`];
  }
}

export async function fetchOpenAiModels(apiCfg) {
  const endpoints = resolveOpenAiModelsEndpoints(apiCfg?.baseUrl);
  if (endpoints.length === 0) return { ok: false, models: [], error: "Base URL is required" };
  const headers = {};
  if (apiCfg?.apiKey) headers.authorization = `Bearer ${apiCfg.apiKey}`;
  let lastError = "Unable to fetch /v1/models";
  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i];
    const hasMore = i < endpoints.length - 1;
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(7_000),
      });
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        lastError = `${endpoint} → HTTP ${res.status}: ${text.slice(0, 180)}`;
        if ((res.status === 404 || res.status === 405) && hasMore) continue;
        return { ok: false, models: [], error: lastError };
      }
      if (contentType.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(text)) {
        lastError = `${endpoint} returned HTML`;
        if (hasMore) continue;
        return { ok: false, models: [], error: lastError };
      }
      let json = null;
      try { json = JSON.parse(text); } catch {
        lastError = `${endpoint} returned invalid JSON`;
        if (hasMore) continue;
        return { ok: false, models: [], error: lastError };
      }
      const rawList = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : Array.isArray(json)
            ? json
            : [];
      const seen = new Set();
      const models = [];
      for (const item of rawList) {
        const id = typeof item === "string"
          ? item.trim()
          : String(item?.id || item?.name || item?.model || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ value: id, name: id });
      }
      models.sort((a, b) => a.value.localeCompare(b.value));
      return { ok: true, models, endpoint };
    } catch (err) {
      lastError = `${endpoint} → ${err.message || String(err)}`;
      if (hasMore) continue;
    }
  }
  return { ok: false, models: [], error: lastError };
}

export function resolveOpenAiChatEndpoints(baseUrl) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) return [];
  if (/\/chat\/completions$/i.test(clean)) return [clean];
  try {
    const parsed = new URL(clean);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname) {
      return [`${clean}/v1/chat/completions`, `${clean}/chat/completions`];
    }
    if (/\/v\d+(?:beta|alpha)?$/i.test(pathname)) {
      return [`${clean}/chat/completions`];
    }
    return [`${clean}/chat/completions`, `${clean}/v1/chat/completions`];
  } catch {
    return [`${clean}/v1/chat/completions`, `${clean}/chat/completions`];
  }
}

export function extractOpenAiContentText(val) {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return String(part.text ?? part.content ?? part.value ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function parseOpenAiJsonCompletion(data) {
  if (!data || typeof data !== "object") return null;
  if (data.error) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : data.error.message || data.error.msg || JSON.stringify(data.error);
    return { error: String(msg) };
  }
  const usage = data.usage
    ? {
        inputTokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
        outputTokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
        thoughtTokens: data.usage.completion_tokens_details?.reasoning_tokens || 0,
      }
    : null;
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && typeof choice === "object") {
    const msg = choice.message || choice.delta || {};
    const text = extractOpenAiContentText(msg.content);
    const thought = extractOpenAiContentText(msg.reasoning_content ?? msg.reasoning ?? msg.thinking);
    const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const toolCalls = rawToolCalls
      .map((tc) => ({
        id: String(tc?.id || ""),
        name: String(tc?.function?.name || tc?.name || ""),
        arguments:
          typeof tc?.function?.arguments === "string"
            ? tc.function.arguments
            : tc?.function?.arguments != null
              ? JSON.stringify(tc.function.arguments)
              : typeof tc?.arguments === "string"
                ? tc.arguments
                : tc?.arguments != null
                  ? JSON.stringify(tc.arguments)
                  : "{}",
      }))
      .filter((tc) => tc.name);
    return { text, thought, toolCalls, usage };
  }
  if (typeof data.output_text === "string" && data.output_text) {
    return { text: data.output_text, thought: "", toolCalls: [], usage };
  }
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (item && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    if (parts.length > 0) return { text: parts.join(""), thought: "", toolCalls: [], usage };
  }
  if (typeof data.message === "string" && data.message) {
    return { error: data.message };
  }
  if (typeof data.msg === "string" && data.msg) {
    return { error: data.msg };
  }
  return null;
}

export function getApiProfiles() {
  const settings = loadStore().settings || {};
  const list = Array.isArray(settings.apiProfiles) ? settings.apiProfiles : [];
  const normalized = list
    .filter((p) => p && typeof p === "object")
    .map((p, idx) => ({
      id: String(p.id || `profile-${idx + 1}`),
      label: String(p.label || "").trim() || `API ${idx + 1}`,
      baseUrl: String(p.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKey: String(p.apiKey || "").trim(),
      model: String(p.model || "").trim(),
    }));
  if (normalized.length > 0) return normalized;
  const legacy = settings.apiConfig;
  if (legacy && (legacy.baseUrl || legacy.model)) {
    return [{
      id: "default",
      label: String(legacy.label || "").trim() || "自定义 API",
      baseUrl: String(legacy.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKey: String(legacy.apiKey || "").trim(),
      model: String(legacy.model || "").trim(),
    }];
  }
  return [];
}

export function getApiConfig(override, profileId = null) {
  const profiles = getApiProfiles();
  let base = null;
  if (profileId) {
    base = profiles.find((p) => p.id === profileId) || null;
  }
  if (!base) base = profiles[0] || loadStore().settings?.apiConfig || {};
  const merged = { ...base, ...(override || {}) };
  return {
    id: merged.id || profileId || "default",
    baseUrl: String(merged.baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: String(merged.apiKey || "").trim(),
    model: String(merged.model || "").trim(),
    label: String(merged.label || "").trim() || "自定义 API",
  };
}

export async function testOpenAiApiConfig(api) {
  if (!api.baseUrl || !api.model) {
    return { ok: false, error: "请先填写 Base URL 和模型名称" };
  }
  const endpoints = resolveOpenAiChatEndpoints(api.baseUrl);
  if (endpoints.length === 0) {
    return { ok: false, error: "无效的 Base URL" };
  }
  const headers = { "content-type": "application/json" };
  if (api.apiKey) headers.authorization = `Bearer ${api.apiKey}`;
  let lastError = "无法连接到接口";
  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i];
    const hasMore = i < endpoints.length - 1;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const bodyText = await res.text().catch(() => "");
      if (!res.ok) {
        lastError = `${endpoint} → HTTP ${res.status}: ${bodyText.slice(0, 240)}`;
        if ((res.status === 404 || res.status === 405) && hasMore) continue;
        return { ok: false, error: lastError };
      }
      if (contentType.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(bodyText)) {
        lastError = `${endpoint} 返回了 HTML 页面而非 OpenAI JSON 接口`;
        if (hasMore) continue;
        return { ok: false, error: lastError };
      }
      if (bodyText.trim().startsWith("{")) {
        try {
          const parsed = parseOpenAiJsonCompletion(JSON.parse(bodyText));
          if (parsed?.error) {
            return { ok: false, error: `${endpoint} → ${parsed.error}` };
          }
        } catch {}
      }
      return { ok: true, model: api.model, endpoint };
    } catch (err) {
      lastError = `${endpoint} → ${err.message || String(err)}`;
      if (hasMore) continue;
    }
  }
  return { ok: false, error: lastError };
}

export async function runOpenAiCompatTurn({
  api,
  threads,
  pendingPermissions,
  executeTool = executeColabTool,
  provider,
  providerId,
  threadKey,
  promptText,
  model,
  approvalMode,
  context,
  emit,
  signal,
}) {
  if (!api.baseUrl || !api.model) {
    emit({ type: "error", error: "请先在「设置 → 智能体提供方」中配置自定义 API 的 Base URL 和模型名称" });
    return;
  }
  const activeModel = model || api.model;
  let candidateEndpoints = resolveOpenAiChatEndpoints(api.baseUrl);
  if (candidateEndpoints.length === 0) {
    emit({ type: "error", error: "自定义 API 的 Base URL 格式无效" });
    return;
  }
  const headers = { "content-type": "application/json" };
  if (api.apiKey) headers.authorization = `Bearer ${api.apiKey}`;

  let thread = threads.get(threadKey);
  if (!thread || !Array.isArray(thread.messages)) {
    thread = { messages: [] };
    threads.set(threadKey, thread);
  }

  const userText = formatTurnPrompt(promptText, context, false);
  const userContent = buildOpenAiUserContent(userText, context.files);
  thread.messages.push({ role: "user", content: userContent });
  if (thread.messages.length > 30) thread.messages = thread.messages.slice(-30);

  emit({
    type: "meta",
    provider: providerId || provider.id,
    providerName: api.label || provider.name,
    model: activeModel,
    sessionId: threadKey,
  });

  const totalUsage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  let includeStreamOptions = true;
  let includeTools = true;
  let preferStream = true;

  const addUsage = (u) => {
    if (!u) return;
    totalUsage.inputTokens += u.inputTokens ?? u.prompt_tokens ?? u.input_tokens ?? 0;
    totalUsage.outputTokens += u.outputTokens ?? u.completion_tokens ?? u.output_tokens ?? 0;
    totalUsage.thoughtTokens += u.thoughtTokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0;
  };

  const requestRound = async (messages, forceNonStream = false) => {
    let lastError = null;
    for (let i = 0; i < candidateEndpoints.length; i += 1) {
      const endpoint = candidateEndpoints[i];
      const hasNextEndpoint = i < candidateEndpoints.length - 1;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const useStream = !forceNonStream && preferStream;
        const payload = {
          model: activeModel,
          messages,
          stream: useStream,
        };
        if (includeTools) payload.tools = COLAB_OPENAI_TOOLS;
        if (useStream && includeStreamOptions) payload.stream_options = { include_usage: true };

        let res;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal,
          });
        } catch (err) {
          if (signal && signal.aborted) throw err;
          lastError = `无法连接 ${endpoint}: ${err.message || String(err)}`;
          break;
        }

        const contentType = String(res.headers.get("content-type") || "").toLowerCase();
        if (res.ok) {
          if (contentType.includes("text/html")) {
            try { await res.body?.cancel(); } catch {}
            lastError = `${endpoint} 返回了 HTML 页面（请检查 Base URL 是否需要 /v1 路径）`;
            if (hasNextEndpoint) break;
            return { error: lastError, endpoint };
          }
          candidateEndpoints = [endpoint];
          return { res, endpoint, contentType };
        }

        const errBody = await res.text().catch(() => "");
        let errDetail = errBody.slice(0, 400) || res.statusText;
        let errType = "";
        if (errBody.trim().startsWith("{")) {
          try {
            const parsedErr = JSON.parse(errBody);
            const e = parsedErr?.error;
            if (e && typeof e === "object") {
              errType = e.type || e.code || "";
              if (e.message || e.msg) errDetail = String(e.message || e.msg);
            } else if (typeof e === "string" && e) {
              errDetail = e;
            } else if (parsedErr?.message || parsedErr?.msg) {
              errDetail = String(parsedErr.message || parsedErr.msg);
            }
          } catch {}
        }
        lastError = `API 请求失败 (${endpoint} · HTTP ${res.status}${errType ? ` · ${errType}` : ""}): ${errDetail}`;

        if ((res.status === 404 || res.status === 405) && hasNextEndpoint) {
          break;
        }
        if (res.status === 400 || res.status === 422) {
          if (useStream && includeStreamOptions) {
            includeStreamOptions = false;
            continue;
          }
          if (includeTools && /tool|function/i.test(errBody)) {
            includeTools = false;
            continue;
          }
          if (useStream && /stream/i.test(errBody)) {
            preferStream = false;
            continue;
          }
          if (includeTools) {
            includeTools = false;
            continue;
          }
        }
        return { error: lastError, endpoint };
      }
    }
    return { error: lastError || "API 请求失败" };
  };

  const readRoundResponse = async (res, contentType) => {
    let assistantText = "";
    let thoughtText = "";
    let sseDataCount = 0;
    let streamError = null;
    const toolCallsMap = new Map();

    const processSseLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") return;
      sseDataCount += 1;
      let chunk;
      try { chunk = JSON.parse(dataStr); } catch { return; }
      if (chunk?.error) {
        streamError =
          typeof chunk.error === "string"
            ? chunk.error
            : chunk.error.message || chunk.error.msg || JSON.stringify(chunk.error);
        return;
      }
      if (chunk.usage) addUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta || choice?.message;
      if (!delta) return;
      const reasoningPart = extractOpenAiContentText(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
      if (reasoningPart) {
        thoughtText += reasoningPart;
        emit({ type: "thought", text: reasoningPart });
      }
      const textPart = extractOpenAiContentText(delta.content);
      if (textPart) {
        assistantText += textPart;
        emit({ type: "text", text: textPart });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const prev = toolCallsMap.get(idx) || { id: "", name: "", arguments: "" };
          if (tc.id) prev.id = tc.id;
          if (tc.function?.name) prev.name += tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            prev.arguments += tc.function.arguments;
          } else if (tc.function?.arguments != null) {
            prev.arguments += JSON.stringify(tc.function.arguments);
          }
          toolCallsMap.set(idx, prev);
        }
      }
    };

    const applyJsonBody = (rawText) => {
      let parsedJson;
      try { parsedJson = JSON.parse(rawText); } catch { return false; }
      const completion = parseOpenAiJsonCompletion(parsedJson);
      if (!completion) return false;
      if (completion.error) {
        streamError = completion.error;
        return true;
      }
      if (completion.usage) addUsage(completion.usage);
      if (completion.thought) {
        thoughtText += completion.thought;
        emit({ type: "thought", text: completion.thought });
      }
      if (completion.text) {
        assistantText += completion.text;
        emit({ type: "text", text: completion.text });
      }
      if (Array.isArray(completion.toolCalls)) {
        completion.toolCalls.forEach((tc, idx) => {
          toolCallsMap.set(idx, tc);
        });
      }
      return true;
    };

    let rawBody = "";
    if (contentType.includes("application/json") || !res.body) {
      rawBody = await res.text().catch(() => "");
      if (!applyJsonBody(rawBody) && rawBody.includes("data:")) {
        for (const line of rawBody.split(/\r?\n/)) processSseLine(line);
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        if (sseDataCount === 0 && rawBody.length < 65_536) {
          rawBody += decoded.slice(0, 65_536 - rawBody.length);
        }
        sseBuf += decoded;
        const lines = sseBuf.split(/\r?\n/);
        sseBuf = lines.pop() || "";
        for (const rawLine of lines) processSseLine(rawLine);
      }
      const tail = decoder.decode();
      if (tail) {
        if (sseDataCount === 0 && rawBody.length < 65_536) {
          rawBody += tail.slice(0, 65_536 - rawBody.length);
        }
        sseBuf += tail;
      }
      if (sseBuf.trim()) {
        for (const rawLine of sseBuf.split(/\r?\n/)) processSseLine(rawLine);
      }
      if (sseDataCount === 0 && rawBody.trim()) {
        applyJsonBody(rawBody.trim());
      }
    }

    const toolCalls = Array.from(toolCallsMap.values()).filter((tc) => tc.name);
    return { assistantText, thoughtText, toolCalls, streamError, rawBody };
  };

  try {
    for (let round = 0; round < 12; round += 1) {
      if (signal && signal.aborted) {
        emit({ type: "done", stopReason: "cancelled", usage: totalUsage });
        return;
      }
      const messages = [
        { role: "system", content: buildColabSystemRules(context) },
        ...thread.messages,
      ];
      let reqRes = await requestRound(messages, false);
      if (reqRes.error) {
        emit({ type: "error", error: reqRes.error });
        return;
      }

      let parsed = await readRoundResponse(reqRes.res, reqRes.contentType);
      if (!parsed.streamError && !parsed.assistantText && !parsed.thoughtText && parsed.toolCalls.length === 0 && preferStream) {
        // Some local gateways accept stream:true with HTTP 200 but emit an empty body; retry once non-streaming
        preferStream = false;
        const fallbackReq = await requestRound(messages, true);
        if (!fallbackReq.error && fallbackReq.res) {
          reqRes = fallbackReq;
          parsed = await readRoundResponse(fallbackReq.res, fallbackReq.contentType);
        }
      }

      if (parsed.streamError) {
        emit({ type: "error", error: `API 返回错误 (${reqRes.endpoint}): ${parsed.streamError}` });
        return;
      }

      const { assistantText, thoughtText, toolCalls, rawBody } = parsed;
      if (toolCalls.length === 0) {
        if (!assistantText && !thoughtText) {
          const snippet = rawBody.trim().replace(/\s+/g, " ").slice(0, 220);
          emit({
            type: "error",
            error: `网关未返回任何回复内容 (${reqRes.endpoint} · ${reqRes.contentType || "unknown"})${snippet ? `: ${snippet}` : "。请检查网关地址（是否需要 /v1）、模型名或网关日志。"}`,
          });
          return;
        }
        if (assistantText) thread.messages.push({ role: "assistant", content: assistantText });
        emit({ type: "done", stopReason: "end_turn", usage: totalUsage });
        return;
      }

      thread.messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls.map((tc, i) => ({
          id: tc.id || `call_${round}_${i}`,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        })),
      });

      for (let i = 0; i < toolCalls.length; i += 1) {
        const tc = toolCalls[i];
        const callId = tc.id || `call_${round}_${i}`;
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(tc.arguments || "{}"); } catch {}

        emit({
          type: "tool_call",
          toolCallId: callId,
          title: `${tc.name}${parsedArgs.command ? `: ${parsedArgs.command}` : ""}`,
          kind: "tool",
          status: "in_progress",
          input: formatCompact(parsedArgs),
        });

        if (approvalMode === "ask") {
          const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const allowed = await new Promise((resolve) => {
            pendingPermissions.set(requestId, resolve);
            emit({ type: "permission_request", requestId, title: tc.name, detail: formatCompact(parsedArgs) });
            if (signal) {
              signal.addEventListener("abort", () => {
                if (pendingPermissions.has(requestId)) {
                  pendingPermissions.delete(requestId);
                  resolve(false);
                }
              }, { once: true });
            }
          });
          if (!allowed) {
            emit({ type: "tool_update", toolCallId: callId, status: "failed", output: "用户拒绝执行" });
            thread.messages.push({ role: "tool", tool_call_id: callId, content: "User denied this tool execution." });
            continue;
          }
        }

        let result;
        try {
          result = await executeTool(tc.name, parsedArgs, context.colabSession, signal);
        } catch (err) {
          result = { ok: false, output: err.message || String(err) };
        }
        emit({
          type: "tool_update",
          toolCallId: callId,
          status: result.ok ? "completed" : "failed",
          output: result.output,
        });
        thread.messages.push({ role: "tool", tool_call_id: callId, content: result.output });
      }
    }
    emit({ type: "done", stopReason: "max_turns", usage: totalUsage });
  } catch (err) {
    if (signal && signal.aborted) {
      emit({ type: "done", stopReason: "cancelled", usage: totalUsage });
    } else {
      emit({ type: "error", error: err.message || String(err) });
    }
  }
}

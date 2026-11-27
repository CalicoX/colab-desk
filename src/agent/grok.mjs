import { spawn } from "node:child_process";
import {
  DEFAULT_GROK_MODELS,
  extractToolContent,
  findExecutable,
  formatCompact,
  formatToolActionTitle,
} from "./constants.mjs";
import { buildColabSystemRules, formatTurnPrompt } from "./prompts.mjs";

export function parseGrokEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = obj.type;
  if (type === "text" && typeof obj.data === "string") {
    return { type: "text", text: obj.data };
  }
  if (type === "thought" || type === "thinking" || type === "reasoning") {
    const text =
      typeof obj.data === "string"
        ? obj.data
        : typeof obj.text === "string"
          ? obj.text
          : typeof obj.data?.text === "string"
            ? obj.data.text
            : "";
    if (text) return { type: "thought", text };
    return null;
  }
  if (type === "tool_use" || type === "tool_call") {
    const rawInput = obj.rawInput ?? obj.input ?? obj.arguments ?? obj.data?.input ?? "";
    const baseName = obj.toolName || obj.name || obj.tool || obj.title || obj.data?.name || "";
    const title = formatToolActionTitle(baseName, rawInput, null);
    return {
      type: "tool_call",
      toolCallId: obj.toolCallId || obj.id || obj.tool_use_id || obj.call_id || `${baseName || "tool"}-${Date.now()}`,
      title,
      kind: obj.kind || "tool",
      status: obj.status === "completed" ? "completed" : obj.status === "failed" ? "failed" : "in_progress",
      input: formatCompact(rawInput),
    };
  }
  if (type === "tool_call_update") {
    const contentText = extractToolContent(obj.content);
    const rawOut = obj.rawOutput;
    const rawText = rawOut
      ? (typeof rawOut.output_for_prompt === "string" ? rawOut.output_for_prompt : formatCompact(rawOut))
      : "";
    const exitCode = rawOut && typeof rawOut.exit_code === "number" ? rawOut.exit_code : null;
    let status = obj.status || undefined;
    if (status === "completed" && exitCode !== null && exitCode !== 0) {
      status = "failed";
    }
    const derivedTitle = (rawOut && typeof rawOut.command === "string" && rawOut.command.trim())
      ? formatToolActionTitle("", { command: rawOut.command }, null)
      : (obj.rawInput ? formatToolActionTitle(obj.title || "", obj.rawInput, null) : (obj.title && obj.title !== "run_terminal_command" ? obj.title : undefined));
    return {
      type: "tool_update",
      toolCallId: obj.toolCallId || obj.id || obj.tool_use_id || obj.call_id || "",
      title: derivedTitle,
      status,
      output: contentText || (status === "completed" || status === "failed" ? rawText : ""),
    };
  }
  if (type === "tool_result") {
    const output = obj.output ?? obj.content ?? obj.data ?? "";
    return {
      type: "tool_update",
      toolCallId: obj.toolCallId || obj.tool_use_id || obj.call_id || obj.id || "",
      status: obj.is_error ? "failed" : "completed",
      output: formatCompact(output),
    };
  }
  if (type === "error") {
    return { type: "error", error: obj.message || obj.error || formatCompact(obj) };
  }
  if (type === "end") {
    return {
      type: "grok_end",
      sessionId: obj.sessionId || null,
      usage: obj.usage || null,
      costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null,
    };
  }
  return null;
}

export function fetchGrokModels() {
  return new Promise((resolve) => {
    const exe = findExecutable("grok");
    if (!exe) {
      resolve(DEFAULT_GROK_MODELS);
      return;
    }
    const child = spawn(exe, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(DEFAULT_GROK_MODELS);
    }, 6000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*([*-])\s+([^\s]+)(.*)$/);
        if (m) {
          const isDefault = m[1] === "*" || /\(default\)/i.test(m[3]);
          parsed.push({
            value: m[2],
            name: isDefault ? `${m[2]} (默认)` : m[2],
            isDefault,
          });
        }
      }
      if (parsed.length === 0) {
        resolve(DEFAULT_GROK_MODELS);
        return;
      }
      parsed.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      resolve(parsed.map(({ value, name }) => ({ value, name })));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(DEFAULT_GROK_MODELS);
    });
  });
}

export function runGrokTurn({
  cwd,
  threads,
  provider,
  threadKey,
  promptText,
  model,
  approvalMode,
  context,
  emit,
  signal,
}) {
  return new Promise((resolve) => {
    const exe = findExecutable("grok");
    if (!exe) {
      emit({ type: "error", error: "grok 命令未找到" });
      resolve();
      return;
    }
    const existing = threads.get(threadKey);
    const argv = [
      "--output-format",
      "streaming-json",
      "--include-partial-messages",
      "--no-memory",
      "--permission-mode",
      approvalMode === "auto" ? "bypassPermissions" : "dontAsk",
    ];
    if (approvalMode === "auto") {
      argv.push("--always-approve");
    } else {
      argv.push("--allow", "Bash(colab *)");
    }
    if (model) argv.push("-m", model);
    argv.push("--rules", buildColabSystemRules(context));
    if (existing && existing.sessionId) {
      argv.push("-r", existing.sessionId);
    }
    const formatted = formatTurnPrompt(promptText, context, false);
    argv.push("-p", formatted);

    emit({
      type: "meta",
      provider: provider.id,
      providerName: provider.name,
      model: model || DEFAULT_GROK_MODELS[0].value,
      sessionId: existing?.sessionId || null,
    });

    const child = spawn(exe, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    let stderr = "";
    let doneEmitted = false;

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 500).unref();
      } catch {}
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        emit({ type: "done", stopReason: "cancelled" });
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const ev = parseGrokEvent(obj);
        if (!ev) continue;
        if (ev.type === "grok_end") {
          if (ev.sessionId) {
            threads.set(threadKey, { sessionId: ev.sessionId, initialized: true });
          }
          doneEmitted = true;
          emit({ type: "done", stopReason: "end_turn", usage: ev.usage, costUsd: ev.costUsd });
        } else {
          emit(ev);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      emit({ type: "error", error: err.message });
      resolve();
    });

    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) {
        if (!doneEmitted) emit({ type: "done", stopReason: "cancelled" });
      } else if (code !== 0 && !doneEmitted) {
        emit({ type: "error", error: stderr.trim() || `grok 退出码 ${code}` });
      } else if (!doneEmitted) {
        emit({ type: "done", stopReason: "end_turn" });
      }
      resolve();
    });
  });
}

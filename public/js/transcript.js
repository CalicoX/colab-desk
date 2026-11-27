import { showSession } from "/desk.mjs";
import { dom } from "./dom.js";
import { desk, state } from "./state.js";
import {
  L,
  createDottedOrb,
  isImageAttachment,
  makeMiniSvg,
  openImageLightbox,
  tr,
} from "./utils.js";
import { renderMarkdownInto } from "./markdown.js";
import { emit } from "./events.js";

const thoughtDomMap = new WeakMap();
const thoughtStreamMap = new WeakMap();

export function describeToolStepTitle(tool) {
  const rawTitle = String(tool?.title || "").trim();
  const generic = !rawTitle || rawTitle === "工具调用" || rawTitle === "执行操作" || rawTitle === "run_terminal_command";
  if (!generic) return rawTitle;
  const rawIn = String(tool?.input || "").trim();
  if (rawIn) {
    if (rawIn.startsWith("{")) {
      try {
        const obj = JSON.parse(rawIn);
        const candidate = obj.command || obj.description || obj.path || obj.script || obj.code;
        if (typeof candidate === "string" && candidate.trim()) {
          const oneLine = candidate.replace(/\s+/g, " ").trim();
          return oneLine.length > 68 ? `${oneLine.slice(0, 65)}…` : oneLine;
        }
      } catch {}
    }
    const oneLine = rawIn.replace(/\s+/g, " ").trim();
    if (oneLine) return oneLine.length > 68 ? `${oneLine.slice(0, 65)}…` : oneLine;
  }
  return state.activeLang === "en" ? "Shell command" : "终端命令";
}

export function formatThoughtMetaText(entry) {
  const parts = [];
  if (entry.thinkSec != null) parts.push(`${entry.thinkSec}s`);
  if (entry.thoughtTokens) parts.push(`${entry.thoughtTokens} tok`);
  return parts.join(" · ");
}

export function syncThoughtFadeMask(body) {
  if (!body || !body.isConnected) return;
  const maxScroll = body.scrollHeight - body.clientHeight;
  body.classList.toggle("has-fade-top", maxScroll > 4 && body.scrollTop > 4);
  body.classList.toggle("has-fade-bottom", maxScroll > 4 && body.scrollTop < maxScroll - 4);
}

export function updateThoughtMetaInPlace(entry) {
  const domRef = thoughtDomMap.get(entry);
  if (!domRef || !domRef.metaEl || !domRef.metaEl.isConnected) return false;
  const text = formatThoughtMetaText(entry);
  domRef.metaEl.textContent = text;
  domRef.metaEl.hidden = !text;
  return true;
}

export function compactThoughtBody(domRef, maxLiveSpans = 34) {
  while (domRef.body.childNodes.length > maxLiveSpans + 1) {
    const oldest = domRef.settledNode.nextSibling;
    if (!oldest) break;
    domRef.settledNode.nodeValue += oldest.textContent || "";
    oldest.remove();
  }
}

export function flushThoughtStream(entry) {
  const stream = thoughtStreamMap.get(entry);
  if (stream) {
    if (stream.rafId) {
      cancelAnimationFrame(stream.rafId);
      stream.rafId = 0;
    }
    const domRef = thoughtDomMap.get(entry);
    if (stream.pending && domRef && domRef.body.isConnected) {
      compactThoughtBody(domRef, 0);
      domRef.settledNode.nodeValue += stream.pending;
      syncThoughtFadeMask(domRef.body);
    }
    stream.pending = "";
  }
  const domRef = thoughtDomMap.get(entry);
  if (domRef && domRef.body && domRef.body.isConnected) {
    domRef.body.classList.remove("is-streaming");
  }
}

export function enqueueThoughtChunk(entry, chunk) {
  if (!chunk) {
    updateThoughtMetaInPlace(entry);
    return Boolean(thoughtDomMap.get(entry)?.body?.isConnected);
  }
  let stream = thoughtStreamMap.get(entry);
  if (!stream) {
    stream = { pending: "", rafId: 0, autoFollow: true };
    thoughtStreamMap.set(entry, stream);
  }
  stream.pending += chunk;

  const domRef = thoughtDomMap.get(entry);
  if (!domRef || !domRef.body || !domRef.body.isConnected) return false;

  if (domRef.chevron && domRef.chevron.hidden) domRef.chevron.hidden = false;
  domRef.body.classList.add("is-streaming");
  updateThoughtMetaInPlace(entry);

  if (entry.thoughtOpen !== false && !domRef.wrap.classList.contains("is-open")) {
    requestAnimationFrame(() => {
      if (domRef.wrap.isConnected && entry.thoughtOpen !== false) {
        domRef.wrap.classList.add("is-open");
        domRef.trigger.setAttribute("aria-expanded", "true");
      }
    });
  }

  if (!stream.rafId) {
    const pump = () => {
      stream.rafId = 0;
      const liveDom = thoughtDomMap.get(entry);
      if (!liveDom || !liveDom.body || !liveDom.body.isConnected) return;

      if (stream.pending.length > 0) {
        let take = stream.pending.length <= 2
          ? stream.pending.length
          : Math.min(stream.pending.length, Math.max(2, Math.ceil(stream.pending.length / 7)));
        const lastCode = stream.pending.charCodeAt(take - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff && take < stream.pending.length) {
          take += 1;
        }
        const slice = stream.pending.slice(0, take);
        stream.pending = stream.pending.slice(take);

        const span = document.createElement("span");
        span.className = "thought-chunk";
        span.textContent = slice;
        liveDom.body.append(span);
        compactThoughtBody(liveDom, 34);
      }

      let stillScrolling = false;
      if (stream.autoFollow) {
        const target = Math.max(0, liveDom.body.scrollHeight - liveDom.body.clientHeight);
        const delta = target - liveDom.body.scrollTop;
        if (delta > 0.6) {
          liveDom.body.scrollTop += delta > 120 ? delta * 0.35 : Math.max(1.2, delta * 0.24);
          stillScrolling = true;
        }
        if (dom.transcript && dom.transcript.scrollHeight - dom.transcript.scrollTop - dom.transcript.clientHeight < 140) {
          dom.transcript.scrollTop = dom.transcript.scrollHeight;
        }
      }
      syncThoughtFadeMask(liveDom.body);

      if (stream.pending.length > 0 || stillScrolling) {
        stream.rafId = requestAnimationFrame(pump);
      }
    };
    stream.rafId = requestAnimationFrame(pump);
  }
  return true;
}

export async function respondPermission(entry, requestId, allow) {
  entry.permissions = (entry.permissions || []).filter((p) => p.requestId !== requestId);
  renderTranscript(desk.view || "");
  try {
    await fetch("/api/agent/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, allow }),
    });
  } catch {}
}

export function renderTranscript(key) {
  const entries = showSession(desk, key);
  const leftover = dom.empty;
  dom.transcript.replaceChildren(leftover);
  if (entries.length === 0) {
    leftover.hidden = false;
    return;
  }
  leftover.hidden = true;
  for (const entry of entries) {
    const node = document.createElement("article");
    node.className = entry.ok === false ? "entry fail" : "entry";
    node.dataset.ok = entry.ok === false ? "false" : "true";

    if (entry.kind === "agent") {
      // User bubble
      const head = document.createElement("header");
      const bubble = document.createElement("span");
      bubble.className = "bubble";
      bubble.append(document.createTextNode(entry.label));
      if (Array.isArray(entry.files) && entry.files.length > 0) {
        const imgFiles = entry.files.filter((f) => isImageAttachment(f));
        const otherFiles = entry.files.filter((f) => !isImageAttachment(f));
        if (imgFiles.length > 0) {
          const imgGrid = document.createElement("span");
          imgGrid.className = "bubble-img-grid";
          for (const f of imgFiles) {
            const src = f.previewUrl || (f.path ? `/api/image?path=${encodeURIComponent(f.path)}` : "");
            if (!src) continue;
            const img = document.createElement("img");
            img.className = "bubble-img-thumb";
            img.src = src;
            img.alt = f.name || "image";
            img.title = f.name || "image";
            img.addEventListener("click", () => openImageLightbox(src, f.name));
            imgGrid.append(img);
          }
          if (imgGrid.childNodes.length > 0) bubble.prepend(imgGrid);
        }
        if (otherFiles.length > 0) {
          const filesRow = document.createElement("span");
          filesRow.className = "bubble-files";
          for (const f of otherFiles) {
            const tag = document.createElement("span");
            tag.className = "bubble-file";
            tag.textContent = `📎 ${f.name}`;
            filesRow.append(tag);
          }
          bubble.append(filesRow);
        }
      }
      head.append(bubble);
      node.append(head);

      // Assistant block
      const block = document.createElement("div");
      block.className = "agent-block";

      const metaRow = document.createElement("div");
      metaRow.className = "agent-meta";
      const dot = document.createElement("span");
      dot.className = `agent-dot p-${entry.provider || "agy"}` + (entry.streaming ? " is-live" : "");
      const pName = document.createElement("span");
      pName.className = "agent-provider";
      pName.textContent = entry.providerName || entry.provider || "Agent";
      const mName = document.createElement("span");
      mName.textContent = entry.model ? `· ${entry.model}` : "";
      metaRow.append(dot, pName, mName);
      if (entry.streaming) {
        const live = document.createElement("span");
        live.textContent = L("· 处理中…", "· Working…");
        metaRow.append(live);
      }
      block.append(metaRow);

      const showThinkingBox = Boolean(
        entry.thought ||
        (entry.streaming && !entry.text && (!entry.tools || entry.tools.length === 0)) ||
        entry.thoughtTokens > 0,
      );
      if (showThinkingBox) {
        const isActivelyThinking = Boolean(entry.streaming && !entry.text);
        const shouldBeOpen = entry.thoughtOpen !== undefined
          ? Boolean(entry.thoughtOpen)
          : Boolean(isActivelyThinking && entry.thought);
        const firstReveal = !entry._thoughtRevealed;
        entry._thoughtRevealed = true;

        const wrap = document.createElement("div");
        wrap.className = "agent-thought" + (shouldBeOpen ? " is-open" : "") + (firstReveal ? " is-entering" : "");

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "thought-trigger";
        trigger.setAttribute("aria-expanded", shouldBeOpen ? "true" : "false");
        trigger.append(createDottedOrb(18, isActivelyThinking));

        const labelEl = document.createElement("span");
        labelEl.className = "thought-label" + (isActivelyThinking ? " is-thinking" : "");
        if (isActivelyThinking) {
          labelEl.textContent = state.activeLang === "en" ? "Thinking…" : "思考中…";
        } else {
          labelEl.textContent = state.activeLang === "en" ? "Thought" : "思考过程";
        }
        trigger.append(labelEl);

        const metaEl = document.createElement("span");
        metaEl.className = "thought-meta";
        const metaText = formatThoughtMetaText(entry);
        metaEl.textContent = metaText;
        metaEl.hidden = !metaText;
        trigger.append(metaEl);

        const chevron = makeMiniSvg('<polyline points="9 6 15 12 9 18" />', "thought-chevron");
        chevron.hidden = !entry.thought;
        trigger.append(chevron);

        trigger.addEventListener("click", () => {
          if (!entry.thought) return;
          const nextOpen = !wrap.classList.contains("is-open");
          entry.thoughtOpen = nextOpen;
          wrap.classList.toggle("is-open", nextOpen);
          trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
          if (nextOpen) requestAnimationFrame(() => syncThoughtFadeMask(body));
        });
        wrap.append(trigger);

        const collapse = document.createElement("div");
        collapse.className = "thought-collapse";
        const inner = document.createElement("div");
        inner.className = "thought-collapse-inner";
        const body = document.createElement("div");
        body.className = "thought-body" + (isActivelyThinking && entry.thought ? " is-streaming" : "");
        const streamState = thoughtStreamMap.get(entry);
        const pendingLen = streamState && streamState.pending ? streamState.pending.length : 0;
        const settledText = pendingLen > 0 && pendingLen <= (entry.thought || "").length
          ? (entry.thought || "").slice(0, entry.thought.length - pendingLen)
          : (entry.thought || "");
        const settledNode = document.createTextNode(settledText);
        body.append(settledNode);
        body.addEventListener("scroll", () => {
          syncThoughtFadeMask(body);
          const s = thoughtStreamMap.get(entry);
          if (s) {
            s.autoFollow = (body.scrollHeight - body.scrollTop - body.clientHeight) < 40;
          }
        }, { passive: true });
        inner.append(body);
        collapse.append(inner);
        wrap.append(collapse);

        thoughtDomMap.set(entry, { wrap, trigger, labelEl, metaEl, chevron, collapse, body, settledNode });
        if (shouldBeOpen && entry.thought) {
          requestAnimationFrame(() => {
            if (isActivelyThinking) body.scrollTop = body.scrollHeight;
            syncThoughtFadeMask(body);
          });
        }
        block.append(wrap);
      }

      if (Array.isArray(entry.tools) && entry.tools.length > 0) {
        const group = document.createElement("div");
        group.className = "tool-group";

        for (const tool of entry.tools) {
          const step = document.createElement("details");
          step.className = "tool-step";
          step.open = Boolean(tool._open);
          step.addEventListener("toggle", () => {
            tool._open = step.open;
          });
          const sum = document.createElement("summary");
          const isRunning = tool.status !== "completed" && tool.status !== "failed";
          const isFailed = tool.status === "failed";
          if (isRunning) {
            sum.append(createDottedOrb(16, true));
          } else if (isFailed) {
            sum.append(makeMiniSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "tool-step-ico is-fail"));
          } else {
            sum.append(makeMiniSvg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', "tool-step-ico is-ok"));
          }
          const tTitle = document.createElement("span");
          tTitle.className = "tool-title" + (isFailed ? " is-fail" : "");
          tTitle.textContent = describeToolStepTitle(tool);
          sum.append(tTitle);
          if (isRunning || isFailed) {
            const stText = document.createElement("span");
            stText.className = "tool-step-status" + (isFailed ? " is-fail" : "");
            stText.textContent = isFailed
              ? (state.activeLang === "en" ? "failed" : "失败")
              : (state.activeLang === "en" ? "running…" : "运行中…");
            sum.append(stText);
          }
          step.append(sum);

          if (tool.input || tool.output) {
            const body = document.createElement("div");
            body.className = "tool-body";
            if (tool.input) {
              const preIn = document.createElement("pre");
              preIn.textContent = tool.input;
              body.append(preIn);
            }
            if (tool.output) {
              const preOut = document.createElement("pre");
              preOut.textContent = tool.output;
              body.append(preOut);
            }
            step.append(body);
          }
          group.append(step);
        }
        block.append(group);
      }

      if (Array.isArray(entry.permissions) && entry.permissions.length > 0) {
        for (const perm of entry.permissions) {
          const pCard = document.createElement("div");
          pCard.className = "perm-card";
          const pHead = document.createElement("div");
          pHead.className = "perm-head";
          pHead.textContent = L(`请求确认：${perm.title}`, `Approval requested: ${perm.title}`);
          pCard.append(pHead);
          if (perm.detail) {
            const pDet = document.createElement("div");
            pDet.className = "perm-detail";
            pDet.textContent = perm.detail;
            pCard.append(pDet);
          }
          const pActs = document.createElement("div");
          pActs.className = "perm-actions";
          const allowBtn = document.createElement("button");
          allowBtn.type = "button";
          allowBtn.className = "perm-allow";
          allowBtn.textContent = L("允许执行", "Allow");
          allowBtn.addEventListener("click", () => respondPermission(entry, perm.requestId, true));
          const denyBtn = document.createElement("button");
          denyBtn.type = "button";
          denyBtn.className = "perm-deny";
          denyBtn.textContent = L("拒绝", "Deny");
          denyBtn.addEventListener("click", () => respondPermission(entry, perm.requestId, false));
          pActs.append(allowBtn, denyBtn);
          pCard.append(pActs);
          block.append(pCard);
        }
      }

      if (entry.error) {
        const errEl = document.createElement("p");
        errEl.className = "error";
        errEl.textContent = entry.error;
        block.append(errEl);
        if (entry.authRequired) {
          const authBtn = document.createElement("button");
          authBtn.type = "button";
          authBtn.className = "s-btn is-primary";
          authBtn.style.alignSelf = "flex-start";
          authBtn.textContent = tr("agent.authRequiredAction");
          authBtn.addEventListener("click", () => emit("ui:open-settings", "providers"));
          block.append(authBtn);
        }
      }

      if (entry.text) {
        const prose = document.createElement("div");
        prose.className = "agent-prose";
        renderMarkdownInto(prose, entry.text);
        block.append(prose);
      }

      node.append(block);
      dom.transcript.append(node);
      continue;
    }

    // Standard CLI entry
    const head = document.createElement("header");
    const bubble = document.createElement("span");
    bubble.className = "bubble";
    bubble.textContent = entry.label;
    head.append(bubble);
    node.append(head);
    if (entry.argv && entry.argv.length) {
      const cmdLine = document.createElement("p");
      cmdLine.className = "entry-argv";
      cmdLine.textContent = `$ colab ${entry.argv.join(" ")}`;
      node.append(cmdLine);
    }
    if (!entry.ok && entry.error) {
      const error = document.createElement("p");
      error.className = "error";
      error.textContent = entry.error;
      node.append(error);
    }
    if (entry.text) {
      const pre = document.createElement("pre");
      pre.textContent = entry.text;
      node.append(pre);
    }
    dom.transcript.append(node);
  }
  dom.transcript.scrollTop = dom.transcript.scrollHeight;
}

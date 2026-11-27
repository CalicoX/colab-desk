import { state } from "./state.js";
import { L, escapeHtml, showToast, tr } from "./utils.js";
import { addNotebookCell } from "./notebook.js";
import { setComposerMode } from "./composer.js";
import { callAction } from "./sessions.js";

/* ── Safe Markdown + Plot Image Renderer ── */
export function renderInlineMarkdown(line) {
  let s = escapeHtml(line);
  // Markdown image pointing to colab-desk-images
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    if (src.includes("colab-desk-images")) {
      return `<img class="agent-plot" src="/api/image?path=${encodeURIComponent(src)}" alt="${alt || "plot"}" />`;
    }
    return escapeHtml(alt || src);
  });
  // Inline code
  s = s.replace(/`([^`]+)`/g, (_, inner) => {
    if (/colab-desk-images\/[^\s]+\.(png|jpe?g|webp)$/i.test(inner)) {
      return `<code>${inner}</code><img class="agent-plot" src="/api/image?path=${encodeURIComponent(inner)}" alt="plot" />`;
    }
    return `<code>${inner}</code>`;
  });
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Links
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s;
}

export function renderMarkdownInto(container, markdown) {
  const text = String(markdown || "");
  const blocks = text.split(/```/);
  const htmlParts = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (i % 2 === 1) {
      const lines = blocks[i].split("\n");
      const lang = (lines[0] || "").trim().slice(0, 24);
      const body = (lang ? lines.slice(1) : lines).join("\n").replace(/\n$/, "");
      const safeLang = escapeHtml(lang || "code");
      htmlParts.push(
        `<div class="code-wrap"><div class="code-head"><span>${safeLang}</span><div class="code-head-actions"><button type="button" class="code-run" data-lang="${safeLang}">${L("▶ 运行", "▶ Run")}</button><button type="button" class="code-to-nb" data-lang="${safeLang}">${tr("nb.insertToNotebook")}</button><button type="button" class="code-copy">${L("复制", "Copy")}</button></div></div><pre><code>${escapeHtml(body)}</code></pre></div>`,
      );
      continue;
    }
    const lines = blocks[i].split("\n");
    let inUl = false;
    let inOl = false;
    const closeLists = () => {
      if (inUl) { htmlParts.push("</ul>"); inUl = false; }
      if (inOl) { htmlParts.push("</ol>"); inOl = false; }
    };
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) {
        closeLists();
        continue;
      }
      const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        closeLists();
        const level = hMatch[1].length;
        htmlParts.push(`<h${level}>${renderInlineMarkdown(hMatch[2])}</h${level}>`);
        continue;
      }
      const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (ulMatch) {
        if (inOl) { htmlParts.push("</ol>"); inOl = false; }
        if (!inUl) { htmlParts.push("<ul>"); inUl = true; }
        htmlParts.push(`<li>${renderInlineMarkdown(ulMatch[1])}</li>`);
        continue;
      }
      const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (olMatch) {
        if (inUl) { htmlParts.push("</ul>"); inUl = false; }
        if (!inOl) { htmlParts.push("<ol>"); inOl = true; }
        htmlParts.push(`<li>${renderInlineMarkdown(olMatch[1])}</li>`);
        continue;
      }
      closeLists();
      htmlParts.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
    }
    closeLists();
  }
  container.innerHTML = htmlParts.join("");
  container.querySelectorAll(".code-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const codeEl = btn.closest(".code-wrap")?.querySelector("code");
      if (!codeEl) return;
      try {
        await navigator.clipboard.writeText(codeEl.textContent || "");
        btn.textContent = L("已复制", "Copied");
        setTimeout(() => { btn.textContent = L("复制", "Copy"); }, 1400);
      } catch {}
    });
  });
  container.querySelectorAll(".code-to-nb").forEach((btn) => {
    btn.addEventListener("click", () => {
      const codeEl = btn.closest(".code-wrap")?.querySelector("code");
      if (!codeEl) return;
      const src = codeEl.textContent || "";
      const lang = String(btn.dataset.lang || "").toLowerCase();
      const finalCode = ["bash", "sh", "shell", "zsh"].includes(lang)
        ? src.split("\n").map((l) => (l.trim() && !l.trim().startsWith("#") ? `!${l}` : l)).join("\n")
        : src;
      addNotebookCell("code", finalCode);
      setComposerMode("notebook");
      showToast(L("已插入到 Notebook 单元格", "Inserted into Notebook cell"));
    });
  });
  container.querySelectorAll(".code-run").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!state.selected) {
        showToast(state.activeLang === "en" ? "Connect to a Colab VM first" : "请先连接一台 Colab 虚拟机");
        return;
      }
      const codeEl = btn.closest(".code-wrap")?.querySelector("code");
      if (!codeEl) return;
      const src = codeEl.textContent || "";
      const lang = String(btn.dataset.lang || "").toLowerCase();
      const isShell = ["bash", "sh", "shell", "zsh"].includes(lang);
      btn.disabled = true;
      btn.textContent = L("运行中…", "Running…");
      try {
        if (isShell) {
          await callAction({ type: "ssh", session: state.selected, command: src }, `ssh ${state.selected}`, state.selected);
        } else {
          await callAction({ type: "exec", session: state.selected, code: src }, `exec ${state.selected}`, state.selected);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = L("▶ 运行", "▶ Run");
      }
    });
  });
}

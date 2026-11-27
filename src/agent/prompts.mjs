import fs from "node:fs";
import path from "node:path";
import { IMAGE_DIR, IMAGE_EXT_MIME, UPLOAD_DIR } from "./constants.mjs";
import { resolveSystemTemplateText } from "./templates.mjs";

export function buildColabSystemRules(context = {}) {
  const session = context.colabSession || null;
  const sessionInfo = context.sessionInfo || null;
  const lines = [
    "你正在 Colab Desk 桌面应用中协助一位不熟悉编程和命令行操作的用户操控 Google Colab 云端算力。",
    "所有对远程 Colab 虚拟机的操作都必须通过本机已安装的官方 `colab` CLI 完成（禁止自己编造或重写 Colab API）。",
    "",
    "核心规则：",
    "1. 默认用简洁易懂的中文向用户汇报结果和下一步建议，避免堆砌晦涩术语。",
  ];

  if (session) {
    const hw = sessionInfo?.hardware ? `，硬件：${sessionInfo.hardware}` : "";
    const shape = sessionInfo?.shape ? `，规格：${sessionInfo.shape}` : "";
    lines.push(`2. 当前选中的 Colab 会话名是 \`${session}\`${hw}${shape}。所有 \`colab\` 命令务必带上 \`-s ${session}\`（如 \`colab exec -s ${session}\`、\`colab ssh -s ${session} -- <cmd>\`、\`colab install -s ${session} <pkg>\`、\`colab ls -s ${session}\`、\`colab upload -s ${session} <local> <remote>\`、\`colab download -s ${session} <remote> <local>\`）。`);
  } else {
    lines.push("2. 当前没有选中的活跃 Colab 会话。如果需要执行远程代码，先运行 `colab sessions` 检查；如无会话，提示用户点击界面「新建会话」按钮（不要擅自 `colab new` 产生计费，除非用户明确要求创建）。");
  }

  lines.push(
    "3. 执行 Python 代码优先用 `colab exec -s <name>`（通过 stdin 或 `-f` 本地文件）；内核状态在多次 `exec` 间持久保留，默认工作目录为 `/content`。",
    `4. 如果代码生成图表/图片，请使用 \`colab exec -s <name> --output-image ${IMAGE_DIR}/plot_<timestamp>.png\` 保存图片，并在最终回复里用 Markdown 图片或原样路径给出该 \`${IMAGE_DIR}/...\` 路径，界面会自动内嵌显示图片。`,
    "5. 计费与安全护栏：除非用户明确要求，严禁主动执行 `colab new`（会产生计费）、`colab stop`（会销毁虚拟机）或 `colab rm`（会删除云端文件）。",
  );

  const tpl = resolveSystemTemplateText(context);
  if (tpl && tpl.content) {
    const header = tpl.name
      ? `\n\n[当前会话系统提示词模板：${tpl.name}]`
      : "\n\n[当前会话系统提示词模板]";
    lines.push(`${header}\n${tpl.content}`);
  }
  return lines.join("\n");
}

export function inferImageMime(filePath, explicitMime = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (IMAGE_EXT_MIME[ext]) return IMAGE_EXT_MIME[ext];
  const clean = String(explicitMime || "").split(";")[0].trim().toLowerCase();
  return clean.startsWith("image/") ? clean : null;
}

export function loadImageAttachments(files = [], maxBytes = 15_000_000, maxCount = 6) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const allowedRoots = [
    path.resolve(UPLOAD_DIR) + path.sep,
    path.resolve(IMAGE_DIR) + path.sep,
  ];
  const out = [];
  for (const f of files) {
    if (out.length >= maxCount) break;
    if (!f || !f.path) continue;
    const mimeType = inferImageMime(f.path, f.mimeType);
    if (!mimeType) continue;
    const resolved = path.resolve(String(f.path));
    if (!allowedRoots.some((root) => resolved.startsWith(root))) continue;
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile() || st.size <= 0 || st.size > maxBytes) continue;
      const base64 = fs.readFileSync(resolved).toString("base64");
      out.push({ name: f.name || path.basename(resolved), path: resolved, mimeType, base64 });
    } catch {}
  }
  return out;
}

export function buildOpenAiUserContent(text, files = []) {
  const images = loadImageAttachments(files);
  if (images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ];
}

export function formatTurnPrompt(prompt, context = {}, includeRules = true) {
  const parts = [];
  if (includeRules) {
    parts.push(`[Colab Desk 上下文]\n${buildColabSystemRules(context)}`);
  } else if (context.colabSession) {
    parts.push(`[当前 Colab 会话: ${context.colabSession}${context.sessionInfo?.hardware ? ` (${context.sessionInfo.hardware})` : ""}]`);
  }
  if (Array.isArray(context.files) && context.files.length > 0) {
    const fileLines = context.files.map((f) => {
      const kindTag = inferImageMime(f.path || f.name, f.mimeType) ? "[图片]" : "[文件]";
      return `- ${kindTag} ${f.name}: ${f.path}`;
    });
    parts.push(`[用户附加的图片 / 本地文件（图片已随消息附带，也可用 colab upload 上传到云端）]\n${fileLines.join("\n")}`);
  }
  parts.push(`[用户消息]\n${prompt}`);
  return parts.join("\n\n");
}

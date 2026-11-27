import { loadAgentx, saveAgentx } from "./agentx-store.mjs";

export const BUILTIN_TEMPLATES = [
  {
    id: "builtin:gpu-training",
    builtin: true,
    name: "GPU 训练助手",
    nameEn: "GPU Training Assistant",
    description: "专注 PyTorch / CUDA 训练监控、显存优化、混合精度与断点续训。",
    descriptionEn: "Focused on PyTorch/CUDA training, VRAM optimization, mixed precision, and checkpointing.",
    content: [
      "你是一位资深深度学习与 GPU 训练工程师。",
      "- 执行训练前先检查 GPU 型号、显存余量（nvidia-smi）与磁盘空间，给出合理的 batch size、梯度累积与 AMP (bf16/fp16) 建议。",
      "- 优先使用断点续训（checkpoint）并定期保存到持久化目录（如 Google Drive），避免 Colab 回收导致进度丢失。",
      "- 遇到 OOM 或梯度爆炸时，先定位原因再给出最小改动修复方案。",
    ].join("\n"),
    contentEn: [
      "You are a senior deep learning and GPU training engineer.",
      "- Before launching training, check GPU model, free VRAM (nvidia-smi), and disk space; recommend safe batch size, gradient accumulation, and AMP (bf16/fp16).",
      "- Prefer checkpointing to persistent storage (e.g. Google Drive) to survive Colab runtime recycling.",
      "- On OOM or NaN loss, diagnose root cause first and propose the smallest targeted fix.",
    ].join("\n"),
  },
  {
    id: "builtin:diffusion-comfyui",
    builtin: true,
    name: "Diffusion / ComfyUI 运维助手",
    nameEn: "Diffusion / ComfyUI Operator",
    description: "管理 Stable Diffusion / Flux / ComfyUI 模型权重、自定义节点与隧道端口。",
    descriptionEn: "Manage Stable Diffusion, Flux, ComfyUI checkpoints, custom nodes, and WebUI tunnels.",
    content: [
      "你是一位熟悉 Stable Diffusion / Flux / ComfyUI 的云端运维专家。",
      "- 下载模型与 LoRA 时优先使用 `hf_transfer` / `aria2c` 或断点续传，并注意检查 `/content` 剩余磁盘空间。",
      "- 安装自定义节点（custom_nodes）后验证依赖冲突，启动 WebUI/ComfyUI 时明确告知监听端口并提示通过隧道访问。",
      "- 生成样图后用 `--output-image` 或本地路径回报，便于界面直接预览。",
    ].join("\n"),
    contentEn: [
      "You are a cloud operator specializing in Stable Diffusion, Flux, and ComfyUI.",
      "- Download checkpoints/LoRAs with resumable tools (`hf_transfer`/`aria2c`) while monitoring `/content` free disk space.",
      "- Verify dependency conflicts after installing custom nodes, and clearly report the listening port for tunnel access.",
      "- Return generated preview images via `--output-image` or saved paths so the UI renders them inline.",
    ].join("\n"),
  },
  {
    id: "builtin:data-analysis",
    builtin: true,
    name: "数据分析助手",
    nameEn: "Data Analysis Assistant",
    description: "面向 Pandas / Polars / DuckDB / Matplotlib 的数据清洗、统计分析与可视化。",
    descriptionEn: "Data cleaning, exploratory analysis, and visualization with Pandas, Polars, DuckDB, and Matplotlib.",
    content: [
      "你是一位严谨的数据科学家与可视化分析师。",
      "- 读取数据后先输出行数、列类型、缺失值与异常值概览，再进行清洗与建模。",
      "- 绘图时设置清晰的标题、坐标轴标签、图例与高 DPI，并使用 `--output-image` 输出图表。",
      "- 用通俗结论总结关键发现，给出可复现的统计口径与下一步分析建议。",
    ].join("\n"),
    contentEn: [
      "You are a rigorous data scientist and visualization analyst.",
      "- Start by profiling row count, dtypes, missing values, and outliers before cleaning or modeling.",
      "- Produce clean charts with clear titles, axis labels, legends, and high DPI via `--output-image`.",
      "- Summarize key findings in plain language with reproducible metrics and next-step recommendations.",
    ].join("\n"),
  },
  {
    id: "builtin:concise-reviewer",
    builtin: true,
    name: "精简代码评审",
    nameEn: "Concise Reviewer",
    description: "直击重点的代码与实验审查：只报高价值缺陷、风险与最小补丁。",
    descriptionEn: "High-signal code and experiment review: report bugs, risks, and minimal patches concisely.",
    content: [
      "你是一位直接、克制的高级代码评审员。",
      "- 回复尽量简短，优先列出阻塞性缺陷、正确性隐患、性能瓶颈与安全问题，跳过客套话。",
      "- 每条意见给出具体位置、原因和最小改动建议。",
      "- 如无明显问题，直接说明已验证点与剩余风险。",
    ].join("\n"),
    contentEn: [
      "You are a concise, high-signal senior code reviewer.",
      "- Keep responses brief; prioritize correctness bugs, performance bottlenecks, and security risks over style nitpicks.",
      "- For each finding, state location, root cause, and the minimal fix.",
      "- If no major issues are found, state what was verified and any residual risks.",
    ].join("\n"),
  },
];

export function listTemplates() {
  const data = loadAgentx();
  const custom = Array.isArray(data.templates)
    ? data.templates.map((t) => ({ ...t, builtin: false }))
    : [];
  return [...BUILTIN_TEMPLATES, ...custom];
}

export function getTemplate(id) {
  if (!id) return null;
  return listTemplates().find((t) => t.id === id) || null;
}

export function createTemplate(input = {}) {
  const name = String(input.name || "").trim().slice(0, 80);
  const content = String(input.content || "").trim().slice(0, 8000);
  if (!name) throw new Error("Template name is required");
  if (!content) throw new Error("Template prompt content is required");
  const data = loadAgentx();
  const tpl = {
    id: `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    builtin: false,
    name,
    nameEn: String(input.nameEn || name).trim().slice(0, 80),
    description: String(input.description || "").trim().slice(0, 200),
    descriptionEn: String(input.descriptionEn || input.description || "").trim().slice(0, 200),
    content,
    contentEn: String(input.contentEn || content).trim().slice(0, 8000),
    updatedAt: Date.now(),
  };
  data.templates = [...(data.templates || []), tpl];
  saveAgentx(data);
  return tpl;
}

export function updateTemplate(id, patch = {}) {
  if (!id || String(id).startsWith("builtin:")) {
    throw new Error("Built-in templates cannot be modified");
  }
  const data = loadAgentx();
  const idx = (data.templates || []).findIndex((t) => t.id === id);
  if (idx < 0) throw new Error("Template not found");
  const prev = data.templates[idx];
  const nextName = patch.name != null ? String(patch.name).trim().slice(0, 80) : prev.name;
  const nextContent = patch.content != null ? String(patch.content).trim().slice(0, 8000) : prev.content;
  if (!nextName) throw new Error("Template name is required");
  if (!nextContent) throw new Error("Template prompt content is required");
  const updated = {
    ...prev,
    name: nextName,
    nameEn: patch.nameEn != null ? String(patch.nameEn).trim().slice(0, 80) : (prev.nameEn || nextName),
    description: patch.description != null ? String(patch.description).trim().slice(0, 200) : prev.description,
    descriptionEn: patch.descriptionEn != null ? String(patch.descriptionEn).trim().slice(0, 200) : (prev.descriptionEn || prev.description),
    content: nextContent,
    contentEn: patch.contentEn != null ? String(patch.contentEn).trim().slice(0, 8000) : (prev.contentEn || nextContent),
    updatedAt: Date.now(),
  };
  data.templates[idx] = updated;
  saveAgentx(data);
  return updated;
}

export function deleteTemplate(id) {
  if (!id || String(id).startsWith("builtin:")) {
    throw new Error("Built-in templates cannot be deleted");
  }
  const data = loadAgentx();
  const prevLen = (data.templates || []).length;
  data.templates = (data.templates || []).filter((t) => t.id !== id);
  if (data.templates.length === prevLen) throw new Error("Template not found");
  for (const [k, v] of Object.entries(data.assignments || {})) {
    if (v === id) delete data.assignments[k];
  }
  saveAgentx(data);
  return true;
}

export function getAssignments() {
  return { ...(loadAgentx().assignments || {}) };
}

export function getAssignedTemplateId(scopeKey) {
  if (!scopeKey) return "";
  return loadAgentx().assignments?.[String(scopeKey)] || "";
}

export function setAssignedTemplate(scopeKey, templateId) {
  const key = String(scopeKey || "").trim();
  if (!key) throw new Error("scopeKey is required");
  const tid = String(templateId || "").trim();
  if (tid && !getTemplate(tid)) throw new Error("Template not found");
  const data = loadAgentx();
  data.assignments = data.assignments || {};
  if (tid) data.assignments[key] = tid;
  else delete data.assignments[key];
  saveAgentx(data);
  return { scopeKey: key, templateId: tid };
}

export function resolveSystemTemplateText(context = {}) {
  const lang = context.lang === "en" ? "en" : "zh-CN";
  if (typeof context.systemTemplate === "string" && context.systemTemplate.trim()) {
    return { name: "", content: context.systemTemplate.trim() };
  }
  if (context.systemTemplate && typeof context.systemTemplate === "object") {
    const t = context.systemTemplate;
    const content = (lang === "en" ? t.contentEn || t.content : t.content || t.contentEn) || "";
    const name = (lang === "en" ? t.nameEn || t.name : t.name || t.nameEn) || "";
    if (content.trim()) return { name: name.trim(), content: content.trim() };
  }
  const tid =
    context.templateId ||
    getAssignedTemplateId(context.threadId) ||
    getAssignedTemplateId(context.colabSession) ||
    "";
  if (!tid) return null;
  const tpl = getTemplate(tid);
  if (!tpl) return null;
  const content = (lang === "en" ? tpl.contentEn || tpl.content : tpl.content || tpl.contentEn) || "";
  const name = (lang === "en" ? tpl.nameEn || tpl.name : tpl.name || tpl.nameEn) || "";
  return content.trim() ? { id: tpl.id, name: name.trim(), content: content.trim() } : null;
}

<div align="center">

# Colab Desk

**基于官方 [`google-colab-cli`](https://pypi.org/project/google-colab-cli/)（`colab`）打造的轻量级 macOS 原生桌面工作台与本地 Web 应用。**

零运行时 npm 依赖 · 离线可用 · 中英双语界面

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![CI](https://github.com/CalicoX/colab-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/CalicoX/colab-desk/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/CalicoX/colab-desk?label=macOS%20App)](https://github.com/CalicoX/colab-desk/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20Apple%20Silicon-black.svg)](https://github.com/CalicoX/colab-desk/releases)

</div>

---

Colab Desk 将官方 `google-colab-cli`（`colab` 命令行）封装为完整的 GPU/TPU 可视化工作台。你可以用 **AI Agent**、**零 Agent 参数化直跑脚本器**、**手动 CLI 命令**，或 **完整交互式 PTY 终端 / 分屏视图** 驱动 Google Colab 云端算力——无需死记命令参数，也不私自魔改 Google 运行时协议。

## 目录

- [核心功能](#核心功能)
- [快速开始](#快速开始)
- [常用场景指南](#常用场景指南)
- [快捷键速查](#快捷键速查)
- [项目架构](#项目架构)
- [隐私与安全](#隐私与安全)
- [开源协议](#开源协议)

## 核心功能

### 多 Agent 协同中心（有无本地 CLI 均可使用）
- **AGY（`agy acp`）**：原生接入 Antigravity ACP 协议，支持官方 OAuth/企业登录、实时套餐等级识别、模型选择、思考深度（`Low / Medium / High / Extra`）以及实时配额监控。
- **Grok（`grok`）**：流式 NDJSON 对话、思考过程实时展示与每周真实额度查询。
- **OpenCode（`opencode acp`）**：原生 ACP 协议接入，支持近 30 天与累计 Token / 费用统计。
- **自定义 OpenAI 兼容 API 配置**：即使**本机没装任何 Agent CLI**也能直接用——支持保存多套配置（OpenAI、DeepSeek、OpenRouter、Gemini、本地 Ollama 等）并内置 Colab 工具调用。
- **代码块一键运行**：Agent 回复中的每个 Markdown 代码块都自带 **`▶ 运行`** 按钮（Bash/Shell 自动走 `colab ssh`，Python 自动走 `colab exec`）。

### 零 Agent 参数化脚本直跑器（Direct Runner）
- 直接通过官方 `colab exec` / `colab ssh` 在 Colab VM 上运行 Python 或 Bash 推理/部署脚本，**完全不经过任何云端大模型审查**。
- 内置 **ComfyUI 一键部署**、**Diffusers / 通用图生视频推理模板** 与 **自定义脚本**。
- 自动解析脚本中的 `{{param}}` 占位符生成交互表单，自动注入环境变量保险箱（`ENV` + `COLAB_PARAM_*`），并自动抓取输出路径中的图片/视频在界面内联预览。

### 交互式 Colab 终端 & 分屏模式（`⌘J`）
- 仅在成功连接 Colab VM 后自动显示（严格限定为远程 Colab VM 会话，不暴露本地宿主机终端）。
- 一键切换 **对话 | 分屏（对话 + 终端） | 终端** 三种视图。
- 基于本地打包的 `xterm.js` + WebSocket POSIX PTY（`colab ssh -s <session>`），支持多标签页、窗口自适应缩放（`SIGWINCH`）、历史回滚重放、完整 TUI 工具（`vim`、`htop`、`nvidia-smi`、`claude`、`agy`、`opencode`），以及 **「发给 Agent」** 按钮（一键抓取终端最近 50 行输出填入输入框排错）。

### 实时 GPU / 显存监控、进程强杀 & 端口自动探测
- 右侧可折叠检查器（`⌘.`）实时轮询 `nvidia-smi`（显存占用、GPU 利用率、温度），可在 **设置 → 通用** 开关自动轮询。
- **GPU 计算进程列表**：查看每个进程的 PID 与显存占用，支持 **一键强杀（Kill）** 释放卡死显存。
- **Web 端口自动探测 + 快捷预设**：自动探测 VM 上正在监听的 TCP 端口并显示为可点击芯片，点一下即可通过 `colab ssh --proxy-mode` 建立隧道并在浏览器打开；同时内置 **ComfyUI（`:8188`）**、**Gradio（`:7860`）**、**Jupyter（`:8888`）**、**Ollama（`:11434`）**、**vLLM（`:8000`）**、**TensorBoard（`:6006`）** 预设。

### 云端文件浏览器 & 媒体画廊
- 可视化浏览 `/content` 与 Google Drive（`/content/drive/MyDrive`），支持 **列表 / 媒体画廊** 双视图切换。
- 支持 **MP4 / WebM / MOV 视频内联流式播放**（HTTP `206 Range` 拖拽进度条）、图片/文本预览、多选 **批量下载**、**一键转存到 Google Drive**、拖拽上传，以及 **「发给 Agent 分析」**。

### 环境变量保险箱、自动初始化 & 本地 ↔ 云端目录同步
- **环境变量保险箱（`0600` 权限）**：本地加密目录存储 `HF_TOKEN`、`CIVITAI_API_KEY`、`WANDB_API_KEY` 等，自动写入云端 `/etc/profile.d/colab-desk-env.sh` 与 `/root/.bashrc`。
- **新会话自动初始化（Auto-Bootstrap）**：新建 VM 后自动（或随时手动）挂载 Google Drive、开启 `hf_transfer` 加速、将 `HF_HOME` 模型缓存持久化到 Google Drive、安装 `uv` 并执行自定义启动 Bash 脚本。
- **本地 ↔ 云端项目目录双向同步**：绑定本地代码目录 ↔ `/content/...`，通过 `tar.gz` + `colab upload`/`download`/`ssh` 一键推送或拉回（自动忽略 `.git`、`node_modules`、`__pycache__`、`.DS_Store`、`.venv`、`dist`）。

### 原生 macOS 桌面体验
- 分类式 **设置中心**（支持 `/` 实时搜索）、**深色 / 浅色 / 跟随系统** 主题同步、**跟随系统 / 中文 / English** 语言切换、**全局命令面板（`⌘K`）**、`.ipynb` / `.md` 对话导出、Prompt 模板库、应用内 **检查更新**（设置 → 关于）。
- 内置 `colab` CLI 环境体检、一键 `uv`/`pip3` 安装与 OAuth 登录引导。

---

## 快速开始

### 环境要求

- **macOS（Apple Silicon）** 可直接运行预构建桌面 App；运行 Web 版需 **Node.js 20+** 与 **Python 3**
- **[`google-colab-cli`](https://pypi.org/project/google-colab-cli/)**（`colab` 命令行，也可直接在 **设置 → Colab CLI** 中一键安装并登录）

### 方式一：直接下载预构建 macOS App（推荐）

1. 前往 [GitHub Releases](https://github.com/CalicoX/colab-desk/releases) 下载 **`Colab-Desk-macOS-arm64.zip`**（或仓库内的 [`dist/Colab-Desk-macOS-arm64.zip`](./dist/Colab-Desk-macOS-arm64.zip)）。
2. 解压并将 **`Colab Desk.app`** 拖入 `/Applications`。
3. 由于使用本地 ad-hoc 签名，首次打开若 macOS 提示无法验证开发者，执行以下命令即可：
   ```bash
   xattr -cr "/Applications/Colab Desk.app"
   ```
   *（或右键 `Colab Desk.app` → **打开**。）*

### 方式二：作为本地 Web 应用运行

```bash
git clone https://github.com/CalicoX/colab-desk.git
cd colab-desk
npm start
```

默认打开 `http://127.0.0.1:4173`（可通过环境变量 `PORT` 修改端口）。

### 方式三：从源码构建并启动 macOS App

```bash
npm run app
```

自动编译 `macos/ColabDesk.swift` 生成 `dist/Colab Desk.app`、从 `macos/AppIcon.png` 生成圆角图标、ad-hoc 签名、打包 `dist/Colab-Desk-macOS-arm64.zip` 并启动应用。如需仅打包不启动，可加 `COLAB_DESK_NO_LAUNCH=1`。

### 运行单元测试

```bash
npm test
```

---

## 常用场景指南

### 1. 零 Agent 直跑生图 / 生视频脚本与 ComfyUI

1. 连接一个 GPU 会话（如 `T4`、`L4`、`A100`）。
2. 点击顶部工具栏 **直跑脚本**（或按 `⌘K` 搜索「直跑脚本」）。
3. 选择内置模板，或编写带 `{{参数名}}` 占位符的 Python / Bash 脚本：
   ```python
   prompt = "{{prompt}}"
   steps = int("{{steps}}")
   out_path = "/content/output.png"
   # ... 在 Colab GPU 上直接执行推理 ...
   print(out_path)
   ```
4. 在自动生成的表单里填参数并点击 **运行**。脚本打印出的 `/content/*.png|jpg|webp|mp4|webm|mov` 路径会自动在结果区渲染内联预览和下载按钮。

### 2. ComfyUI / WebUI 一键端口转发

- 在 Colab 上启动 ComfyUI（`:8188`）、Gradio（`:7860`）或任意 Web 服务后，右侧检查器（`⌘.`）会自动探测监听端口并展示可点击芯片，点一下即可通过 `colab ssh --proxy-mode` 转发到本机并在浏览器打开。
- 也可直接点击内置的 **ComfyUI `:8188`** 预设按钮。

### 3. 环境变量保险箱与新会话自动初始化

1. 打开 **设置 → Colab CLI**。
2. 在 **环境变量保险箱** 添加 `HF_TOKEN`、`CIVITAI_API_KEY`、`WANDB_API_KEY` 等。
3. 勾选 **新会话自动初始化** 选项（挂载 Drive、启用 `hf_transfer`、持久化 `HF_HOME` 到 Drive、安装 `uv`、自定义启动脚本）。
4. 之后每次新建 Colab VM 会自动完成初始化；也可在右侧检查器随时点击 **初始化环境** 手动执行。

---

## 快捷键速查

| 快捷键 | 功能 |
| --- | --- |
| `⌘K` | 打开全局命令面板（在终端聚焦时也可用） |
| `⌘J` | 切换视图：对话 → 分屏 → 终端（连接 VM 后可用） |
| `⌘B` | 折叠 / 展开左侧导航栏 |
| `⌘.` | 折叠 / 展开右侧检查器（GPU 监控、端口、文件、同步） |
| `/` | 在设置弹窗中快速聚焦搜索框 |
| `⌘Enter` | 发送消息 / 执行命令 |
| `Esc` | 关闭当前弹窗或命令面板 |

---

## 项目架构

- `src/server.mjs` — 零依赖 HTTP + RFC 6455 WebSocket 服务端（含 HTTP `206 Range` 视频流）
- `src/plan.mjs`、`src/run.mjs`、`src/parse.mjs`、`src/desk.mjs` — 官方 `colab` CLI 参数规划器、执行器、输出解析与会话状态管理
- `src/agent.mjs` — ACP（`agy`、`opencode`）、Grok 流式 NDJSON 与 OpenAI 兼容工具调用 Agent 调度中心
- `src/terminal.mjs` & `src/pty-bridge.py` — Colab SSH 交互式 PTY 管理器与 WebSocket 桥接
- `src/cloud-ops.mjs` — GPU 遥测与进程强杀、自动端口探测、云端文件/媒体画廊、直跑脚本器、自动初始化、目录同步、`.ipynb`/`.md` 导出与更新检查
- `src/colab-env.mjs` — `colab` CLI 环境检测、一键 `uv`/`pip3` 安装与 OAuth 登录
- `src/store.mjs` & `src/i18n.mjs` — 本地原子持久化（`0600`）与中英双语词典
- `macos/ColabDesk.swift` — 轻量级 AppKit + `WKWebView` 原生壳（不启动登录 shell，不读取钥匙串）
- `public/index.html` — 单文件前端与本地内置 `xterm.js`

## 隐私与安全

- **纯本地存储**：设置、API Key 与环境变量保险箱仅保存在本机 `~/.config/colab-desk/state.json`（`0600` 权限），不会上传到任何第三方服务器。
- **严格走官方 CLI**：Colab Desk 不直接接触你的 Google 账号凭据，所有鉴权与算力调用全部经由官方 `colab` 二进制完成。
- **干净构建**：`scripts/build-mac-app.sh` 使用 `-file-prefix-map` 与 `strip -x` 清理本地构建路径，确保发布的二进制包不包含任何个人路径或隐私信息。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

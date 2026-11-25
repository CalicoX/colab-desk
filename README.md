# Colab Desk

A lightweight, native macOS desktop workbench & local web app for the official [`google-colab-cli`](https://pypi.org/project/google-colab-cli/) (`colab` binary). Zero runtime npm dependencies.

Colab Desk lets you drive Google Colab GPU/TPU runtimes through **AI Agents**, **manual CLI commands**, or a **full interactive PTY terminal** — without memorizing flags or re-implementing Google's runtime protocol.

## Key Features

- **Multi-Agent Support (Zero-CLI Ready)**
  - **AGY (`agy acp`)**: Native Antigravity ACP protocol integration with Antigravity OAuth/Enterprise authentication, live plan tier detection, model selector, thinking level (`Low / Medium / High / Extra`), and live quota tracking.
  - **Grok (`grok`)**: Streaming NDJSON chat with live thinking display and real-time weekly quota tracking.
  - **OpenCode (`opencode acp`)**: ACP protocol support with 30-day & lifetime token/cost stats.
  - **Custom OpenAI-Compatible API Profiles**: Works even with **no local Agent CLI installed** — save multiple profiles (OpenAI, DeepSeek, OpenRouter, Gemini, local Ollama) with built-in Colab tool calling.
- **Interactive PTY Terminal & Split View (`⌘J`)**
  - Appears automatically once connected to an active Colab VM to switch between **Chat**, **Split (Chat + Terminal)**, and **Terminal**.
  - Full `xterm.js` + POSIX PTY over WebSocket (`colab ssh -s <session>`), supporting multiple tabs, resize (`SIGWINCH`), scrollback replay, one-click **"Send to Agent"** error debugging, and full TUI agents (`claude`, `agy`, `opencode`, `vim`, `htop`, `nvidia-smi`).
- **Direct Parameterized Script Runner (Zero Agent)**
  - Run Python (`colab exec`) or Bash (`colab ssh`) inference/deployment workflows directly on the Colab VM with auto-generated `{{param}}` forms, Env Vault injection, and automatic inline preview for generated images and videos — completely bypassing cloud LLMs.
- **Cloud File Explorer & Media Gallery**
  - Visual browser for `/content` and Google Drive (`/content/drive/MyDrive`) with **List / Media Gallery** views, inline **MP4/WebM video playback**, image/text preview, multi-select batch download, one-click Save to Drive, drag-and-drop upload, and one-click "Analyze with Agent".
- **Live GPU / VRAM Monitor, Process Killer & Auto Port Forwarding**
  - Real-time `nvidia-smi` VRAM, utilization, temperature, and GPU process list with **1-click Kill** in the collapsible right inspector (`⌘.`).
  - Automatically detects active listening Web ports on the VM alongside presets for **ComfyUI (`:8188`)**, Gradio (`:7860`), Jupyter (`:8888`), Ollama (`:11434`), vLLM (`:8000`), and TensorBoard (`:6006`) via `colab ssh --proxy-mode`.
- **Env Vault, Auto-Bootstrap & Local ↔ Cloud Folder Sync**
  - Store `HF_TOKEN`, `WANDB_API_KEY`, `CIVITAI_API_KEY`, etc. locally (`0600`), auto-inject on VM creation, enable `hf_transfer` & Google Drive `HF_HOME` caching, and push/pull local project folders to `/content`.
- **Command Palette (`⌘K`), Inline Code Execution, Export & Updates**
  - Press `⌘K` for instant navigation, click **▶ Run** on any code block in chat, export `.ipynb` / `.md`, manage prompt templates, and check GitHub Releases for updates in Settings → About.
- **Native macOS Experience**
  - Categorized Settings modal with search (`/`), **Dark / Light / System** theme sync, **System / 中文 / English** language switching, local disk persistence (`~/.config/colab-desk/state.json`), and built-in `colab` CLI health check + one-click install/OAuth login.

## Requirements

- **Node.js 20+**
- **Python 3** (used for the POSIX PTY bridge on macOS)
- **[`google-colab-cli`](https://pypi.org/project/google-colab-cli/)** (`colab` binary — can also be installed directly inside Settings → Colab CLI)

## Quick Start

### Run Web App

```bash
npm start
```

Opens on `http://127.0.0.1:4173` (override with `PORT`).

### Download Prebuilt macOS App

Download [`dist/Colab-Desk-macOS-arm64.zip`](dist/Colab-Desk-macOS-arm64.zip) (or from [GitHub Releases](https://github.com/CalicoX/colab-desk/releases)), unzip `Colab Desk.app`, and move it to `/Applications`.

> Note: Since the app is ad-hoc signed, if macOS Gatekeeper prompts on first launch, run `xattr -cr "/Applications/Colab Desk.app"` or right-click → Open.

### Build & Launch macOS App

```bash
npm run app
```

Compiles `macos/ColabDesk.swift` into `dist/Colab Desk.app`, packages `dist/Colab-Desk-macOS-<arch>.zip`, generates the squircle app icon from `macos/AppIcon.png`, signs the bundle ad-hoc, and launches it automatically. Set `COLAB_DESK_NO_LAUNCH=1` to build without launching.

### Run Tests

```bash
npm test
```

## Architecture

- `src/server.mjs` — Zero-dependency HTTP + RFC 6455 WebSocket server
- `src/plan.mjs`, `src/run.mjs`, `src/parse.mjs`, `src/desk.mjs` — Official `colab` CLI argv planner, runner, parser, and transcript state
- `src/agent.mjs` — ACP (`agy`, `opencode`), Grok streaming-JSON, and OpenAI-compatible tool-calling Agent hub
- `src/terminal.mjs` & `src/pty-bridge.py` — Interactive PTY manager & WebSocket bridge
- `src/cloud-ops.mjs` — GPU telemetry, remote file explorer, SSH port forwarding, `.ipynb`/`.md` export
- `src/colab-env.mjs` — `colab` CLI diagnostics, one-click `uv`/`pip3` install, and OAuth login
- `src/store.mjs` & `src/i18n.mjs` — Local atomic persistence (`0600`) and bilingual dictionary
- `macos/ColabDesk.swift` — Lightweight AppKit + `WKWebView` native shell
- `public/index.html` — Single-file frontend with locally vendored `xterm.js`

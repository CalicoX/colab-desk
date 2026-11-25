# Colab Desk

A lightweight, native macOS desktop workbench & local web app for the official [`google-colab-cli`](https://pypi.org/project/google-colab-cli/) (`colab` binary). Zero runtime npm dependencies.

Colab Desk lets you drive Google Colab GPU/TPU runtimes through **AI Agents**, **manual CLI commands**, or a **full interactive PTY terminal** — without memorizing flags or re-implementing Google's runtime protocol.

## Key Features

- **Multi-Agent Support (Zero-CLI Ready)**
  - **AGY (`agy acp`)**: Native Antigravity ACP protocol integration with Antigravity OAuth/Enterprise authentication, live plan tier detection, model selector, thinking level (`Low / Medium / High / Extra`), and live quota tracking.
  - **Grok (`grok`)**: Streaming NDJSON chat with live thinking display and real-time weekly quota tracking.
  - **OpenCode (`opencode acp`)**: ACP protocol support with 30-day & lifetime token/cost stats.
  - **Custom OpenAI-Compatible API Profiles**: Works even with **no local Agent CLI installed** — save multiple profiles (OpenAI, DeepSeek, OpenRouter, Gemini, local Ollama) with built-in Colab tool calling.
- **Interactive PTY Terminal (`⌘J`)**
  - Appears automatically once connected to an active Colab VM to switch between **Chat** and **Terminal**.
  - Full `xterm.js` + POSIX PTY over WebSocket (`colab ssh -s <session>`), supporting multiple tabs, resize (`SIGWINCH`), scrollback replay, and full TUI agents (`claude`, `agy`, `opencode`, `vim`, `htop`, `nvidia-smi`).
- **Cloud File Explorer**
  - Visual browser for `/content` and Google Drive (`/content/drive/MyDrive`) with one-click `drivemount`, drag-and-drop upload, download, delete, inline image/text preview, and one-click "Analyze with Agent".
- **Live GPU / VRAM Monitor & SSH Port Forwarding**
  - Real-time `nvidia-smi` VRAM, utilization, and temperature meters in the collapsible right inspector (`⌘.`).
  - One-click SSH tunnels via `colab ssh --proxy-mode` for Gradio (`:7860`), Jupyter (`:8888`), Ollama (`:11434`), vLLM (`:8000`), TensorBoard (`:6006`), or any custom port.
- **Notebook Export, Templates & Cost Guardrails**
  - Export sessions to `.ipynb` or `.md`, manage reusable prompt templates, and get native macOS notifications on long task completion, low Compute Units, or idle GPU VMs.
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

### Build & Launch macOS App

```bash
npm run app
```

Compiles `macos/ColabDesk.swift` into `dist/Colab Desk.app`, generates the squircle app icon from `macos/AppIcon.png`, signs the bundle ad-hoc, and launches it automatically. Set `COLAB_DESK_NO_LAUNCH=1` to build without launching.

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

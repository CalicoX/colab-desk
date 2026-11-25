# AGENTS.md — Colab Desk Development Rules

## Core Architecture Constraints
- **Official `colab` CLI only**: Never re-implement Google Colab's runtime API or WebSocket kernel protocol. Every Colab operation must spawn the official `google-colab-cli` (`colab`) binary via `src/plan.mjs`, `src/run.mjs`, `src/cloud-ops.mjs`, `src/colab-env.mjs`, or `src/terminal.mjs`.
- **Zero runtime npm dependencies**: Keep `package.json` dependency-free. Browser assets (such as `xterm.js`) must be vendored locally under `public/vendor/` so `Colab Desk.app` works offline.
- **Terminal scope**: Interactive terminals (`src/terminal.mjs` + `src/pty-bridge.py`) are strictly for connected Colab VM sessions (`colab ssh -s <session>`). Do not expose a local host shell, and hide/disable the terminal switcher whenever no Colab VM is connected.
- **AGY authentication**: AGY must always connect via `agy acp` using Antigravity's native ACP authentication (`initialize` → `authMethods` / `authenticate` / `logout`).
- **macOS AppKit rules (`macos/ColabDesk.swift`)**:
  - Never start a login shell (`zsh -lic` / `/bin/zsh`) or touch the macOS Keychain.
  - Never attach an `NSToolbar` to the `.fullSizeContentView` window (it intercepts clicks on HTML buttons in the top strip).
  - Keep `CFBundleIdentifier` as `com.calicox.colab-desk` (no personal usernames).

## Privacy & Distribution Hygiene
- Never commit or embed personal usernames, home directory paths (`/Users/...`), personal emails, API keys, OAuth tokens, or `~/.config/colab-desk/state.json` into the repository or `dist/Colab Desk.app`.
- `scripts/build-mac-app.sh` compiles with `-file-prefix-map` and `strip -x`, codesigns ad-hoc, and produces a clean distributable `dist/Colab-Desk-macOS-<arch>.zip`.

## Mandatory Release Workflow (After Every Task)
After completing any code or UI change:
1. Run `npm test` and ensure all tests pass (add/update unit tests in `test/colab.test.mjs` for new behavior).
2. Run `npm run app` to rebuild `dist/Colab Desk.app`, regenerate `dist/Colab-Desk-macOS-arm64.zip`, codesign, and restart the app.
3. Verify code signature (`codesign --verify --verbose "dist/Colab Desk.app"`) and confirm no personal info leaked into the built bundle or git diff.
4. Commit all changes (including the updated `dist/Colab-Desk-macOS-arm64.zip`) and `git push origin main`.
5. Update the GitHub Release asset when the built app changes (`gh release upload v0.1.0 dist/Colab-Desk-macOS-arm64.zip --clobber`).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  findChromeBinary, installFakeColab, launchChrome, startServer, stopProcess,
} from "./helpers/harness.mjs";

const EXPECTED = {
  guard: { settingsTabs: ["guard"], rail: true },
  jobs: { settingsTabs: ["jobs-notifications"], rail: true },
  backup: { settingsTabs: ["backup"], rail: true },
  agentx: { settingsTabs: ["agentx-mcp", "agentx-templates"] },
  recipes: { rail: true, toolBtn: "#recipes-tool-btn" },
  fleet: { toolBtn: "#open-fleet-btn" },
  search: { toolBtn: "#open-search-btn" },
  notebookx: {},
};

const chromeBin = findChromeBinary();

describe("Colab Desk feature-wave UI suite", { skip: !chromeBin && "No Chrome/Chromium binary found" }, () => {
  let tmpRoot; let serverProc; let chromeProc; let cdp; let baseUrl;
  let features = { backend: [], frontend: [], styles: [] };
  const pageErrors = []; const consoleErrors = []; const failedRequests = [];
  const loaded = new Map(); const pending = new Map();

  const has = (id) => features.backend.includes(id)
    && features.frontend.some((u) => u.includes(`/features/${id}/`));

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "colab-desk-feat-"));
    const fakeBin = installFakeColab(tmpRoot);
    const home = path.join(tmpRoot, "home");
    const state = path.join(tmpRoot, "state");
    const profile = path.join(tmpRoot, "chrome-profile");
    for (const d of [home, state, profile]) fs.mkdirSync(d, { recursive: true });
    const srv = await startServer(fakeBin, home, state);
    serverProc = srv.child; baseUrl = srv.baseUrl;
    const browser = await launchChrome(chromeBin, profile);
    chromeProc = browser.child; cdp = browser.cdp;
    for (const d of ["Page", "Runtime", "Network", "Log"]) await cdp.send(`${d}.enable`);
    cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails || {};
      pageErrors.push({ text: d.exception?.description || d.text, url: d.url, line: d.lineNumber });
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") consoleErrors.push({ text: (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ") });
    });
    cdp.on("Log.entryAdded", (p) => {
      const e = p.entry || {};
      if (e.level === "error" && !(e.url || "").endsWith("/favicon.ico")) consoleErrors.push({ text: e.text, url: e.url });
    });
    cdp.on("Network.requestWillBeSent", (p) => pending.set(p.requestId, p.request?.url || ""));
    cdp.on("Network.responseReceived", (p) => {
      const url = p.response?.url || "";
      if (!url.startsWith(baseUrl)) return;
      const pn = new URL(url).pathname;
      loaded.set(pn, p.response.status);
      if (p.response.status >= 400 && pn !== "/favicon.ico") failedRequests.push({ url, status: p.response.status });
    });
    cdp.on("Network.loadingFailed", (p) => {
      if (p.canceled) return;
      const url = pending.get(p.requestId) || "";
      if (!url.endsWith("/favicon.ico")) failedRequests.push({ url, error: p.errorText });
    });

    const done = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await done;
    await cdp.waitFor(`document.querySelector("#session-items")?.textContent?.includes("lab-alpha")`, { label: "app hydrated" });
    features = await fetch(`${baseUrl}/api/features`).then((r) => r.json());
    await cdp.waitFor(
      `document.querySelectorAll("#rail section, #rail [data-feature], #jobs-rail-section, #recipes-rail-section").length > 0`,
      { label: "feature modules mounted" },
    );
    await new Promise((r) => setTimeout(r, 400));
  });

  after(async () => {
    if (cdp) cdp.close();
    await stopProcess(chromeProc);
    await stopProcess(serverProc);
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  });

  const openSettings = async () => {
    await cdp.eval(`document.querySelector("#open-settings-modal").click()`);
    await cdp.waitFor(`document.querySelector("#settings-modal")?.open === true`, { label: "settings open" });
  };
  const closeSettings = async () => {
    await cdp.eval(`document.querySelector("#close-settings-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#settings-modal")?.open`, { label: "settings closed" });
  };

  test("GET /api/features lists every expected feature", () => {
    assert.ok(Array.isArray(features.backend), "backend[] present");
    assert.ok(Array.isArray(features.frontend), "frontend[] present");
    assert.ok(Array.isArray(features.styles), "styles[] present");
    for (const id of Object.keys(EXPECTED)) {
      assert.ok(has(id), `expected feature "${id}" in GET /api/features (got backend=${JSON.stringify(features.backend)}, frontend=${JSON.stringify(features.frontend)})`);
    }
  });

  test("every discovered feature frontend module and stylesheet loads with HTTP 200", async () => {
    for (const url of [...features.frontend, ...features.styles]) {
      assert.ok(url.startsWith("/"), `feature url should be root-relative: ${url}`);
      const res = await fetch(baseUrl + url);
      assert.equal(res.status, 200, `${url} -> ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      assert.match(ct, url.endsWith(".css") ? /text\/css/ : /javascript/, `${url} content-type ${ct}`);
    }
    for (const url of features.frontend) {
      assert.equal(loaded.get(url), 200, `browser should have imported ${url}`);
    }
  });

  test("feature settings tabs, rail sections, and workspace-tools mount points render", async () => {
    await openSettings();
    for (const [id, spec] of Object.entries(EXPECTED)) {
      for (const tabId of spec.settingsTabs || []) {
        const found = await cdp.eval(`!!document.querySelector('#settings-modal [data-settings-tab="${tabId}"]')`);
        assert.ok(found, `settings tab "${tabId}" for feature "${id}" should be mounted`);
        await cdp.eval(`document.querySelector('#settings-modal [data-settings-tab="${tabId}"]').click()`);
        const txt = await cdp.eval(`document.querySelector("#settings-modal").innerText`);
        assert.doesNotMatch(txt, new RegExp(`\\b${id}\\.[a-zA-Z]+`), `raw i18n key leaked for ${id} in tab ${tabId}`);
      }
    }
    await closeSettings();

    const railCount = await cdp.eval(`document.querySelectorAll("#rail > *").length`);
    assert.ok(railCount >= 4, `expected inspector rail to contain mounted feature sections, got ${railCount}`);
    for (const [id, spec] of Object.entries(EXPECTED)) {
      if (!spec.toolBtn) continue;
      const present = await cdp.eval(`!!document.querySelector(${JSON.stringify(spec.toolBtn)})`);
      assert.ok(present, `workspace-tools button ${spec.toolBtn} for "${id}" should be mounted`);
    }
  });

  test("EN/ZH strings resolve without raw feature.key leaks; light and dark themes render", async () => {
    const ids = Object.keys(EXPECTED);
    const leakRe = `\\b(${ids.join("|")})\\.[a-zA-Z][a-zA-Z0-9.]+`;
    for (const lang of ["en", "zh-CN"]) {
      for (const theme of ["light", "dark"]) {
        await openSettings();
        await cdp.eval(`(() => { for (const [sel, v] of [["#setting-language", ${JSON.stringify(lang)}], ["#setting-theme", ${JSON.stringify(theme)}]]) { const s = document.querySelector(sel); s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); } })()`);
        await cdp.waitFor(`document.documentElement.lang === ${JSON.stringify(lang)} && document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, { label: `${lang}/${theme}` });
        for (const [id, spec] of Object.entries(EXPECTED)) {
          for (const tabId of spec.settingsTabs || []) {
            const label = await cdp.eval(`document.querySelector('#settings-modal [data-settings-tab="${tabId}"]')?.textContent?.trim() || ""`);
            assert.ok(label && !label.startsWith(`${id}.`), `tab "${tabId}" label unresolved in ${lang}: ${label}`);
          }
        }
        await closeSettings();
        const leaks = await cdp.eval(`(document.body.innerText.match(new RegExp(${JSON.stringify(leakRe)}, "g")) || [])`);
        assert.deepEqual(leaks, [], `raw i18n keys visible in ${lang}/${theme}: ${JSON.stringify(leaks)}`);
      }
    }
  });

  test("command palette opens and lists feature commands", async () => {
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))`);
    await cdp.waitFor(`document.querySelector("#cmd-palette-modal")?.open === true && document.querySelectorAll("#cmd-palette-list .palette-item").length > 0`, { label: "palette open" });
    const count = await cdp.eval(`document.querySelectorAll("#cmd-palette-list .palette-item").length`);
    assert.ok(count >= 10, `expected core + feature commands in palette, got ${count}`);
    await cdp.eval(`document.querySelector("#cmd-palette-modal").click()`);
    await cdp.waitFor(`!document.querySelector("#cmd-palette-modal")?.open`, { label: "palette closed" });
  });

  test("Fleet and Search overlays open and close cleanly", async () => {
    // Fleet overlay
    await cdp.eval(`document.querySelector("#open-fleet-btn").click()`);
    await cdp.waitFor(`(() => { const d = document.querySelector("#fleet-modal, dialog.fleet-modal, [id*='fleet'][open]"); return !!(d && d.open); })()`, { label: "fleet overlay open" });
    await cdp.eval(`(() => { const d = document.querySelector("#fleet-modal, dialog.fleet-modal, [id*='fleet'][open]"); if (d?.close) d.close(); })()`);
    await cdp.waitFor(`!document.querySelector("#fleet-modal[open], dialog.fleet-modal[open]")`, { label: "fleet overlay closed" });

    // Search overlay
    await cdp.eval(`document.querySelector("#open-search-btn").click()`);
    await cdp.waitFor(`(() => { const d = document.querySelector("#search-modal, dialog.search-modal, [id*='search'][open]"); return !!(d && d.open); })()`, { label: "search overlay open" });
    await cdp.eval(`(() => { const d = document.querySelector("#search-modal, dialog.search-modal, [id*='search'][open]"); if (d?.close) d.close(); })()`);
    await cdp.waitFor(`!document.querySelector("#search-modal[open], dialog.search-modal[open]")`, { label: "search overlay closed" });
  });

  test("new-session modal shows recipe picker and snipe priority UI", async () => {
    await cdp.eval(`document.querySelector("#open-new-session").click()`);
    await cdp.waitFor(`document.querySelector("#new-session-modal")?.open === true`, { label: "new session modal" });
    const ui = await cdp.eval(`({
      recipe: !!document.querySelector('#new-session-modal #recipe-picker-row'),
      snipe: !!document.querySelector('#new-session-modal #snipe-queue-section'),
    })`);
    assert.equal(ui.recipe, true, "recipe picker (#recipe-picker-row) should be present in new-session modal");
    assert.equal(ui.snipe, true, "snipe priority UI (#snipe-queue-section) should be present in new-session modal");
    await cdp.eval(`document.querySelector("#close-new-session").click()`);
    await cdp.waitFor(`!document.querySelector("#new-session-modal")?.open`, { label: "new session closed" });
  });

  test("notebook diff modal opens cleanly via palette/command or button", async () => {
    // Open via ⌘K palette searching for Diff or direct button if notebook view is loaded
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))`);
    await cdp.waitFor(`document.querySelector("#cmd-palette-modal")?.open === true`, { label: "palette open for nb diff" });
    await cdp.eval(`(() => {
      const inp = document.querySelector("#cmd-palette-input");
      inp.value = "Diff";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.querySelectorAll("#cmd-palette-list .palette-item").length > 0`, { label: "nb diff palette item" });
    await cdp.eval(`document.querySelector("#cmd-palette-list .palette-item").click()`);
    await cdp.waitFor(`(() => { const m = document.querySelector("#nbx-diff-modal"); return !!(m && !m.hidden); })()`, { label: "notebook diff modal open" });
    await cdp.eval(`document.querySelector("#nbx-diff-close").click()`);
    await cdp.waitFor(`document.querySelector("#nbx-diff-modal")?.hidden === true`, { label: "notebook diff modal closed" });
  });

  test("zero page errors, console errors, and failed requests", async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(pageErrors, [], JSON.stringify(pageErrors, null, 2));
    assert.deepEqual(consoleErrors, [], JSON.stringify(consoleErrors, null, 2));
    assert.deepEqual(failedRequests, [], JSON.stringify(failedRequests, null, 2));
  });
});

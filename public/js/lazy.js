import { dom } from "./dom.js";
import { state } from "./state.js";
import { L, showToast } from "./utils.js";
import { emit, on } from "./events.js";

/**
 * Memoized dynamic import() loaders for all 8 non-initial heavy feature modules.
 * Guarantees each module and its lazily-mounted modal template initializes strictly once.
 */
let settingsPromise = null;
let usagePromise = null;
let sessionCreatePromise = null;
let filesPromise = null;
let cloudToolsPromise = null;
let notebookPromise = null;
let terminalPromise = null;
let palettePromise = null;

export function ensureSettingsLoaded() {
  if (!settingsPromise) {
    settingsPromise = import("./settings.js")
      .then((mod) => {
        mod.initSettings();
        emit("settings:mounted", mod);
        return mod;
      })
      .catch((err) => {
        settingsPromise = null;
        throw err;
      });
  }
  return settingsPromise;
}

export function ensureUsageLoaded() {
  if (!usagePromise) {
    usagePromise = import("./usage.js")
      .then((mod) => {
        mod.initUsageModals();
        return mod;
      })
      .catch((err) => {
        usagePromise = null;
        throw err;
      });
  }
  return usagePromise;
}

export function ensureSessionCreateLoaded() {
  if (!sessionCreatePromise) {
    sessionCreatePromise = import("./session-create.js")
      .then((mod) => {
        mod.initSessionCreate();
        return mod;
      })
      .catch((err) => {
        sessionCreatePromise = null;
        throw err;
      });
  }
  return sessionCreatePromise;
}

export function ensureFilesLoaded() {
  if (!filesPromise) {
    filesPromise = import("./files.js")
      .then((mod) => {
        mod.initFiles();
        return mod;
      })
      .catch((err) => {
        filesPromise = null;
        throw err;
      });
  }
  return filesPromise;
}

export function ensureCloudToolsLoaded() {
  if (!cloudToolsPromise) {
    cloudToolsPromise = import("./cloud-tools.js")
      .then((mod) => {
        mod.initCloudTools();
        return mod;
      })
      .catch((err) => {
        cloudToolsPromise = null;
        throw err;
      });
  }
  return cloudToolsPromise;
}

export function ensureNotebookLoaded() {
  if (!notebookPromise) {
    notebookPromise = import("./notebook.js")
      .then((mod) => {
        mod.initNotebook();
        return mod;
      })
      .catch((err) => {
        notebookPromise = null;
        throw err;
      });
  }
  return notebookPromise;
}

export function ensureTerminalLoaded() {
  if (!terminalPromise) {
    terminalPromise = import("./terminal.js")
      .then((mod) => {
        mod.initTerminal();
        return mod;
      })
      .catch((err) => {
        terminalPromise = null;
        throw err;
      });
  }
  return terminalPromise;
}

export function ensurePaletteLoaded() {
  if (!palettePromise) {
    palettePromise = import("./palette.js")
      .then((mod) => {
        mod.initPalette();
        return mod;
      })
      .catch((err) => {
        palettePromise = null;
        throw err;
      });
  }
  return palettePromise;
}

export function initLazyTriggers() {
  // Initial shell button bindings -> lazy module loaders
  document.querySelector("#open-settings-modal")?.addEventListener("click", () => {
    ensureSettingsLoaded().then((mod) => mod.openSettings("general"));
  });
  document.querySelector("#env-alert-btn")?.addEventListener("click", () => {
    ensureSettingsLoaded().then((mod) => mod.openSettings("colab"));
  });
  dom.inspectorBootstrapBtn?.addEventListener("click", () => {
    ensureSettingsLoaded().then((mod) => mod.runBootstrapOnSession(state.selected, false));
  });

  document.querySelector("#quick-usage")?.addEventListener("click", () => {
    ensureUsageLoaded().then((mod) => mod.openColabCuModal());
  });
  document.querySelector("#open-usage-modal")?.addEventListener("click", () => {
    ensureUsageLoaded().then((mod) => mod.openAgentUsageModal());
  });

  document.querySelector("#open-new-session")?.addEventListener("click", () => {
    ensureSessionCreateLoaded().then((mod) => mod.openNewSessionModal());
  });
  document.querySelector("#mini-new-session")?.addEventListener("click", () => {
    ensureSessionCreateLoaded().then((mod) => mod.openNewSessionModal());
  });
  document.querySelector("#welcome-create-btn")?.addEventListener("click", () => {
    ensureSessionCreateLoaded().then((mod) => mod.openNewSessionModal());
  });

  document.querySelector("#open-templates-btn")?.addEventListener("click", () => {
    ensureCloudToolsLoaded().then((mod) => mod.openTemplatesModal());
  });
  document.querySelector("#open-runner-btn")?.addEventListener("click", () => {
    ensureCloudToolsLoaded().then((mod) => mod.openRunnerModal());
  });
  dom.inspectorSyncBtn?.addEventListener("click", () => {
    ensureCloudToolsLoaded().then((mod) => mod.openSyncModal());
  });

  document.querySelector("#open-cmd-palette-kbd")?.addEventListener("click", () => {
    ensurePaletteLoaded().then((mod) => mod.openCommandPalette());
  });

  dom.viewChatBtn?.addEventListener("click", () => {
    ensureTerminalLoaded().then((mod) => mod.setWorkspaceView("chat"));
  });
  dom.viewSplitBtn?.addEventListener("click", () => {
    ensureTerminalLoaded().then((mod) => mod.setWorkspaceView("split"));
  });
  dom.viewTermBtn?.addEventListener("click", () => {
    ensureTerminalLoaded().then((mod) => mod.setWorkspaceView("terminal"));
  });

  // Event-bus triggers from core modules
  on("ui:open-settings", (tabId = "general") => {
    ensureSettingsLoaded().then((mod) => mod.openSettings(tabId));
  });
  on("settings:bootstrap", ({ session, silent = false } = {}) => {
    ensureSettingsLoaded().then((mod) => mod.runBootstrapOnSession(session, silent));
  });
  on("ui:open-new-session", () => {
    ensureSessionCreateLoaded().then((mod) => mod.openNewSessionModal());
  });
  on("session-create:track", ({ toolCallId, spec } = {}) => {
    ensureSessionCreateLoaded().then((mod) => mod.trackAgentSessionCreate(toolCallId, spec));
  });
  on("session-create:resolve", ({ status, outputText } = {}) => {
    ensureSessionCreateLoaded().then((mod) => mod.resolveAgentSessionCreate(status, outputText));
  });
  on("ui:open-files", (dir = "/content") => {
    ensureFilesLoaded().then((mod) => mod.openFilesModal(dir));
  });
  on("ui:open-templates", () => {
    ensureCloudToolsLoaded().then((mod) => mod.openTemplatesModal());
  });
  on("ui:open-runner", () => {
    ensureCloudToolsLoaded().then((mod) => mod.openRunnerModal());
  });
  on("ui:open-sync", () => {
    ensureCloudToolsLoaded().then((mod) => mod.openSyncModal());
  });
  on("ui:open-palette", () => {
    ensurePaletteLoaded().then((mod) => mod.openCommandPalette());
  });
  on("ui:open-usage", () => {
    ensureUsageLoaded().then((mod) => mod.openAgentUsageModal());
  });
  on("ui:open-cu", () => {
    ensureUsageLoaded().then((mod) => mod.openColabCuModal());
  });
  on("notebook:activate", () => {
    ensureNotebookLoaded().then((mod) => mod.renderNotebook());
  });
  on("notebook:insert-code", ({ code } = {}) => {
    ensureNotebookLoaded().then((mod) => {
      mod.addNotebookCell("code", code || "");
      emit("composer:set-mode", "notebook");
      showToast(L("已插入到 Notebook 单元格", "Inserted into Notebook cell"));
    });
  });
  on("terminal:set-view", (nextView) => {
    if (nextView === "chat" && state.activeWorkspaceView === "chat") return;
    ensureTerminalLoaded().then((mod) => mod.setWorkspaceView(nextView));
  });
  on("terminal:toggle", () => {
    ensureTerminalLoaded().then((mod) => mod.toggleTerminalView());
  });
}

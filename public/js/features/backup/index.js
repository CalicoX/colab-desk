const STRINGS = {
  "zh-CN": {
    "backup.rail.title": "自动备份",
    "backup.rail.auto": "自动",
    "backup.rail.lastRun": "上次运行",
    "backup.rail.never": "从未",
    "backup.rail.synced": "已同步",
    "backup.rail.pending": "待同步",
    "backup.rail.errors": "错误",
    "backup.rail.running": "正在备份…",
    "backup.rail.backupNow": "立即备份",
    "backup.rail.cancel": "取消",
    "backup.rail.configure": "配置",
    "backup.tab.title": "自动备份",
    "backup.settings.targetGroup": "备份目标与策略",
    "backup.settings.targetTitle": "备份目标",
    "backup.settings.targetDesc": "将检测到的产物/检查点复制到 Google Drive、拉取到本地文件夹或同时执行。",
    "backup.settings.targetDrive": "Google Drive（云端拷贝）",
    "backup.settings.targetLocal": "本地文件夹（colab download）",
    "backup.settings.targetBoth": "Google Drive + 本地文件夹",
    "backup.settings.driveDirTitle": "Google Drive 目录",
    "backup.settings.driveDirDesc": "VM 上挂载的 Drive 目标根目录，将按 <会话>/<日期> 归档。",
    "backup.settings.localRootTitle": "本地备份文件夹",
    "backup.settings.localRootDesc": "增量拉取的本地根目录（支持 ~，禁止写入根目录或路径穿越）。",
    "backup.settings.safetyNetTitle": "断连/回收前安全网",
    "backup.settings.safetyNetDesc": "当会话守卫发出断连或即将回收预警时，若 VM 仍可达则立即触发一次备份。",
    "backup.settings.maxSizeTitle": "单文件大小上限 (MB)",
    "backup.settings.maxSizeDesc": "超过此大小的超大文件将被跳过并记录错误。",
    "backup.settings.retriesTitle": "失败重试次数",
    "backup.settings.retriesDesc": "单文件/批次失败时按指数退避自动重试。",
    "backup.settings.saveSettings": "保存全局设置",
    "backup.settings.rulesGroup": "当前会话监控规则",
    "backup.settings.noSession": "当前未连接 Colab 会话；连接会话后可编辑其监控路径与过滤规则。",
    "backup.settings.sessionLabel": "目标会话",
    "backup.settings.enabledTitle": "启用该会话自动备份",
    "backup.settings.enabledDesc": "按轮询间隔自动扫描新增或变更文件并增量备份。",
    "backup.settings.pathsTitle": "监控路径",
    "backup.settings.pathsDesc": "每行或逗号分隔多个远程目录（默认 /content/output）。",
    "backup.settings.includeTitle": "包含通配符 (Include)",
    "backup.settings.includeDesc": "留空表示包含全部文件；例如 *.pt, *.safetensors, *.json。",
    "backup.settings.excludeTitle": "排除通配符 (Exclude)",
    "backup.settings.excludeDesc": "默认忽略 *.tmp, __pycache__, .ipynb_checkpoints。",
    "backup.settings.intervalTitle": "轮询间隔 (秒)",
    "backup.settings.intervalDesc": "自动扫描远程变更的周期（10–86400 秒）。",
    "backup.settings.minAgeTitle": "最小文件静默时间 (秒)",
    "backup.settings.minAgeDesc": "结合大小稳定性校验，避免拷贝仍在写入中的半成品文件。",
    "backup.settings.saveRules": "保存会话规则",
    "backup.settings.clearManifest": "重置同步清单",
    "backup.cmd.backupNow": "立即备份当前会话产物",
    "backup.toast.saved": "备份设置已保存",
    "backup.toast.rulesSaved": "会话备份规则已保存",
    "backup.toast.started": "已开始备份",
    "backup.toast.alreadyRunning": "当前会话已在备份中",
    "backup.toast.cancelled": "已请求取消备份",
    "backup.toast.cleared": "同步清单已重置",
    "backup.toast.noSession": "请先选择一个已连接的 Colab 会话",
    "backup.toast.safetyNet": "已触发断连/回收安全网备份",
    "backup.notify.failTitle": "Colab Desk — 备份失败",
    "backup.notify.failBody": "会话备份出现错误：",
  },
  en: {
    "backup.rail.title": "Backups",
    "backup.rail.auto": "Auto",
    "backup.rail.lastRun": "Last run",
    "backup.rail.never": "Never",
    "backup.rail.synced": "Synced",
    "backup.rail.pending": "Pending",
    "backup.rail.errors": "Errors",
    "backup.rail.running": "Backing up…",
    "backup.rail.backupNow": "Backup now",
    "backup.rail.cancel": "Cancel",
    "backup.rail.configure": "Configure",
    "backup.tab.title": "Backup",
    "backup.settings.targetGroup": "Targets & Policy",
    "backup.settings.targetTitle": "Backup target",
    "backup.settings.targetDesc": "Copy detected checkpoints/artifacts to Google Drive, pull locally, or both.",
    "backup.settings.targetDrive": "Google Drive (on-VM copy)",
    "backup.settings.targetLocal": "Local folder (colab download)",
    "backup.settings.targetBoth": "Google Drive + Local folder",
    "backup.settings.driveDirTitle": "Google Drive directory",
    "backup.settings.driveDirDesc": "Destination root on mounted Drive; organized as <session>/<date>.",
    "backup.settings.localRootTitle": "Local backup folder",
    "backup.settings.localRootDesc": "Local root for incremental pulls (~ supported; writes never escape this folder).",
    "backup.settings.safetyNetTitle": "Pre-recycle safety net",
    "backup.settings.safetyNetDesc": "Automatically trigger a backup pass when Session Guard warns of loss or recycle.",
    "backup.settings.maxSizeTitle": "Max file size (MB)",
    "backup.settings.maxSizeDesc": "Files larger than this threshold are skipped and reported.",
    "backup.settings.retriesTitle": "Retry attempts",
    "backup.settings.retriesDesc": "Exponential-backoff retries on transient transfer failures.",
    "backup.settings.saveSettings": "Save Settings",
    "backup.settings.rulesGroup": "Session Watch Rules",
    "backup.settings.noSession": "No Colab session selected. Connect a session to edit its watch paths and filters.",
    "backup.settings.sessionLabel": "Session",
    "backup.settings.enabledTitle": "Enable auto-backup for session",
    "backup.settings.enabledDesc": "Periodically scan for new/changed files and back them up incrementally.",
    "backup.settings.pathsTitle": "Watched paths",
    "backup.settings.pathsDesc": "Comma or newline separated remote paths (default /content/output).",
    "backup.settings.includeTitle": "Include globs",
    "backup.settings.includeDesc": "Leave blank for all files; e.g. *.pt, *.safetensors, *.json.",
    "backup.settings.excludeTitle": "Exclude globs",
    "backup.settings.excludeDesc": "Defaults to *.tmp, __pycache__, .ipynb_checkpoints.",
    "backup.settings.intervalTitle": "Poll interval (sec)",
    "backup.settings.intervalDesc": "How often to scan for remote changes (10–86400s).",
    "backup.settings.minAgeTitle": "Min file age (sec)",
    "backup.settings.minAgeDesc": "Combined with size-stability checks to avoid copying half-written files.",
    "backup.settings.saveRules": "Save Rules",
    "backup.settings.clearManifest": "Reset Manifest",
    "backup.cmd.backupNow": "Backup now",
    "backup.toast.saved": "Backup settings saved",
    "backup.toast.rulesSaved": "Session backup rules saved",
    "backup.toast.started": "Backup started",
    "backup.toast.alreadyRunning": "Backup already running for this session",
    "backup.toast.cancelled": "Backup cancellation requested",
    "backup.toast.cleared": "Sync manifest cleared",
    "backup.toast.noSession": "Select a connected Colab session first",
    "backup.toast.safetyNet": "Safety-net backup triggered",
    "backup.notify.failTitle": "Colab Desk — Backup failed",
    "backup.notify.failBody": "Backup errors on session:",
  },
};

function formatTime(ts, neverLabel) {
  if (!ts) return neverLabel;
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return neverLabel;
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c != null) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export async function init(api) {
  api.registerStrings(STRINGS);

  let serverState = {
    settings: {
      targets: "drive",
      driveDir: "/content/drive/MyDrive/colab-desk-backups",
      localRoot: "",
      safetyNet: true,
      maxFileBytes: 4 * 1024 * 1024 * 1024,
      retries: 3,
    },
    defaults: {
      rules: {
        paths: ["/content/output"],
        include: [],
        exclude: ["*.tmp", "__pycache__", ".ipynb_checkpoints"],
        intervalSec: 120,
        minAgeSec: 20,
      },
      localRootHint: "~/Downloads/ColabDesk-Backups",
    },
    sessions: {},
  };

  function currentSessionName() {
    const s = api.getSession?.();
    if (!s) return "";
    return typeof s === "string" ? s : (s.name || "");
  }

  function getSessionInfo(name) {
    if (!name) return null;
    const defRules = serverState.defaults?.rules || {
      paths: ["/content/output"],
      include: [],
      exclude: ["*.tmp", "__pycache__", ".ipynb_checkpoints"],
      intervalSec: 120,
      minAgeSec: 20,
    };
    return serverState.sessions?.[name] || {
      session: name,
      enabled: false,
      rules: defRules,
      lastRun: null,
      lastOk: null,
      synced: 0,
      totalSynced: 0,
      pending: 0,
      deferred: 0,
      errors: [],
      running: false,
      progress: null,
    };
  }

  async function refreshState() {
    try {
      const res = await api.fetchJson("/api/backup/state");
      if (res && res.ok) {
        serverState = res;
        renderRail();
        renderSettings();
      }
    } catch {}
  }

  async function triggerBackupNow(sessionName = currentSessionName()) {
    if (!sessionName) {
      api.showToast(api.tr("backup.toast.noSession"));
      return;
    }
    try {
      const res = await api.fetchJson("/api/backup/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sessionName, async: true, force: true }),
      });
      if (res?.alreadyRunning) api.showToast(api.tr("backup.toast.alreadyRunning"));
      else if (res?.ok) api.showToast(`${api.tr("backup.toast.started")} (${sessionName})`);
      else if (res?.error) api.showToast(res.error);
    } catch (err) {
      api.showToast(String(err?.message || err));
    }
  }

  async function cancelBackup(sessionName = currentSessionName()) {
    if (!sessionName) return;
    try {
      const res = await api.fetchJson("/api/backup/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sessionName }),
      });
      if (res?.ok) api.showToast(api.tr("backup.toast.cancelled"));
    } catch {}
  }

  /* ── Rail Section: "Backups" ── */
  const railEl = el("section", { class: "backup-rail", "data-feature": "backup" });
  railEl.hidden = true;

  function renderRail() {
    const sess = currentSessionName();
    if (!sess) {
      railEl.hidden = true;
      return;
    }
    railEl.hidden = false;
    const info = getSessionInfo(sess);
    const dotClass = info.running
      ? "backup-status-dot is-running"
      : info.errors.length > 0
        ? "backup-status-dot is-error"
        : info.lastOk
          ? "backup-status-dot is-ok"
          : "backup-status-dot";

    const toggleInput = el("input", { type: "checkbox", "aria-label": api.tr("backup.rail.auto") });
    toggleInput.checked = Boolean(info.enabled);
    toggleInput.addEventListener("change", async () => {
      try {
        const res = await api.fetchJson("/api/backup/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: sess, enabled: toggleInput.checked }),
        });
        if (res?.state) {
          serverState = res.state;
          renderRail();
          renderSettings();
        }
      } catch (err) {
        toggleInput.checked = !toggleInput.checked;
        api.showToast(String(err?.message || err));
      }
    });

    const head = el("div", { class: "backup-rail-head" }, [
      el("span", { class: "backup-rail-title" }, [
        el("span", { class: dotClass }),
        el("span", { text: api.tr("backup.rail.title") }),
      ]),
      el("label", { class: "backup-toggle" }, [
        toggleInput,
        el("span", { class: "backup-toggle-label", text: api.tr("backup.rail.auto") }),
      ]),
    ]);

    const kv = el("div", { class: "backup-kv-grid" }, [
      el("div", { class: "backup-kv" }, [
        el("span", { class: "backup-kv-label", text: api.tr("backup.rail.lastRun") }),
        el("span", { class: "backup-kv-val", text: formatTime(info.lastRun, api.tr("backup.rail.never")) }),
      ]),
      el("div", { class: "backup-kv" }, [
        el("span", { class: "backup-kv-label", text: api.tr("backup.rail.synced") }),
        el("span", { class: `backup-kv-val${info.totalSynced > 0 ? " is-ok" : ""}`, text: String(info.totalSynced || 0) }),
      ]),
      el("div", { class: "backup-kv" }, [
        el("span", { class: "backup-kv-label", text: api.tr("backup.rail.pending") }),
        el("span", { class: "backup-kv-val", text: String(info.pending || 0) }),
      ]),
      el("div", { class: "backup-kv" }, [
        el("span", { class: "backup-kv-label", text: api.tr("backup.rail.errors") }),
        el("span", {
          class: `backup-kv-val${info.errors.length > 0 ? " is-error" : ""}`,
          text: String(info.errors.length),
        }),
      ]),
    ]);

    const children = [head, kv];

    if (info.running) {
      const p = info.progress || { done: 0, total: 0 };
      const label = p.total > 0
        ? `${api.tr("backup.rail.running")} (${p.done}/${p.total})`
        : api.tr("backup.rail.running");
      children.push(el("div", { class: "backup-progress", text: label }));
    }

    if (info.errors.length > 0) {
      children.push(el("div", { class: "backup-error-box", text: info.errors[0] }));
    }

    const actions = el("div", { class: "backup-actions" }, [
      info.running
        ? el("button", {
            type: "button",
            class: "backup-btn is-danger",
            text: api.tr("backup.rail.cancel"),
            onclick: () => cancelBackup(sess),
          })
        : el("button", {
            type: "button",
            class: "backup-btn is-primary",
            text: api.tr("backup.rail.backupNow"),
            onclick: () => triggerBackupNow(sess),
          }),
      el("button", {
        type: "button",
        class: "backup-btn",
        text: api.tr("backup.rail.configure"),
        onclick: () => api.emit?.("ui:open-settings", "backup"),
      }),
    ]);
    children.push(actions);

    railEl.replaceChildren(...children);
  }

  /* ── Settings Pane: "Backup" ── */
  const settingsEl = el("div", { class: "backup-settings", "data-feature": "backup" });

  function makeRow(titleKey, descKey, control) {
    return el("div", { class: "s-row" }, [
      el("div", { class: "s-copy" }, [
        el("span", { class: "s-title", text: api.tr(titleKey) }),
        el("span", { class: "s-desc", text: api.tr(descKey) }),
      ]),
      control,
    ]);
  }

  function renderSettings() {
    const s = serverState.settings || {};
    const targetSel = el("select", { class: "s-select", id: "backup-target-select" }, [
      el("option", { value: "drive", text: api.tr("backup.settings.targetDrive") }),
      el("option", { value: "local", text: api.tr("backup.settings.targetLocal") }),
      el("option", { value: "both", text: api.tr("backup.settings.targetBoth") }),
    ]);
    targetSel.value = s.targets || "drive";

    const driveInput = el("input", {
      class: "s-input",
      type: "text",
      id: "backup-drive-dir",
      value: s.driveDir || "/content/drive/MyDrive/colab-desk-backups",
      placeholder: "/content/drive/MyDrive/colab-desk-backups",
    });

    const localInput = el("input", {
      class: "s-input",
      type: "text",
      id: "backup-local-root",
      value: s.localRoot || "",
      placeholder: serverState.defaults?.localRootHint || "~/Downloads/ColabDesk-Backups",
    });

    const safetyCheck = el("input", { type: "checkbox", id: "backup-safety-net" });
    safetyCheck.checked = s.safetyNet !== false;

    const maxMbInput = el("input", {
      class: "s-input s-num",
      type: "number",
      min: "1",
      max: "262144",
      id: "backup-max-mb",
      value: String(Math.max(1, Math.round((s.maxFileBytes || 4 * 1024 * 1024 * 1024) / (1024 * 1024)))),
    });

    const retriesInput = el("input", {
      class: "s-input s-num",
      type: "number",
      min: "0",
      max: "8",
      id: "backup-retries",
      value: String(s.retries ?? 3),
    });

    const saveGlobalBtn = el("button", {
      type: "button",
      class: "backup-btn is-primary",
      text: api.tr("backup.settings.saveSettings"),
      onclick: async () => {
        try {
          const res = await api.fetchJson("/api/backup/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              targets: targetSel.value,
              driveDir: driveInput.value.trim(),
              localRoot: localInput.value.trim(),
              safetyNet: safetyCheck.checked,
              maxFileBytes: Math.max(1, Number(maxMbInput.value) || 4096) * 1024 * 1024,
              retries: Number(retriesInput.value) || 0,
            }),
          });
          if (!res?.ok) {
            api.showToast(res?.error || "Failed to save settings");
            return;
          }
          if (res.state) serverState = res.state;
          api.showToast(api.tr("backup.toast.saved"));
          renderRail();
          renderSettings();
        } catch (err) {
          api.showToast(String(err?.message || err));
        }
      },
    });

    const globalGroup = el("div", { class: "s-group" }, [
      el("h4", { class: "s-group-title", text: api.tr("backup.settings.targetGroup") }),
      el("div", { class: "s-card" }, [
        makeRow("backup.settings.targetTitle", "backup.settings.targetDesc", targetSel),
        makeRow("backup.settings.driveDirTitle", "backup.settings.driveDirDesc", driveInput),
        makeRow("backup.settings.localRootTitle", "backup.settings.localRootDesc", localInput),
        makeRow("backup.settings.safetyNetTitle", "backup.settings.safetyNetDesc", safetyCheck),
        makeRow("backup.settings.maxSizeTitle", "backup.settings.maxSizeDesc", maxMbInput),
        makeRow("backup.settings.retriesTitle", "backup.settings.retriesDesc", retriesInput),
      ]),
      el("div", { class: "backup-settings-footer" }, [saveGlobalBtn]),
    ]);

    const sess = currentSessionName();
    const rulesGroupChildren = [
      el("h4", {
        class: "s-group-title",
        text: sess ? `${api.tr("backup.settings.rulesGroup")} (${sess})` : api.tr("backup.settings.rulesGroup"),
      }),
    ];

    if (!sess) {
      rulesGroupChildren.push(
        el("div", { class: "s-card" }, [
          el("div", { class: "s-row" }, [
            el("p", { class: "backup-hint", text: api.tr("backup.settings.noSession") }),
          ]),
        ]),
      );
    } else {
      const info = getSessionInfo(sess);
      const r = info.rules || {};

      const enabledCheck = el("input", { type: "checkbox", id: "backup-session-enabled" });
      enabledCheck.checked = Boolean(info.enabled);

      const pathsArea = el("textarea", {
        class: "s-textarea",
        id: "backup-rules-paths",
        placeholder: "/content/output",
      });
      pathsArea.value = (r.paths || ["/content/output"]).join("\n");

      const includeInput = el("input", {
        class: "s-input",
        type: "text",
        id: "backup-rules-include",
        value: (r.include || []).join(", "),
        placeholder: "*.pt, *.json",
      });

      const excludeInput = el("input", {
        class: "s-input",
        type: "text",
        id: "backup-rules-exclude",
        value: (r.exclude || []).join(", "),
        placeholder: "*.tmp, __pycache__, .ipynb_checkpoints",
      });

      const intervalInput = el("input", {
        class: "s-input s-num",
        type: "number",
        min: "10",
        max: "86400",
        id: "backup-rules-interval",
        value: String(r.intervalSec ?? 120),
      });

      const minAgeInput = el("input", {
        class: "s-input s-num",
        type: "number",
        min: "0",
        max: "3600",
        id: "backup-rules-min-age",
        value: String(r.minAgeSec ?? 20),
      });

      const saveRulesBtn = el("button", {
        type: "button",
        class: "backup-btn is-primary",
        text: api.tr("backup.settings.saveRules"),
        onclick: async () => {
          try {
            const res = await api.fetchJson("/api/backup/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                session: sess,
                enabled: enabledCheck.checked,
                rules: {
                  paths: pathsArea.value,
                  include: includeInput.value,
                  exclude: excludeInput.value,
                  intervalSec: Number(intervalInput.value) || 120,
                  minAgeSec: Number(minAgeInput.value) || 0,
                },
              }),
            });
            if (!res?.ok) {
              api.showToast(res?.error || "Failed to save rules");
              return;
            }
            if (res.state) serverState = res.state;
            api.showToast(api.tr("backup.toast.rulesSaved"));
            renderRail();
            renderSettings();
          } catch (err) {
            api.showToast(String(err?.message || err));
          }
        },
      });

      const clearBtn = el("button", {
        type: "button",
        class: "backup-btn",
        text: api.tr("backup.settings.clearManifest"),
        onclick: async () => {
          try {
            const res = await api.fetchJson("/api/backup/clear-manifest", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: sess }),
            });
            if (res?.state) serverState = res.state;
            api.showToast(api.tr("backup.toast.cleared"));
            renderRail();
          } catch {}
        },
      });

      const runBtn = el("button", {
        type: "button",
        class: "backup-btn",
        text: api.tr("backup.rail.backupNow"),
        onclick: () => triggerBackupNow(sess),
      });

      rulesGroupChildren.push(
        el("div", { class: "s-card" }, [
          makeRow("backup.settings.enabledTitle", "backup.settings.enabledDesc", enabledCheck),
          makeRow("backup.settings.pathsTitle", "backup.settings.pathsDesc", pathsArea),
          makeRow("backup.settings.includeTitle", "backup.settings.includeDesc", includeInput),
          makeRow("backup.settings.excludeTitle", "backup.settings.excludeDesc", excludeInput),
          makeRow("backup.settings.intervalTitle", "backup.settings.intervalDesc", intervalInput),
          makeRow("backup.settings.minAgeTitle", "backup.settings.minAgeDesc", minAgeInput),
        ]),
        el("div", { class: "backup-settings-footer" }, [clearBtn, runBtn, saveRulesBtn]),
      );
    }

    settingsEl.replaceChildren(globalGroup, el("div", { class: "s-group" }, rulesGroupChildren));
  }

  /* ── Mount & Wire Events ── */
  api.mount("rail", railEl);
  api.mount("settings-pane", {
    id: "backup",
    title: "backup.tab.title",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>`,
    element: settingsEl,
  });

  api.registerCommand({
    id: "backup.runNow",
    title: () => api.tr("backup.cmd.backupNow"),
    run: () => triggerBackupNow(),
  });

  api.onServerEvent("backup:state", (payload) => {
    if (payload && payload.ok) {
      serverState = payload;
      renderRail();
      renderSettings();
    }
  });

  api.onServerEvent("backup:error", (payload) => {
    if (!payload) return;
    const detail = Array.isArray(payload.errors) ? payload.errors[0] : "";
    const body = `${api.tr("backup.notify.failBody")} ${payload.session || ""}${detail ? ` — ${detail}` : ""}`;
    api.notifyNative?.({ title: api.tr("backup.notify.failTitle"), body });
    api.showToast(body);
  });

  api.onServerEvent("backup:safety-net", (payload) => {
    if (!payload?.session) return;
    api.showToast(`${api.tr("backup.toast.safetyNet")} (${payload.session})`);
  });

  for (const ev of ["session:change", "sessions:updated", "session:selected", "language:changed", "settings:mounted"]) {
    api.on?.(ev, () => {
      renderRail();
      renderSettings();
    });
  }

  // Initial render + lazy fetch
  renderRail();
  renderSettings();
  await refreshState();
}

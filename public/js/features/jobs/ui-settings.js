const DEFAULT_TEMPLATE = "[{status}] {job} ({duration}) @ {session}";

export function createJobsSettingsPane(api) {
  const root = document.createElement("div");
  root.className = "jobs-settings";

  let config = { notifyNative: true, sound: false, endpoints: [] };
  let loaded = false;

  function render() {
    root.replaceChildren();

    // Group 1: Completion Notifications
    const gNotify = document.createElement("div");
    gNotify.className = "s-group";
    gNotify.innerHTML = `<h4 class="s-group-title"></h4><div class="s-card"></div>`;
    gNotify.querySelector("h4").textContent = api.tr("jobs.settingsNotifyGroup");
    const notifyCard = gNotify.querySelector(".s-card");

    notifyCard.append(
      makeToggleRow(
        api.tr("jobs.settingsNativeTitle"),
        api.tr("jobs.settingsNativeDesc"),
        config.notifyNative !== false,
        (checked) => {
          config.notifyNative = checked;
        },
      ),
      makeToggleRow(
        api.tr("jobs.settingsSoundTitle"),
        api.tr("jobs.settingsSoundDesc"),
        !!config.sound,
        (checked) => {
          config.sound = checked;
        },
      ),
    );

    // Group 2: Webhooks
    const gWh = document.createElement("div");
    gWh.className = "s-group";
    const hWh = document.createElement("h4");
    hWh.className = "s-group-title";
    hWh.textContent = api.tr("jobs.settingsWebhooksGroup");
    const hint = document.createElement("p");
    hint.className = "jobs-settings-hint";
    hint.textContent = api.tr("jobs.settingsWebhooksHint");

    const list = document.createElement("div");
    list.className = "jobs-wh-list";

    if (!config.endpoints || config.endpoints.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jobs-wh-empty";
      empty.textContent = api.tr("jobs.settingsWebhooksEmpty");
      list.append(empty);
    } else {
      config.endpoints.forEach((ep, idx) => {
        list.append(renderEndpointCard(ep, idx));
      });
    }

    const actions = document.createElement("div");
    actions.className = "jobs-settings-actions";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "s-btn";
    addBtn.textContent = api.tr("jobs.action.addWebhook");
    addBtn.addEventListener("click", () => {
      config.endpoints = config.endpoints || [];
      config.endpoints.push({
        id: `ep-${Math.random().toString(36).slice(2, 9)}`,
        kind: "feishu",
        name: api.state?.activeLang === "en" ? "Feishu Bot" : "飞书机器人",
        enabled: true,
        url: "",
        token: "",
        chatId: "",
        template: DEFAULT_TEMPLATE,
        onSuccess: true,
        onFailure: true,
      });
      render();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "s-btn is-primary";
    saveBtn.textContent = api.tr("jobs.action.save");
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const res = await api.fetchJson("/api/jobs/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(config),
        });
        if (res?.ok && res.config) {
          config = res.config;
          api.showToast(api.tr("jobs.toastSaved"));
          render();
        } else {
          api.showToast(res?.error || "Failed to save");
        }
      } finally {
        saveBtn.disabled = false;
      }
    });

    actions.append(addBtn, saveBtn);
    gWh.append(hWh, hint, list, actions);
    root.append(gNotify, gWh);
  }

  function makeToggleRow(title, desc, checked, onChange) {
    const row = document.createElement("div");
    row.className = "s-row";
    const copy = document.createElement("div");
    copy.className = "s-copy";
    const t = document.createElement("span");
    t.className = "s-title";
    t.textContent = title;
    const d = document.createElement("span");
    d.className = "s-desc";
    d.textContent = desc;
    copy.append(t, d);

    const lbl = document.createElement("label");
    lbl.className = "s-toggle";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = checked;
    inp.addEventListener("change", () => onChange(inp.checked));
    const track = document.createElement("span");
    track.className = "s-toggle-track";
    lbl.append(inp, track);

    row.append(copy, lbl);
    return row;
  }

  function renderEndpointCard(ep, idx) {
    const card = document.createElement("div");
    card.className = "s-card jobs-wh-card";

    const topRow = document.createElement("div");
    topRow.className = "jobs-wh-top";

    const kindSel = document.createElement("select");
    kindSel.className = "s-select jobs-wh-kind";
    [
      ["feishu", api.tr("jobs.wh.kindFeishu")],
      ["telegram", api.tr("jobs.wh.kindTelegram")],
      ["generic", api.tr("jobs.wh.kindGeneric")],
    ].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (ep.kind === val) opt.selected = true;
      kindSel.append(opt);
    });
    kindSel.addEventListener("change", () => {
      ep.kind = kindSel.value;
      render();
    });

    const nameInp = document.createElement("input");
    nameInp.type = "text";
    nameInp.className = "jobs-input";
    nameInp.value = ep.name || "";
    nameInp.placeholder = api.tr("jobs.wh.name");
    nameInp.addEventListener("input", () => {
      ep.name = nameInp.value;
    });

    const enabledLbl = document.createElement("label");
    enabledLbl.className = "jobs-wh-check";
    const enabledInp = document.createElement("input");
    enabledInp.type = "checkbox";
    enabledInp.checked = ep.enabled !== false;
    enabledInp.addEventListener("change", () => {
      ep.enabled = enabledInp.checked;
    });
    enabledLbl.append(enabledInp, ` ${api.tr("jobs.wh.enabled")}`);

    topRow.append(kindSel, nameInp, enabledLbl);
    card.append(topRow);

    const fields = document.createElement("div");
    fields.className = "jobs-wh-fields";

    if (ep.kind === "telegram") {
      fields.append(
        makeInputField(api.tr("jobs.wh.token"), ep.token || "", "123456:ABC-DEF…", (v) => {
          ep.token = v;
        }),
        makeInputField(api.tr("jobs.wh.chatId"), ep.chatId || "", "-1001234567890", (v) => {
          ep.chatId = v;
        }),
      );
    } else {
      fields.append(
        makeInputField(
          api.tr("jobs.wh.url"),
          ep.url || "",
          ep.kind === "feishu" ? "https://open.feishu.cn/open-apis/bot/v2/hook/..." : "https://example.com/webhook",
          (v) => {
            ep.url = v;
          },
        ),
      );
    }

    fields.append(
      makeInputField(api.tr("jobs.wh.template"), ep.template || DEFAULT_TEMPLATE, DEFAULT_TEMPLATE, (v) => {
        ep.template = v;
      }),
    );
    card.append(fields);

    const foot = document.createElement("div");
    foot.className = "jobs-wh-foot";

    const triggers = document.createElement("div");
    triggers.className = "jobs-wh-triggers";
    const okChk = makeMiniCheck(api.tr("jobs.wh.onSuccess"), ep.onSuccess !== false, (v) => {
      ep.onSuccess = v;
    });
    const failChk = makeMiniCheck(api.tr("jobs.wh.onFailure"), ep.onFailure !== false, (v) => {
      ep.onFailure = v;
    });
    triggers.append(okChk, failChk);

    const btns = document.createElement("div");
    btns.className = "jobs-wh-btns";

    const statusSpan = document.createElement("span");
    statusSpan.className = "jobs-wh-test-status";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "s-btn";
    testBtn.textContent = api.tr("jobs.action.test");
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = api.tr("jobs.action.testing");
      statusSpan.textContent = "";
      try {
        const res = await api.fetchJson("/api/jobs/webhook-test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: ep.id, endpoint: ep }),
        });
        if (res?.ok) {
          statusSpan.className = "jobs-wh-test-status is-ok";
          statusSpan.textContent = `✓ ${res.status || 200}`;
          api.showToast(api.tr("jobs.toastTestOk"));
        } else {
          statusSpan.className = "jobs-wh-test-status is-err";
          statusSpan.textContent = res?.error || "Failed";
          api.showToast(`${api.tr("jobs.toastTestFail")}: ${res?.error || ""}`);
        }
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = api.tr("jobs.action.test");
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "s-btn is-danger";
    delBtn.textContent = api.tr("jobs.action.remove");
    delBtn.addEventListener("click", () => {
      config.endpoints.splice(idx, 1);
      render();
    });

    btns.append(statusSpan, testBtn, delBtn);
    foot.append(triggers, btns);
    card.append(foot);
    return card;
  }

  function makeInputField(label, value, placeholder, onInput) {
    const wrap = document.createElement("div");
    wrap.className = "jobs-field";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "jobs-input";
    inp.value = value;
    inp.placeholder = placeholder;
    inp.addEventListener("input", () => onInput(inp.value));
    wrap.append(lbl, inp);
    return wrap;
  }

  function makeMiniCheck(label, checked, onChange) {
    const lbl = document.createElement("label");
    lbl.className = "jobs-wh-check";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = checked;
    inp.addEventListener("change", () => onChange(inp.checked));
    lbl.append(inp, ` ${label}`);
    return lbl;
  }

  async function loadConfig() {
    const res = await api.fetchJson("/api/jobs/config");
    if (res?.ok && res.config) {
      config = res.config;
      loaded = true;
      render();
    }
  }

  render();

  return {
    element: root,
    ensureLoaded() {
      if (!loaded) loadConfig().catch(() => {});
    },
    refreshLabels: render,
  };
}

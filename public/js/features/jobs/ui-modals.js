export function fmtSec(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function createJobModals(api, { onSubmit, onCancel, onRerun, getJobById }) {
  let submitDlg = null;
  let logDlg = null;
  let activeLogJobId = null;

  function ensureSubmitDialog() {
    if (submitDlg) return submitDlg;
    submitDlg = document.createElement("dialog");
    submitDlg.id = "jobs-submit-modal";
    submitDlg.className = "jobs-modal";
    submitDlg.innerHTML = `
      <form class="jobs-modal-card" method="dialog">
        <div class="jobs-modal-head">
          <strong class="jobs-modal-title" data-role="title"></strong>
          <button type="button" class="icon-btn jobs-close-btn" data-role="close" aria-label="Close">✕</button>
        </div>
        <div class="jobs-modal-body">
          <div class="jobs-field">
            <label data-role="session-label"></label>
            <div class="jobs-session-pill" data-role="session-val"></div>
          </div>
          <div class="jobs-field-row">
            <div class="jobs-field">
              <label data-role="name-label"></label>
              <input type="text" class="jobs-input" data-role="name" maxlength="80" />
            </div>
            <div class="jobs-field jobs-field-sm">
              <label data-role="lang-label"></label>
              <select class="jobs-select" data-role="lang">
                <option value="python"></option>
                <option value="bash"></option>
              </select>
            </div>
          </div>
          <div class="jobs-field">
            <label data-role="code-label"></label>
            <textarea class="jobs-textarea" data-role="code" rows="8" spellcheck="false"></textarea>
          </div>
          <div class="jobs-form-error" data-role="err" hidden></div>
        </div>
        <div class="jobs-modal-foot">
          <button type="button" class="s-btn" data-role="cancel-btn"></button>
          <button type="submit" class="s-btn is-primary" data-role="submit-btn"></button>
        </div>
      </form>
    `;

    const close = () => submitDlg.close();
    submitDlg.querySelector('[data-role="close"]').addEventListener("click", close);
    submitDlg.querySelector('[data-role="cancel-btn"]').addEventListener("click", close);
    submitDlg.addEventListener("click", (e) => {
      if (e.target === submitDlg) close();
    });

    submitDlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = submitDlg.querySelector('[data-role="err"]');
      const btn = submitDlg.querySelector('[data-role="submit-btn"]');
      const sess = submitDlg.dataset.session || api.getSession()?.name || "";
      const title = submitDlg.querySelector('[data-role="name"]').value.trim();
      const language = submitDlg.querySelector('[data-role="lang"]').value;
      const code = submitDlg.querySelector('[data-role="code"]').value;

      if (!sess) {
        errEl.textContent = api.tr("jobs.toastNoSession");
        errEl.hidden = false;
        return;
      }
      if (!code.trim()) {
        errEl.textContent = api.state?.activeLang === "en" ? "Script is empty" : "脚本内容不能为空";
        errEl.hidden = false;
        return;
      }
      errEl.hidden = true;
      btn.disabled = true;
      try {
        const res = await onSubmit({ session: sess, language, code, title });
        if (res && res.ok) {
          submitDlg.querySelector('[data-role="code"]').value = "";
          submitDlg.querySelector('[data-role="name"]').value = "";
          submitDlg.close();
        } else {
          errEl.textContent = res?.error || "Failed";
          errEl.hidden = false;
        }
      } finally {
        btn.disabled = false;
      }
    });

    document.body.append(submitDlg);
    return submitDlg;
  }

  function openSubmitModal(prefill = {}) {
    const dlg = ensureSubmitDialog();
    const sess = prefill.session || api.getSession()?.name || "";
    dlg.dataset.session = sess;
    dlg.querySelector('[data-role="title"]').textContent = api.tr("jobs.submitTitle");
    dlg.querySelector('[data-role="session-label"]').textContent = api.tr("jobs.submitSession");
    dlg.querySelector('[data-role="session-val"]').textContent = sess || api.tr("jobs.submitNoSession");
    dlg.querySelector('[data-role="name-label"]').textContent = api.tr("jobs.submitNameLabel");
    dlg.querySelector('[data-role="name"]').placeholder = api.tr("jobs.submitNamePlaceholder");
    dlg.querySelector('[data-role="lang-label"]').textContent = api.tr("jobs.submitLangLabel");
    const langSel = dlg.querySelector('[data-role="lang"]');
    langSel.options[0].textContent = api.tr("jobs.submitLangPy");
    langSel.options[1].textContent = api.tr("jobs.submitLangBash");
    dlg.querySelector('[data-role="code-label"]').textContent = api.tr("jobs.submitCodeLabel");
    dlg.querySelector('[data-role="code"]').placeholder = api.tr("jobs.submitCodePlaceholder");
    dlg.querySelector('[data-role="cancel-btn"]').textContent = api.tr("jobs.action.close");
    dlg.querySelector('[data-role="submit-btn"]').textContent = api.tr("jobs.action.submit");
    dlg.querySelector('[data-role="err"]').hidden = true;

    if (prefill.title != null) dlg.querySelector('[data-role="name"]').value = prefill.title;
    if (prefill.language) langSel.value = prefill.language === "bash" || prefill.language === "command" ? "bash" : "python";
    if (prefill.code != null) dlg.querySelector('[data-role="code"]').value = prefill.code;

    if (!dlg.open) dlg.showModal();
    dlg.querySelector('[data-role="code"]').focus();
  }

  function ensureLogDialog() {
    if (logDlg) return logDlg;
    logDlg = document.createElement("dialog");
    logDlg.id = "jobs-log-modal";
    logDlg.className = "jobs-modal jobs-log-modal";
    logDlg.innerHTML = `
      <div class="jobs-modal-card jobs-log-card">
        <div class="jobs-modal-head">
          <div class="jobs-log-head-left">
            <strong class="jobs-modal-title" data-role="title"></strong>
            <span class="jobs-chip" data-role="chip"></span>
          </div>
          <div class="jobs-log-head-actions">
            <label class="jobs-autoscroll"><input type="checkbox" data-role="autoscroll" checked /> <span data-role="autoscroll-lbl"></span></label>
            <button type="button" class="s-btn" data-role="refresh"></button>
            <button type="button" class="s-btn is-danger" data-role="cancel" hidden></button>
            <button type="button" class="s-btn" data-role="rerun" hidden></button>
            <button type="button" class="icon-btn jobs-close-btn" data-role="close" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="jobs-log-meta" data-role="meta"></div>
        <pre class="jobs-log-pre" data-role="pre"></pre>
      </div>
    `;

    const close = () => {
      activeLogJobId = null;
      logDlg.close();
    };
    logDlg.querySelector('[data-role="close"]').addEventListener("click", close);
    logDlg.addEventListener("close", () => {
      activeLogJobId = null;
    });
    logDlg.addEventListener("click", (e) => {
      if (e.target === logDlg) close();
    });

    logDlg.querySelector('[data-role="refresh"]').addEventListener("click", async () => {
      if (!activeLogJobId) return;
      await fetchAndRenderLog(activeLogJobId, true);
    });
    logDlg.querySelector('[data-role="cancel"]').addEventListener("click", async () => {
      if (!activeLogJobId) return;
      await onCancel(activeLogJobId);
      renderLogHeader(getJobById(activeLogJobId));
    });
    logDlg.querySelector('[data-role="rerun"]').addEventListener("click", async () => {
      if (!activeLogJobId) return;
      const res = await onRerun(activeLogJobId);
      if (res?.ok && res.job) {
        activeLogJobId = res.job.id;
        renderLogHeader(res.job);
        logDlg.querySelector('[data-role="pre"]').textContent = api.tr("jobs.logEmpty");
      }
    });

    document.body.append(logDlg);
    return logDlg;
  }

  function renderLogHeader(job) {
    if (!logDlg || !job) return;
    logDlg.querySelector('[data-role="title"]').textContent = job.title || api.tr("jobs.logTitle");
    const chip = logDlg.querySelector('[data-role="chip"]');
    chip.textContent = api.tr(`jobs.status.${job.status}`) || job.status;
    chip.className = `jobs-chip is-${job.status}`;

    logDlg.querySelector('[data-role="autoscroll-lbl"]').textContent = api.tr("jobs.logAutoScroll");
    logDlg.querySelector('[data-role="refresh"]').textContent = api.tr("jobs.action.refresh");
    const cancelBtn = logDlg.querySelector('[data-role="cancel"]');
    const rerunBtn = logDlg.querySelector('[data-role="rerun"]');
    cancelBtn.textContent = api.tr("jobs.action.cancel");
    rerunBtn.textContent = api.tr("jobs.action.rerun");
    cancelBtn.hidden = job.status !== "running";
    rerunBtn.hidden = job.status === "running";

    const elapsed = ((job.endedAt || Date.now()) - job.startedAt) / 1000;
    const parts = [`${job.session}`, `${api.tr("jobs.elapsed")}: ${fmtSec(elapsed)}`];
    if (job.progress?.percent != null) parts.push(`${job.progress.percent}%`);
    if (job.progress?.rate) parts.push(job.progress.rate);
    if (job.progress?.etaSec != null && job.status === "running") {
      parts.push(`${api.tr("jobs.eta")}: ${fmtSec(job.progress.etaSec)}`);
    }
    if (job.exitCode != null) parts.push(`exit ${job.exitCode}`);
    logDlg.querySelector('[data-role="meta"]').textContent = parts.join(" · ");
  }

  async function fetchAndRenderLog(id, poll = false) {
    const dlg = ensureLogDialog();
    const res = await api.fetchJson(`/api/jobs/${encodeURIComponent(id)}/log?lines=400${poll ? "&poll=1" : ""}`);
    if (res?.ok) {
      if (res.job) renderLogHeader(res.job);
      const pre = dlg.querySelector('[data-role="pre"]');
      pre.textContent = res.log || api.tr("jobs.logEmpty");
      if (dlg.querySelector('[data-role="autoscroll"]').checked) {
        pre.scrollTop = pre.scrollHeight;
      }
    }
  }

  async function openLogModal(id) {
    const dlg = ensureLogDialog();
    activeLogJobId = id;
    const job = getJobById(id);
    if (job) renderLogHeader(job);
    dlg.querySelector('[data-role="pre"]').textContent = job?.tail || api.tr("jobs.logEmpty");
    if (!dlg.open) dlg.showModal();
    await fetchAndRenderLog(id, job?.status === "running");
  }

  function onJobUpdated(job) {
    if (!logDlg || !logDlg.open || activeLogJobId !== job.id) return;
    renderLogHeader(job);
    if (typeof job.tail === "string") {
      const pre = logDlg.querySelector('[data-role="pre"]');
      pre.textContent = job.tail || api.tr("jobs.logEmpty");
      if (logDlg.querySelector('[data-role="autoscroll"]').checked) {
        pre.scrollTop = pre.scrollHeight;
      }
    }
  }

  return { openSubmitModal, openLogModal, onJobUpdated };
}

export const NEW_SESSION_MODAL_HTML = `
  <dialog id="new-session-modal" class="modal" aria-labelledby="new-session-title">
    <form id="new-session-form" class="modal-form" method="dialog">
      <div class="modal-head">
        <h3 id="new-session-title" data-i18n="modal.newSession.title">新建会话</h3>
        <button id="close-new-session" class="icon-btn" type="button" aria-label="Close" data-i18n-title="modal.close" title="关闭">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
        </button>
      </div>
      <div class="modal-field recipe-picker-field" id="recipe-picker-row">
        <div class="recipe-picker-head">
          <label class="field-label" for="recipe-picker-select" data-i18n="recipes.pickerLabel">会话配方</label>
          <div class="recipe-picker-actions">
            <button id="save-as-recipe-btn" class="recipe-mini-btn" type="button" data-i18n="recipes.saveAs">存为配方</button>
            <button id="manage-recipes-btn" class="recipe-mini-btn" type="button" data-i18n="recipes.manage">管理</button>
          </div>
        </div>
        <select id="recipe-picker-select" class="recipe-select" aria-label="Session recipe">
          <option value="" data-i18n="recipes.noneSelected">— 不使用配方（自定义配置）—</option>
        </select>
        <div id="recipe-picker-summary" class="recipe-picker-summary" hidden></div>
      </div>
      <div class="modal-field">
        <label class="field-label" for="session-name" data-i18n="modal.newSession.name">会话名称</label>
        <input id="session-name" type="text" placeholder="train-t4" aria-label="session name" autocomplete="off" />
      </div>
      <fieldset id="hardware-picker" data-region="hardware-picker">
        <legend><span data-i18n="modal.newSession.hardware">选择服务器硬件</span> <span class="sr-only">Hardware picker</span></legend>
        <div class="chips" role="radiogroup" aria-label="hardware picker">
          <label class="is-selected"><input type="radio" name="hardware" value="cpu" checked /> CPU</label>
          <label><input type="radio" name="hardware" value="T4" /> T4</label>
          <label><input type="radio" name="hardware" value="L4" /> L4</label>
          <label><input type="radio" name="hardware" value="G4" /> G4</label>
          <label><input type="radio" name="hardware" value="H100" /> H100</label>
          <label><input type="radio" name="hardware" value="A100" /> A100</label>
          <label><input type="radio" name="hardware" value="v5e1" /> v5e1</label>
          <label><input type="radio" name="hardware" value="v6e1" /> v6e1</label>
        </div>
        <label class="high-mem"><input id="high-mem" type="checkbox" checked /> <span data-i18n="modal.newSession.highMem">high-mem（高内存规格）</span></label>
        <p class="high-mem-note" id="high-mem-note" hidden data-i18n="modal.newSession.highMemNote">L4 / TPU 仅提供单一内存规格，CLI 会忽略 --high-mem。</p>
      </fieldset>
      <details id="snipe-queue-section" class="snipe-queue-section">
        <summary class="snipe-queue-summary">
          <span data-i18n="recipes.snipeQueueTitle">多规格抢卡优先级队列</span>
          <span id="snipe-queue-badge" class="recipe-badge" hidden></span>
        </summary>
        <div class="snipe-queue-body">
          <div id="snipe-target-list" class="snipe-target-list" role="list" aria-label="Snipe priority targets"></div>
          <div class="snipe-add-row">
            <select id="snipe-add-hw" class="recipe-select" aria-label="Add accelerator target">
              <option value="A100">A100</option>
              <option value="H100">H100</option>
              <option value="L4">L4</option>
              <option value="G4">G4</option>
              <option value="T4">T4</option>
              <option value="v6e1">v6e1 (TPU)</option>
              <option value="v5e1">v5e1 (TPU)</option>
              <option value="cpu">CPU</option>
            </select>
            <label class="snipe-add-hm"><input id="snipe-add-highmem" type="checkbox" checked /> <span data-i18n="modal.newSession.highMemShort">高内存</span></label>
            <button id="snipe-add-target-btn" class="recipe-mini-btn" type="button" data-i18n="recipes.addTarget">添加</button>
          </div>
          <div class="snipe-params-grid">
            <label class="snipe-param">
              <span data-i18n="recipes.intervalSec">重试间隔(秒)</span>
              <input id="snipe-interval-sec" type="number" min="5" max="3600" value="10" />
            </label>
            <label class="snipe-param">
              <span data-i18n="recipes.maxAttempts">最大轮次(0=不限)</span>
              <input id="snipe-max-attempts" type="number" min="0" max="10000" value="0" />
            </label>
            <label class="snipe-param">
              <span data-i18n="recipes.timeoutMin">超时(分钟,0=不限)</span>
              <input id="snipe-timeout-min" type="number" min="0" max="10080" value="0" />
            </label>
          </div>
        </div>
      </details>
      <div id="new-session-cmd" class="modal-cmd">colab new -s &lt;name&gt;</div>
      <div id="new-session-status" class="modal-status" hidden></div>
      <p id="new-session-error" class="modal-error" hidden></p>
      <div class="modal-foot">
        <button id="bg-snipe-btn" class="btn-snipe" type="button" data-i18n="modal.newSession.bgSnipe">转后台抢卡</button>
        <button id="cancel-new-session" class="btn-secondary" type="button" data-i18n="modal.newSession.cancel">取消</button>
        <button id="start-session" class="btn-primary" type="submit" data-i18n="modal.newSession.start">开始</button>
      </div>
    </form>
  </dialog>
`;

export const COLAB_CU_MODAL_HTML = `
  <dialog id="colab-cu-modal" class="modal" aria-labelledby="cu-modal-title">
    <div class="modal-form">
      <div class="modal-head">
        <h3 id="cu-modal-title" data-i18n="modal.cu.title">Colab 计算单元 (CU)</h3>
        <button id="close-cu-modal" class="icon-btn" type="button" aria-label="关闭弹窗">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
        </button>
      </div>
      <div class="stat-grid">
        <div class="stat-box">
          <span class="stat-label" data-i18n="modal.cu.balance">剩余计算单元</span>
          <span id="cu-balance" class="stat-val">—</span>
          <span id="cu-est-hours" class="stat-sub">—</span>
        </div>
        <div class="stat-box">
          <span class="stat-label" data-i18n="modal.cu.rate">当前消耗速率</span>
          <span id="cu-rate" class="stat-val">—</span>
          <span id="cu-active" class="stat-sub">—</span>
        </div>
      </div>
      <pre id="cu-raw-output" class="cu-raw">colab usage…</pre>
      <div class="modal-foot">
        <button id="refresh-cu-modal" class="btn-secondary" type="button" data-i18n="modal.cu.refresh">刷新</button>
        <button id="done-cu-modal" class="btn-primary" type="button" data-i18n="modal.cu.close">关闭</button>
      </div>
    </div>
  </dialog>
`;

export const AGENT_USAGE_MODAL_HTML = `
  <dialog id="agent-usage-modal" class="modal" aria-labelledby="usage-modal-title">
    <div class="modal-form">
      <div class="modal-head">
        <h3 id="usage-modal-title" data-i18n="modal.usage.title">Agent 剩余额度</h3>
        <button id="close-usage-modal" class="icon-btn" type="button" aria-label="关闭弹窗">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
        </button>
      </div>
      <div id="agent-quota-body" class="quota-section">
        <p class="quota-note">AGY / Grok / OpenCode…</p>
      </div>
      <div class="quota-section">
        <div class="quota-section-head">
          <span class="quota-section-title" data-i18n="modal.usage.local">本应用对话累计</span>
          <span id="stat-local-summary" class="quota-section-sub">0 · 0 tok</span>
        </div>
      </div>
      <div class="modal-foot">
        <button id="refresh-agent-quota" class="btn-secondary" type="button" data-i18n="modal.usage.refresh">刷新额度</button>
        <button id="done-usage-modal" class="btn-primary" type="button" data-i18n="modal.usage.close">关闭</button>
      </div>
    </div>
  </dialog>
`;

export const FILES_MODAL_HTML = `
  <dialog id="files-modal" class="wide-modal" aria-labelledby="files-modal-title">
    <div class="wide-modal-shell">
      <div class="wide-modal-head">
        <h3 id="files-modal-title" data-i18n="files.title">云端文件管理器</h3>
        <div class="s-actions">
          <button id="files-go-content" class="s-btn" type="button">/content</button>
          <button id="files-go-drive" class="s-btn" type="button">Google Drive</button>
          <button id="files-mount-drive" class="s-btn" type="button" hidden data-i18n="files.mountDrive">挂载 Drive</button>
          <button id="files-upload-btn" class="s-btn is-primary" type="button" data-i18n="files.upload">上传文件</button>
          <input id="files-upload-input" type="file" multiple hidden />
          <button id="files-refresh-btn" class="s-btn" type="button" data-i18n="ws.refresh">刷新</button>
          <button id="close-files-modal" class="icon-btn" type="button" aria-label="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
          </button>
        </div>
      </div>
      <div class="files-toolbar">
        <span id="files-current-path" class="files-path">/content</span>
        <div class="s-actions">
          <button id="files-mode-list" class="s-btn is-primary" type="button" data-i18n="files.listView">列表</button>
          <button id="files-mode-gallery" class="s-btn" type="button" data-i18n="files.galleryView">媒体画廊</button>
          <button id="files-batch-dl" class="s-btn" type="button" hidden data-i18n="files.batchDownload">批量下载</button>
          <button id="files-copy-drive" class="s-btn" type="button" hidden data-i18n="files.copyDrive">存到 Drive</button>
          <span id="files-status-note" class="s-desc"></span>
        </div>
      </div>
      <div class="files-body">
        <div id="files-list" class="files-list"></div>
        <div id="files-preview" class="files-preview">
          <p class="s-desc" data-i18n="files.previewHint">点击左侧文件即可预览内容，或直接拖入本地文件上传到当前目录。</p>
        </div>
      </div>
    </div>
  </dialog>
`;

export const TEMPLATES_MODAL_HTML = `
  <dialog id="templates-modal" class="wide-modal" aria-labelledby="templates-modal-title">
    <div class="wide-modal-shell">
      <div class="wide-modal-head">
        <h3 id="templates-modal-title" data-i18n="templates.title">常用任务模板</h3>
        <button id="close-templates-modal" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
        </button>
      </div>
      <div class="templates-body">
        <div id="templates-list" class="templates-list"></div>
        <form id="template-form" class="tpl-form">
          <span class="s-title" data-i18n="templates.addTitle">保存新模板</span>
          <input id="tpl-title-input" class="s-input" type="text" data-i18n-placeholder="templates.titlePlaceholder" placeholder="模板名称，例如：部署 Ollama 推理" required />
          <textarea id="tpl-prompt-input" class="tpl-textarea" data-i18n-placeholder="templates.promptPlaceholder" placeholder="输入让 Agent 执行的完整指令…" required></textarea>
          <button class="s-btn is-primary" type="submit" data-i18n="templates.save">保存模板</button>
        </form>
      </div>
    </div>
  </dialog>
`;

export const RUNNER_MODAL_HTML = `
  <dialog id="runner-modal" class="wide-modal" aria-labelledby="runner-modal-title">
    <div class="wide-modal-shell">
      <div class="wide-modal-head">
        <h3 id="runner-modal-title" data-i18n="runner.title">参数化直连运行器（不经过 Agent）</h3>
        <div class="s-actions">
          <button id="runner-new-btn" class="s-btn" type="button" data-i18n="runner.newBtn">+ 新建脚本</button>
          <button id="close-runner-modal" class="icon-btn" type="button" aria-label="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
          </button>
        </div>
      </div>
      <div class="runner-body">
        <div id="runner-sidebar" class="runner-sidebar"></div>
        <div class="runner-main">
          <div class="s-form-grid">
            <div class="s-field">
              <label for="runner-name" data-i18n="runner.nameLabel">脚本名称</label>
              <input id="runner-name" class="s-input" type="text" data-i18n-placeholder="runner.namePlaceholder" placeholder="例如：MiniMax / Diffusers 生图脚本" />
            </div>
            <div class="s-field">
              <label for="runner-runtime" data-i18n="runner.runtimeLabel">执行环境</label>
              <select id="runner-runtime" class="s-select" style="width:100%;">
                <option value="python">Python (colab exec)</option>
                <option value="bash">Bash (colab ssh)</option>
              </select>
            </div>
          </div>
          <div id="runner-params-wrap" class="runner-params-grid"></div>
          <div class="s-field">
            <label for="runner-code" data-i18n="runner.codeLabel">脚本内容（支持 {{prompt}}、{{seed}} 等占位符，自动生成上方参数表单）</label>
            <textarea id="runner-code" class="tpl-textarea" style="min-height:150px;font-family:var(--mono);font-size:12px;" placeholder="import os&#10;prompt = os.environ.get('COLAB_PARAM_PROMPT', '''{{prompt}}''')&#10;print('Running:', prompt)"></textarea>
          </div>
          <div class="s-actions">
            <button id="runner-exec-btn" class="s-btn is-primary" type="button" data-i18n="runner.run">▶ 直接在 VM 运行</button>
            <button id="runner-save-btn" class="s-btn" type="button" data-i18n="runner.save">保存脚本</button>
            <button id="runner-delete-btn" class="s-btn is-danger" type="button" hidden data-i18n="runner.deleteBtn">删除</button>
            <span id="runner-status" class="s-desc"></span>
          </div>
          <div id="runner-media" class="runner-media-grid"></div>
          <pre id="runner-output" class="s-log" style="max-height:200px;" hidden></pre>
        </div>
      </div>
    </div>
  </dialog>
`;

export const SYNC_MODAL_HTML = `
  <dialog id="sync-modal" class="modal" aria-labelledby="sync-modal-title">
    <div class="modal-form">
      <div class="modal-head">
        <h3 id="sync-modal-title" data-i18n="sync.title">本地 ↔ 云端目录同步</h3>
        <button id="close-sync-modal" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
        </button>
      </div>
      <div class="s-field">
        <label for="sync-local-input" data-i18n="sync.localLabel">本机目录绝对路径（自动排除 .git / node_modules / __pycache__）</label>
        <input id="sync-local-input" class="s-input" type="text" placeholder="~/Projects/my-model" />
      </div>
      <div class="s-field">
        <label for="sync-remote-input" data-i18n="sync.remoteLabel">Colab 云端目录路径</label>
        <input id="sync-remote-input" class="s-input" type="text" placeholder="/content/my-model" />
      </div>
      <pre id="sync-log" class="s-log" hidden></pre>
      <div class="modal-foot">
        <button id="sync-pull-btn" class="btn-secondary" type="button" data-i18n="sync.pull">从云端拉回 ↓</button>
        <button id="sync-push-btn" class="btn-primary" type="button" data-i18n="sync.push">推送到云端 ↑</button>
      </div>
    </div>
  </dialog>
`;

export const CMD_PALETTE_MODAL_HTML = `
  <dialog id="cmd-palette-modal" class="palette-modal" aria-label="Command Palette">
    <input id="cmd-palette-input" class="palette-input" type="text" data-i18n-placeholder="palette.placeholder" placeholder="输入命令、切换会话或打开面板… (⌘K)" autocomplete="off" />
    <div id="cmd-palette-list" class="palette-list"></div>
  </dialog>
`;

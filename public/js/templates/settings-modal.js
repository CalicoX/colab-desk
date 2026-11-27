export const SETTINGS_MODAL_HTML = `
  <dialog id="settings-modal" class="settings-modal" aria-labelledby="settings-modal-title">
    <div class="settings-shell">
      <nav class="settings-sidebar" aria-label="设置分类">
        <div class="settings-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-search" /></svg>
          <input id="settings-search-input" type="search" data-i18n-placeholder="settings.search" placeholder="搜索" aria-label="搜索设置" />
          <kbd>/</kbd>
        </div>

        <button class="settings-nav-btn is-active" type="button" data-settings-tab="general">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          <span data-i18n="settings.tab.general">通用</span>
        </button>
        <button class="settings-nav-btn" type="button" data-settings-tab="chat">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span data-i18n="settings.tab.chat">聊天</span>
        </button>

        <div class="settings-nav-section" data-i18n="settings.section.agents">智能体</div>
        <button class="settings-nav-btn" type="button" data-settings-tab="providers">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/><path d="M9 15h6"/></svg>
          <span data-i18n="settings.tab.providers">智能体提供方</span>
        </button>
        <button class="settings-nav-btn" type="button" data-settings-tab="safety">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span data-i18n="settings.tab.safety">安全与权限</span>
        </button>

        <div class="settings-nav-section" data-i18n="settings.section.connection">连接</div>
        <button class="settings-nav-btn" type="button" data-settings-tab="colab">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <span data-i18n="settings.tab.colab">Colab 环境</span>
          <span id="nav-colab-dot" class="settings-nav-dot" hidden></span>
        </button>

        <div class="settings-nav-section" data-i18n="settings.section.system">系统</div>
        <button class="settings-nav-btn" type="button" data-settings-tab="maintenance">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          <span data-i18n="settings.tab.maintenance">维护</span>
        </button>
        <button class="settings-nav-btn" type="button" data-settings-tab="about">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <span data-i18n="settings.tab.about">关于</span>
        </button>
      </nav>

      <div class="settings-main">
        <div class="settings-topbar">
          <div class="settings-crumb" id="settings-modal-title"><span data-i18n="settings.title">设置</span> / <strong id="settings-crumb-tab">通用</strong></div>
          <div class="settings-topbar-actions">
            <button id="settings-restore-defaults" class="settings-reset-btn" type="button" data-i18n="settings.restoreDefaults">↺ 恢复默认设置</button>
            <button id="close-settings-modal" class="icon-btn" type="button" aria-label="关闭设置">
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-close" /></svg>
            </button>
          </div>
        </div>

        <div class="settings-scroll">
          <!-- Tab: General -->
          <section class="settings-pane is-active" data-settings-pane="general">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.general.langGroup">语言与界面</h4>
              <div class="s-card">
                <div class="s-row" data-search="语言 language english chinese 中文 英文 系统">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.langTitle">界面语言</span>
                    <span class="s-desc" data-i18n="settings.general.langDesc">默认跟随系统语言自动切换，也可以手动固定为简体中文或 English。</span>
                  </div>
                  <select id="setting-language" class="s-select">
                    <option value="auto" id="opt-lang-auto">跟随系统</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </div>
                <div class="s-row" data-search="主题 外观 theme appearance dark light system 深色 浅色">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.themeTitle">外观主题</span>
                    <span class="s-desc" data-i18n="settings.general.themeDesc">支持深色、浅色或自动跟随 macOS 系统外观切换。</span>
                  </div>
                  <select id="setting-theme" class="s-select">
                    <option value="system" data-i18n="settings.general.themeSystem">跟随系统</option>
                    <option value="dark" data-i18n="settings.general.themeDark">深色</option>
                    <option value="light" data-i18n="settings.general.themeLight">浅色</option>
                  </select>
                </div>
                <div class="s-row is-column" data-search="皮肤 配色 颜色 skin palette color theme ocean emerald rose amber nord paper obsidian">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.skinTitle">配色皮肤</span>
                    <span class="s-desc" data-i18n="settings.general.skinDesc">选择你喜欢的界面配色方案，支持实时切换与自动保存。</span>
                  </div>
                  <div id="skin-picker-grid" class="skin-grid"></div>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.general.inputGroup">输入与发送</h4>
              <div class="s-card">
                <div class="s-row" data-search="回车 发送 指令 enter shortcut send">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.enterTitle">回车发送指令</span>
                    <span class="s-desc" data-i18n="settings.general.enterDesc">开启后按 Enter 直接发送指令（Agent 与 CLI 均生效），Shift+Enter 换行。</span>
                  </div>
                  <label class="s-toggle"><input id="setting-enter-send" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="默认 操作 模式 agent cli mode">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.modeTitle">默认操作模式</span>
                    <span class="s-desc" data-i18n="settings.general.modeDesc">启动应用时底部输入框默认展示自然语言 Agent 模式或手动 CLI 模式。</span>
                  </div>
                  <select id="setting-mode" class="s-select">
                    <option value="agent" data-i18n="settings.general.modeAgent">Agent 模式</option>
                    <option value="notebook" data-i18n="ws.modeNotebook">Notebook</option>
                    <option value="cli" data-i18n="settings.general.modeCli">CLI 模式</option>
                  </select>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.general.panelsGroup">侧边栏与面板</h4>
              <div class="s-card">
                <div class="s-row" data-search="右侧 面板 inspector panel rail 折叠 收起 展开">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.railTitle">展开右侧信息面板</span>
                    <span class="s-desc" data-i18n="settings.general.railDesc">显示或收起右侧 Colab VM 状态与计算单元配额面板（快捷键 ⌘.）。</span>
                  </div>
                  <label class="s-toggle"><input id="setting-rail-open" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="侧边栏 宽度 折叠 收起 sidebar reset">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.resetSidebarTitle">重置侧边栏布局</span>
                    <span class="s-desc" data-i18n="settings.general.resetSidebarDesc">恢复左侧导航栏默认 272px 宽度并同时展开左右两侧面板。</span>
                  </div>
                  <button id="setting-reset-sidebar" class="s-btn" type="button" data-i18n="settings.general.resetBtn">恢复默认</button>
                </div>
                <div class="s-row" data-search="gpu 监控 显存 轮询 telemetry poll">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.gpuPollTitle">GPU 显存与端口自动轮询</span>
                    <span class="s-desc" data-i18n="settings.general.gpuPollDesc">连接 GPU 会话时每 15 秒自动刷新显存占用、GPU 进程与新启动的 Web 端口。</span>
                  </div>
                  <label class="s-toggle"><input id="setting-gpu-poll" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="高内存 high-mem high ram default session 新建会话">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.general.highMemTitle">新建会话默认选中高内存</span>
                    <span class="s-desc" data-i18n="settings.general.highMemDesc">打开新建 Colab 会话弹窗时默认勾选 --high-mem（L4 / TPU 单一内存规格将自动忽略）。</span>
                  </div>
                  <label class="s-toggle"><input id="setting-default-high-mem" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
              </div>
            </div>
          </section>

          <!-- Tab: Chat -->
          <section class="settings-pane" data-settings-pane="chat">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.chat.group">显示与思考过程</h4>
              <div class="s-card">
                <div class="s-row" data-search="思考 过程 thinking 展开 折叠 reasoning">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.chat.keepThoughtTitle">思考过程保持展开</span>
                    <span class="s-desc" data-i18n="settings.chat.keepThoughtDesc">回复完成后默认保持展开思考块，不自动折叠。</span>
                  </div>
                  <label class="s-toggle"><input id="setting-keep-thought" type="checkbox" /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="本地 存储 聊天记录 持久化 history local">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.chat.localHistoryTitle">本地自动保存聊天记录</span>
                    <span class="s-desc" data-i18n="settings.chat.localHistoryDesc">所有会话对话与用量统计自动写入 ~/.config/colab-desk/state.json，重启不丢失。</span>
                  </div>
                  <span class="s-badge is-ok" data-i18n="settings.chat.enabled">已启用</span>
                </div>
                <div class="s-row" data-search="queue steer 排队 转向 插队 运行中 发送">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.chat.busySendTitle">Agent 运行中发送行为</span>
                    <span class="s-desc" data-i18n="settings.chat.busySendDesc">当 Agent 正在回复或执行工具时，按 Enter 发送消息是加入队列等待（Queue），还是立即中断当前回合转向（Steer）。</span>
                  </div>
                  <select id="setting-busy-send-mode" class="s-select" aria-label="运行中发送行为">
                    <option value="queue" data-i18n="settings.chat.busyQueue">排队等待 (Queue)</option>
                    <option value="steer" data-i18n="settings.chat.busySteer">立即转向 (Steer)</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          <!-- Tab: Agent Providers -->
          <section class="settings-pane" data-settings-pane="providers">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.providers.acpGroup">Antigravity (AGY) ACP 认证</h4>
              <div class="s-card">
                <div class="s-row is-column" data-search="agy antigravity acp auth login oauth google 认证 登录">
                  <div class="s-row" style="padding:0;width:100%;border:0;">
                    <div class="s-copy">
                      <span class="s-title" data-i18n="settings.providers.acpTitle">Antigravity ACP 协议认证</span>
                      <span id="agy-acp-status-desc" class="s-desc" data-i18n="settings.providers.acpDesc">AGY 始终通过官方 agy acp 走 Antigravity ACP 原生认证与套餐配额。</span>
                    </div>
                    <span id="agy-acp-status-badge" class="s-badge is-warn">检测中</span>
                  </div>
                  <div class="s-actions" style="width:100%;align-items:center;">
                    <select id="agy-acp-method" class="s-select" aria-label="Antigravity ACP 认证方式">
                      <option value="oauth-personal" data-i18n="settings.providers.acpMethodPersonal">使用 Google 账号登录 (oauth-personal)</option>
                      <option value="oauth-business" data-i18n="settings.providers.acpMethodBusiness">使用 Gemini Enterprise 登录 (oauth-business)</option>
                      <option value="agent-platform" data-i18n="settings.providers.acpMethodPlatform">Agent Platform / ADC (agent-platform)</option>
                      <option value="gemini-api-key" data-i18n="settings.providers.acpMethodApiKey">Gemini API Key (gemini-api-key)</option>
                    </select>
                    <button id="agy-acp-login-btn" class="s-btn is-primary" type="button" data-i18n="settings.providers.acpLogin">Antigravity ACP 登录</button>
                    <button id="agy-acp-logout-btn" class="s-btn is-danger" type="button" hidden data-i18n="settings.providers.acpLogout">退出登录</button>
                    <button id="agy-acp-refresh-btn" class="s-btn" type="button" data-i18n="settings.providers.acpRefresh">刷新状态</button>
                  </div>
                  <pre id="agy-acp-log" class="s-log" hidden></pre>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.providers.localGroup">本机已安装 Agent CLI</h4>
              <div id="setting-provider-list" class="s-card"></div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.providers.apiGroup">自定义 API 提供方（无需安装任何本机 Agent）</h4>
              <div class="s-card">
                <div class="s-row is-column" data-search="api key openai deepseek openrouter gemini ollama 自定义 模型 零安装 custom">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.providers.apiTitle">OpenAI 兼容 API（内置 Colab 工具调用）</span>
                    <span class="s-desc" data-i18n="settings.providers.apiDesc">即使本机完全没装 AGY / Grok / OpenCode，填入任意兼容接口即可直接让 AI 操控 Colab。API Key 仅保存在本机 0600 权限文件中。</span>
                  </div>
                  <div id="api-profiles-list" class="api-profile-list"></div>
                  <div class="s-presets">
                    <button class="s-preset" type="button" data-api-preset="openai">OpenAI</button>
                    <button class="s-preset" type="button" data-api-preset="deepseek">DeepSeek</button>
                    <button class="s-preset" type="button" data-api-preset="openrouter">OpenRouter</button>
                    <button class="s-preset" type="button" data-api-preset="gemini">Gemini</button>
                    <button class="s-preset" type="button" data-api-preset="ollama">Ollama</button>
                  </div>
                  <div class="s-form-grid">
                    <div class="s-field">
                      <label for="api-label" data-i18n="settings.providers.apiLabel">显示名称</label>
                      <input id="api-label" class="s-input" type="text" placeholder="DeepSeek / OpenAI" />
                    </div>
                    <div class="s-field">
                      <label for="api-model" data-i18n="settings.providers.apiModel">模型名称</label>
                      <input id="api-model" class="s-input" type="text" list="api-models-datalist" placeholder="gpt-4o / deepseek-chat" />
                      <datalist id="api-models-datalist"></datalist>
                    </div>
                    <div class="s-field is-full">
                      <label for="api-base-url" data-i18n="settings.providers.apiBaseUrl">Base URL</label>
                      <input id="api-base-url" class="s-input" type="text" placeholder="https://api.openai.com/v1" />
                    </div>
                    <div class="s-field is-full">
                      <label for="api-key" data-i18n="settings.providers.apiKey">API Key（本地 Ollama 可留空）</label>
                      <input id="api-key" class="s-input" type="password" placeholder="sk-..." autocomplete="off" />
                    </div>
                  </div>
                  <div class="s-actions">
                    <button id="api-save-btn" class="s-btn is-primary" type="button" data-i18n="settings.providers.apiSave">保存并启用</button>
                    <button id="api-fetch-models-btn" class="s-btn" type="button" data-i18n="settings.providers.apiFetchModels">拉取模型</button>
                    <button id="api-test-btn" class="s-btn" type="button" data-i18n="settings.providers.apiTest">测试连接</button>
                    <span id="api-test-status" class="s-desc"></span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Tab: Safety & Permissions -->
          <section class="settings-pane" data-settings-pane="safety">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.safety.group">确认操作</h4>
              <div class="s-card">
                <div class="s-row" data-search="权限 确认 自动 执行 approval permission">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.safety.approvalTitle">Agent 执行权限</span>
                    <span class="s-desc" data-i18n="settings.safety.approvalDesc">选择「执行前确认」时，Agent 每次执行命令前会在聊天区弹出允许/拒绝卡片。</span>
                  </div>
                  <select id="setting-approval" class="s-select">
                    <option value="auto" data-i18n="settings.safety.auto">自动执行</option>
                    <option value="ask" data-i18n="settings.safety.ask">执行前确认</option>
                  </select>
                </div>
                <div class="s-row" data-search="安全 计费 护栏 stop new rm guardrail">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.safety.guardTitle">算力计费与删文件护栏</span>
                    <span class="s-desc" data-i18n="settings.safety.guardDesc">提示词内置约束：除非你明确要求，Agent 不会擅自执行 colab new（开卡计费）、colab stop（释放机器）或 colab rm（删文件）。</span>
                  </div>
                  <span class="s-badge is-ok" data-i18n="settings.safety.defaultOn">默认开启</span>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.safety.notifyGroup">通知与成本保护</h4>
              <div class="s-card">
                <div class="s-row" data-search="通知 notification macos alert 提醒">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.safety.notifyTitle">任务完成 / 异常系统通知</span>
                    <span class="s-desc" data-i18n="settings.safety.notifyDesc">当耗时较长的 Agent 任务完成或执行失败时，发送 macOS 原生系统通知。</span>
                  </div>
                  <label class="s-toggle"><input id="setting-notify-complete" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="cu 余额 告警 阈值 成本 cost balance">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.safety.cuAlertTitle">CU 余额低水位提醒</span>
                    <span class="s-desc" data-i18n="settings.safety.cuAlertDesc">计算单元余额低于设定值时弹出提醒（设为 0 关闭）。</span>
                  </div>
                  <input id="setting-cu-alert" class="s-num-input" type="number" min="0" max="10000" step="10" value="50" />
                </div>
                <div class="s-row" data-search="空闲 idle vm 超时 释放 省钱">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.safety.idleAlertTitle">空闲 GPU VM 超时提醒（分钟）</span>
                    <span class="s-desc" data-i18n="settings.safety.idleAlertDesc">活跃会话连续空闲超过该分钟数后提醒是否释放 VM 以节省额度（0 关闭）。</span>
                  </div>
                  <input id="setting-idle-alert" class="s-num-input" type="number" min="0" max="720" step="5" value="30" />
                </div>
              </div>
            </div>
          </section>

          <!-- Tab: Colab CLI & Login Diagnostics -->
          <section class="settings-pane" data-settings-pane="colab">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.colab.healthGroup">Colab CLI 健康检查</h4>
              <div class="s-card">
                <div class="s-row" data-search="colab cli 安装 版本 检查 install version">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.cliTitle">官方 colab CLI</span>
                    <span id="env-cli-desc" class="s-desc">google-colab-cli…</span>
                  </div>
                  <span id="env-cli-badge" class="s-badge is-warn">…</span>
                </div>
                <div class="s-row" data-search="colab 登录 oauth 账号 邮箱 whoami account login">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.authTitle">Google Colab 登录状态</span>
                    <span id="env-auth-desc" class="s-desc">…</span>
                  </div>
                  <span id="env-auth-badge" class="s-badge is-warn">…</span>
                </div>
                <div class="s-row" data-search="刷新 重新 检测 环境 recheck">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.recheckTitle">重新检测环境</span>
                    <span id="env-tools-desc" class="s-desc">uv / pip3 / colab</span>
                  </div>
                  <button id="env-recheck-btn" class="s-btn" type="button" data-i18n="settings.colab.recheckBtn">重新检测</button>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.colab.guideGroup">初次安装与登录向导</h4>
              <div class="s-card">
                <div class="s-row is-column" data-search="安装 google-colab-cli uv pip 一键安装 install">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.step1Title">1. 安装官方 colab CLI</span>
                    <span class="s-desc" data-i18n="settings.colab.step1Desc">若尚未安装，推荐通过 uv 一键安装（或回退 pip3）；也可以复制命令到终端执行。</span>
                  </div>
                  <div class="s-code-row">
                    <code>uv tool install google-colab-cli</code>
                    <button class="s-btn" type="button" data-copy-cmd="uv tool install google-colab-cli" data-i18n="settings.colab.copy">复制</button>
                  </div>
                  <div class="s-actions">
                    <button id="env-install-uv-btn" class="s-btn is-primary" type="button" data-i18n="settings.colab.installUv">使用 uv 一键安装</button>
                    <button id="env-install-pip-btn" class="s-btn" type="button" data-i18n="settings.colab.installPip">使用 pip3 安装</button>
                  </div>
                  <pre id="env-install-log" class="s-log" hidden></pre>
                </div>

                <div class="s-row is-column" data-search="登录 浏览器 oauth2 gcloud adc 401 403 login">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.step2Title">2. 登录 Google Colab 账号</span>
                    <span class="s-desc" data-i18n="settings.colab.step2Desc">点击下方按钮会触发 colab --auth=oauth2 sessions 并打开系统浏览器完成授权；若偏好无头 ADC 认证，也可在终端运行 gcloud 命令。</span>
                  </div>
                  <div class="s-actions">
                    <button id="env-login-btn" class="s-btn is-primary" type="button" data-i18n="settings.colab.loginBtn">浏览器 OAuth 登录</button>
                  </div>
                  <div class="s-code-row">
                    <code>gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory</code>
                    <button class="s-btn" type="button" data-copy-cmd="gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory" data-i18n="settings.colab.copyAdc">复制 ADC</button>
                  </div>
                  <pre id="env-login-log" class="s-log" hidden></pre>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.colab.envVaultGroup">环境变量保险箱（本地 0600 加密保存）</h4>
              <div class="s-card">
                <div class="s-row is-column" data-search="环境变量 env vault hf_token wandb civitai 密钥 token">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.envTitle">云端 VM 环境变量与 Token</span>
                    <span class="s-desc" data-i18n="settings.colab.envDesc">安全保存在本机 0600 状态文件中，新开会话或点击「注入当前 VM」时自动写入 /etc/profile.d 与脚本运行器。</span>
                  </div>
                  <div class="s-presets">
                    <button class="s-preset" type="button" data-env-preset="HF_TOKEN">HF_TOKEN</button>
                    <button class="s-preset" type="button" data-env-preset="HF_HUB_ENABLE_HF_TRANSFER" data-env-val="1">HF_TRANSFER=1</button>
                    <button class="s-preset" type="button" data-env-preset="WANDB_API_KEY">WANDB_API_KEY</button>
                    <button class="s-preset" type="button" data-env-preset="CIVITAI_API_KEY">CIVITAI_API_KEY</button>
                    <button class="s-preset" type="button" data-env-preset="GITHUB_TOKEN">GITHUB_TOKEN</button>
                  </div>
                  <div id="env-vars-list" class="env-var-list"></div>
                  <div class="s-form-grid">
                    <div class="s-field">
                      <label for="env-key-input" data-i18n="settings.colab.envKey">变量名</label>
                      <input id="env-key-input" class="s-input" type="text" placeholder="HF_TOKEN" />
                    </div>
                    <div class="s-field">
                      <label for="env-val-input" data-i18n="settings.colab.envVal">变量值</label>
                      <input id="env-val-input" class="s-input" type="password" placeholder="hf_..." autocomplete="off" />
                    </div>
                  </div>
                  <div class="s-actions">
                    <button id="env-var-add-btn" class="s-btn is-primary" type="button" data-i18n="settings.colab.envSave">保存变量</button>
                    <button id="env-inject-now-btn" class="s-btn" type="button" data-i18n="settings.colab.envInject">立即注入当前 VM</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.colab.bootstrapGroup">开卡自动初始化 &amp; 缓存加速</h4>
              <div class="s-card">
                <div class="s-row" data-search="自动 挂载 google drive bootstrap">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.bootDriveTitle">开卡后自动挂载 Google Drive</span>
                    <span class="s-desc" data-i18n="settings.colab.bootDriveDesc">新建会话成功后自动运行 colab drivemount。</span>
                  </div>
                  <label class="s-toggle"><input id="boot-mount-drive" type="checkbox" /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="hf_transfer 高速 下载 权重 huggingface">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.bootHfTitle">启用 HuggingFace 高速下载 (hf_transfer)</span>
                    <span class="s-desc" data-i18n="settings.colab.bootHfDesc">自动安装 hf_transfer 并开启 HF_HUB_ENABLE_HF_TRANSFER=1，大幅加速生图/生视频大模型权重拉取。</span>
                  </div>
                  <label class="s-toggle"><input id="boot-hf-transfer" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="缓存 持久化 drive hf_home huggingface cache">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.bootCacheTitle">HuggingFace 缓存持久化到 Google Drive</span>
                    <span class="s-desc" data-i18n="settings.colab.bootCacheDesc">自动将 HF_HOME 指向 /content/drive/MyDrive/.cache/huggingface，重开 VM 无需重复下大模型。</span>
                  </div>
                  <label class="s-toggle"><input id="boot-hf-drive-cache" type="checkbox" /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="自动 安装 uv 包管理">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.bootUvTitle">自动安装 uv 加速包管理</span>
                    <span class="s-desc" data-i18n="settings.colab.bootUvDesc">确保远程 VM 已安装 uv，加快后续依赖安装速度。</span>
                  </div>
                  <label class="s-toggle"><input id="boot-install-uv" type="checkbox" /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row" data-search="自动 注入 环境变量">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.bootEnvTitle">开卡后自动注入环境变量保险箱</span>
                    <span class="s-desc" data-i18n="settings.colab.bootEnvDesc">将上方配置的环境变量自动写入新 VM 的 shell 配置。</span>
                  </div>
                  <label class="s-toggle"><input id="boot-inject-env" type="checkbox" checked /><span class="s-toggle-track"></span></label>
                </div>
                <div class="s-row is-column" data-search="自定义 启动 脚本 bootstrap custom script">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.colab.bootScriptTitle">自定义启动脚本（Bash，可选）</span>
                    <span class="s-desc" data-i18n="settings.colab.bootScriptDesc">每次初始化 VM 时在云端执行的额外命令（例如拉取仓库或启动后台服务）。</span>
                  </div>
                  <textarea id="boot-custom-script" class="tpl-textarea" style="min-height:76px;width:100%;font-family:var(--mono);font-size:12px;" placeholder="# pip install -q diffusers accelerate"></textarea>
                  <div class="s-actions">
                    <button id="boot-run-now-btn" class="s-btn is-primary" type="button" data-i18n="settings.colab.bootRunNow">对当前 VM 立即执行初始化</button>
                  </div>
                  <pre id="boot-run-log" class="s-log" hidden></pre>
                </div>
              </div>
            </div>
          </section>

          <!-- Tab: Maintenance -->
          <section class="settings-pane" data-settings-pane="maintenance">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.maint.group">本地数据与缓存</h4>
              <div class="s-card">
                <div class="s-row" data-search="清空 聊天记录 历史 clear history">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.maint.clearHistoryTitle">清空全部聊天记录</span>
                    <span class="s-desc" data-i18n="settings.maint.clearHistoryDesc">删除本地保存的所有会话对话历史，不会停止云端正在运行的 Colab 虚拟机。</span>
                  </div>
                  <button id="clear-all-history" class="s-btn is-danger" type="button" data-i18n="settings.maint.clearHistoryBtn">清空记录</button>
                </div>
                <div class="s-row" data-search="清空 用量 统计 tokens usage reset">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.maint.clearUsageTitle">清空本应用用量统计</span>
                    <span class="s-desc" data-i18n="settings.maint.clearUsageDesc">重置本应用累计记录的对话轮次与本地 Token 计数（不影响云端真实剩余额度）。</span>
                  </div>
                  <button id="clear-local-usage-btn" class="s-btn" type="button" data-i18n="settings.maint.clearUsageBtn">重置统计</button>
                </div>
              </div>
            </div>
          </section>

          <!-- Tab: About -->
          <section class="settings-pane" data-settings-pane="about">
            <div class="s-group">
              <h4 class="s-group-title" data-i18n="settings.about.group">关于 Colab Desk</h4>
              <div class="s-card">
                <div class="s-row" data-search="关于 版本 协议 about version">
                  <div class="s-copy">
                    <span class="s-title">Colab Desk 0.8.2</span>
                    <span class="s-desc" data-i18n="settings.about.appDesc">基于官方 google-colab-cli 驱动的本地桌面工作台。支持 AGY (ACP)、Grok、OpenCode (ACP) 与内置 OpenAI 兼容 API 智能体。</span>
                  </div>
                </div>
                <div class="s-row" data-search="本地 状态 文件 路径 store path">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.about.storeTitle">本地数据文件</span>
                    <span class="s-desc" data-i18n="settings.about.storeDesc">~/.config/colab-desk/state.json（仅当前用户可读 0600）</span>
                  </div>
                </div>
                <div class="s-row" data-search="更新 版本 update release github">
                  <div class="s-copy">
                    <span class="s-title" data-i18n="settings.about.updateTitle">检查更新</span>
                    <span id="update-status-desc" class="s-desc" data-i18n="settings.about.updateCurrent">当前版本 v0.8.2（GitHub: CalicoX/colab-desk）</span>
                  </div>
                  <button id="check-updates-btn" class="s-btn" type="button" data-i18n="settings.about.updateBtn">检查更新</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </dialog>
`;

# Colab Desk 调研

这份笔记决定本仓库怎么做。界面是本地程序，真正跟 Google Colab 说话的只有用户已经安装的官方客户端。

## 官方客户端：只能拉起 `colab`，不能重写运行时协议

官方客户端是 PyPI 包 `google-colab-cli`，装好后的可执行文件叫 `colab`（仓库 `googlecolab/google-colab-cli`）。它自己负责登录、分配 VM、Jupyter 内核和 WebSocket。Colab Desk 把每一次操作变成参数列表，再 `spawn` 这个二进制；界面不直接请求 Google，也不自己实现 Colab 的运行时协议。

`colab console` 已从上游删掉。需要本地交互终端的 `colab repl`、无命令的交互式 `colab ssh`、会打开 `$EDITOR` 的 `colab edit`、会打开浏览器的 `colab pay` 不做进界面；`colab auth` 和 `colab drivemount` 在无 TTY 环境下可能会阻塞等待人工确认，仅保留参数映射供需要时调用，不作为应用内登录手段。

已实测本机 `google-colab-cli` `0.8.0` 的全部非交互命令面如下。

全局参数（必须放在子命令前）：`--auth {oauth2|adc}`（默认 `oauth2`）、`--config PATH`（隔离会话状态文件，默认 `~/.config/colab-cli/sessions.json`）、`-c / --client-oauth-config PATH`。

会话：

- `new`：`-s NAME`，可选 `--gpu`（T4、L4、G4、H100、A100）、`--tpu`（v5e1、v6e1）、`--high-mem`（L4 / TPU 只有单一规格，会自动忽略该开关）
- `sessions`：列出当前后端上的会话，并自动清理本地过期记录；无本地名称的孤儿会话显示为 `[?]`
- `status`：硬件、机器形态、状态（IDLE / BUSY）和本地元数据
- `restart-kernel`：保留 VM 仅重置 Jupyter 内核
- `stop`：释放 VM，停止计费
- `url`：打印连接现有 VM 的浏览器地址（可选 `--host`，不代用户加 `--open`）

执行：

- `exec`：代码从标准输入读入，或用 `-f` 指向本地 `.py` / `.ipynb`；支持 `--timeout SECONDS`（默认 30s，0 为不限）、`--env KEY=VALUE`（可重复）、`--output-image PATH`
- `ssh`：单次非交互远程命令 `colab ssh -s NAME -- CMD [ARGS...]`，在 `/content` 下执行并返回退出码（需要本地 `ssh` 与 `~/.ssh/id_ed25519` 或 `id_ecdsa` 密钥）
- `run`：在一台新虚拟机上跑本地脚本，脚本路径是位置参数并可透传 `[ARGS...]`；支持与 `new` 相同的硬件开关，以及 `--keep`（跑完保留 VM）、`--timeout`、`--env`

文件：

- `ls`（默认列出 `content`）、`upload`（`LOCAL REMOTE`）、`download`（`REMOTE LOCAL`）、`rm`

工具与诊断：

- `install`（优先 `uv`，不行退回 `pip`；支持多个包名或 `-r requirements.txt`）
- `drivemount`（默认挂到 `/content/drive`）
- `log`（`-n LINES`、`-t TYPE` 如 `execution` / `file_operation`、`-o FILE` 支持导出 `.ipynb` / `.md` / `.txt` / `.jsonl`）
- `usage`（输出账号计算单元余额、消耗速率和活跃分配数）
- `auth`（给虚拟机内核注入 GCP 凭据）
- `whoami`（隐藏调试命令，输出当前 CLI 认证邮箱、scopes 和过期时间，排查 401/403）
- `version`（查看 CLI 版本）

`sessions` / `status` 的文本形态来自官方演示，一行一个会话，例如：

```text
[gpu-eval] m-s-kkb-usc1c0-3cickkby8ivx5 | Hardware: CPU | Variant: DEFAULT
[long-running] m-s-kkb-use4a2-2qvalahyh7yzg | Hardware: CPU | Variant: DEFAULT | Status: IDLE
```

解析器认方括号里的会话名和 `Hardware:` 后面的加速器。`exec` 的标准输出原样进活动记录。命令找不到，或进程以非零退出，都记成错误，不能当成成功。

## Cursor 和 VS Code 的 agent 是怎么做的

Cursor 是 VS Code 的分叉，壳是 Electron，语言是 TypeScript，编辑器是 Monaco。Agent 待在编辑器里面，对文件、终端和 diff 做工具调用循环。Cursor 3 的 Agents Window 是一块多 agent 控制面（并行 agent、本地和云端、diff 和 worktree），不是侧边栏里的一段聊天。

VS Code 的 agent 栈是 Electron workbench，加上单独的 extension host，再加上 LSP。Copilot 风格的聊天是跑在这个 host 上的工具调用循环。2026 年的 VS Code 又拆出一个 Agent Host 进程来托管 harness，extension host 仍然负责扩展；本应用不模仿这套进程模型。

Colab Desk 不是 agent，也不是编辑器分叉。它只保留「侧栏选一个上下文、主区看活动、底部提交下一件事」这种操作。

## 已经有的开源 Colab 界面

- Colab Playground（`scarletkc/colab-playground`）：Rust + GPUI 的桌面程序，包在官方 CLI 外面。它做多账号、费用保护和端口转发，这些本应用都不做。
- EasyColab（`wy51ai/easycolab`）：面向 macOS / Windows / Linux 的创作工作台，用 SwiftUI 或 Qt 管理 Colab GPU，并带模型部署。它不是会话侧栏加活动记录。
- colabapi（`Nahom-digital/colabapi`，`colabapi ui`）：官方 CLI 外面的图形窗口，里面是资源曲线和内嵌终端。

这三家都不是本应用的布局。本应用也不抄 Colab Playground 的多账号库、费用守卫、端口转发和插件。

## 从 T3 Code 借来的操作

T3 Code 是 `pingdotgg/t3code`。它的网页界面加一个本地服务去驱动 CLI。用户看到的是：侧栏里一列上下文，主区是当前这条的活动，底部 composer 提交下一件事。

Colab Desk 用同一套操作，上下文换成 Colab 会话：

- 侧栏列出 `colab sessions` 的结果，点一行就选中
- 主区是这条会话的活动记录（命令、标准输出、错误）
- 底部 composer 提交执行、文件和工具命令
- 硬件选择在开机会话或 `run` 之前一直可见：CPU，以及上面的 GPU / TPU 名字，再加上 high-mem

不借这些：git worktree、模型供应商选择、审批、commit / push / PR。

页面由同一个本地入口提供。`file://` 开不了进程，所以浏览器只跟这个入口说话，入口再去 `spawn` `colab`。

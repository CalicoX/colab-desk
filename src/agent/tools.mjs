import { runAction } from "../run.mjs";
import { mcpManager } from "./mcp.mjs";

export async function executeColabTool(name, args, colabSession, signal) {
  if (mcpManager.isMcpTool(name)) {
    if (signal?.aborted) return { ok: false, output: "已取消执行" };
    return mcpManager.callByName(name, args);
  }
  const reqSession = () => {
    if (!colabSession) throw new Error("当前没有选中的 Colab 会话，请先创建一个会话");
    return colabSession;
  };
  let action;
  switch (name) {
    case "colab_exec":
      action = {
        type: "exec",
        session: reqSession(),
        code: args.code,
        outputImage: args.outputImage,
        timeout: args.timeout,
      };
      break;
    case "colab_ssh":
      action = { type: "ssh", session: reqSession(), command: args.command };
      break;
    case "colab_install":
      action = { type: "install", session: reqSession(), packages: Array.isArray(args.packages) ? args.packages : [] };
      break;
    case "colab_ls":
      action = { type: "ls", session: reqSession(), path: args.path };
      break;
    case "colab_upload":
      action = { type: "upload", session: reqSession(), local: args.local, remote: args.remote };
      break;
    case "colab_download":
      action = { type: "download", session: reqSession(), remote: args.remote, local: args.local };
      break;
    case "colab_status":
      action = colabSession ? { type: "status", session: colabSession } : { type: "status" };
      break;
    case "colab_usage":
      action = { type: "usage" };
      break;
    case "colab_sessions":
      action = { type: "sessions" };
      break;
    default:
      return { ok: false, output: `未知工具: ${name}` };
  }
  const res = await runAction(action, { signal });
  const out = [res.stdout, res.stderr, res.error].filter(Boolean).join("\n").trim() || (res.ok ? "(执行成功，无输出)" : "执行失败");
  return { ok: res.ok, output: out.slice(0, 16_000) };
}

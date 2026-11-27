import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentManager } from "./agent.mjs";
import { TunnelManager } from "./cloud-ops.mjs";
import { emptyState } from "./parse.mjs";
import { handleAgentRoutes } from "./routes/agent.mjs";
import { handleCloudRoutes } from "./routes/cloud.mjs";
import { sendJson } from "./routes/http.mjs";
import { handleSessionRoutes } from "./routes/sessions.mjs";
import { createStaticHandler } from "./routes/static.mjs";
import { TerminalManager } from "./terminal.mjs";

const DEFAULT_APP_VERSION = "0.7.0";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(rootDir, "..");
const publicDir = path.resolve(rootDir, "../public");

const agents = new AgentManager(projectRoot);
const tunnels = new TunnelManager();
const terminals = new TerminalManager(projectRoot);

const handleStatic = createStaticHandler({ rootDir, publicDir });
const routeContext = {
  rootDir,
  agents,
  tunnels,
  terminals,
  defaultVersion: DEFAULT_APP_VERSION,
};

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (handleStatic(req, res, url)) return;
  if (await handleSessionRoutes(req, res, url, routeContext)) return;
  if (await handleAgentRoutes(req, res, url, routeContext)) return;
  if (await handleCloudRoutes(req, res, url, routeContext)) return;

  sendJson(res, 404, { ok: false, error: "not found", argv: [], state: emptyState() });
}

function shutdownManagers() {
  agents.shutdown();
  tunnels.shutdown();
  terminals.shutdown();
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      sendJson(res, 500, { ok: false, error: err.message, argv: [], state: emptyState() });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/api/terminal/ws") {
        const id = url.searchParams.get("id") || "";
        terminals.handleUpgrade(req, socket, head, id);
        return;
      }
    } catch {}
    socket.destroy();
  });

  server.on("close", shutdownManagers);
  return server;
}

export function listen(port = Number(process.env.PORT ?? 4173)) {
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`colab-desk listening on http://127.0.0.1:${address.port}`);
  });
  const cleanup = () => {
    shutdownManagers();
    process.exit(0);
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  return server;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  listen();
}

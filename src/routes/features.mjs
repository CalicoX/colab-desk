import { sendJson } from "./http.mjs";

/** Platform routes: GET /api/features (discovery) and GET /api/events (SSE). */
export async function handleFeatureRoutes(req, res, url, { featureHost }) {
  if (req.method === "GET" && url.pathname === "/api/features") {
    sendJson(res, 200, await featureHost.describe());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    featureHost.addClient(req, res);
    return true;
  }
  return false;
}

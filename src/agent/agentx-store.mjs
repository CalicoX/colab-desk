import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function agentxFile() {
  const dir = process.env.COLAB_DESK_STATE_DIR || path.join(os.homedir(), ".config", "colab-desk");
  return path.join(dir, "agentx.json");
}

export function loadAgentx() {
  try {
    const d = JSON.parse(fs.readFileSync(agentxFile(), "utf8"));
    return { mcpServers: d.mcpServers || [], templates: d.templates || [], assignments: d.assignments || {} };
  } catch {
    return { mcpServers: [], templates: [], assignments: {} };
  }
}

export function saveAgentx(data) {
  const f = agentxFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

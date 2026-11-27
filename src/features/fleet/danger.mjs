// Detects obviously destructive shell/python snippets so the UI can demand confirmation.
const PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\brm\s+--(recursive|force)\b/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bkill(all)?\s+(-\d+|-[A-Z]+)?/,
  /\bpkill\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+[^|;&]*\bof=\/dev\//,
  />\s*\/dev\/(sd|nvme|vd)/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+0?777\s+\//,
  /shutil\.rmtree|os\.remove\(|os\.system\(\s*['"]\s*rm\b/,
  /\bcurl\b[^|;]*\|\s*(sudo\s+)?(ba)?sh\b/,
];

export function detectDanger(command) {
  const text = String(command || "");
  const hits = [];
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0].trim());
  }
  return { dangerous: hits.length > 0, matches: hits };
}

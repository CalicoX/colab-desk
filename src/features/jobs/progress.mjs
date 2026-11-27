// Parse common training/progress patterns from log text. Pure functions.
const stripAnsi = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export function parseDuration(str) {
  if (!str) return null;
  const parts = String(str).trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function parseProgress(text, { elapsedSec = null } = {}) {
  const clean = stripAnsi(text).replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim());
  const out = { percent: null, label: "", etaSec: null, rate: "" };

  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
    const l = lines[i];
    let m;

    if (out.percent == null && (m = l.match(/(\d{1,3}(?:\.\d+)?)%\s*\|/))) {
      out.percent = Math.min(100, Number(m[1]));
      out.label = "tqdm";
      const eta = l.match(/<\s*(\d+:\d{2}(?::\d{2})?)/);
      if (eta) out.etaSec = parseDuration(eta[1]);
    }
    if (out.percent == null && (m = l.match(/Epoch\s*[:\[]?\s*(\d+)\s*\/\s*(\d+)/i)) && Number(m[2]) > 0) {
      out.percent = Math.min(100, (Number(m[1]) / Number(m[2])) * 100);
      out.label = `Epoch ${m[1]}/${m[2]}`;
    }
    if (out.percent == null && (m = l.match(/\b(?:step|iter(?:ation)?)s?\s*[:=]?\s*(\d+)\s*\/\s*(\d+)/i)) && Number(m[2]) > 0) {
      out.percent = Math.min(100, (Number(m[1]) / Number(m[2])) * 100);
      out.label = `step ${m[1]}/${m[2]}`;
    }
    if (!out.rate && (m = l.match(/(\d+(?:\.\d+)?)\s*(it\/s|s\/it)/))) {
      out.rate = `${m[1]} ${m[2]}`;
    }
    if (out.percent != null && out.rate) break;
  }

  if (out.percent != null) {
    out.percent = Math.round(out.percent * 10) / 10;
    if (out.percent >= 100) {
      out.etaSec = 0;
    } else if (out.etaSec == null && out.percent > 0 && Number.isFinite(elapsedSec) && elapsedSec > 0) {
      out.etaSec = Math.round((elapsedSec * (100 - out.percent)) / out.percent);
    }
  }
  return out;
}

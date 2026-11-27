// Inline SVG hourly Compute Units consumption chart (zero external dependencies).

export function renderCuChartSvg(history = [], hourlyCap = 0) {
  const recent = Array.isArray(history) ? history.slice(-12) : [];
  if (!recent.length) return "";

  const w = 240;
  const h = 68;
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const vals = recent.map((d) => Math.max(0, Number(d.used) || 0));
  const maxVal = Math.max(0.5, ...vals, hourlyCap > 0 ? hourlyCap : 0);
  const gap = 3;
  const barW = Math.max(6, Math.floor((plotW - gap * (recent.length - 1)) / recent.length));
  const totalW = barW * recent.length + gap * (recent.length - 1);
  const startX = padL + Math.max(0, Math.floor((plotW - totalW) / 2));

  const bars = recent.map((d, i) => {
    const val = vals[i];
    const bh = Math.max(2, Math.round((val / maxVal) * plotH));
    const x = startX + i * (barW + gap);
    const y = padT + (plotH - bh);
    const hr = new Date(d.hour).getHours();
    const label = `${String(hr).padStart(2, "0")}`;
    const cls = hourlyCap > 0 && val > hourlyCap ? "guard-bar is-over" : "guard-bar";
    return `<g><title>${label}:00 — ${val.toFixed(2)} CU</title><rect class="${cls}" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" />${i === 0 || i === recent.length - 1 || i === Math.floor(recent.length / 2) ? `<text class="guard-axis" x="${x + barW / 2}" y="${h - 3}" text-anchor="middle">${label}h</text>` : ""}</g>`;
  }).join("");

  let capLine = "";
  if (hourlyCap > 0 && hourlyCap <= maxVal) {
    const cy = padT + Math.round(plotH - (hourlyCap / maxVal) * plotH);
    capLine = `<line class="guard-cap-line" x1="${padL}" y1="${cy}" x2="${w - padR}" y2="${cy}" />`;
  }

  return `<svg class="guard-cu-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Hourly CU chart">${capLine}${bars}</svg>`;
}

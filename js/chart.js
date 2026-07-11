// Progress chart: single-series SVG line of avg form score per session.
// Series color #65a30d is validated (lightness band, chroma, ≥3:1 contrast)
// against the chart surface #151b23. Single series → no legend; the title
// names it. Last point is direct-labeled; every point has a hover tooltip.

const SERIES = "#65a30d";
const GRID = "#2a323d";
const BASELINE = "#3a434f";
const MUTED = "#8a939d";
const INK = "#f4f6f8";

let tooltip = null;
function showTip(x, y, html) {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "viz-tooltip";
    document.body.appendChild(tooltip);
  }
  tooltip.innerHTML = html;
  tooltip.style.left = `${x + 14}px`;
  tooltip.style.top = `${y - 10}px`;
  tooltip.style.display = "block";
}
function hideTip() { if (tooltip) tooltip.style.display = "none"; }

export function renderChart(container, sessions) {
  container.innerHTML = "";
  if (sessions.length === 0) return;

  const W = 720, H = 260;
  const pad = { top: 18, right: 84, bottom: 30, left: 40 };
  const iw = W - pad.left - pad.right, ih = H - pad.top - pad.bottom;

  const data = sessions.slice(-12); // last 12 sessions
  const n = data.length;
  const x = (i) => pad.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.top + (1 - v / 100) * ih;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  let g = "";
  // horizontal gridlines at 0/25/50/75/100 + y labels
  for (const v of [0, 25, 50, 75, 100]) {
    const yy = y(v);
    g += `<line x1="${pad.left}" y1="${yy}" x2="${W - pad.right}" y2="${yy}"
            stroke="${v === 0 ? BASELINE : GRID}" stroke-width="1"/>`;
    g += `<text x="${pad.left - 8}" y="${yy + 4}" text-anchor="end"
            font-size="11" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${v}</text>`;
  }
  // x labels: session index (dates collide at this width)
  data.forEach((s, i) => {
    if (n > 8 && i % 2 === 1 && i !== n - 1) return;
    g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${MUTED}">${s.shortDate}</text>`;
  });

  // line
  const path = data.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.avgScore).toFixed(1)}`).join(" ");
  if (n > 1) g += `<path d="${path}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round"/>`;

  // markers (≥8px hit target via invisible halo)
  data.forEach((s, i) => {
    g += `<circle cx="${x(i)}" cy="${y(s.avgScore)}" r="4" fill="${SERIES}" stroke="#151b23" stroke-width="2"/>`;
    g += `<circle class="hit" data-i="${i}" cx="${x(i)}" cy="${y(s.avgScore)}" r="12" fill="transparent"/>`;
  });

  // direct label on the last point
  const last = data[n - 1];
  g += `<text x="${x(n - 1) + 10}" y="${y(last.avgScore) + 4}" font-size="12" font-weight="700"
          fill="${INK}">${last.avgScore} · ${last.exercise}</text>`;

  svg.innerHTML = g;
  container.appendChild(svg);

  svg.addEventListener("pointermove", (e) => {
    const hit = e.target.closest(".hit");
    if (!hit) { hideTip(); return; }
    const s = data[+hit.dataset.i];
    showTip(e.clientX, e.clientY,
      `<strong>${s.exercise}</strong> · ${s.shortDate}<br>` +
      `Form score: <strong>${s.avgScore}</strong> · ${s.reps} reps` +
      (s.bestJumpCm ? ` · best ${s.bestJumpCm} cm` : ""));
  });
  svg.addEventListener("pointerleave", hideTip);
}

export function renderTable(container, sessions) {
  const rows = sessions.slice(-12).map((s) =>
    `<tr><td>${s.shortDate}</td><td>${s.exercise}</td><td>${s.reps}</td>` +
    `<td>${s.avgScore}</td><td>${s.bestJumpCm ? s.bestJumpCm + " cm" : "—"}</td></tr>`
  ).join("");
  container.innerHTML =
    `<table><thead><tr><th>Date</th><th>Exercise</th><th>Reps</th><th>Avg score</th><th>Best jump</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

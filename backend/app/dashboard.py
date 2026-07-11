"""Coach Team Dashboard — one view of every athlete's sessions.

A school or club coach runs the backend once; every athlete trains in their
own browser (video never leaves their device) and only session stats arrive
here. The dashboard aggregates them: who trained, form trends, injury flags.
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FormCoach AI — Coach Dashboard</title>
<style>
  :root { --bg:#0b0e13; --surface:#151b23; --border:rgba(255,255,255,.08);
    --ink:#f4f6f8; --ink2:#b7c0ca; --muted:#8a939d; --accent:#a3e635;
    --good:#0ca30c; --warn:#fab219; --bad:#d03b3b; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif; padding:2rem 1.2rem; }
  .wrap { max-width:1000px; margin:0 auto; }
  h1 { font-size:1.5rem; } h1 em { color:var(--accent); font-style:normal; }
  .sub { color:var(--muted); margin:.3rem 0 1.4rem; font-size:.9rem; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
    gap:.8rem; margin-bottom:1.4rem; }
  .tile { background:var(--surface); border:1px solid var(--border);
    border-radius:14px; padding:1rem; }
  .tile b { display:block; font-size:1.7rem; color:var(--accent); }
  .tile span { color:var(--muted); font-size:.8rem; }
  .athlete { background:var(--surface); border:1px solid var(--border);
    border-radius:14px; padding:1rem 1.2rem; margin-bottom:.9rem; }
  .athlete h2 { font-size:1.05rem; display:flex; align-items:center; gap:.6rem; }
  .flag { font-size:.72rem; padding:.15rem .5rem; border-radius:999px; font-weight:700; }
  .flag.ok { background:rgba(12,163,12,.15); color:var(--good); }
  .flag.risk { background:rgba(208,59,59,.18); color:var(--bad); }
  table { width:100%; border-collapse:collapse; margin-top:.6rem; font-size:.85rem; }
  th,td { text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--border);
    font-variant-numeric:tabular-nums; }
  th { color:var(--muted); font-weight:600; }
  .s-good { color:var(--good); } .s-warn { color:var(--warn); } .s-bad { color:var(--bad); }
  .empty { color:var(--muted); padding:2rem; text-align:center;
    background:var(--surface); border:1px solid var(--border); border-radius:14px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>FormCoach <em>AI</em> — Coach Dashboard</h1>
  <p class="sub">Every athlete trains privately in their own browser; only anonymized joint-angle stats arrive here.</p>
  <div class="tiles" id="tiles"></div>
  <div id="athletes"></div>
</div>
<script>
const band = s => s >= 85 ? 's-good' : s >= 60 ? 's-warn' : 's-bad';
fetch('/api/reports?limit=200').then(r => r.json()).then(rows => {
  if (!rows.length) {
    document.getElementById('athletes').innerHTML =
      '<div class="empty">No sessions yet — athletes\\' finished sessions will appear here automatically.</div>';
    return;
  }
  const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  document.getElementById('tiles').innerHTML = [
    ['' + new Set(rows.map(r => r.athlete)).size, 'athletes'],
    ['' + rows.length, 'sessions'],
    [avg(rows.map(r => r.avg_score)), 'team avg form'],
    ['' + rows.filter(r => (r.report.agents || []).some(a => a.key === 'injury' && a.score < 60)).length, 'injury flags'],
  ].map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join('');

  const byAthlete = {};
  rows.forEach(r => (byAthlete[r.athlete] ??= []).push(r));
  document.getElementById('athletes').innerHTML = Object.entries(byAthlete).map(([name, list]) => {
    const risk = list.some(r => (r.report.agents || []).some(a => a.key === 'injury' && a.score < 60));
    const rowsHtml = list.slice(0, 8).map(r =>
      `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${r.exercise}</td>
       <td>${r.reps}</td><td class="${band(r.avg_score)}">${r.avg_score}</td>
       <td class="${band(r.report.overall)}">${r.report.overall}</td><td>${r.report.verdict}</td></tr>`).join('');
    return `<div class="athlete">
      <h2>${name} <span class="flag ${risk ? 'risk' : 'ok'}">${risk ? '⚠ injury risk flagged' : '✓ moving well'}</span></h2>
      <table><thead><tr><th>When</th><th>Exercise</th><th>Reps</th><th>Form</th><th>Readiness</th><th>Verdict</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
  }).join('');
});
</script>
</body>
</html>"""


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard() -> str:
    return PAGE

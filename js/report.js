// Multi-agent AI Coaching Report — talks to the FastAPI backend.
// Gracefully degrades: if the backend is down, the section explains how to start it.

const BACKEND = localStorage.getItem("formcoach.backend") || "http://localhost:8001";

export async function requestReport(session, history) {
  const sec = document.getElementById("report");
  const body = document.getElementById("reportBody");
  sec.classList.remove("hidden");
  body.innerHTML = `<p class="report-status">🤖 4 AI agents are analyzing your session in parallel…</p>`;

  try {
    const res = await fetch(`${BACKEND}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, history }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(body, await res.json());
  } catch {
    body.innerHTML =
      `<p class="report-status">Backend offline — the live demo still works fully in-browser. ` +
      `To enable the multi-agent report, run:<br><code>cd server && pip install -r requirements.txt && uvicorn main:app --port 8001</code></p>`;
  }
}

function render(el, report) {
  const cards = report.agents
    .map(
      (a) => `
      <article class="agent-card">
        <header>
          <span class="agent-icon">${a.icon}</span>
          <div>
            <h4>${a.name}</h4>
            <span class="agent-engine">${a.engine === "claude" ? "Claude-powered" : "rules engine"}</span>
          </div>
          <span class="agent-score" data-band="${band(a.score)}">${a.score}</span>
        </header>
        <ul>${a.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        <p class="agent-reasoning">Why: ${esc(a.reasoning)}</p>
      </article>`
    )
    .join("");

  el.innerHTML = `
    <div class="report-overall">
      <span class="report-overall-num" data-band="${band(report.overall)}">${report.overall}</span>
      <div>
        <strong>Athlete readiness: ${esc(report.verdict)}</strong>
        <p>Synthesized from 4 specialized agents analyzing your joint-angle data in parallel.</p>
      </div>
    </div>
    <div class="agent-grid">${cards}</div>`;
}

const band = (s) => (s >= 85 ? "good" : s >= 60 ? "warn" : "bad");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

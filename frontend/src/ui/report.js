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
      // hosted-page -> local backend needs Chrome's loopback permission hint
      // (but the hint BREAKS fetches from a localhost page — https only)
      ...(location.protocol === "https:" ? { targetAddressSpace: "loopback" } : {}),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, history }),
    });
    if (res.status === 503) {
      body.innerHTML = `<p class="report-status">⚠ AI engine offline — start Ollama (<code>ollama serve</code>, model llama3.2) or set <code>ANTHROPIC_API_KEY</code>, then finish another session.</p>`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(body, await res.json());
  } catch {
    body.innerHTML =
      `<p class="report-status">Backend offline — the live demo still works fully in-browser. ` +
      `To enable the multi-agent report, run:<br><code>cd backend && pip install -r requirements.txt && uvicorn app.main:app --port 8001</code></p>`;
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
      ${radar(report.agents)}
    </div>
    <div class="agent-grid">${cards}</div>`;
}

// 4-axis radar chart of the agent scores.
function radar(agents) {
  const C = 70, R = 52; // center, max radius
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // axis unit vectors: up/right/down/left
  const p = (i, v) => `${C + dirs[i][0] * R * (v / 100)},${C + dirs[i][1] * R * (v / 100)}`;
  const grid = [25, 50, 75, 100]
    .map((g) => `<polygon points="${dirs.map((_, i) => p(i, g)).join(" ")}" fill="none" stroke="#e9e7f2" stroke-width="1"/>`)
    .join("");
  const shape = agents.map((a, i) => p(i, a.score)).join(" ");
  const labels = agents
    .map((a, i) => `<text x="${C + dirs[i][0] * (R + 11)}" y="${C + dirs[i][1] * (R + 11) + 4}" text-anchor="middle" font-size="11">${a.icon}</text>`)
    .join("");
  return `<svg class="agent-radar" viewBox="0 0 140 140" role="img" aria-label="Radar chart of the four agent scores">
    ${grid}
    <polygon points="${shape}" fill="rgba(94,92,230,0.22)" stroke="#5e5ce6" stroke-width="2"/>
    ${agents.map((a, i) => `<circle cx="${p(i, a.score).split(",")[0]}" cy="${p(i, a.score).split(",")[1]}" r="3" fill="#5e5ce6"/>`).join("")}
    ${labels}
  </svg>`;
}

const band = (s) => (s >= 85 ? "good" : s >= 60 ? "warn" : "bad");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

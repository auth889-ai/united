// Voice coaching + coach chat (rule-based fallback, optional LLM).

let voiceOn = true;
let lastSpokenAt = 0;
const SPEAK_COOLDOWN_MS = 2500;

export function setVoice(on) { voiceOn = on; if (!on) speechSynthesis.cancel(); }

export function speak(text, { force = false } = {}) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  const now = performance.now();
  if (!force && now - lastSpokenAt < SPEAK_COOLDOWN_MS) return;
  lastSpokenAt = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

export function speakRep(n) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  // Rep counts bypass the cooldown but never cancel an active fault cue.
  if (speechSynthesis.speaking) return;
  const u = new SpeechSynthesisUtterance(String(n));
  u.rate = 1.2;
  speechSynthesis.speak(u);
}

/* ---------------- session summary text ---------------- */

export function summarize(session) {
  const { exercise, reps, avgScore, faults, bestJumpCm } = session;
  const parts = [];
  if (exercise === "Vertical jump") {
    parts.push(`You logged ${reps} jump${reps === 1 ? "" : "s"} with a best of ${bestJumpCm} cm.`);
    if (bestJumpCm >= 50) parts.push("That's an explosive, athlete-level jump — keep it up.");
    else if (bestJumpCm >= 35) parts.push("Solid spring. Add depth jumps and squats to push past 50 cm.");
    else parts.push("Good baseline. Two sessions a week of squats and calf raises will move this fast.");
  } else {
    parts.push(`You completed ${reps} ${exercise.toLowerCase()} rep${reps === 1 ? "" : "s"} with an average form score of ${avgScore}.`);
    if (avgScore >= 90) parts.push("Excellent control — you're ready to add load or reps.");
    else if (avgScore >= 75) parts.push("Good work overall, with a few fixable faults.");
    else parts.push("Let's prioritise quality over quantity next session.");
  }
  const topFault = Object.entries(faults).sort((a, b) => b[1] - a[1])[0];
  if (topFault && topFault[1] >= 2) parts.push(`Your most common fault: "${topFault[0]}" (${topFault[1]}×). Fix that first — it's worth more than extra reps.`);
  return parts.join(" ");
}

/* ---------------- optional LLM (OpenAI-compatible, e.g. Featherless) ---------------- */

const CFG_KEY = "formcoach.llm";
export function getLLMConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
}
export function setLLMConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

async function llmReply(question, history, override) {
  const cfg = override || getLLMConfig();
  const stats = history.slice(-5);
  const headers = { "Content-Type": "application/json" };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`; // Ollama needs no key
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: "You are FormCoach, a concise, encouraging sports form coach inside a webcam training app. " +
            "The user's recent session stats (JSON): " + JSON.stringify(stats) +
            ". Give specific, actionable coaching in under 120 words. Never invent stats not in the JSON.",
        },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "(empty reply)";
}

// Zero-config local AI: if no LLM is configured, auto-detect Ollama running
// on this machine. A positive result is cached; a negative one is retried
// every 15s (Ollama may start after the page loads).
let ollamaDetected = null;
let lastCheck = 0;
async function detectOllama() {
  if (ollamaDetected === true) return true;
  if (ollamaDetected === false && Date.now() - lastCheck < 15000) return false;
  lastCheck = Date.now();
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    ollamaDetected = res.ok;
  } catch { ollamaDetected = false; }
  return ollamaDetected;
}

// AI-only: configured LLM -> auto-detected local Ollama. No canned fallback —
// if no AI engine is reachable, the coach says so honestly.
const OFFLINE_MSG =
  "⚠ AI coach offline. Start Ollama on this machine (ollama serve, model llama3.2) " +
  "or add an API key in ⚙ settings — then ask me again.";

export async function coachReply(question, history) {
  const cfg = getLLMConfig();
  if (cfg.endpoint && cfg.model) {
    try { return { text: await llmReply(question, history), engine: "🧠 " + cfg.model }; }
    catch { return { text: OFFLINE_MSG, engine: "offline" }; }
  }
  if (await detectOllama()) {
    try {
      const text = await llmReply(question, history, {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
        key: "",
      });
      return { text, engine: "🧠 llama3.2 · local AI" };
    } catch { return { text: OFFLINE_MSG, engine: "offline" }; }
  }
  return { text: OFFLINE_MSG, engine: "offline" };
}

// Live AI commentary — short spoken lines generated from what the vision
// engine is seeing right now (reps, scores, Twin deviations, fatigue).
// Fires only when a local LLM is available; never blocks the video loop.
let liveBusy = false;
export async function liveCoachLine(snapshot) {
  if (liveBusy || !(await detectOllama())) return null;
  liveBusy = true;
  try {
    const res = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",
        max_tokens: 40,
        messages: [
          { role: "system", content:
            "You are a live workout voice coach. Reply with ONE short spoken line, " +
            "under 18 words, energetic and specific to the JSON data. No emojis, no quotes." },
          { role: "user", content: JSON.stringify(snapshot) },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    liveBusy = false;
  }
}

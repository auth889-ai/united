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

/* ---------------- rule-based chat coach ---------------- */

function ruleReply(question, history) {
  const q = question.toLowerCase();
  const last = history[history.length - 1];
  if (!last) {
    return "I don't have any session data yet — do a set above (even 5 squats), then ask me again and I'll coach you on the numbers.";
  }
  const statLine = last.exercise === "Vertical jump"
    ? `your last session: ${last.reps} jumps, best ${last.bestJumpCm} cm`
    : `your last session: ${last.reps} ${last.exercise.toLowerCase()} reps at ${last.avgScore}/100 form`;

  if (/(score|form|how.*(do|did)|rate)/.test(q)) {
    return `Here's ${statLine}. ${last.avgScore >= 85 ? "That's strong — your movement is consistent." : "The score drops mainly when you cut range of motion or lose alignment — slow down 20% and the score will climb."}`;
  }
  if (/(fix|improve|better|mistake|wrong|fault)/.test(q)) {
    const top = Object.entries(last.faults || {}).sort((a, b) => b[1] - a[1])[0];
    return top
      ? `Your #1 issue was "${top[0]}" — it happened ${top[1]} time${top[1] === 1 ? "" : "s"}. Focus your entire next set on just that one cue. One fault at a time is how form actually changes.`
      : `Honestly, no repeated faults last session (${statLine}). Add 2–3 reps or slow the lowering phase to keep progressing.`;
  }
  if (/(plan|week|program|next|routine|schedule)/.test(q)) {
    return `Based on ${statLine}: train 3×/week — Day 1: 3 sets of ${last.exercise.toLowerCase()}s at a quality you can hold above 85/100. Day 2: a different drill from the picker. Day 3: repeat Day 1 and try to beat your average by 5 points. Progress by score first, reps second.`;
  }
  if (/(jump|vertical|higher)/.test(q)) {
    return "To jump higher: squat depth builds the engine, and explosive intent builds the spring. Do 3×5 deep squats, then 3×3 max-effort jumps fully rested. Re-test here weekly — the chart below will show the trend.";
  }
  if (/(injur|pain|hurt|knee|back)/.test(q)) {
    return "If anything actually hurts, stop and see a professional — I coach form, I don't diagnose. That said, most knee/back complaints in training come from the exact faults I flag: knees caving, chest dropping, hips sagging. Keep your score above 85 and you're moving well.";
  }
  return `Good question. Here's ${statLine}. Ask me to "rate my form", "what should I fix", or "give me a plan" — or open ⚙ settings to plug in an LLM for open-ended coaching.`;
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
// on this machine and use it. Checked once per page load.
let ollamaDetected = null;
async function detectOllama() {
  if (ollamaDetected !== null) return ollamaDetected;
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    ollamaDetected = res.ok;
  } catch { ollamaDetected = false; }
  return ollamaDetected;
}

// Always answers: configured LLM -> auto-detected local Ollama -> rules coach.
export async function coachReply(question, history) {
  const cfg = getLLMConfig();
  if (cfg.endpoint && cfg.model) {
    try { return await llmReply(question, history); }
    catch { return "(LLM unreachable — built-in coach) " + ruleReply(question, history); }
  }
  if (await detectOllama()) {
    try {
      return await llmReply(question, history, {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
        key: "",
      });
    } catch { /* fall through to rules */ }
  }
  return ruleReply(question, history);
}

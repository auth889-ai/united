// Voice coaching + coach chat (rule-based fallback, optional LLM).

let voiceOn = true;
let lastSpokenAt = 0;
const SPEAK_COOLDOWN_MS = 2500;

export function setVoice(on) { voiceOn = on; if (!on) speechSynthesis.cancel(); }

export function speak(text, { force = false, interrupt = false } = {}) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  const now = performance.now();
  if (!force && now - lastSpokenAt < SPEAK_COOLDOWN_MS) return;
  lastSpokenAt = now;
  // Never cut the coach off mid-word for routine lines: queue behind the
  // current sentence. Interrupt only for urgent safety cues, or when a
  // backlog is already waiting (newest info wins over a stale queue).
  if (interrupt || speechSynthesis.pending) speechSynthesis.cancel();
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
// Chrome's Local Network Access rule: a public HTTPS page must declare that a
// request targets the loopback address, or the browser silently blocks it.
// With this hint Chrome shows a permission prompt instead — one click, then
// the hosted app can talk to local Ollama like the localhost app does.
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u);
// The hint is ONLY for public https pages — adding it on a localhost page
// makes Chrome fail the fetch outright.
const needsHint = location.protocol === "https:";
function aiFetch(url, init = {}) {
  return fetch(url, needsHint && isLocalUrl(url) ? { ...init, targetAddressSpace: "loopback" } : init);
}

export function getLLMConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
}
export function setLLMConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

async function llmReply(question, history, override) {
  const cfg = override || getLLMConfig();
  const stats = history.slice(-5);
  const headers = { "Content-Type": "application/json" };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`; // Ollama needs no key
  const res = await aiFetch(cfg.endpoint, {
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
let ollamaModels = null;
async function getOllamaModels() {
  if (ollamaModels && Date.now() - lastCheck < 15000) return ollamaModels;
  if (ollamaDetected === false && Date.now() - lastCheck < 15000) return null;
  lastCheck = Date.now();
  try {
    const res = await aiFetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error("ollama tags failed");
    ollamaModels = (await res.json()).models || [];
    ollamaDetected = true;
    return ollamaModels;
  } catch {
    ollamaModels = null;
    ollamaDetected = false;
    return null;
  }
}

async function detectOllama() {
  if (ollamaDetected === true) return true;
  await getOllamaModels();
  return ollamaDetected;
}

const VISION_HINTS = /vision|llava|bakllava|moondream|minicpm|qwen2\.5vl|qwen2-vl|gemma3/i;
const TEXT_HINTS = /llama|mistral|qwen|gemma|phi|deepseek|command|mixtral|olmo|smollm/i;
const TEXT_AVOID = /vision|llava|bakllava|moondream|minicpm|qwen2\.5vl|qwen2-vl|clip|embed/i;

function modelNames(models) {
  return (models || []).map((m) => m.name).filter(Boolean);
}

async function findTextModel() {
  const names = modelNames(await getOllamaModels());
  return names.find((n) => !TEXT_AVOID.test(n) && /llama3\.2/i.test(n))
    || names.find((n) => !TEXT_AVOID.test(n) && TEXT_HINTS.test(n))
    || names.find((n) => !TEXT_AVOID.test(n))
    || null;
}

// Pick a reachable engine: a saved-but-broken ⚙ endpoint must not kill the
// coach — probe it (4s), then fall back to auto-detected local Ollama.
async function resolveEngine() {
  const cfg = getLLMConfig();
  if (cfg.endpoint && cfg.model) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
      const probe = await aiFetch(cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: AbortSignal.timeout(4000),
      });
      if (probe.ok) return { endpoint: cfg.endpoint, model: cfg.model, key: cfg.key || "", label: "🧠 " + cfg.model };
    } catch { /* unreachable — fall through to local */ }
  }
  const localModel = await findTextModel();
  if (localModel) {
    return { endpoint: "http://localhost:11434/v1/chat/completions", model: localModel, key: "", label: `🧠 ${localModel} · local AI` };
  }
  return null;
}

// AI-only: configured LLM -> auto-detected local Ollama. No canned fallback —
// if no AI engine is reachable, the coach says so honestly.
const OFFLINE_MSG =
  "⚠ AI coach offline. Start Ollama on this machine and pull a chat model, for example: ollama pull llama3.2. " +
  "Or add an API key in ⚙ settings — then ask me again." +
  (location.protocol === "https:"
    ? " On this hosted page your browser may ask permission to reach local Ollama — click Allow, or open the app at http://localhost:8000 for zero-prompt local AI."
    : "");

export async function coachReply(question, history) {
  const cfg = getLLMConfig();
  if (cfg.endpoint && cfg.model) {
    try { return { text: await llmReply(question, history), engine: "🧠 " + cfg.model }; }
    catch { /* configured endpoint is down/misconfigured — fall back to local Ollama */ }
  }
  const localModel = await findTextModel();
  if (localModel) {
    try {
      const text = await llmReply(question, history, {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: localModel,
        key: "",
      });
      return { text, engine: `🧠 ${localModel} · local AI` };
    } catch { return { text: OFFLINE_MSG, engine: "offline" }; }
  }
  return { text: OFFLINE_MSG, engine: "offline" };
}

// Live AI commentary — short spoken lines generated from what the vision
// engine is seeing right now (reps, scores, Twin deviations, fatigue).
// Fires only when a local LLM is available; never blocks the video loop.
let liveBusy = false;
let recentLines = []; // anti-repetition memory for spoken commentary
export async function liveCoachLine(snapshot) {
  const model = await findTextModel();
  if (liveBusy || !model) return null;
  liveBusy = true;
  try {
    const res = await aiFetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 40,
        temperature: 1.1,
        messages: [
          { role: "system", content:
            "You are a live workout voice coach. Reply with ONE short spoken line, " +
            "under 18 words, energetic and specific to the JSON data. No emojis, no quotes." +
            (recentLines.length
              ? " You already said these — say something DIFFERENT in wording and angle: " + JSON.stringify(recentLines)
              : "") },
          { role: "user", content: JSON.stringify(snapshot) },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    const line = data.choices?.[0]?.message?.content?.trim() || null;
    if (line) recentLines = [...recentLines.slice(-3), line];
    return line;
  } catch {
    return null;
  } finally {
    liveBusy = false;
  }
}

// Queue speech without cancelling what's already being said —
// used for streamed sentences so they flow naturally.
export function speakQueued(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

// Streaming reply: sentences are delivered (and can be spoken) AS the model
// generates them — first words in ~1s instead of waiting for the full answer.
// Conversation memory: the coach remembers this session's chat, so
// follow-ups ("what about my knees?") work like a real conversation.
let chatTurns = [];
export function resetChat() { chatTurns = []; }

async function readStreamingText(res, onToken) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const parsePayload = (payload) => {
    const raw = payload.trim();
    if (!raw || raw === "[DONE]") return "";
    try {
      const data = JSON.parse(raw);
      return data.choices?.[0]?.delta?.content
        || data.choices?.[0]?.message?.content
        || data.message?.content
        || data.response
        || "";
    } catch {
      return "";
    }
  };
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5) : trimmed;
    const token = parsePayload(payload);
    if (token) onToken(token);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) handleLine(line);
  }
  if (buf.trim()) handleLine(buf);
}

export async function coachReplyStream(question, history, onSentence) {
  const eng = await resolveEngine();
  if (!eng) return { text: OFFLINE_MSG, engine: "offline" };
  const { endpoint, model, key } = eng;

  const stats = history.slice(-5);
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await aiFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 220,
        messages: [
          { role: "system", content:
            "You are FormCoach, a concise, encouraging sports form coach inside a webcam training app. " +
            "The user's recent session stats (JSON): " + JSON.stringify(stats) +
            ". Answer in under 80 words. Never invent stats not in the JSON." },
          ...chatTurns.slice(-8),
          { role: "user", content: question },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);

    let full = "", pending = "";
    const flush = (force = false) => {
      // emit complete sentences as they land
      let m;
      while ((m = pending.match(/^[\s\S]*?[.!?](\s|$)/))) {
        const sentence = m[0].trim();
        pending = pending.slice(m[0].length);
        if (sentence.length > 1) onSentence(sentence);
      }
      if (force && pending.trim().length > 1) { onSentence(pending.trim()); pending = ""; }
    };
    await readStreamingText(res, (delta) => {
      full += delta;
      pending += delta;
      flush();
    });
    flush(true);
    if (full.trim()) {
      chatTurns.push({ role: "user", content: question }, { role: "assistant", content: full.trim() });
      if (chatTurns.length > 16) chatTurns = chatTurns.slice(-16);
    }
    return { text: full.trim() || OFFLINE_MSG, engine: full ? eng.label + " · streamed" : "offline" };
  } catch {
    return { text: OFFLINE_MSG, engine: "offline" };
  }
}

// Coach's Review — after the session, the LLM studies the full rep-by-rep
// measurement timeline (what happened, when, by how many degrees) and writes
// a detailed chronological review. Real-time stays physics; depth comes after.
export async function coachReview(timeline, onSentence) {
  const eng = await resolveEngine();
  if (!eng) return null;
  const { endpoint, model, key } = eng;

  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await aiFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 400,
        messages: [
          { role: "system", content:
            "You are a professional strength coach reviewing an athlete's session recording. " +
            "You are given a rep-by-rep measurement timeline (rep number, seconds into the session, " +
            "0-100 form score, joint angles, deviation vs the athlete's own best rep, faults, fatigue point). " +
            "Write a chronological review in 120-180 words: what went well early, exactly when and how form " +
            "changed (cite rep numbers, timestamps and degree values FROM THE DATA ONLY — never invent numbers), " +
            "and end with the single most important fix. Warm, direct, second person." },
          { role: "user", content: JSON.stringify(timeline) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    let full = "", pending = "";
    const flush = (force = false) => {
      let m;
      while ((m = pending.match(/^[\s\S]*?[.!?](\s|$)/))) {
        const s = m[0].trim();
        pending = pending.slice(m[0].length);
        if (s.length > 1) onSentence(s);
      }
      if (force && pending.trim().length > 1) { onSentence(pending.trim()); pending = ""; }
    };
    await readStreamingText(res, (delta) => {
      full += delta; pending += delta; flush();
    });
    flush(true);
    return full.trim() || null;
  } catch { return null; }
}

// Deep visual analysis — sends the fault snapshot IMAGES to a local vision
// model (via Ollama), which looks at the actual frames and writes a detailed
// report. Post-session by design: vision models are too slow for live use.
export async function findVisionModel() {
  const names = modelNames(await getOllamaModels());
  return names.find((n) => /moondream/i.test(n))
    || names.find((n) => VISION_HINTS.test(n))
    || null;
}

export async function visionReport(shots, timeline, onSentence) {
  const model = await findVisionModel();
  if (!model) return { error: "no-vision-model" };
  // Two-stage pipeline, one image at a time:
  //   1) the small vision model DESCRIBES what it sees (its only strength)
  //   2) llama3.2 turns that observation + the measured fault into a real
  //      coach note: what is happening, why it matters, how to fix it.
  // Tiny vision models asked to "coach" directly produce junk — splitting
  // seeing from writing is what makes the walkthrough detailed and useful.
  let full = "";
  const entries = [];
  for (const s of shots) {
    const stamp = `${Math.floor(s.at / 60)}:${String(s.at % 60).padStart(2, "0")}`;
    const head = `\n\n⏱ ${stamp} — ${s.text}\n`;
    full += head; onSentence(head);
    let note = "";
    // stage 1 — eyes
    let observed = "";
    try {
      const seeRes = await aiFetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          options: { num_predict: 110 },
          messages: [{
            role: "user",
            content: "Describe this person's body position in detail: torso, hips, arms, legs, and how bent or straight each is.",
            images: [s.img.split(",")[1]],
          }],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (seeRes.ok) observed = ((await seeRes.json()).message?.content || "").trim();
    } catch { /* eyes failed — the writer still has the measured fault */ }
    // stage 2 — writer
    try {
      const writeRes = await aiFetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3.2",
          stream: true,
          options: { num_predict: 130 },
          messages: [
            { role: "system", content:
              "You are a precise strength coach writing one entry of a session review. " +
              "Write 2-3 plain sentences, second person, no headings, no preamble: " +
              "what is happening in the athlete's body, why it matters (injury or performance), " +
              "and exactly how to fix it on the next rep. Never invent measurements." },
            { role: "user", content:
              `Moment: ${stamp} into the session. ` +
              (s.text === "form check"
                ? "Routine form-check photo (no fault was flagged). "
                : `The measurement engine flagged: "${s.text}". `) +
              (observed ? `A vision model looked at the photo and reported: "${observed}"` : "") },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (writeRes.ok) {
        await readStreamingText(writeRes, (chunk) => {
          note += chunk;
          full += chunk;
          onSentence(chunk);
        });
      }
    } catch { /* skip this shot, keep walking the timeline */ }
    entries.push({
      at: s.at,
      stamp,
      fault: s.text,
      note: note.trim() || "The local vision model could not describe this frame. Use the measured fault text and skeleton overlay for this page.",
    });
  }
  return { text: full.trim(), model, entries };
}

// Mode 2 — AI Eyes: while you train, a local vision model looks at a live
// snapshot and speaks one short line about what it actually sees. Fully
// on-device; a frame is analyzed only if the previous one has finished.
let eyesInFlight = false;
let recentEyesLines = [];
export async function liveVisionLine(imgDataUrl, model, exercise) {
  if (eyesInFlight) return null;
  eyesInFlight = true;
  try {
    const res = await aiFetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        options: { num_predict: 35 },
        messages: [{
          role: "user",
          content:
            `You are watching an athlete do ${exercise} live through a camera ` +
            "(skeleton overlay drawn on them). In ONE short spoken coaching line " +
            "(max 14 words), tell them what you see about their body position. " +
            "No preamble, just the line." +
            (recentEyesLines.length
              ? ` You already said these — observe something DIFFERENT: ${JSON.stringify(recentEyesLines)}`
              : ""),
          images: [imgDataUrl.split(",")[1]],
        }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    let text = (await res.json()).message?.content?.trim();
    text = text ? text.replace(/^["']|["']$/g, "") : null;
    if (text) recentEyesLines = [...recentEyesLines.slice(-2), text];
    return text;
  } catch { return null; }
  finally { eyesInFlight = false; }
}

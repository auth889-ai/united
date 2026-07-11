// Hands-free voice control (Web Speech Recognition, Chrome/Edge).
// Makes the whole app usable eyes-free — including by blind and
// low-vision athletes: the coach already talks; now it listens too.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function voiceControlSupported() { return Boolean(SR); }

// Command grammar -> canonical intent. Checked in order; first match wins.
const COMMANDS = [
  { intent: "start",   re: /\b(start|begin|let's go|go)\b/ },
  { intent: "stop",    re: /\b(stop|finish|end|done)\b/ },
  { intent: "squat",   re: /\bsquats?\b/ },
  { intent: "pushup",  re: /\b(push[- ]?ups?|press[- ]?ups?)\b/ },
  { intent: "curl",    re: /\b(curls?|biceps?)\b/ },
  { intent: "jump",    re: /\b(jumps?|vertical)\b/ },
  { intent: "status",  re: /\b(how am i doing|score|status|how many)\b/ },
  { intent: "help",    re: /\b(help|what can i say|commands)\b/ },
];

let rec = null;
let active = false;

export function startVoiceControl(onIntent) {
  if (!SR || rec) return false;
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = "en-US";

  rec.onresult = (e) => {
    // Ignore the mic while the coach is speaking, or it hears itself.
    if (speechSynthesis.speaking) return;
    const text = e.results[e.results.length - 1][0].transcript.toLowerCase();
    const hit = COMMANDS.find((c) => c.re.test(text));
    if (hit) onIntent(hit.intent, text);
  };
  // Recognition times out after silence — keep it alive while enabled.
  rec.onend = () => { if (active) { try { rec.start(); } catch { /* already starting */ } } };
  rec.onerror = (e) => {
    if (e.error === "not-allowed") { active = false; onIntent("mic-denied"); }
  };

  active = true;
  rec.start();
  return true;
}

export function stopVoiceControl() {
  active = false;
  if (rec) { rec.stop(); rec = null; }
}

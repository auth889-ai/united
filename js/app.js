import { EXERCISES, PRIORITY } from "./exercises.js";
import { speak, speakRep, setVoice, summarize, coachReply, getLLMConfig, setLLMConfig } from "./coach.js";
import { renderChart, renderTable } from "./chart.js";
import { voiceControlSupported, startVoiceControl, stopVoiceControl } from "./voice.js";
import { requestReport } from "./report.js";
import {
  PoseLandmarker, FilesetResolver, DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), ctx = overlay.getContext("2d");

const state = {
  exercise: "squat",
  landmarker: null,
  analyzer: null,
  running: false,        // session active
  cameraOn: false,
  reps: 0,
  scores: [],
  repTimes: [],          // performance.now() per completed rep (tempo analytics)
  faults: {},            // cue text -> count
  rafId: null,
  lastVideoTime: -1,
};

/* ================= camera + model ================= */

async function enableCamera() {
  $("stageMsg").innerHTML = "<p>Loading pose model…</p>";
  try {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    state.landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 720, facingMode: "user" }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    // videoWidth can be 0 until metadata arrives on some browsers
    if (!video.videoWidth) {
      await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
    }
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    state.cameraOn = true;
    $("stageMsg").classList.add("hidden");
    $("phaseBadge").classList.remove("hidden");
    $("btnSession").disabled = false;
    loop();
  } catch (err) {
    $("stageMsg").innerHTML =
      `<p>⚠ ${err.name === "NotAllowedError"
        ? "Camera permission denied — allow camera access and reload."
        : "Could not start: " + err.message}</p>
       <button id="btnCamera" class="btn btn-primary">Try again</button>`;
    $("btnCamera").onclick = enableCamera;
  }
}

const drawer = () => new DrawingUtils(ctx);
let drawingUtils = null;

function loop() {
  if (!state.cameraOn) return;
  if (video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    const result = state.landmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const lm = result.landmarks?.[0];
    if (lm) {
      if (!drawingUtils) drawingUtils = drawer();
      drawingUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#a3e635", lineWidth: 3 });
      drawingUtils.drawLandmarks(lm, { color: "#ffffff", fillColor: "#ffffff", radius: 3 });
      if (state.running) onFrame(lm);
    } else if (state.running) {
      setCue("I can't see you — step into frame.", "warn");
    }
  }
  state.rafId = requestAnimationFrame(loop);
}

/* ================= session logic ================= */

let lastFault = { text: "", at: 0 };
let fatigueWarned = false;

// Real-life safety: warn when form degrades rep-over-rep (fatigue),
// before bad reps become injuries.
function checkFatigue() {
  const s = state.scores;
  if (fatigueWarned || s.length < 4) return;
  const [a, b, c] = s.slice(-3);
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  if (a > b && b > c && c < avg - 10) {
    fatigueWarned = true;
    setCue("Fatigue detected — form is dropping. Rest before your next set.", "warn");
    speak("Your form is dropping. Take a rest before the next set.", { force: true });
  }
}

function onFrame(lm) {
  const r = state.analyzer.update(lm);
  $("phaseBadge").textContent = r.phase;

  if (r.cues.length) {
    const top = r.cues.sort((a, b) => b.level - a.level)[0];
    setCue(top.text, top.level === PRIORITY.CRITICAL ? "bad" : top.level === PRIORITY.WARN ? "warn" : "good");
    if (top.level >= PRIORITY.WARN) {
      speak(top.text);
      // a held bad position counts as one fault, not one per frame
      const now = performance.now();
      if (top.text !== lastFault.text || now - lastFault.at > 3000) {
        state.faults[top.text] = (state.faults[top.text] || 0) + 1;
        lastFault = { text: top.text, at: now };
      }
    }
  }

  if (r.repDone) {
    state.reps++;
    if (r.repScore !== null) state.scores.push(r.repScore);
    state.repTimes.push(performance.now());
    checkFatigue();
    $("repCount").textContent = state.reps;
    if (state.exercise === "jump" && state.analyzer.lastJumpCm) {
      speak(`${state.analyzer.lastJumpCm} centimetres`, { force: true });
    } else {
      speakRep(state.reps);
    }
    updateScoreRing();
  }
  if (r.metric) setCue(r.metric, "good");
}

function updateScoreRing() {
  const avg = state.scores.length
    ? Math.round(state.scores.reduce((a, b) => a + b, 0) / state.scores.length) : 0;
  $("scoreVal").textContent = state.scores.length ? avg : "–";
  $("scoreRing").style.setProperty("--pct", avg);
}

function setCue(text, cls) {
  const el = $("liveCue");
  el.textContent = text;
  el.className = "live-cue " + (cls || "");
}

function startSession() {
  state.analyzer = EXERCISES[state.exercise].make(() => +$("userHeight").value || 170);
  state.running = true;
  state.reps = 0; state.scores = []; state.faults = {};
  state.repTimes = []; fatigueWarned = false;
  $("repCount").textContent = "0";
  updateScoreRing();
  $("btnSession").textContent = "Finish session";
  setCue("Session started — let's go!", "good");
  speak(`${EXERCISES[state.exercise].name} session started. Let's go!`, { force: true });
  $("summary").classList.add("hidden");
}

function finishSession() {
  state.running = false;
  $("btnSession").textContent = "Start session";
  const avg = state.scores.length
    ? Math.round(state.scores.reduce((a, b) => a + b, 0) / state.scores.length) : 0;
  const session = {
    date: new Date().toISOString(),
    shortDate: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    exercise: EXERCISES[state.exercise].name,
    reps: state.reps,
    avgScore: avg,
    faults: state.faults,
    bestJumpCm: state.analyzer.bestJumpCm || 0,
  };
  if (state.reps > 0) {
    const all = loadSessions();
    all.push(session);
    localStorage.setItem("formcoach.sessions", JSON.stringify(all));
    refreshProgress();
    showSummary(session);
    const note = summarize(session);
    speak(note, { force: true });
    requestReport(session, all);
  } else {
    setCue("Session ended — no reps recorded.", "warn");
  }
}

function showSummary(s) {
  $("summary").classList.remove("hidden");
  const cards = [
    { v: s.reps, l: s.exercise === "Vertical jump" ? "jumps" : "reps" },
    { v: s.avgScore, l: "avg form score" },
    { v: Object.values(s.faults).reduce((a, b) => a + b, 0), l: "faults flagged" },
  ];
  if (s.bestJumpCm) cards.push({ v: s.bestJumpCm + " cm", l: "best jump" });
  const t = state.repTimes;
  if (t.length >= 2) {
    const tempo = ((t[t.length - 1] - t[0]) / (t.length - 1) / 1000).toFixed(1);
    cards.push({ v: tempo + "s", l: "avg rep tempo" });
  }
  $("summaryCards").innerHTML = cards
    .map((c) => `<div class="sum-card"><b>${c.v}</b><span>${c.l}</span></div>`).join("");
  // per-rep score strip — a pro-training-log view of the whole set
  const band = (v) => (v >= 85 ? "good" : v >= 60 ? "warn" : "bad");
  $("repStrip").innerHTML = state.scores.length
    ? `<span class="rep-strip-label">Rep-by-rep quality:</span>` +
      state.scores.map((v, i) =>
        `<span class="rep-bar" data-band="${band(v)}" title="Rep ${i + 1}: ${v}/100" style="height:${Math.round(6 + v * 0.42)}px"></span>`
      ).join("")
    : "";
  $("summaryCoach").textContent = "🎙 Coach: " + summarize(s);
  $("summary").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ================= progress ================= */

function loadSessions() {
  try { return JSON.parse(localStorage.getItem("formcoach.sessions")) || []; } catch { return []; }
}

function refreshProgress() {
  const sessions = loadSessions();
  $("chartEmpty").classList.toggle("hidden", sessions.length > 0);
  renderChart($("chart"), sessions);
  renderTable($("chartTable"), sessions);
}

/* ================= chat ================= */

function addMsg(text, who) {
  const div = document.createElement("div");
  div.className = `msg msg-${who}`;
  div.textContent = text;
  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return div;
}

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("chatInput").value.trim();
  if (!q) return;
  $("chatInput").value = "";
  addMsg(q, "user");
  const pending = addMsg("thinking…", "coach");
  pending.classList.add("thinking");
  const reply = await coachReply(q, loadSessions());
  pending.classList.remove("thinking");
  pending.textContent = reply;
});

/* ================= settings modal ================= */

$("btnSettings").onclick = () => {
  const cfg = getLLMConfig();
  $("cfgEndpoint").value = cfg.endpoint || "https://api.featherless.ai/v1/chat/completions";
  $("cfgModel").value = cfg.model || "meta-llama/Meta-Llama-3.1-8B-Instruct";
  $("cfgKey").value = cfg.key || "";
  $("settingsModal").showModal();
};
$("cfgSave").onclick = () => {
  setLLMConfig({
    endpoint: $("cfgEndpoint").value.trim(),
    model: $("cfgModel").value.trim(),
    key: $("cfgKey").value.trim(),
  });
  $("settingsModal").close();
};
$("cfgClose").onclick = () => $("settingsModal").close();

/* ================= UI wiring ================= */

document.querySelectorAll(".ex-card").forEach((card) => {
  card.addEventListener("click", () => {
    if (state.running) finishSession();
    document.querySelectorAll(".ex-card").forEach((c) => {
      c.classList.toggle("selected", c === card);
      c.setAttribute("aria-selected", c === card);
    });
    state.exercise = card.dataset.ex;
    $("repLabel").textContent = EXERCISES[state.exercise].repNoun;
    $("jumpCalib").classList.toggle("hidden", state.exercise !== "jump");
    $("repCount").textContent = "0";
    setCue(`${EXERCISES[state.exercise].name} selected. Press Start session.`, "");
  });
});

$("btnCamera").onclick = enableCamera;
$("btnSession").onclick = () => (state.running ? finishSession() : startSession());

$("voiceToggle").onclick = () => {
  const on = $("voiceToggle").getAttribute("aria-pressed") !== "true";
  $("voiceToggle").setAttribute("aria-pressed", on);
  $("voiceToggle").textContent = on ? "🔊 Voice on" : "🔇 Voice off";
  setVoice(on);
};

/* ---------- hands-free voice control ---------- */

function selectExercise(key) {
  document.querySelector(`.ex-card[data-ex="${key}"]`)?.click();
}

function handleIntent(intent) {
  switch (intent) {
    case "start":
      if (!state.cameraOn) { speak("Enable the camera first.", { force: true }); return; }
      if (!state.running) { startSession(); }
      break;
    case "stop":
      if (state.running) finishSession();
      break;
    case "squat": case "pushup": case "curl": case "jump":
      selectExercise(intent);
      speak(`${EXERCISES[intent].name} selected. Say start when you're ready.`, { force: true });
      break;
    case "status": {
      const avg = state.scores.length
        ? Math.round(state.scores.reduce((a, b) => a + b, 0) / state.scores.length) : null;
      speak(state.running
        ? `${state.reps} reps so far${avg !== null ? `, form score ${avg}` : ""}.`
        : "No session running. Say start to begin.", { force: true });
      break;
    }
    case "help":
      speak("You can say: squats, push ups, curls, or jump to pick a drill. Start. Stop. Or, how am I doing.", { force: true });
      break;
    case "mic-denied":
      $("micToggle").setAttribute("aria-pressed", "false");
      $("micToggle").textContent = "🎤 Mic blocked";
      break;
  }
}

const micBtn = $("micToggle");
if (!voiceControlSupported()) {
  micBtn.disabled = true;
  micBtn.title = "Voice control needs Chrome or Edge";
  micBtn.textContent = "🎤 N/A";
} else {
  micBtn.onclick = () => {
    const on = micBtn.getAttribute("aria-pressed") !== "true";
    micBtn.setAttribute("aria-pressed", on);
    micBtn.textContent = on ? "🎤 Listening" : "🎤 Voice control";
    if (on) {
      startVoiceControl(handleIntent);
      speak("Voice control on. Say help to hear the commands.", { force: true });
    } else {
      stopVoiceControl();
    }
  };
}

$("tableToggle").onclick = () => {
  const showTable = $("chartTable").classList.contains("hidden");
  $("chartTable").classList.toggle("hidden", !showTable);
  $("chart").classList.toggle("hidden", showTable);
  $("tableToggle").setAttribute("aria-pressed", showTable);
};

refreshProgress();

// Installable PWA: relative path so it works at both / and /united/ (GitHub Pages)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

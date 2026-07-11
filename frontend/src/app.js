import { EXERCISES, PRIORITY, LM, angle } from "./engine/exercises.js";
import { speak, speakRep, setVoice, summarize, coachReply, getLLMConfig, setLLMConfig } from "./services/coach.js";
import { renderChart, renderTable } from "./ui/chart.js";
import { voiceControlSupported, startVoiceControl, stopVoiceControl } from "./services/voice.js";
import { requestReport } from "./ui/report.js";
import { downloadShareCard } from "./ui/share.js";
import { demoPose } from "./engine/demo.js";
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
  demo: false,           // synthetic-athlete mode (no camera needed)
  ghost: true,           // overlay of your best rep
  frames: 0,             // frames analyzed on-device (privacy HUD)
  repFrames: [],         // landmark frames of the current rep
  bestRep: null,         // frames of the best-scoring rep this session
  bestRepScore: -1,
  reps: 0,
  scores: [],
  repTimes: [],          // performance.now() per completed rep (tempo analytics)
  faults: {},            // cue text -> count
  rafId: null,
  lastVideoTime: -1,
};

/* ================= camera + model ================= */

async function loadModel() {
  if (state.landmarker) return;
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
}

async function startTracking() {
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
  $("btnGuided").disabled = false;
  loop();
}

async function enableCamera() {
  $("stageMsg").innerHTML = "<p>Loading pose model…</p>";
  try {
    await loadModel();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 720, facingMode: "user" }, audio: false,
    });
    video.srcObject = stream;
    await startTracking();
  } catch (err) {
    $("stageMsg").innerHTML =
      `<p>⚠ ${err.name === "NotAllowedError"
        ? "Camera permission denied — allow camera access and reload."
        : "Could not start: " + err.message}</p>
       <button id="btnCamera" class="btn btn-primary">Try again</button>`;
    $("btnCamera").onclick = enableCamera;
  }
}

// Analyze ANY footage — your own recordings, a training clip, a downloaded
// video of a pro athlete. Same engine, same coaching, no camera involved.
async function analyzeVideoFile(file) {
  $("stageMsg").innerHTML = "<p>Loading pose model…</p>";
  try {
    await loadModel();
    video.srcObject = null;
    video.src = URL.createObjectURL(file);
    video.loop = true;
    video.muted = true;
    document.querySelector(".stage").classList.add("file-mode"); // don't mirror uploaded footage
    await startTracking();
    setCue("Video loaded — press Start session to analyze the athlete.", "good");
  } catch (err) {
    $("stageMsg").innerHTML = `<p>⚠ Could not play that video: ${err.message}</p>
       <button id="btnCamera" class="btn btn-primary">Enable camera instead</button>`;
    $("btnCamera").onclick = enableCamera;
  }
}

const drawer = () => new DrawingUtils(ctx);
let drawingUtils = null;

/* ---------- telestration: live joint-angle readouts on the athlete ---------- */

const ANGLE_TRIPLES = {
  squat: [[LM.L_HIP, LM.L_KNEE, LM.L_ANKLE], [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE]],
  pushup: [[LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST], [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]],
  curl: [[LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST], [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]],
};

function drawLabel(text, x, y) {
  ctx.save();
  ctx.translate(x, y);
  // the canvas is CSS-mirrored in selfie mode — pre-flip text so it reads correctly
  if (!document.querySelector(".stage").classList.contains("file-mode")) ctx.scale(-1, 1);
  ctx.font = "700 15px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "center";
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = "rgba(11,14,19,0.75)";
  ctx.fillRect(-w / 2, -13, w, 19);
  ctx.fillStyle = "#a3e635";
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

function drawAngles(lm) {
  const triples = ANGLE_TRIPLES[state.exercise];
  if (!triples) return;
  for (const [a, b, c] of triples) {
    if ((lm[b]?.visibility ?? 0) < 0.5) continue;
    const deg = Math.round(angle(lm[a], lm[b], lm[c]));
    const x = lm[b].x * overlay.width, y = lm[b].y * overlay.height;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(163,230,53,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    drawLabel(`${deg}°`, x, y - 26);
  }
}

/* ---------- ghost rep: race your own best form ---------- */

let ghostIdx = 0;

function recordFrame(lm) {
  if (state.repFrames.length < 300) {
    state.repFrames.push(lm.map((p) => ({ x: p.x, y: p.y, z: 0, visibility: p.visibility ?? 1 })));
  }
}

function maybeSaveBestRep(score) {
  if (score !== null && score >= state.bestRepScore && state.repFrames.length > 5) {
    state.bestRep = state.repFrames;
    state.bestRepScore = score;
  }
  state.repFrames = [];
}

function drawGhost() {
  if (!state.ghost || !state.bestRep || !state.running) return;
  const f = state.bestRep[ghostIdx++ % state.bestRep.length];
  drawingUtils.drawConnectors(f, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(163,230,53,0.22)", lineWidth: 2 });
}

/* ---------- demo mode: synthetic athlete, no camera required ---------- */

function startDemo() {
  if (state.demo || state.cameraOn) return;
  state.demo = true;
  overlay.width = 640;
  overlay.height = 480;
  $("stageMsg").classList.add("hidden");
  $("phaseBadge").classList.remove("hidden");
  $("btnSession").disabled = false;
  $("btnGuided").disabled = false;
  selectExercise("squat");
  setCue("Demo athlete loaded — press Start session to watch the AI coach it.", "good");
  demoLoop();
}

function demoLoop() {
  if (!state.demo) return;
  ctx.fillStyle = "#10151c";
  ctx.fillRect(0, 0, overlay.width, overlay.height);
  const lm = demoPose(performance.now());
  countFrame();
  if (!drawingUtils) drawingUtils = drawer();
  drawGhost();
  drawingUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#a3e635", lineWidth: 3 });
  drawingUtils.drawLandmarks(lm, { color: "#ffffff", fillColor: "#ffffff", radius: 3 });
  if (state.running) { onFrame(lm); drawAngles(lm); }
  requestAnimationFrame(demoLoop);
}

function loop() {
  if (!state.cameraOn) return;
  if (video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    const result = state.landmarker.detectForVideo(video, performance.now());
    countFrame();
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const lm = result.landmarks?.[0];
    if (lm) {
      if (!drawingUtils) drawingUtils = drawer();
      drawGhost();
      drawingUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#a3e635", lineWidth: 3 });
      drawingUtils.drawLandmarks(lm, { color: "#ffffff", fillColor: "#ffffff", radius: 3 });
      if (state.running) { onFrame(lm); drawAngles(lm); }
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

function countFrame() {
  state.frames++;
  if (state.frames % 15 === 0) $("framesCount").textContent = state.frames.toLocaleString();
}

const localOnly = () => $("localOnly").checked;

function onFrame(lm) {
  if (guided?.phase === "rest") return; // resting — the athlete is off the clock
  recordFrame(lm);
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
    maybeSaveBestRep(r.repScore);
    checkFatigue();
    $("repCount").textContent = state.reps;
    if (state.exercise === "jump" && state.analyzer.lastJumpCm) {
      speak(`${state.analyzer.lastJumpCm} centimetres`, { force: true });
    } else {
      speakRep(state.reps);
    }
    updateScoreRing();
    guidedAfterRep();
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

/* ---------- guided workout: sets x reps, voice-run rest timers ---------- */

let guided = null; // {sets, reps, rest, set, setStartReps, phase, timer}

function startGuidedWorkout() {
  guided = {
    sets: +$("gSets").value,
    reps: +$("gReps").value,
    rest: +$("gRest").value,
    set: 1,
    setStartReps: 0,
    phase: "work",
    timer: null,
  };
  startSession();
  speak(`Guided workout: ${guided.sets} sets of ${guided.reps}. Set 1 — go!`, { force: true });
  setCue(`Set 1 of ${guided.sets} — ${guided.reps} reps. Go!`, "good");
}

function endGuided() {
  if (guided?.timer) clearInterval(guided.timer);
  guided = null;
}

function startRest() {
  guided.phase = "rest";
  let remaining = guided.rest;
  $("phaseBadge").textContent = "Rest";
  speak(`Set ${guided.set} done. Rest ${guided.rest} seconds.`, { force: true });
  guided.timer = setInterval(() => {
    remaining--;
    setCue(`Rest: ${remaining}s — set ${guided.set + 1} of ${guided.sets} next`, "");
    if (remaining === 10) speak("10 seconds.", { force: true });
    if (remaining <= 0) {
      clearInterval(guided.timer);
      guided.timer = null;
      guided.set++;
      guided.setStartReps = state.reps;
      guided.phase = "work";
      speak(`Set ${guided.set} of ${guided.sets} — go!`, { force: true });
      setCue(`Set ${guided.set} of ${guided.sets} — ${guided.reps} reps. Go!`, "good");
    }
  }, 1000);
}

function guidedAfterRep() {
  if (!guided || guided.phase !== "work") return;
  const inSet = state.reps - guided.setStartReps;
  if (inSet < guided.reps) return;
  if (guided.set >= guided.sets) {
    speak("Workout complete. Outstanding work!", { force: true });
    endGuided();
    finishSession();
  } else {
    startRest();
  }
}

function startSession() {
  state.analyzer = EXERCISES[state.exercise].make(() => +$("userHeight").value || 170);
  state.running = true;
  state.reps = 0; state.scores = []; state.faults = {};
  state.repTimes = []; fatigueWarned = false;
  state.repFrames = []; state.bestRep = null; state.bestRepScore = -1; ghostIdx = 0;
  $("repCount").textContent = "0";
  updateScoreRing();
  $("btnSession").textContent = "Finish session";
  setCue("Session started — let's go!", "good");
  speak(`${EXERCISES[state.exercise].name} session started. Let's go!`, { force: true });
  $("summary").classList.add("hidden");
}

function finishSession() {
  endGuided();
  state.running = false;
  $("btnSession").textContent = "Start session";
  const avg = state.scores.length
    ? Math.round(state.scores.reduce((a, b) => a + b, 0) / state.scores.length) : 0;
  const session = {
    date: new Date().toISOString(),
    shortDate: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    athlete: localStorage.getItem("formcoach.athlete") || "Solo athlete",
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
    if (localOnly()) {
      document.getElementById("report").classList.add("hidden");
    } else {
      requestReport(session, all);
    }
  } else {
    setCue("Session ended — no reps recorded.", "warn");
  }
}

let lastSession = null;
$("btnShare").onclick = () => lastSession && downloadShareCard(lastSession);

function showSummary(s) {
  lastSession = s;
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

// Gamification: training streak + personal records from local history.
function renderStreaks(sessions) {
  const el = $("streakTiles");
  if (!sessions.length) { el.innerHTML = ""; return; }
  const days = new Set(sessions.map((s) => s.date.slice(0, 10)));
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (days.has(key)) streak++;
    else if (i === 0) continue; // no session yet today — streak can still be alive
    else break;
  }
  const tiles = [
    { v: `${streak} 🔥`, l: "day streak" },
    { v: sessions.length, l: "total sessions" },
    { v: Math.max(...sessions.map((s) => s.avgScore)), l: "best form score" },
  ];
  const bestJump = Math.max(...sessions.map((s) => s.bestJumpCm || 0));
  if (bestJump) tiles.push({ v: bestJump + " cm", l: "jump PR" });
  el.innerHTML = tiles
    .map((t) => `<div class="sum-card"><b>${t.v}</b><span>${t.l}</span></div>`).join("");
}

function refreshProgress() {
  const sessions = loadSessions();
  $("chartEmpty").classList.toggle("hidden", sessions.length > 0);
  renderStreaks(sessions);
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
  $("cfgName").value = localStorage.getItem("formcoach.athlete") || "";
  const cfg = getLLMConfig();
  $("cfgEndpoint").value = cfg.endpoint || "https://api.featherless.ai/v1/chat/completions";
  $("cfgModel").value = cfg.model || "meta-llama/Meta-Llama-3.1-8B-Instruct";
  $("cfgKey").value = cfg.key || "";
  $("settingsModal").showModal();
};
$("cfgSave").onclick = () => {
  const name = $("cfgName").value.trim();
  if (name) localStorage.setItem("formcoach.athlete", name);
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

$("btnCamera").onclick = () => { state.demo = false; enableCamera(); };
$("btnDemo").onclick = startDemo;
$("btnGuided").onclick = () => { if (!state.running) startGuidedWorkout(); };
$("btnVideo").onclick = () => $("videoFile").click();
$("videoFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) { state.demo = false; analyzeVideoFile(file); }
});
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
      if (!state.cameraOn && !state.demo) { speak("Enable the camera first.", { force: true }); return; }
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

$("localOnly").checked = localStorage.getItem("formcoach.localOnly") === "1";
$("localOnly").addEventListener("change", () => {
  localStorage.setItem("formcoach.localOnly", $("localOnly").checked ? "1" : "0");
});

$("ghostToggle").onclick = () => {
  state.ghost = !state.ghost;
  $("ghostToggle").setAttribute("aria-pressed", state.ghost);
  $("ghostToggle").textContent = state.ghost ? "👻 Ghost rep on" : "👻 Ghost rep off";
};

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

import { EXERCISES, PRIORITY, LM, angle } from "./engine/exercises.js";
import { speak, speakRep, speakQueued, setVoice, summarize, coachReply, coachReplyStream, coachReview, liveCoachLine, getLLMConfig, setLLMConfig } from "./services/coach.js";
import { renderChart, renderTable } from "./ui/chart.js";
import { voiceControlSupported, startVoiceControl, stopVoiceControl } from "./services/voice.js";
import { requestReport } from "./ui/report.js";
import { downloadShareCard } from "./ui/share.js";
import { demoPose } from "./engine/demo.js";
import { createSmoother } from "./engine/smooth.js";
import { compareToBaseline } from "./engine/twin.js";
import { register, signIn, signOut, resume, currentUser, loadVault, saveVault } from "./services/auth.js";
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
  bestMetrics: null,     // per-rep metrics of the best rep (Movement Twin baseline)
  reps: 0,
  scores: [],
  repTimes: [],          // performance.now() per completed rep (tempo analytics)
  repHistory: [],        // full measurement timeline for the Coach's Review
  sessionStart: 0,
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
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
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

// Analyze anything on your screen — point it at a YouTube tab and FormCoach
// coaches the athlete in the video live, while it plays.
async function analyzeScreen() {
  $("stageMsg").innerHTML = "<p>Loading pose model…</p>";
  try {
    await loadModel();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    video.srcObject = stream;
    document.querySelector(".stage").classList.add("file-mode"); // screen content isn't a selfie
    await startTracking();
    setCue("Screen connected — play the athlete's video and press Start session.", "good");
    stream.getVideoTracks()[0].addEventListener("ended", () => location.reload());
  } catch (err) {
    $("stageMsg").innerHTML = `<p>⚠ Screen capture ${err.name === "NotAllowedError" ? "was declined" : "failed: " + err.message}.</p>
       <button id="btnCamera" class="btn btn-primary">Enable camera instead</button>`;
    $("btnCamera").onclick = enableCamera;
  }
}

const drawer = () => new DrawingUtils(ctx);
let drawingUtils = null;
const smoother = createSmoother();

/* ---------- telestration: live joint-angle readouts on the athlete ---------- */

const ANGLE_TRIPLES = {
  plank: [[LM.L_SHOULDER, LM.L_HIP, LM.L_ANKLE], [LM.R_SHOULDER, LM.R_HIP, LM.R_ANKLE]],
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
  ctx.fillStyle = "rgba(20,18,40,0.78)";
  ctx.fillRect(-w / 2, -13, w, 19);
  ctx.fillStyle = "#c3c1ff";
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
    ctx.strokeStyle = "rgba(125,123,255,0.9)";
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

function maybeSaveBestRep(score, metrics) {
  if (score !== null && score >= state.bestRepScore && state.repFrames.length > 5) {
    state.bestRep = state.repFrames;
    state.bestRepScore = score;
    state.bestMetrics = metrics || state.bestMetrics;
    if (state.reps === 1) speak("Personal best captured. Now match it.", { force: true });
  }
  state.repFrames = [];
}

function drawGhost() {
  if (!state.ghost || !state.bestRep || !state.running) return;
  const f = state.bestRep[ghostIdx++ % state.bestRep.length];
  drawingUtils.drawConnectors(f, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(125,123,255,0.28)", lineWidth: 2 });
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
  ctx.fillStyle = "#141228";
  ctx.fillRect(0, 0, overlay.width, overlay.height);
  const lm = demoPose(performance.now());
  countFrame();
  if (!drawingUtils) drawingUtils = drawer();
  drawGhost();
  drawingUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#7d7bff", lineWidth: 3 });
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
    const raw = result.landmarks?.[0];
    const lm = raw ? smoother.smooth(raw) : (smoother.reset(), null);
    if (lm) {
      if (!drawingUtils) drawingUtils = drawer();
      drawGhost();
      drawingUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#7d7bff", lineWidth: 3 });
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

// The coach shouldn't sound like a recording: rotate spoken phrasings while
// keeping the canonical text for HUD display and fault tracking.
const CUE_VARIANTS = {
  "Chest up — you're leaning too far forward.": [
    "Chest up — you're leaning too far forward.",
    "Lift that chest, keep your torso tall.",
    "You're tipping forward — proud chest!",
  ],
  "Too shallow — aim to get thighs near parallel.": [
    "Too shallow — aim to get thighs near parallel.",
    "Sink deeper — get those thighs parallel.",
    "Half reps build half strength — go deeper.",
  ],
  "Go lower — chest toward the floor.": [
    "Go lower — chest toward the floor.",
    "More range — bring your chest to the floor.",
  ],
  "Knees caving in — push them out over your toes.": [
    "Knees caving in — push them out over your toes.",
    "Careful — knees out, track them over your toes.",
  ],
  "Hips sagging — squeeze your glutes, straight body line.": [
    "Hips sagging — squeeze your glutes, straight body line.",
    "Tighten up — hips level, body like a plank.",
  ],
  "Pin your elbow to your side — no swinging.": [
    "Pin your elbow to your side — no swinging.",
    "Strict form — stop swinging that elbow.",
  ],
};
const cueRotation = {};
function vary(text) {
  const opts = CUE_VARIANTS[text];
  if (!opts) return text;
  cueRotation[text] = ((cueRotation[text] ?? -1) + 1) % opts.length;
  return opts[cueRotation[text]];
}
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
    const declineRep = s.length - 2;
    setCue(`Form began declining after rep ${declineRep} — rest before your next set.`, "warn");
    speak(`Your form began declining after rep ${declineRep}. Take a rest before the next set.`, { force: true });
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
      speak(vary(top.text));
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
    // Movement Twin: measure this rep against the athlete's own best
    let twinDeviation = null;
    if (state.bestMetrics && r.repMetrics && r.repScore < state.bestRepScore) {
      const devs = compareToBaseline(state.exercise, state.bestMetrics, r.repMetrics);
      if (devs.length) {
        twinDeviation = devs[0];
        setCue(devs[0], "warn");
        speak(devs[0]);
        state.faults[devs[0]] = (state.faults[devs[0]] || 0) + 1;
      }
    }
    state.repHistory.push({
      rep: state.reps,
      atSeconds: Math.round((performance.now() - state.sessionStart) / 1000),
      score: r.repScore,
      metrics: r.repMetrics || undefined,
      vsBest: twinDeviation || undefined,
    });
    maybeSaveBestRep(r.repScore, r.repMetrics);
    checkFatigue();
    // Live AI commentary every 3rd rep — the LLM reacts to what the vision
    // engine just measured, spoken moments later without blocking the loop.
    if (state.reps % 3 === 0) {
      const avg = state.scores.length
        ? Math.round(state.scores.reduce((x, y) => x + y, 0) / state.scores.length) : null;
      liveCoachLine({
        exercise: EXERCISES[state.exercise].name,
        repJustCompleted: state.reps,
        lastRepScore: r.repScore,
        sessionAverage: avg,
        vsPersonalBest: twinDeviation || "matching their best",
        fatigueWarning: fatigueWarned,
      }).then((line) => {
        // lowest-priority voice: never interrupt a safety cue mid-sentence
        if (line && state.running && !speechSynthesis.speaking) {
          speak(line);
          setCue("🧠 " + line, "good");
        }
      });
    }
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
  state.repFrames = []; state.bestRep = null; state.bestRepScore = -1; state.bestMetrics = null; ghostIdx = 0;
  state.repHistory = []; state.sessionStart = performance.now();
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
    athlete: athleteName() || "Solo athlete",
    exercise: EXERCISES[state.exercise].name,
    reps: state.reps,
    avgScore: avg,
    faults: state.faults,
    bestJumpCm: state.analyzer.bestJumpCm || 0,
  };
  if (state.reps > 0) {
    sessionsCache.push(session);
    saveVault(sessionsCache).catch(() => {});
    refreshProgress();
    showSummary(session);
    const note = summarize(session);
    speak(note, { force: true });
    // Event-driven AI debrief: the LLM reacts to the finished workout and
    // speaks a personalized close-out once the stats readout ends.
    liveCoachLine({
      event: "workout_complete",
      exercise: session.exercise,
      reps: session.reps,
      averageFormScore: session.avgScore,
      topFaults: Object.keys(session.faults).slice(0, 2),
      bestJumpCm: session.bestJumpCm || undefined,
    }).then((line) => {
      if (!line) return;
      let tries = 0;
      const sayWhenQuiet = () => {
        if (!speechSynthesis.speaking) speak(line, { force: true });
        else if (++tries < 8) setTimeout(sayWhenQuiet, 1500);
      };
      sayWhenQuiet();
    });
    if (localOnly()) {
      document.getElementById("report").classList.add("hidden");
    } else {
      requestReport(session, mySessions());
    }
  } else {
    setCue("Session ended — no reps recorded.", "warn");
  }
}

let lastSession = null;
$("btnShare").onclick = () => lastSession && downloadShareCard(lastSession);

async function renderCoachReview(session) {
  const box = $("coachReview");
  box.classList.add("hidden");
  box.textContent = "";
  if (!state.repHistory.length) return;
  const timeline = {
    exercise: session.exercise,
    durationSeconds: Math.round((performance.now() - state.sessionStart) / 1000),
    averageScore: session.avgScore,
    fatigueDetected: fatigueWarned,
    reps: state.repHistory,
  };
  let started = false;
  const full = await coachReview(timeline, (sentence) => {
    if (!started) {
      started = true;
      box.classList.remove("hidden");
      box.textContent = "🧠 Coach's review: ";
    }
    box.textContent += sentence + " ";
  });
  if (full) {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = "🔊 Read aloud";
    btn.onclick = () => speak(full, { force: true });
    box.appendChild(btn);
  }
}

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
  renderCoachReview(s);
  $("summary").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ================= progress ================= */

// In-memory session store — the signed-in user's decrypted vault, or the
// guest legacy store. All reads go through this cache; writes re-encrypt.
let sessionsCache = [];

function loadSessions() {
  return sessionsCache;
}

/* ---------- accounts: email+password, per-user encrypted history ---------- */

const athleteName = () =>
  currentUser()?.split("@")[0] || localStorage.getItem("formcoach.athlete") || "";

// Signed-in users' vaults are already theirs alone; guests filter legacy data.
const mySessions = () =>
  currentUser() ? sessionsCache : sessionsCache.filter((s) => !s.athlete || s.athlete === athleteName());

function setAthlete(name) {
  localStorage.setItem("formcoach.athlete", name);
  updateProfileChip();
  refreshProgress();
}

function updateProfileChip() {
  $("profileChip").textContent = "👤 " + (currentUser() || athleteName() || "Sign in");
  $("authSignedInRow").hidden = !currentUser();
}

async function afterAuthChange() {
  sessionsCache = await loadVault();
  updateProfileChip();
  refreshProgress();
}

async function tryAuth(fn) {
  $("authError").textContent = "";
  try {
    await fn($("authEmail").value, $("authPass").value);
    $("authPass").value = "";
    $("welcomeModal").close();
    await afterAuthChange();
    speak(`Signed in. Welcome, ${athleteName()}!`, { force: true });
  } catch (err) {
    $("authError").textContent = err.message;
  }
}

$("authSignIn").onclick = () => tryAuth(signIn);
$("authRegister").onclick = () => tryAuth(register);
$("authGuest").onclick = () => {
  if (!localStorage.getItem("formcoach.athlete")) localStorage.setItem("formcoach.athlete", "Guest");
  $("welcomeModal").close();
  afterAuthChange();
};
$("authSignOut").onclick = async () => {
  signOut();
  $("welcomeModal").close();
  await afterAuthChange();
};
$("profileChip").onclick = () => {
  $("authEmail").value = currentUser() || "";
  $("welcomeModal").showModal();
};

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
  const sessions = mySessions();
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
  let first = true;
  const reply = await coachReplyStream(q, mySessions(), (sentence) => {
    if (first) { pending.classList.remove("thinking"); pending.textContent = ""; first = false; }
    pending.textContent += (pending.textContent ? " " : "") + sentence;
  });
  if (first) { pending.classList.remove("thinking"); pending.textContent = reply.text; }
  const tag = document.createElement("span");
  tag.className = "msg-engine";
  tag.textContent = reply.engine;
  pending.appendChild(tag);
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
  if (name) setAthlete(name);
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
$("btnScreen").onclick = () => { state.demo = false; analyzeScreen(); };
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

function handleIntent(intent, text) {
  switch (intent) {
    case "start":
      if (!state.cameraOn && !state.demo) { speak("Enable the camera first.", { force: true }); return; }
      if (!state.running) { startSession(); }
      break;
    case "stop":
      if (state.running) finishSession();
      break;
    case "squat": case "pushup": case "curl": case "jump": case "jacks": case "knees": case "plank":
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
      speak("You can say: squats, push ups, curls, or jump to pick a drill. Start. Stop. How am I doing. Or just ask me anything — I'll answer.", { force: true });
      break;
    case "chat": {
      // Full hands-free conversation, streamed: the coach starts SPEAKING the
      // first sentence while the rest of the answer is still generating.
      addMsg(text, "user");
      const pending = addMsg("", "coach");
      pending.classList.add("thinking");
      pending.textContent = "thinking…";
      let first = true;
      coachReplyStream(text, mySessions(), (sentence) => {
        if (first) { pending.classList.remove("thinking"); pending.textContent = ""; first = false; }
        pending.textContent += (pending.textContent ? " " : "") + sentence;
        speakQueued(sentence);
      }).then((reply) => {
        if (first) { pending.classList.remove("thinking"); pending.textContent = reply.text; speak(reply.text, { force: true }); }
        const tag = document.createElement("span");
        tag.className = "msg-engine";
        tag.textContent = reply.engine;
        pending.appendChild(tag);
      });
      break;
    }
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
  $("ghostToggle").textContent = state.ghost ? "👻 Movement Twin on" : "👻 Movement Twin off";
};

$("tableToggle").onclick = () => {
  const showTable = $("chartTable").classList.contains("hidden");
  $("chartTable").classList.toggle("hidden", !showTable);
  $("chart").classList.toggle("hidden", showTable);
  $("tableToggle").setAttribute("aria-pressed", showTable);
};

// Boot: restore the tab's signed-in user (if any), decrypt their vault,
// then render. First-time visitors get the sign-in screen.
(async () => {
  await resume();
  await afterAuthChange();
  if (!currentUser() && !localStorage.getItem("formcoach.athlete")) {
    $("welcomeModal").showModal();
  }
})();

/* ---------- tabs: Train / Progress / Coach as separate screens ---------- */

const TABS = {
  train: ["train", "summary", "report"],
  progress: ["progress"],
  coach: ["coach"],
};

function showTab(name) {
  if (!TABS[name]) name = "train";
  const visible = new Set(TABS[name]);
  for (const ids of Object.values(TABS)) {
    for (const id of ids) {
      document.getElementById(id)?.classList.toggle("tab-hidden", !visible.has(id));
    }
  }
  document.querySelectorAll('.topnav a[data-tab]').forEach((link) => {
    link.classList.toggle("active", link.dataset.tab === name);
  });
}

window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1) || "train");

// Never keep talking after the athlete leaves the page.
window.addEventListener("pagehide", () => speechSynthesis.cancel());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) speechSynthesis.cancel();
});

// Installable PWA: relative path so it works at both / and /united/ (GitHub Pages)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

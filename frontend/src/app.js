import { EXERCISES, PRIORITY, LM, angle } from "./engine/exercises.js";
import { speak, speakRep, speakQueued, setVoice, summarize, coachReply, coachReplyStream, coachReview, liveCoachLine, visionReport, findVisionModel, liveVisionLine, resetChat, getLLMConfig, setLLMConfig } from "./services/coach.js";
import { renderChart, renderTable } from "./ui/chart.js";
import { voiceControlSupported, startVoiceControl, stopVoiceControl, setBargeIn } from "./services/voice.js";
import { requestReport } from "./ui/report.js";
import { downloadShareCard } from "./ui/share.js";
import { askMemoryCoach, syncCoachMemory } from "./services/memoryCoach.js";
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
  faultShots: [],        // evidence snapshots: the exact frame of each fault
  sampleShots: [],       // timed form-check snapshots for the visual report
  lastSampleAt: 0,
  errorLog: [],          // 📓 written notebook: every fault, timestamped
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
  press: [[LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST], [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]],
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
      state.missedFrames = 0;
    } else if (state.running) {
      // Fast movement (high knees, jacks) drops single frames constantly —
      // only complain after ~1s of genuinely lost tracking.
      state.missedFrames = (state.missedFrames || 0) + 1;
      if (state.missedFrames > 25) setCue("I can't see you — step into frame.", "warn");
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
  // timed form-check snapshots: every 5s, so the visual report can review the
  // whole session — not only the moments physics flagged
  const atSec = (performance.now() - state.sessionStart) / 1000;
  if (atSec - state.lastSampleAt >= 5 && state.sampleShots.length < 10) {
    state.lastSampleAt = atSec;
    state.sampleShots.push({ at: Math.round(atSec), text: "form check", img: frameSnapshot() });
  }
  recordFrame(lm);
  const r = state.analyzer.update(lm);
  $("phaseBadge").textContent = r.phase;

  if (r.cues.length) {
    const top = r.cues.sort((a, b) => b.level - a.level)[0];
    // `say` carries this rep's MEASURED numbers — every correction is
    // specific to what actually happened, never a canned repeat
    const spoken = top.say || vary(top.text);
    setCue(top.say || top.text, top.level === PRIORITY.CRITICAL ? "bad" : top.level === PRIORITY.WARN ? "warn" : "good");
    if (top.level >= PRIORITY.WARN) {
      speak(spoken, { interrupt: top.level === PRIORITY.CRITICAL });
      // a held bad position counts as one fault, not one per frame
      const now = performance.now();
      if (top.text !== lastFault.text || now - lastFault.at > 3000) {
        state.faults[top.text] = (state.faults[top.text] || 0) + 1;
        lastFault = { text: top.text, at: now };
        captureFaultShot(top.say || top.text);
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
        captureFaultShot(devs[0]);
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

// Evidence snapshot — like a coach photographing the exact moment of a fault.
// Stays in memory only: never uploaded, never persisted (privacy by default).
function frameSnapshot() {
  const w = 320;
  const h = Math.round((w * (overlay.height || 3)) / (overlay.width || 4));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d");
  const mirrored = !document.querySelector(".stage").classList.contains("file-mode");
  if (mirrored) { cx.translate(w, 0); cx.scale(-1, 1); }
  if (video.videoWidth) cx.drawImage(video, 0, 0, w, h);
  else { cx.fillStyle = "#141228"; cx.fillRect(0, 0, w, h); }
  cx.drawImage(overlay, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.6);
}

function captureFaultShot(label) {
  if (eyesModel) eyesTick(true); // Live Coach: look at this mistake right now
  const at = Math.round((performance.now() - state.sessionStart) / 1000);
  // the written notebook records EVERY fault (text is cheap and persists);
  // photos stop at 12 (memory-only evidence, enough for the visual report)
  if (state.errorLog.length < 100) {
    state.errorLog.push({ at, rep: state.reps + 1, text: label });
  }
  if (state.faultShots.length >= 12) return;
  state.faultShots.push({ at, text: label, img: frameSnapshot() });
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
  state.repHistory = []; state.sessionStart = performance.now(); state.faultShots = [];
  state.sampleShots = []; state.lastSampleAt = 0; state.errorLog = [];
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
  setCue("Session complete — your summary is below.", "good");
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
    errorLog: state.errorLog,
  };
  if (state.reps > 0) {
    sessionsCache.push(session);
    saveVault(sessionsCache).catch(() => {});
    syncMemoryCoach().catch(() => {});
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
    faultEvents: state.faultShots.map(({ at, text }) => ({ atSeconds: at, fault: text })),
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


/* hosted page + blocked local AI -> show the escape hatch prominently */
if (location.protocol === "https:") {
  $("lanDismiss").onclick = () => $("lanBanner").classList.add("hidden");
  const checkLan = async () => {
    try {
      const r = await fetch("http://localhost:11434/api/tags", { targetAddressSpace: "loopback", signal: AbortSignal.timeout(2500) });
      $("lanBanner").classList.toggle("hidden", r.ok);
    } catch { $("lanBanner").classList.remove("hidden"); }
  };
  checkLan();
  setInterval(checkLan, 20000);
}

/* ============ session flip-book: one downloadable book per session ============ */

const esc = (t) => String(t)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function visionNotesByStamp(s) {
  const notes = {};
  if (Array.isArray(s.visionShots)) {
    for (const v of s.visionShots) notes[v.stamp || tstamp(v.at)] = v.note;
  }
  // Backward compatibility for books generated from sessions saved before
  // per-image notes were added.
  (s.visionNote || "").split("⏱").slice(1).forEach((part) => {
    const stamp = part.slice(0, 8).trim().split(" ")[0];
    notes[stamp] = part.slice(part.indexOf("\n") + 1).trim();
  });
  return notes;
}

function buildSessionBook(s) {
  const shots = [...state.faultShots, ...state.sampleShots].sort((x, y) => x.at - y.at);
  const notes = {};
  if (Array.isArray(s.visionShots)) {
    for (const v of s.visionShots) notes[v.stamp || tstamp(v.at)] = v.note;
  }
  const fmtNote = (n) => esc(n).split("\n").map((line) => {
    const m = line.match(/^(Problem|Why it matters|Fix|Drill):/);
    return m ? `<p class="vl"><b>${m[1]}</b>${line.slice(m[0].length)}</p>` : (line.trim() ? `<p class="vl">${line}</p>` : "");
  }).join("");

  // faces of the paper sheets: [cover, photo, note, photo, note, …, notebook, verdict]
  // sheet k = front faces[2k], back faces[2k+1] — flipping a sheet around the
  // spine reveals photo (left) + its AI note (right), like a real book.
  const faces = [];
  faces.push(`<div class="cov-frame">
    <p class="cov-house">FormCoach AI · Training Press</p>
    <div class="cov-rule"></div>
    <h1>${esc(s.exercise)}</h1>
    <p class="cov-sub">A Session in ${s.reps} ${s.exercise === "Plank" ? "Seconds" : "Reps"}</p>
    <div class="cov-medal"><span>${s.avgScore}</span><small>/100 form</small></div>
    <p class="cov-athlete">${esc(s.athlete)}</p>
    <p class="cov-date">${esc(s.shortDate)}</p>
    <div class="cov-rule"></div>
    <p class="cov-note">Every photograph analyzed on this device · nothing uploaded</p>
    <p class="cov-hint">Tap the page or press → to open</p>
  </div>`);
  for (const f of shots) {
    const stamp = tstamp(f.at);
    faces.push(`<figure class="photo"><img src="${f.img}" alt="training frame at ${stamp}" />
      <figcaption>⏱ ${stamp}</figcaption></figure>`);
    faces.push(`<h3><span class="stamp">⏱ ${stamp}</span></h3><p class="fault">${esc(f.text)}</p>
      ${notes[stamp] ? `<div class="vn">${fmtNote(notes[stamp])}</div>` : `<p class="vn">Timed form-check frame.</p>`}`);
  }
  faces.push(`<h3>📓 Error notebook</h3><div class="ruled">
    ${state.errorLog.map((n) => `<p class="err">⏱ ${tstamp(n.at)} · rep ${n.rep} — ${esc(n.text)}</p>`).join("") || "<p class='err clean'>No faults — clean session!</p>"}</div>`);
  faces.push(`<div class="verdict"><h3>Coach's Verdict</h3>
    <p class="v-text">${esc(summarize(s))}</p>
    <p class="v-sign">— FormCoach</p><div class="v-seal">🏅</div>
    <p class="v-fine">Written on the athlete's own device · United Hacks V7 · no cloud, no uploads</p></div>`);
  if (faces.length % 2) faces.push(`<p class="fin">Fin 🏁</p>`);

  const sheets = [];
  for (let k = 0; k * 2 < faces.length; k++) {
    const cover = k === 0 ? " cov" : "";
    const pgL = 2 * k, pgR = 2 * k + 1;
    sheets.push(`<div class="sheet" data-k="${k}">
      <div class="face front${cover}">${faces[pgL]}${k ? `<span class="pg">${pgL}</span>` : ""}</div>
      <div class="face back">${faces[pgR] || ""}<span class="pg">${pgR}</span></div>
    </div>`);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FormCoach book — ${esc(s.exercise)} ${esc(s.shortDate)}</title><style>
  body{margin:0;font-family:Georgia,'Iowan Old Style','Times New Roman',serif;display:grid;place-items:center;
    min-height:100vh;background:#14121c radial-gradient(ellipse 90% 70% at 50% 38%,#2b2740,#14121c 75%)}
  #book{position:relative;width:min(96vw,1020px);height:min(84vh,660px);perspective:2800px}
  /* closed-book base: left board + stacked page edges on the right */
  #book::before{content:"";position:absolute;inset:0;left:-8px;width:52%;border-radius:14px 0 0 14px;
    background:linear-gradient(120deg,#20263e,#161b30 70%);
    box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(201,166,90,.25)}
  #book::after{content:"";position:absolute;top:5px;bottom:5px;right:-7px;width:9px;border-radius:0 5px 5px 0;
    background:repeating-linear-gradient(180deg,#efe6d2 0 3px,#ddd2b8 3px 4px)}
  .sheet{position:absolute;left:50%;top:0;width:50%;height:100%;transform-style:preserve-3d;
    transform-origin:left center;transition:transform 1.1s cubic-bezier(.3,.05,.2,1)}
  .sheet.turned{transform:rotateY(-180deg)}
  @media (prefers-reduced-motion:reduce){.sheet{transition:none}}
  .face{position:absolute;inset:0;backface-visibility:hidden;box-sizing:border-box;color:#2c2620;
    background:#f7f1e2 repeating-linear-gradient(2deg,transparent 0 5px,rgba(120,96,60,.025) 5px 6px);
    padding:2rem 2.1rem 2.4rem;overflow:auto;display:flex;flex-direction:column;justify-content:center;text-align:center;
    border-radius:0 12px 12px 0;box-shadow:0 12px 38px rgba(0,0,0,.4)}
  .face::after{content:"";position:absolute;left:0;top:0;bottom:0;width:34px;pointer-events:none;
    background:linear-gradient(90deg,rgba(60,40,20,.18),transparent)}
  .face.back{transform:rotateY(180deg);border-radius:12px 0 0 12px}
  .face.back::after{left:auto;right:0;background:linear-gradient(-90deg,rgba(60,40,20,.18),transparent)}
  .pg{position:absolute;bottom:.7rem;left:0;right:0;font-size:.72rem;letter-spacing:.18em;color:#a08d64}
  /* ── cover: navy board, gold foil ── */
  .cov{background:linear-gradient(135deg,#232a52,#151a38 65%);color:#efe4c4;
    box-shadow:0 12px 38px rgba(0,0,0,.5),inset 0 0 0 1px rgba(201,166,90,.35)}
  .cov::after{background:linear-gradient(90deg,rgba(0,0,0,.4),transparent)}
  .cov-frame{border:1px solid rgba(201,166,90,.55);border-radius:6px;padding:1.6rem 1.2rem;margin:auto;width:82%;
    box-shadow:inset 0 0 0 3px rgba(201,166,90,.12)}
  .cov-house{font-size:.68rem;letter-spacing:.34em;text-transform:uppercase;color:#c9a65a;margin:0}
  .cov-rule{height:1px;background:linear-gradient(90deg,transparent,#c9a65a,transparent);margin:.9rem 0}
  .cov h1{font-size:2.3rem;font-weight:400;letter-spacing:.04em;margin:.2rem 0;color:#f3e9cd;text-wrap:balance}
  .cov-sub{font-style:italic;color:#bfae85;margin:.1rem 0 1rem}
  .cov-medal{width:98px;height:98px;border-radius:50%;margin:.4rem auto;display:flex;flex-direction:column;
    align-items:center;justify-content:center;color:#1d2240;
    background:radial-gradient(circle at 32% 28%,#f0da9e,#c9a65a 62%,#a57f35);box-shadow:0 4px 14px rgba(0,0,0,.45)}
  .cov-medal span{font-size:2rem;font-weight:700;line-height:1}
  .cov-medal small{font-size:.6rem;letter-spacing:.12em;text-transform:uppercase}
  .cov-athlete{font-size:1.15rem;letter-spacing:.06em;margin:.8rem 0 .1rem}
  .cov-date{font-style:italic;font-size:.85rem;color:#bfae85;margin:0}
  .cov-note{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:#c9a65a;margin:.2rem 0 0}
  .cov-hint{font-size:.75rem;color:#8d84a8;margin:.9rem 0 0;font-style:italic}
  /* ── photo plates ── */
  .photo{margin:auto;max-width:100%}
  .photo img{max-width:100%;max-height:70vh;object-fit:contain;display:block;background:#fff;
    padding:10px 10px 0;border-radius:3px;box-shadow:0 6px 18px rgba(60,40,20,.3);transform:rotate(-.7deg)}
  .photo figcaption{display:inline-block;background:#fff;padding:.35rem 1rem .5rem;border-radius:0 0 3px 3px;
    box-shadow:0 6px 18px rgba(60,40,20,.3);transform:rotate(-.7deg);font-weight:700;color:#8c6a2c;letter-spacing:.06em}
  h3{font-weight:400;font-size:1.35rem;color:#3d3428;margin:.2rem 0 .6rem}
  .stamp{color:#8c6a2c;letter-spacing:.05em}
  .fault{color:#8e3030;font-weight:600;font-style:italic}
  .vn{font-size:.9rem;color:#42382a;background:rgba(255,255,255,.75);border:1px solid rgba(160,130,80,.3);
    border-radius:6px;padding:.8rem 1rem;text-align:left;box-shadow:inset 0 1px 3px rgba(120,96,60,.08)}
  .vl{margin:.32rem 0}.vl b{color:#8c6a2c;margin-right:.3rem}
  /* ── ruled notebook page ── */
  .ruled{text-align:left;padding:.2rem .2rem .2rem 2rem;position:relative;
    background:repeating-linear-gradient(180deg,transparent 0 26px,rgba(120,140,180,.35) 26px 27px)}
  .ruled::before{content:"";position:absolute;left:1.2rem;top:0;bottom:0;width:1px;background:rgba(190,80,80,.5)}
  .err{color:#8e3030;font-size:.9rem;line-height:27px;margin:0}
  .err.clean{color:#3c6e47}
  /* ── verdict certificate ── */
  .verdict{border:1px solid rgba(160,130,80,.45);border-radius:6px;padding:1.4rem 1.2rem;margin:auto;width:84%;
    box-shadow:inset 0 0 0 3px rgba(160,130,80,.1)}
  .verdict h3{letter-spacing:.2em;text-transform:uppercase;font-size:.9rem;color:#8c6a2c}
  .v-text{font-size:1.02rem;line-height:1.65;text-align:left}
  .v-sign{font-style:italic;font-size:1.3rem;color:#3d3428;text-align:right;margin:.8rem .4rem .2rem}
  .v-seal{font-size:2rem}
  .v-fine{font-size:.64rem;letter-spacing:.12em;text-transform:uppercase;color:#a08d64}
  .fin{font-size:1.6rem;margin:auto;font-style:italic;color:#3d3428}
  /* ── nav ── */
  nav{position:fixed;bottom:1.1rem;left:50%;transform:translateX(-50%);display:flex;gap:.9rem;align-items:center}
  nav button{width:46px;height:46px;font-size:1.35rem;border:1px solid rgba(201,166,90,.5);border-radius:50%;
    cursor:pointer;background:rgba(30,27,48,.85);color:#e9dcb4;transition:background .2s}
  nav button:hover{background:rgba(60,52,90,.9)}
  #ctr{color:#8d84a8;font-size:.8rem;letter-spacing:.14em;min-width:7ch;text-align:center;font-style:italic}
  </style></head><body><div id="book">${sheets.join("")}</div>
  <nav><button id="p" aria-label="previous page">‹</button><span id="ctr">cover</span><button id="n" aria-label="next page">›</button></nav>
  <script>
  const sh=[...document.querySelectorAll(".sheet")];let c=0;
  const ctr=document.getElementById("ctr");
  const zfix=()=>sh.forEach((x,i)=>x.style.zIndex=x.classList.contains("turned")?i+1:sh.length-i);
  const label=()=>{ctr.textContent=c===0?"cover":c>=sh.length?"the end":"pages "+(2*c-1)+"–"+(2*c)};
  zfix();label();
  const flip=(d)=>{if(d>0&&c<sh.length){sh[c++].classList.add("turned");}else if(d<0&&c>0){sh[--c].classList.remove("turned");}zfix();label();};
  document.getElementById("n").onclick=()=>flip(1);document.getElementById("p").onclick=()=>flip(-1);
  document.getElementById("book").onclick=()=>flip(1);
  addEventListener("keydown",(e)=>{if(e.key==="ArrowRight")flip(1);if(e.key==="ArrowLeft")flip(-1);});
  <\x2fscript></body></html>`;
}

$("btnBook").onclick = async () => {
  if (!lastSession) return;
  // the book is made AFTER the AI has seen every image — run the visual
  // analysis first if it hasn't happened yet
  if (!lastSession.visionNote && state.faultShots.length + state.sampleShots.length > 0) {
    $("btnBook").disabled = true;
    $("btnBook").textContent = "📖 AI is reading every photo…";
    const analyzed = await runVisionAnalysis();
    $("btnBook").disabled = false;
    $("btnBook").textContent = "📖 Download session flip-book";
    if (!analyzed) return;
  }
  const blob = new Blob([buildSessionBook(lastSession)], { type: "text/html" });
  const aEl = document.createElement("a");
  aEl.href = URL.createObjectURL(blob);
  aEl.download = `formcoach-book-${lastSession.exercise.toLowerCase().replace(/\s+/g, "-")}-${lastSession.shortDate.replace(/\s+/g, "-")}.html`;
  aEl.click();
  URL.revokeObjectURL(aEl.href);
};

async function runVisionAnalysis() {
  const box = $("visionReport");
  box.classList.remove("hidden");
  const model = await findVisionModel();
  if (!model) {
    box.innerHTML = location.protocol === "https:"
      ? "No reachable local vision model. Open <a href=\"http://localhost:8000/app.html\"><b>the local app</b></a>, or allow Local network access for this site, then run <code>ollama pull moondream</code> and try again."
      : "No local vision model found. Pull one: <code>ollama pull moondream</code> — then finish another session and click again.";
    return false;
  }
  box.innerHTML = `<p class="vr-status">🔍 ${model} is walking through your session, one photo at a time…</p>`;
  const shots = [...state.faultShots, ...state.sampleShots]
    .sort((x, y) => x.at - y.at);
  let card = null, body = null;
  const LABELS = /^(Problem|Why it matters|Fix|Drill):/;
  const prettify = (note) => note.split("\n").map((line) => {
    const m = line.match(LABELS);
    return m
      ? `<p class="vr-line"><b>${m[1]}</b>${line.slice(m[0].length)}</p>`
      : (line.trim() ? `<p class="vr-line">${line}</p>` : "");
  }).join("");
  const result = await visionReport(shots, state.errorLog, (chunk, meta = {}) => {
    if (meta.type === "head") {
      card = document.createElement("div");
      card.className = "vision-card" + (meta.fault === "form check" ? " vr-check" : " vr-fault");
      card.innerHTML = `<div class="vr-head"><span class="vr-stamp">⏱ ${meta.stamp}</span><span class="vr-tag">${meta.fault === "form check" ? "✅ form check" : "⚠ " + meta.fault}</span></div>`;
      body = document.createElement("div");
      body.className = "vr-body";
      body.textContent = "…";
      card.appendChild(body);
      box.appendChild(card);
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (meta.type === "note" && body) {
      if (body.textContent === "…") body.textContent = "";
      body.textContent += chunk;
    } else if (meta.type === "done" && body) {
      body.innerHTML = prettify(meta.note); // final pass: bold labels, clean lines
    }
  });
  box.querySelector(".vr-status")?.remove();
  if (result.error) box.textContent = "Visual analysis unavailable: " + result.error;
  else if (result.text && lastSession) {
    // the vision note becomes part of this session's permanent record
    lastSession.visionNote = result.text;
    lastSession.visionShots = result.entries || [];
    saveVault(sessionsCache).catch(() => {});
    refreshProgress();
    return true;
  }
  return false;
}
$("btnVision").onclick = runVisionAnalysis;

const tstamp = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

function notebookHTML(log) {
  return log.map((n) =>
    `<p class="note-entry">⏱ ${tstamp(n.at)} · rep ${n.rep} — ${n.text}</p>`).join("");
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
  $("btnVision").classList.toggle("hidden", state.faultShots.length + state.sampleShots.length === 0);
  $("visionReport").classList.add("hidden");
  $("visionReport").textContent = "";
  $("faultGallery").innerHTML = state.faultShots.length
    ? `<span class="rep-strip-label">📸 Fault evidence (on-device only):</span>` +
      state.faultShots.map((f) =>
        `<figure class="fault-shot"><img src="${f.img}" alt="fault frame" />
         <figcaption>${Math.floor(f.at / 60)}:${String(f.at % 60).padStart(2, "0")} — ${f.text}</figcaption></figure>`
      ).join("")
    : "";
  $("errorNotebook").innerHTML = state.errorLog.length
    ? `<span class="rep-strip-label">📓 Error notebook — every fault, written down:</span>` +
      notebookHTML(state.errorLog)
    : "";
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
  syncMemoryCoach().catch(() => {});
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
  // per-session error notebooks — every session's mistakes, kept separately
  const withLogs = sessions.filter((s) => s.errorLog?.length || s.visionNote).slice().reverse();
  $("notebooks").innerHTML = withLogs.length
    ? `<h3 class="notebooks-title">📓 Session notebooks</h3>` + withLogs.map((s) =>
        `<details class="notebook-session"><summary>${s.shortDate} · ${s.exercise} — ${s.errorLog.length} fault${s.errorLog.length > 1 ? "s" : ""} noted${s.visionNote ? " · 🔍 visual review" : ""}</summary>${notebookHTML(s.errorLog)}${s.visionNote ? `<p class="coach-note" style="white-space:pre-line">🔍 ${s.visionNote}</p>` : ""}</details>`
      ).join("")
    : "";
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

// Same idea as tests/src/voice_assistant: speak complete sentences as they
// arrive, while the text is also written into the chat.
let coachTalking = false; // our own flag — the engine's .speaking can stick

function speakCoachText(text) {
  if (!text || !("speechSynthesis" in window)) return Promise.resolve();
  speechSynthesis.cancel();
  coachTalking = true;
  const sentences = String(text).match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  const cleanSentences = sentences.map((s) => s.trim()).filter(Boolean);
  if (!cleanSentences.length) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false, ticks = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      coachTalking = false;
      clearInterval(watch);
      clearTimeout(cap);
      resolve();
    };
    // Chrome silently drops utterance end events — poll the engine itself
    // (skipping the first ticks while speech spins up) and hard-cap, so a
    // lost event can never freeze the voice loop again.
    const watch = setInterval(() => {
      ticks++;
      if (ticks > 3 && !speechSynthesis.speaking && !speechSynthesis.pending) finish();
    }, 300);
    const cap = setTimeout(finish, Math.min(30000, 3000 + text.length * 80));
    let remaining = cleanSentences.length;
    const done = () => { if (--remaining <= 0) finish(); };
    for (const sentence of cleanSentences) {
      const u = new SpeechSynthesisUtterance(sentence);
      u.rate = 1.05;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
  });
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("chatInput").value.trim();
  if (!q) return;
  $("chatInput").value = "";
  askCoach(q);
});

/* ================= local voice memory coach ================= */

let memoryTurns = [];


async function syncMemoryCoach() {
  const sessions = mySessions();
  if (!sessions.length) return;
  const r = await syncCoachMemory(athleteName() || "Solo athlete", sessions);
  $("memoryVoiceStatus").textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"} remembered locally.`;
  return r;
}

async function askCoach(question, { speakAnswer = true } = {}) {
  const q = question.trim();
  if (!q) return;
  addMsg(q, "user");
  const pending = addMsg("thinking…", "coach");
  pending.classList.add("thinking");
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const tagIt = (engine) => {
    const tag = document.createElement("span");
    tag.className = "msg-engine";
    tag.textContent = engine;
    pending.appendChild(tag);
  };
  // 1) memory coach backend — knows the athlete's whole history
  try {
    $("memoryVoiceStatus").textContent = "🧠 Reading athlete memory…";
    const reply = await askMemoryCoach({
      athlete: athleteName() || "Solo athlete",
      question: q,
      sessions: mySessions(),
      chatHistory: memoryTurns,
    });
    pending.classList.remove("thinking");
    pending.textContent = reply.text;
    tagIt(reply.engine);
    memoryTurns.push({ role: "user", content: q }, { role: "assistant", content: reply.text });
    if (memoryTurns.length > 16) memoryTurns = memoryTurns.slice(-16);
    $("memoryVoiceStatus").textContent = "🧠 Answered from remembered sessions.";
    if (speakAnswer) await speakCoachText(reply.text);
    return;
  } catch { /* backend offline — the local streaming coach takes over */ }
  // 2) local streaming AI with session stats + in-chat memory
  $("memoryVoiceStatus").textContent = "🧠 Memory backend offline — answering from this device.";
  let first = true;
  const reply = await coachReplyStream(q, mySessions(), (sentence) => {
    if (first) { pending.classList.remove("thinking"); pending.textContent = ""; first = false; }
    pending.textContent += (pending.textContent ? " " : "") + sentence;
    if (speakAnswer) { coachTalking = true; speakQueued(sentence); }
  });
  if (speakAnswer) {
    // release once the queued sentences drain — bounded, never stuck
    let waited = 0;
    const drain = setInterval(() => {
      waited += 400;
      if ((!speechSynthesis.speaking && !speechSynthesis.pending) || waited > 25000) {
        coachTalking = false;
        clearInterval(drain);
      }
    }, 400);
  }
  if (first) {
    pending.classList.remove("thinking");
    pending.textContent = reply.text;
    if (speakAnswer) await speakCoachText(reply.text);
  }
  tagIt(reply.engine);
}

const MemorySR = window.SpeechRecognition || window.webkitSpeechRecognition;
let memoryRec = null;
let voiceLoop = { active: false, target: "chat", listening: false, answering: false, timer: null };

function isStopPhrase(text) {
  // only short, direct commands — "should I stop leaning?" is a question
  return text.trim().split(/\s+/).length <= 4
    && /\b(stop|exit|goodbye|quit|cancel voice|stop listening)\b/i.test(text);
}

function setVoiceLoopUI(active, target = "chat", label = "") {
  const main = $("btnVoiceChat");
  main.setAttribute("aria-pressed", active);
  main.textContent = active ? "🎙 Stop" : "🎙 Ask";
  if (label) $("memoryVoiceStatus").textContent = label;
}

function stopVoiceLoop(message = "Voice chat stopped.") {
  voiceLoop.active = false;
  voiceLoop.answering = false;
  clearTimeout(voiceLoop.timer);
  stopMicMeter();
  voiceLoop.listening = false;
  memoryRec?.stop();
  memoryRec = null;
  setVoiceLoopUI(false, voiceLoop.target, message);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function listenOnce(target = "chat") {
  if (!MemorySR) {
    $("memoryVoiceStatus").textContent = "Speech input is not available in this browser. Type your question.";
    speak("Speech input is not available in this browser. Type your question.", { force: true });
    return;
  }
  if ($("micToggle").getAttribute("aria-pressed") === "true") {
    stopVoiceControl();
    $("micToggle").setAttribute("aria-pressed", "false");
    $("micToggle").textContent = "🎤 Voice control";
  }
  if (!voiceLoop.active || voiceLoop.listening) return;
  if (coachTalking) { setTimeout(() => listenOnce(target), 300); return; }
  if (memoryRec) memoryRec.stop();
  voiceLoop.listening = true;
  vlog("rec starting");
  setVoiceLoopUI(true, target, "Listening…");
  memoryRec = new MemorySR();
  memoryRec.lang = "en-US";
  memoryRec.continuous = false;
  memoryRec.interimResults = true; // show what it's hearing, as it hears it
  memoryRec.onresult = async (e) => {
    const last = e.results[e.results.length - 1];
    const text = last[0].transcript;
    vlog(`onresult final=${last.isFinal} talking=${coachTalking} "${text.slice(0, 30)}"`);
    // without headphones the mic picks up the coach's own voice — discard
    // ANYTHING heard while the coach is talking, before any other handling
    if (coachTalking) { $("memoryVoiceStatus").textContent = "🎙 (ignored — I was talking)"; return; }
    if (!last.isFinal) {
      $("memoryVoiceStatus").textContent = `🎙 Heard: “${text.trim()}…”`;
      return;
    }
    // accept exactly ONE final result per session — close it immediately so
    // no stale result from this session can ever re-enter the pipeline
    const rec = memoryRec;
    memoryRec = null;
    voiceLoop.listening = false;
    try { rec.onresult = null; rec.abort(); } catch { /* already gone */ }
    if (isStopPhrase(text)) {
      stopVoiceLoop("Voice chat stopped.");
      await speakCoachText("Voice chat stopped.");
      return;
    }
    voiceLoop.answering = true;
    try {
      // hard cap — a hung model/backend must never wedge the loop
      await Promise.race([
        askCoach(text, { speakAnswer: true }),
        new Promise((r) => setTimeout(r, 90_000)),
      ]);
    } finally {
      voiceLoop.answering = false;
      coachTalking = false; // belt-and-braces: never leave this stuck
    }
    // Chrome keeps flaky state between recognition sessions inside one
    // "conversation" — so every new turn re-runs the FULL start path that
    // provably works on the first turn: clean stop, clean start.
    if (voiceLoop.active) {
      const t = voiceLoop.target;
      stopVoiceLoop("");
      setTimeout(() => toggleVoiceLoop(t, { quiet: true }), 500);
    }
  };
  memoryRec.onerror = (e) => {
    vlog(`onerror ${e.error}`);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopVoiceLoop("🎙 Microphone blocked — click the address-bar icon → Microphone → Allow, then reload.");
      return;
    }
    if (e.error === "network") {
      stopVoiceLoop("🎙 Voice input needs internet (Chrome's speech service). Typed chat works offline.");
      return;
    }
    if (e.error === "no-speech") $("memoryVoiceStatus").textContent = "🎙 Didn't catch that — listening again…";
    // onend always follows and handles the restart
  };
  // Chrome can end a session with NO result and NO error (silence timeout).
  // onend is the only guaranteed event — so onend owns the restart. This is
  // what kept "auto-stopping" the conversation after one answer.
  memoryRec.onend = () => {
    vlog("rec.onend");
    voiceLoop.listening = false;
    memoryRec = null;
    scheduleRelisten();
  };
  try {
    memoryRec.start();
  } catch {
    voiceLoop.listening = false;
    memoryRec = null;
    $("memoryVoiceStatus").textContent = "Microphone busy — retrying…";
    scheduleRelisten(800);
  }
}

// Like a desktop voice assistant: open the input device FIRST and keep a
// live level meter on it. If the meter stays flat while you talk, the OS is
// using the wrong microphone — the classic failure the reference assistant
// solves with its list-audio-devices step.
// ONE audio pipeline at a time — the reference assistant's rule. A meter
// stream held open while SpeechRecognition runs can starve the recognizer
// of the mic entirely (observed: recognition produced zero results while
// the meter stream was live). So the meter is a short PRE-FLIGHT check
// that fully releases the microphone before listening starts.
async function preflightMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const msg = err.name === "NotAllowedError"
      ? "Chrome has blocked the microphone for this page. Click the icon left of the address bar → Microphone → Allow, then reload."
      : "No working microphone found — check your input device.";
    $("memoryVoiceStatus").textContent = "🎙 " + msg;
    speak(msg, { force: true });
    return false;
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const BARS = "▁▂▃▄▅▆▇█";
    let peak = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1200) {
      analyser.getByteTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      $("micLevel").textContent = "🎚" + BARS[Math.max(0, Math.min(7, Math.round(peak / 14)))];
      await new Promise((r) => setTimeout(r, 100));
    }
    await ctx.close().catch(() => {});
    // name the device — a wrong Chrome mic selection is invisible otherwise
    const label = stream.getAudioTracks()[0]?.label || "unknown device";
    $("micLevel").textContent = peak > 6 ? `🎚✓ ${label}` : `🎚 QUIET — ${label}`;
  } finally {
    stream.getTracks().forEach((t) => t.stop()); // release BEFORE listening
  }
  return true;
}

function stopMicMeter() { $("micLevel").textContent = ""; }

const vlog = (m) => console.debug("[voiceloop]", m);
function scheduleRelisten(delay = 350) {
  vlog(`schedule(${delay}) active=${voiceLoop.active} talking=${coachTalking} answering=${voiceLoop.answering} listening=${voiceLoop.listening}`);
  if (!voiceLoop.active) return;
  clearTimeout(voiceLoop.timer);
  voiceLoop.timer = setTimeout(() => {
    if (!voiceLoop.active) return;
    if (coachTalking || voiceLoop.answering) { scheduleRelisten(400); return; }
    vlog("-> listenOnce");
    listenOnce(voiceLoop.target);
  }, delay);
}

async function toggleVoiceLoop(target = "chat", { quiet = false } = {}) {
  if (voiceLoop.active && voiceLoop.target === target && !quiet) {
    stopVoiceLoop("Voice chat stopped.");
    return;
  }
  voiceLoop.active = true; // before the meter starts — its tick checks this
  voiceLoop.target = target;
  if (!quiet && !(await preflightMic())) { voiceLoop.active = false; return; }
  setVoiceLoopUI(true, target, quiet ? "Listening…" : "Voice chat on. Listening after the beep.");
  if (!quiet) {
    await speakCoachText("Voice chat on. Ask me anything.");
    $("memoryVoiceStatus").textContent = "🎙 Listening — say \"goodbye\" or press the button to end.";
  }
  listenOnce(target);
}

$("btnVoiceChat").onclick = () => toggleVoiceLoop("chat");



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
    case "squat": case "pushup": case "curl": case "jacks": case "press":
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
      speak("You can say: squats, push ups, curls, jacks, or press to pick a drill. Start. Stop. How am I doing. Or just ask me anything — I'll answer.", { force: true });
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
    case "reset-chat": {
      resetChat();
      addMsg("🔄 New conversation started.", "coach");
      speak("Fresh start. What do you want to talk about?", { force: true });
      break;
    }
    case "stt-offline": {
      $("micToggle").setAttribute("aria-pressed", "false");
      $("micToggle").textContent = "🎤 Voice control";
      setCue("Voice input needs internet (Chrome's recognizer is a cloud service). Typed chat stays fully local.", "warn");
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

$("bargeToggle").onclick = () => {
  const on = $("bargeToggle").getAttribute("aria-pressed") !== "true";
  $("bargeToggle").setAttribute("aria-pressed", on);
  $("bargeToggle").textContent = on ? "🎧 Barge-in on" : "🎧 Barge-in off";
  setBargeIn(on);
  if (on) speak("Barge-in enabled. Wear headphones, and feel free to interrupt me.", { force: true });
};

/* Mode 2 — Live Coach: the vision LLM watches live snapshots and speaks
   about what it actually SEES, while the mic stays open so the athlete can
   talk back — a real two-way conversation, all on-device.
   Mode 1 (default) stays pure physics + post-session analysis. */
let eyesModel = null, eyesTimer = null;
async function eyesTick(faultTriggered = false) {
  if (!state.running || !eyesModel) return;
  if (!faultTriggered && speechSynthesis.speaking) return;
  // fault-triggered looks snapshot the mistake IMMEDIATELY (while the instant
  // physics cue is still talking) so the vision comment lands ~4s after the error
  const line = await liveVisionLine(frameSnapshot(), eyesModel, state.exercise);
  if (line && state.running) {
    setCue(`👁 ${line}`, "info");
    if (speechSynthesis.speaking) speakQueued(line);
    else speak(line, { force: true });
  }
}
$("eyesToggle").onclick = async () => {
  const turningOn = $("eyesToggle").getAttribute("aria-pressed") !== "true";
  if (turningOn) {
    eyesModel = await findVisionModel();
    if (!eyesModel) {
      setCue("No local vision model — run: ollama pull moondream", "warn");
      speak("Live Coach needs a vision model. Pull moondream in Ollama first.", { force: true });
      return;
    }
    eyesTimer = setInterval(eyesTick, 9000);
    // open the athlete's side of the conversation too
    const mic = $("micToggle");
    if (!mic.disabled && mic.getAttribute("aria-pressed") !== "true") mic.click();
    speak("Live Coach on. I can see you now — and you can talk to me any time.", { force: true });
  } else {
    clearInterval(eyesTimer);
    eyesModel = null;
  }
  $("eyesToggle").setAttribute("aria-pressed", turningOn);
  $("eyesToggle").textContent = turningOn ? "👁 Live Coach: on" : "👁 Live Coach: off";
};

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

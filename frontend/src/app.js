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
  const visionBits = visionNotesByStamp(s);
  const log = s.errorLog || state.errorLog;
  // every spread is a real open book: photo on the LEFT page, the AI's
  // written description on the RIGHT page
  const pages = [];
  pages.push(`<section class="page cover"><div class="pg-left cov">
      <h1>🏋️ FormCoach AI</h1><h2>${esc(s.exercise)}</h2><p>${esc(s.shortDate)}</p></div>
    <div class="pg-right cov"><p class="big">${s.reps} reps</p><p class="big">${s.avgScore}/100 form</p>
      <p>${esc(s.athlete)}'s training book — every photo analyzed on this device. Tap or → to turn the page.</p></div></section>`);
  for (const f of shots) {
    const stamp = tstamp(f.at);
    const vision = visionBits[stamp];
    pages.push(`<section class="page">
      <div class="pg-left"><img src="${f.img}" alt="training frame at ${stamp}" /></div>
      <div class="pg-right"><h3>⏱ ${stamp}</h3><p class="fault">${esc(f.text)}</p>
        ${vision ? `<p class="vn">🔍 What the AI sees: ${esc(vision)}</p>` : `<p class="vn">Measured form-check frame. Run deep visual analysis before downloading to add where, why, and how-to-fix notes.</p>`}</div></section>`);
  }
  if (!shots.length) {
    pages.push(`<section class="page">
      <div class="pg-left"><h3>No photos captured</h3><p>Finish a longer session so FormCoach can capture timed frames and fault evidence.</p></div>
      <div class="pg-right"><h3>Coach note</h3><p>${esc(summarize(s))}</p></div></section>`);
  }
  pages.push(`<section class="page">
    <div class="pg-left"><h3>📓 Error notebook</h3>
      ${log.map((n) => `<p class="err">⏱ ${tstamp(n.at)} · rep ${n.rep} — ${esc(n.text)}</p>`).join("") || "<p>No faults — clean session!</p>"}</div>
    <div class="pg-right"><h3>🎙 Coach's verdict</h3><p>${esc(summarize(s))}</p>
      <p class="vn">Generated by FormCoach AI — United Hacks V7. No cloud, no uploads: this book was written on the athlete's own device.</p></div></section>`);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FormCoach book — ${esc(s.exercise)} ${esc(s.shortDate)}</title><style>
  body{margin:0;font-family:system-ui,sans-serif;background:#2a2740;display:grid;place-items:center;min-height:100vh}
  #book{position:relative;width:min(96vw,980px);height:min(84vh,640px);perspective:2200px}
  .page{position:absolute;inset:0;background:#f5f1f0;border-radius:12px;box-sizing:border-box;
    box-shadow:0 10px 34px rgba(0,0,0,.4);backface-visibility:hidden;transform-origin:left center;
    transition:transform .8s cubic-bezier(.4,.1,.2,1);display:grid;grid-template-columns:1fr 1fr;overflow:hidden}
  .page::after{content:"";position:absolute;left:50%;top:0;bottom:0;width:2px;background:rgba(0,0,0,.12)}
  .page.flipped{transform:rotateY(-170deg);pointer-events:none}
  .pg-left,.pg-right{padding:1.3rem;overflow:auto;display:flex;flex-direction:column;justify-content:center}
  .pg-left img{max-width:100%;max-height:100%;object-fit:contain;border-radius:10px;margin:auto;display:block}
  .cover{background:linear-gradient(120deg,#5e5ce6,#7d7bff);color:#fff}
  .cov h1,.cov h2{margin:.2rem 0}
  .big{font-size:1.7rem;font-weight:700;margin:.2rem 0}
  .fault{color:#c0392b;font-weight:600}
  .vn{font-size:.92rem;color:#333;background:#fff;border-radius:8px;padding:.7rem;text-align:left}
  .err{color:#c0392b;border-left:3px solid #c0392b;padding-left:.6rem;font-size:.9rem;text-align:left}
  h3{color:#5e5ce6;margin:.2rem 0}
  nav{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);display:flex;gap:1rem}
  nav button{font-size:1.4rem;border:0;border-radius:10px;padding:.4rem 1.1rem;cursor:pointer;background:#5e5ce6;color:#fff}
  </style></head><body><div id="book">${pages.join("")}</div>
  <nav><button id="p">‹</button><button id="n">›</button></nav>
  <script>
  const pg=[...document.querySelectorAll(".page")];let c=0;
  pg.forEach((p,i)=>p.style.zIndex=pg.length-i);
  const flip=(d)=>{if(d>0&&c<pg.length-1)pg[c++].classList.add("flipped");else if(d<0&&c>0)pg[--c].classList.remove("flipped");};
  document.getElementById("n").onclick=()=>flip(1);document.getElementById("p").onclick=()=>flip(-1);
  document.getElementById("book").onclick=()=>flip(1);
  addEventListener("keydown",(e)=>{if(e.key==="ArrowRight")flip(1);if(e.key==="ArrowLeft")flip(-1);});
  <\/script></body></html>`;
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
  box.textContent = `🔍 ${model} is looking at your fault photos…`;
  let started = false;
  const shots = [...state.faultShots, ...state.sampleShots]
    .sort((x, y) => x.at - y.at);
  const result = await visionReport(
    shots,
    state.errorLog,
    (chunk) => {
      if (!started) { started = true; box.textContent = "🔍 Visual walkthrough of your session:"; }
      box.textContent += chunk;
    }
  );
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
function speakCoachText(text) {
  if (!text || !("speechSynthesis" in window)) return Promise.resolve();
  speechSynthesis.cancel();
  const sentences = String(text).match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  const cleanSentences = sentences.map((s) => s.trim()).filter(Boolean);
  if (!cleanSentences.length) return Promise.resolve();
  return new Promise((resolve) => {
    let remaining = cleanSentences.length;
    const done = () => {
      remaining--;
      if (remaining <= 0) resolve();
    };
    for (const sentence of cleanSentences) {
      const u = new SpeechSynthesisUtterance(sentence);
      u.rate = 1.05;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
  });
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
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const reply = await coachReplyStream(q, mySessions(), (sentence) => {
    if (first) { pending.classList.remove("thinking"); pending.textContent = ""; first = false; }
    pending.textContent += (pending.textContent ? " " : "") + sentence;
    speakQueued(sentence);
  });
  if (first) {
    pending.classList.remove("thinking");
    pending.textContent = reply.text;
    await speakCoachText(reply.text);
  }
  const tag = document.createElement("span");
  tag.className = "msg-engine";
  tag.textContent = reply.engine;
  pending.appendChild(tag);
});

/* ================= local voice memory coach ================= */

let memoryTurns = [];

function addMemoryMsg(text, who) {
  const div = document.createElement("div");
  div.className = `msg msg-${who}`;
  div.textContent = text;
  $("memoryVoiceLog").appendChild(div);
  $("memoryVoiceLog").scrollTop = $("memoryVoiceLog").scrollHeight;
  return div;
}

async function syncMemoryCoach() {
  const sessions = mySessions();
  if (!sessions.length) return;
  const r = await syncCoachMemory(athleteName() || "Solo athlete", sessions);
  $("memoryVoiceStatus").textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"} remembered locally.`;
  return r;
}

async function askRememberingCoach(question, { speakAnswer = true, target = "memory" } = {}) {
  const q = question.trim();
  if (!q) return;
  const logToMain = target === "chat";
  (logToMain ? addMsg : addMemoryMsg)(q, "user");
  $("memoryAskInput").value = "";
  if (logToMain) $("chatInput").value = "";
  $("memoryVoiceStatus").textContent = "Reading athlete memory…";
  const pending = (logToMain ? addMsg : addMemoryMsg)("thinking…", "coach");
  pending.classList.add("thinking");
  try {
    const reply = await askMemoryCoach({
      athlete: athleteName() || "Solo athlete",
      question: q,
      sessions: mySessions(),
      chatHistory: memoryTurns,
    });
    pending.classList.remove("thinking");
    pending.textContent = reply.text;
    const tag = document.createElement("span");
    tag.className = "msg-engine";
    tag.textContent = reply.engine;
    pending.appendChild(tag);
    memoryTurns.push({ role: "user", content: q }, { role: "assistant", content: reply.text });
    if (memoryTurns.length > 16) memoryTurns = memoryTurns.slice(-16);
    $("memoryVoiceStatus").textContent = "Answer based on remembered sessions.";
    if (speakAnswer) await speakCoachText(reply.text);
  } catch {
    pending.classList.remove("thinking");
    pending.textContent = "Memory coach backend offline. Start it with: cd backend && uvicorn app.main:app --port 8001";
    $("memoryVoiceStatus").textContent = "Backend offline.";
    if (speakAnswer) await speakCoachText("Memory coach backend is offline.");
  }
}

$("memoryAskForm").addEventListener("submit", (e) => {
  e.preventDefault();
  askRememberingCoach($("memoryAskInput").value, { speakAnswer: true, target: "memory" });
});

const MemorySR = window.SpeechRecognition || window.webkitSpeechRecognition;
let memoryRec = null;
let voiceLoop = { active: false, target: "chat", listening: false };

function isStopPhrase(text) {
  return /\b(stop|exit|goodbye|quit|cancel voice|stop listening)\b/i.test(text);
}

function setVoiceLoopUI(active, target = "chat", label = "") {
  const main = $("btnVoiceChat");
  const memory = $("memoryVoiceToggle");
  main.setAttribute("aria-pressed", active && target === "chat");
  memory.setAttribute("aria-pressed", active && target === "memory");
  main.textContent = active && target === "chat" ? "🎙 Stop" : "🎙 Ask";
  memory.textContent = active && target === "memory" ? "🎙 Stop" : "🎙 Talk";
  if (label) $("memoryVoiceStatus").textContent = label;
}

function stopVoiceLoop(message = "Voice chat stopped.") {
  voiceLoop.active = false;
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
  if (memoryRec) memoryRec.stop();
  voiceLoop.listening = true;
  setVoiceLoopUI(true, target, "Listening…");
  memoryRec = new MemorySR();
  memoryRec.lang = "en-US";
  memoryRec.continuous = false;
  memoryRec.interimResults = false;
  memoryRec.onresult = async (e) => {
    const text = e.results[e.results.length - 1][0].transcript;
    voiceLoop.listening = false;
    memoryRec = null;
    if (isStopPhrase(text)) {
      stopVoiceLoop("Voice chat stopped.");
      await speakCoachText("Voice chat stopped.");
      return;
    }
    await askRememberingCoach(text, { speakAnswer: true, target });
    if (voiceLoop.active) {
      setTimeout(() => listenOnce(target), 250);
    }
  };
  memoryRec.onerror = () => {
    $("memoryVoiceStatus").textContent = "Could not hear that. Type the question or try again.";
    voiceLoop.listening = false;
    memoryRec = null;
    if (voiceLoop.active) setTimeout(() => listenOnce(target), 700);
  };
  memoryRec.onend = () => {
    voiceLoop.listening = false;
    memoryRec = null;
  };
  try {
    memoryRec.start();
  } catch {
    voiceLoop.listening = false;
    memoryRec = null;
    setVoiceLoopUI(false, target, "Microphone is busy or blocked. Turn off other voice control and try again.");
  }
}

async function toggleVoiceLoop(target = "chat") {
  if (voiceLoop.active && voiceLoop.target === target) {
    stopVoiceLoop("Voice chat stopped.");
    return;
  }
  voiceLoop.active = true;
  voiceLoop.target = target;
  setVoiceLoopUI(true, target, "Voice chat on. Listening after the beep.");
  await speakCoachText("Voice chat on. Ask me anything. Say stop when you are done.");
  listenOnce(target);
}

$("btnVoiceChat").onclick = () => toggleVoiceLoop("chat");

$("memoryVoiceToggle").onclick = () => {
  const on = $("memoryVoiceToggle").getAttribute("aria-pressed") !== "true";
  if (on) toggleVoiceLoop("memory");
  else stopVoiceLoop("Voice chat stopped.");
};

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
    case "squat": case "pushup": case "curl": case "jump": case "jacks": case "knees": case "plank": case "press":
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

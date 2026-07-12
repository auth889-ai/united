// Biomechanics engine test suite — run with: node frontend/tests/engine.test.mjs
// Feeds the synthetic demo athlete through the REAL squat analyzer and asserts
// rep detection, scoring, and fault penalties behave correctly.

import { demoPose } from "../src/engine/demo.js";
import { EXERCISES, angle } from "../src/engine/exercises.js";

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failures++;
};

// --- angle math ---
check("angle: straight line is 180°",
  Math.abs(angle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }) - 180) < 1e-6);
check("angle: right angle is 90°",
  Math.abs(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }) - 90) < 1e-6);

// --- squat rep detection over 8 synthetic rep cycles at ~30fps ---
const squat = EXERCISES.squat.make();
let reps = 0;
const scores = [];
for (let t = 0; t < 2600 * 8; t += 33) {
  const r = squat.update(demoPose(t));
  if (r.repDone) { reps++; scores.push(r.repScore); }
}
check(`rep detection: 8 cycles -> 8 reps (got ${reps})`, reps === 8);
check("scoring: full-depth reps score 100", scores.filter((s) => s === 100).length === 6);
check("scoring: shallow reps are penalized (<80)", scores.filter((s) => s < 80).length === 2);
check("scoring: all scores within 0-100", scores.every((s) => s >= 0 && s <= 100));

// --- no double counting on held positions ---
const squat2 = EXERCISES.squat.make();
let reps2 = 0;
const held = demoPose(1300); // mid-rep deep position
for (let i = 0; i < 120; i++) if (squat2.update(held).repDone) reps2++;
check("no reps counted while holding a static position", reps2 === 0);

// --- anti-blip guard: a 2-frame noise dip must not count as a rep ---
const squat3 = EXERCISES.squat.make();
let blipReps = 0;
const up = demoPose(0);        // standing
const down = demoPose(1300);   // deep squat
for (let i = 0; i < 30; i++) if (squat3.update(up).repDone) blipReps++;
for (let i = 0; i < 2; i++) if (squat3.update(down).repDone) blipReps++;  // 2-frame blip
for (let i = 0; i < 30; i++) if (squat3.update(up).repDone) blipReps++;
check("2-frame noise blip does not count as a rep", blipReps === 0);


// --- jumping jacks: open/close cycles count; alternation for high knees ---
function jackPose(open) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  lm[0]  = { x: 0.5, y: 0.15, z: 0, visibility: 1 };               // nose
  lm[11] = { x: 0.44, y: 0.3, z: 0, visibility: 1 }; lm[12] = { x: 0.56, y: 0.3, z: 0, visibility: 1 };
  lm[23] = { x: 0.46, y: 0.55, z: 0, visibility: 1 }; lm[24] = { x: 0.54, y: 0.55, z: 0, visibility: 1 };
  if (open) {
    lm[15] = { x: 0.3, y: 0.08, z: 0, visibility: 1 }; lm[16] = { x: 0.7, y: 0.08, z: 0, visibility: 1 };  // wrists overhead
    lm[27] = { x: 0.3, y: 0.93, z: 0, visibility: 1 }; lm[28] = { x: 0.7, y: 0.93, z: 0, visibility: 1 };  // feet wide
  } else {
    lm[15] = { x: 0.42, y: 0.55, z: 0, visibility: 1 }; lm[16] = { x: 0.58, y: 0.55, z: 0, visibility: 1 };
    lm[27] = { x: 0.47, y: 0.93, z: 0, visibility: 1 }; lm[28] = { x: 0.53, y: 0.93, z: 0, visibility: 1 };
  }
  return lm;
}
const jacks = EXERCISES.jacks.make();
let jackReps = 0;
for (let c = 0; c < 5; c++) {
  for (let i = 0; i < 8; i++) if (jacks.update(jackPose(true)).repDone) jackReps++;
  for (let i = 0; i < 8; i++) if (jacks.update(jackPose(false)).repDone) jackReps++;
}
check(`jumping jacks: 5 cycles -> 5 reps (got ${jackReps})`, jackReps === 5);

function kneePose(leg) { // leg: null | "L" | "R"
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  lm[23] = { x: 0.46, y: 0.55, z: 0, visibility: 1 }; lm[24] = { x: 0.54, y: 0.55, z: 0, visibility: 1 };
  lm[25] = { x: 0.46, y: leg === "L" ? 0.45 : 0.75, z: 0, visibility: 1 };
  lm[26] = { x: 0.54, y: leg === "R" ? 0.45 : 0.75, z: 0, visibility: 1 };
  return lm;
}
const knees = EXERCISES.knees.make();
let strides = 0;
for (const leg of ["L", null, "R", null, "L", null, "L", null, "R", null]) {
  for (let i = 0; i < 4; i++) if (knees.update(kneePose(leg)).repDone) strides++;
}
// L, R, L count; the second consecutive L is rejected (no alternation), final R counts
check(`high knees: alternation enforced (got ${strides}, want 4)`, strides === 4);

// --- high knees: drive height is scored, not just counted ---
function kneeLiftPose(leg, lift) { // lift = how far the knee rises above the hip
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  lm[23] = { x: 0.46, y: 0.55, z: 0, visibility: 1 }; lm[24] = { x: 0.54, y: 0.55, z: 0, visibility: 1 };
  lm[25] = { x: 0.46, y: leg === "L" ? 0.55 - lift : 0.75, z: 0, visibility: 1 };
  lm[26] = { x: 0.54, y: leg === "R" ? 0.55 - lift : 0.75, z: 0, visibility: 1 };
  return lm;
}
function strideScore(analyzer, leg, lift) {
  let score = null;
  for (let i = 0; i < 4; i++) analyzer.update(kneeLiftPose(leg, lift));
  for (let i = 0; i < 4; i++) { const r = analyzer.update(kneeLiftPose(null, 0)); if (r.repDone) score = r.repScore; }
  return score;
}
const kneesScored = EXERCISES.knees.make();
const highDrive = strideScore(kneesScored, "L", 0.12);
const shallowDrive = strideScore(kneesScored, "R", 0.04);
check(`high knees: hip-height drive scores 100 (got ${highDrive})`, highDrive === 100);
check(`high knees: shallow drive is penalized (got ${shallowDrive})`, shallowDrive !== null && shallowDrive < 85);


// --- shoulder press: rack->lockout cycles count; soft lockout penalized ---
function pressPose(elbowDeg) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  lm[11] = { x: 0.44, y: 0.35, z: 0, visibility: 1 }; lm[12] = { x: 0.56, y: 0.35, z: 0, visibility: 1 };
  lm[23] = { x: 0.46, y: 0.62, z: 0, visibility: 1 }; lm[24] = { x: 0.54, y: 0.62, z: 0, visibility: 1 };
  // place elbow/wrist to produce the requested elbow angle at the joint
  const rad = ((180 - elbowDeg) * Math.PI) / 180;
  lm[13] = { x: 0.44, y: 0.22, z: 0, visibility: 1 }; lm[14] = { x: 0.56, y: 0.22, z: 0, visibility: 1 };
  lm[15] = { x: 0.44 + Math.sin(rad) * 0.13, y: 0.22 - Math.cos(rad) * 0.13, z: 0, visibility: 1 };
  lm[16] = { x: 0.56 - Math.sin(rad) * 0.13, y: 0.22 - Math.cos(rad) * 0.13, z: 0, visibility: 1 };
  return lm;
}
function pressRep(analyzer, topAngle) {
  let score = null;
  for (let i = 0; i < 6; i++) analyzer.update(pressPose(topAngle));
  for (let i = 0; i < 6; i++) { const r = analyzer.update(pressPose(70)); if (r.repDone) score = r.repScore; }
  return score;
}
const press = EXERCISES.press.make();
const fullLockout = pressRep(press, 172);
const softLockout = pressRep(press, 140);
check(`shoulder press: full lockout scores 100 (got ${fullLockout})`, fullLockout === 100);
check(`shoulder press: soft lockout penalized (got ${softLockout})`, softLockout !== null && softLockout <= 70);

// --- plank: straight line accrues held seconds; sag stops the clock ---
function plankPose(sag) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.9, z: 0, visibility: 1 }));
  lm[11] = { x: 0.25, y: 0.60, z: 0, visibility: 1 }; lm[12] = { x: 0.25, y: 0.60, z: 0, visibility: 1 };
  lm[23] = { x: 0.50, y: sag ? 0.72 : 0.62, z: 0, visibility: 1 };
  lm[24] = { x: 0.50, y: sag ? 0.72 : 0.62, z: 0, visibility: 1 };
  lm[27] = { x: 0.75, y: 0.64, z: 0, visibility: 1 }; lm[28] = { x: 0.75, y: 0.64, z: 0, visibility: 1 };
  return lm;
}
const plank = EXERCISES.plank.make();
let heldSec = 0, sagCued = false;
for (let i = 0; i < 95; i++) if (plank.update(plankPose(false)).repDone) heldSec++;   // ~3.1s straight
for (let i = 0; i < 30; i++) {
  const r = plank.update(plankPose(true));                                            // sagging
  if (r.repDone) heldSec++;
  if (r.cues.some((c) => c.text.includes("sagging"))) sagCued = true;
}
check(`plank: ~3s straight hold credited (got ${heldSec})`, heldSec === 3);
check("plank: sagging stops the clock and cues", sagCued);

console.log(failures ? `\n${failures} test(s) FAILED` : "\nALL ENGINE TESTS PASS");
process.exit(failures ? 1 : 0);

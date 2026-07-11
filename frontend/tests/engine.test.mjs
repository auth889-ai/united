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

console.log(failures ? `\n${failures} test(s) FAILED` : "\nALL ENGINE TESTS PASS");
process.exit(failures ? 1 : 0);

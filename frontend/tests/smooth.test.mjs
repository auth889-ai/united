// Smoothing filter tests — run with: node frontend/tests/smooth.test.mjs

import { createSmoother } from "../src/engine/smooth.js";

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failures++;
};

const pt = (x) => [{ x, y: x, z: 0, visibility: 1 }];

// converges to a constant input
const s1 = createSmoother(0.5);
let out;
for (let i = 0; i < 30; i++) out = s1.smooth(pt(0.7));
check("converges to constant input", Math.abs(out[0].x - 0.7) < 1e-6);

// reduces variance of a noisy signal (deterministic pseudo-noise)
const s2 = createSmoother(0.5);
let rawVar = 0, smoothVar = 0, prevRaw = null, prevSm = null;
for (let i = 0; i < 200; i++) {
  const noise = 0.5 + 0.05 * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
  const sm = s2.smooth(pt(noise))[0].x;
  if (prevRaw !== null) { rawVar += (noise - prevRaw) ** 2; smoothVar += (sm - prevSm) ** 2; }
  prevRaw = noise; prevSm = sm;
}
check(`smoothing reduces frame-to-frame variance (${(smoothVar / rawVar).toFixed(2)}x)`, smoothVar < rawVar * 0.6);

// visibility passes through unsmoothed (confidence must be current)
const s3 = createSmoother(0.5);
s3.smooth([{ x: 0, y: 0, z: 0, visibility: 1 }]);
const v = s3.smooth([{ x: 0, y: 0, z: 0, visibility: 0.1 }])[0].visibility;
check("visibility is passed through, not smoothed", v === 0.1);

// reset clears history (no ghost from a previous person in frame)
const s4 = createSmoother(0.5);
s4.smooth(pt(0.1));
s4.reset();
check("reset clears history", s4.smooth(pt(0.9))[0].x === 0.9);

console.log(failures ? `\n${failures} test(s) FAILED` : "\nALL SMOOTHING TESTS PASS");
process.exit(failures ? 1 : 0);

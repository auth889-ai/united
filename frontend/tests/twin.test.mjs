// Movement Twin test suite — run with: node frontend/tests/twin.test.mjs

import { compareToBaseline } from "../src/engine/twin.js";

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failures++;
};

// shallower + more lean than the best rep -> two measured deviations, worst first
const devs = compareToBaseline("squat", { depth: 85, lean: 30 }, { depth: 97, lean: 48 });
check("squat: detects both deviations", devs.length === 2);
check("squat: worst deviation reported first", devs[0].includes("18°"));
check("squat: depth deviation measured (12°)", devs.some((t) => t.includes("12°")));

// matching your best -> silence
check("no deviation when within threshold",
  compareToBaseline("squat", { depth: 85, lean: 30 }, { depth: 87, lean: 32 }).length === 0);

// a BETTER rep than baseline -> no complaints
check("better-than-best rep produces no deviation",
  compareToBaseline("squat", { depth: 85, lean: 30 }, { depth: 78, lean: 25 }).length === 0);

// pushup body line: lower angle = sagging (worseWhenLower path)
const pu = compareToBaseline("pushup", { depth: 90, line: 175 }, { depth: 91, line: 158 });
check("pushup: sagging line detected via inverted comparison", pu.length === 1 && pu[0].includes("17°"));

// unknown exercise / missing baseline -> safe empty
check("unknown exercise is safe", compareToBaseline("jump", { a: 1 }, { a: 9 }).length === 0);
check("missing baseline is safe", compareToBaseline("squat", null, { depth: 90, lean: 30 }).length === 0);

console.log(failures ? `\n${failures} test(s) FAILED` : "\nALL TWIN TESTS PASS");
process.exit(failures ? 1 : 0);

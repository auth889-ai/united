// Synthetic athlete — judges (and anyone without a camera) can watch
// FormCoach analyze a live squat set through the SAME biomechanics engine
// the webcam path uses. Every 4th rep is deliberately shallow so the fault
// detection and scoring visibly react.

// Keyframes in normalized image coords (y grows downward), frontal view.
const UP = {
  nose: [0.5, 0.18],
  shoulder: [[0.44, 0.30], [0.56, 0.30]],
  elbow: [[0.42, 0.42], [0.58, 0.42]],
  wrist: [[0.41, 0.53], [0.59, 0.53]],
  hip: [[0.46, 0.55], [0.54, 0.55]],
  knee: [[0.46, 0.75], [0.54, 0.75]],
  ankle: [[0.46, 0.93], [0.54, 0.93]],
};
const DOWN = {
  nose: [0.5, 0.44],
  shoulder: [[0.45, 0.55], [0.55, 0.55]],
  elbow: [[0.36, 0.56], [0.64, 0.56]],
  wrist: [[0.30, 0.55], [0.70, 0.55]],
  hip: [[0.47, 0.74], [0.53, 0.74]],
  knee: [[0.37, 0.78], [0.63, 0.78]],
  ankle: [[0.46, 0.93], [0.54, 0.93]],
};

const PERIOD = 2600; // ms per rep

const lerp = (a, b, t) => a + (b - a) * t;

function point(x, y, sway) {
  return { x: x + sway, y, z: 0, visibility: 1 };
}

// Build all 33 MediaPipe landmarks from the anchor joints.
function skeleton(d, sway) {
  const j = {};
  for (const key of Object.keys(UP)) {
    j[key] = Array.isArray(UP[key][0])
      ? UP[key].map((p, i) => [lerp(p[0], DOWN[key][i][0], d), lerp(p[1], DOWN[key][i][1], d)])
      : [lerp(UP[key][0], DOWN[key][0], d), lerp(UP[key][1], DOWN[key][1], d)];
  }
  const lm = new Array(33);
  const nose = j.nose;
  // face (0-10) clustered around the nose
  for (let i = 0; i <= 10; i++) lm[i] = point(nose[0] + (i % 3 - 1) * 0.015, nose[1] - 0.01, sway);
  lm[11] = point(...j.shoulder[0], sway); lm[12] = point(...j.shoulder[1], sway);
  lm[13] = point(...j.elbow[0], sway);    lm[14] = point(...j.elbow[1], sway);
  lm[15] = point(...j.wrist[0], sway);    lm[16] = point(...j.wrist[1], sway);
  // hands (17-22) near wrists
  for (const [i, w] of [[17, 0], [18, 1], [19, 0], [20, 1], [21, 0], [22, 1]]) {
    lm[i] = point(j.wrist[w][0] + (w ? 0.02 : -0.02), j.wrist[w][1] + 0.02, sway);
  }
  lm[23] = point(...j.hip[0], sway);   lm[24] = point(...j.hip[1], sway);
  lm[25] = point(...j.knee[0], sway);  lm[26] = point(...j.knee[1], sway);
  lm[27] = point(...j.ankle[0], sway); lm[28] = point(...j.ankle[1], sway);
  // heels + foot index
  lm[29] = point(j.ankle[0][0] - 0.01, 0.95, sway); lm[30] = point(j.ankle[1][0] + 0.01, 0.95, sway);
  lm[31] = point(j.ankle[0][0] - 0.03, 0.96, sway); lm[32] = point(j.ankle[1][0] + 0.03, 0.96, sway);
  return lm;
}

export function demoPose(tMs) {
  const rep = Math.floor(tMs / PERIOD);
  const phase = (tMs % PERIOD) / PERIOD;
  const depthScale = rep % 4 === 3 ? 0.8 : 1; // every 4th rep: shallow (triggers the coach)
  const d = Math.sin(Math.PI * phase) ** 1.4 * depthScale;
  const sway = 0.004 * Math.sin(tMs / 900);
  return skeleton(d, sway);
}

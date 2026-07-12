// Movement Twin — the athlete's own best rep becomes their baseline.
//
// Most fitness tools compare everyone against fixed thresholds. The Twin
// compares each rep against THIS athlete's captured best, and reports the
// deviation in measurable units: "Torso leaned 13° more than your best rep."

export const TWIN_DIMS = {
  press: [
    {
      key: "lockout", threshold: 6, worseWhenHigher: false, // lower max elbow = weaker lockout
      phrase: (d) => `Lockout ${d}° short of your best rep — press all the way up.`,
    },
    {
      key: "lean", threshold: 5, worseWhenHigher: true,
      phrase: (d) => `Leaned back ${d}° more than your best rep — ribs down.`,
    },
  ],
  squat: [
    {
      key: "depth", threshold: 5, worseWhenHigher: true, // higher knee angle = shallower
      phrase: (d) => `Depth ${d}° short of your best rep — sink lower.`,
    },
    {
      key: "lean", threshold: 5, worseWhenHigher: true,
      phrase: (d) => `Torso leaned ${d}° more than your best rep — chest up.`,
    },
  ],
  pushup: [
    {
      key: "depth", threshold: 5, worseWhenHigher: true, // higher elbow angle = less range
      phrase: (d) => `Range ${d}° short of your best rep — get lower.`,
    },
    {
      key: "line", threshold: 5, worseWhenHigher: false, // lower body-line angle = sagging
      phrase: (d) => `Body line sagged ${d}° more than your best rep.`,
    },
  ],
  curl: [
    {
      key: "extension", threshold: 6, worseWhenHigher: true,
      phrase: (d) => `Squeeze ${d}° short of your best rep at the top.`,
    },
    {
      key: "drift", threshold: 6, worseWhenHigher: true,
      phrase: (d) => `Elbow swung ${d}° more than your best rep — pin it.`,
    },
  ],
};

// Compare a rep's metrics to the athlete's baseline. Returns measurable
// deviation messages, worst first; empty array = matching your best.
export function compareToBaseline(exercise, best, current) {
  const dims = TWIN_DIMS[exercise];
  if (!dims || !best || !current) return [];
  const out = [];
  for (const dim of dims) {
    const delta = dim.worseWhenHigher
      ? current[dim.key] - best[dim.key]
      : best[dim.key] - current[dim.key];
    if (Number.isFinite(delta) && delta >= dim.threshold) {
      out.push({ delta: Math.round(delta), text: dim.phrase(Math.round(delta)) });
    }
  }
  return out.sort((a, b) => b.delta - a.delta).map((d) => d.text);
}

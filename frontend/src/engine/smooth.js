// Landmark smoothing — exponential moving average over all 33 landmarks.
// Raw pose estimates jitter frame-to-frame; unfiltered, that jitter makes
// joint angles flicker, cues fire spuriously, and the skeleton tremble.
// EMA keeps latency near-zero while stabilizing the signal.

export function createSmoother(alpha = 0.55) {
  let prev = null;
  return {
    smooth(lm) {
      if (!lm) { prev = null; return lm; }
      if (!prev || prev.length !== lm.length) {
        prev = lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0, visibility: p.visibility ?? 1 }));
        return prev;
      }
      prev = lm.map((p, i) => ({
        x: prev[i].x + alpha * (p.x - prev[i].x),
        y: prev[i].y + alpha * (p.y - prev[i].y),
        z: (prev[i].z ?? 0) + alpha * ((p.z ?? 0) - (prev[i].z ?? 0)),
        visibility: p.visibility ?? 1, // confidence must stay current, not smoothed
      }));
      return prev;
    },
    reset() { prev = null; },
  };
}

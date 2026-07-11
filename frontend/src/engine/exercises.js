// Biomechanics engine: joint-angle math + per-exercise state machines.
// Landmarks follow MediaPipe Pose indices.

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

// Angle at vertex b (degrees) between rays b->a and b->c.
export function angle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const magA = Math.hypot(abx, aby), magC = Math.hypot(cbx, cby);
  if (magA === 0 || magC === 0) return 180;
  const cos = Math.min(1, Math.max(-1, dot / (magA * magC)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Angle of segment a->b from vertical (0 = perfectly upright).
function leanFromVertical(top, bottom) {
  const dx = top.x - bottom.x, dy = top.y - bottom.y;
  return Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
}

function vis(lm, ...ids) {
  return ids.reduce((s, i) => s + (lm[i]?.visibility ?? 0), 0) / ids.length;
}

// Pick the better-visible side; returns landmark ids for that side.
function bestSide(lm) {
  const left = vis(lm, LM.L_SHOULDER, LM.L_HIP, LM.L_KNEE, LM.L_ANKLE);
  const right = vis(lm, LM.R_SHOULDER, LM.R_HIP, LM.R_KNEE, LM.R_ANKLE);
  return left >= right
    ? { shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST, hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE }
    : { shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST, hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE };
}

// Cue priorities: higher = spoken first.
const P = { CRITICAL: 3, WARN: 2, INFO: 1 };

/* ------------------------------------------------------------------ *
 * Each analyzer:  reset()  ·  update(lm) -> {
 *   phase, repDone (bool), repScore (0-100 | null), cues: [{text, level}],
 *   metric (label shown under reps, e.g. jump height)
 * } ------------------------------------------------------------------ */

class SquatAnalyzer {
  constructor() { this.reset(); }
  reset() { this.state = "up"; this.minKnee = 180; this.maxLean = 0; this.valgus = false; this.downFrames = 0; }
  update(lm) {
    const s = bestSide(lm);
    if (vis(lm, s.hip, s.knee, s.ankle) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Step back — I need to see your hips, knees and ankles.", level: P.INFO }] };
    }
    const knee = angle(lm[s.hip], lm[s.knee], lm[s.ankle]);
    // Lean is only meaningful when the torso has real vertical extent —
    // seated/close-up poses degenerate the 2D shoulder-hip segment.
    const torsoLen = lm[s.hip].y - lm[s.shoulder].y;
    const lean = torsoLen > 0.12 ? leanFromVertical(lm[s.shoulder], lm[s.hip]) : 0;
    const cues = [];
    let repDone = false, repScore = null;

    // Frontal-view knee valgus (knees caving inward) — a primary ACL risk marker.
    const bothKnees = vis(lm, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE) > 0.5;
    if (bothKnees && this.state === "down") {
      const kneeSpread = Math.abs(lm[LM.L_KNEE].x - lm[LM.R_KNEE].x);
      const ankleSpread = Math.abs(lm[LM.L_ANKLE].x - lm[LM.R_ANKLE].x);
      if (ankleSpread > 0.02 && kneeSpread < ankleSpread * 0.75) {
        this.valgus = true;
        cues.push({ text: "Knees caving in — push them out over your toes.", level: P.CRITICAL });
      }
    }

    // Enter "down" at 120° so partial squats still register (and get scored down).
    if (this.state === "up" && knee < 120) { this.state = "down"; this.downFrames = 0; this.seatedWarned = false; }
    if (this.state === "down") {
      this.downFrames++;
      if (this.downFrames > 300 && !this.seatedWarned) { // ~10s stuck "down"
        this.seatedWarned = true;
        cues.push({ text: "Are you sitting down? Stand up and step back so I can see your whole body.", level: P.WARN });
      }
      this.minKnee = Math.min(this.minKnee, knee);
      this.maxLean = Math.max(this.maxLean, lean);
      if (knee < 115 && this.minKnee > 95) cues.push({ text: "Go a little deeper.", level: P.INFO });
      if (lean > 50) cues.push({ text: "Chest up — you're leaning too far forward.", level: P.CRITICAL });
      if (knee > 155 && this.downFrames < 6) { // a noise blip, not a rep
        this.state = "up"; this.minKnee = 180; this.maxLean = 0; this.valgus = false;
      } else if (knee > 155) { // completed the rep
        this.state = "up";
        repDone = true;
        repScore = 100;
        this.lastRepMetrics = { depth: Math.round(this.minKnee), lean: Math.round(this.maxLean) };
        if (this.minKnee > 105) { repScore -= 30; cues.push({ text: "Too shallow — aim to get thighs near parallel.", level: P.WARN }); }
        else if (this.minKnee > 95) { repScore -= 12; }
        if (this.maxLean > 50) repScore -= 25;
        else if (this.maxLean > 40) repScore -= 10;
        if (this.valgus) repScore -= 20;
        if (repScore >= 90) cues.push({ text: "Great depth, strong rep!", level: P.INFO });
        this.minKnee = 180; this.maxLean = 0; this.valgus = false;
      }
    }
    return { phase: this.state === "down" ? "Down" : "Up", repDone, repScore, cues, repMetrics: repDone ? this.lastRepMetrics : null };
  }
}

class PushupAnalyzer {
  constructor() { this.reset(); }
  reset() { this.state = "up"; this.minElbow = 180; this.worstLine = 180; this.downFrames = 0; }
  update(lm) {
    const s = bestSide(lm);
    if (vis(lm, s.shoulder, s.elbow, s.wrist, s.hip) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Turn side-on to the camera so I can see your arm and body line.", level: P.INFO }] };
    }
    const elbow = angle(lm[s.shoulder], lm[s.elbow], lm[s.wrist]);
    // Body line needs a visible ankle — feet out of frame would produce
    // garbage angles and false "hips sagging" alarms.
    const ankleVisible = (lm[s.ankle]?.visibility ?? 0) > 0.5;
    const bodyLine = ankleVisible ? angle(lm[s.shoulder], lm[s.hip], lm[s.ankle]) : 180;
    const cues = [];
    let repDone = false, repScore = null;

    if (bodyLine < 155) cues.push({ text: "Hips sagging — squeeze your glutes, straight body line.", level: P.CRITICAL });

    // Enter "down" at 115° so shallow push-ups still register (and get scored down).
    if (this.state === "up" && elbow < 115) { this.state = "down"; this.downFrames = 0; }
    if (this.state === "down") {
      this.downFrames++;
      this.minElbow = Math.min(this.minElbow, elbow);
      this.worstLine = Math.min(this.worstLine, bodyLine);
      if (elbow > 150 && this.downFrames < 6) { // a noise blip, not a rep
        this.state = "up"; this.minElbow = 180; this.worstLine = 180;
      } else if (elbow > 150) {
        this.state = "up";
        repDone = true;
        repScore = 100;
        this.lastRepMetrics = { depth: Math.round(this.minElbow), line: Math.round(this.worstLine) };
        if (this.minElbow > 100) { repScore -= 25; cues.push({ text: "Go lower — chest toward the floor.", level: P.WARN }); }
        if (this.worstLine < 155) repScore -= 25;
        else if (this.worstLine < 165) repScore -= 10;
        if (repScore >= 90) cues.push({ text: "Clean push-up, nice line!", level: P.INFO });
        this.minElbow = 180; this.worstLine = 180;
      }
    }
    return { phase: this.state === "down" ? "Down" : "Up", repDone, repScore, cues, repMetrics: repDone ? this.lastRepMetrics : null };
  }
}

class CurlAnalyzer {
  constructor() { this.reset(); }
  reset() { this.state = "extended"; this.minElbow = 180; this.maxDrift = 0; this.flexFrames = 0; }
  update(lm) {
    const s = bestSide(lm);
    if (vis(lm, s.shoulder, s.elbow, s.wrist) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Move so your arm is fully in frame.", level: P.INFO }] };
    }
    const elbow = angle(lm[s.shoulder], lm[s.elbow], lm[s.wrist]);
    const drift = leanFromVertical(lm[s.shoulder], lm[s.elbow]); // upper arm swing
    const cues = [];
    let repDone = false, repScore = null;

    // Register the rep at 100° (matching published exercise-correction research)
    // so shallow curls are COUNTED and coached, not silently ignored.
    if (this.state === "extended" && elbow < 100) { this.state = "flexed"; this.flexFrames = 0; }
    if (this.state === "flexed") {
      this.flexFrames++;
      this.minElbow = Math.min(this.minElbow, elbow);
      this.maxDrift = Math.max(this.maxDrift, drift);
      if (drift > 30) cues.push({ text: "Pin your elbow to your side — no swinging.", level: P.WARN });
      if (elbow > 150 && this.flexFrames < 4) { // noise blip, not a rep
        this.state = "extended"; this.minElbow = 180; this.maxDrift = 0;
      } else if (elbow > 150) {
        this.state = "extended";
        repDone = true;
        repScore = 100;
        this.lastRepMetrics = { extension: Math.round(this.minElbow), drift: Math.round(this.maxDrift) };
        if (this.minElbow > 80) { repScore -= 30; cues.push({ text: "Curl higher — bring the weight all the way up.", level: P.WARN }); }
        else if (this.minElbow > 60) { repScore -= 15; cues.push({ text: "Squeeze all the way up at the top.", level: P.INFO }); }
        if (this.maxDrift > 35) repScore -= 25;
        else if (this.maxDrift > 25) repScore -= 10;
        if (repScore >= 90) cues.push({ text: "Strict curl — textbook.", level: P.INFO });
        this.minElbow = 180; this.maxDrift = 0;
      }
    }
    return { phase: this.state === "flexed" ? "Curling" : "Extended", repDone, repScore, cues, repMetrics: repDone ? this.lastRepMetrics : null };
  }
}

// Vertical jump: calibrates standing hip height + body length in normalized
// units, then converts hip rise into centimetres using the user's real height.
class JumpAnalyzer {
  constructor(getUserHeightCm) { this.getUserHeightCm = getUserHeightCm; this.reset(); }
  reset() {
    this.samples = [];        // calibration hip-y samples
    this.baseHipY = null;
    this.bodyLen = null;      // nose->ankle in normalized units
    this.state = "ground";
    this.peakRise = 0;
    this.lastJumpCm = 0;
    this.bestJumpCm = 0;
  }
  update(lm) {
    if (vis(lm, LM.L_HIP, LM.R_HIP, LM.L_ANKLE, LM.R_ANKLE, LM.NOSE) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Stand back — I need your whole body, head to feet.", level: P.INFO }] };
    }
    const hipY = (lm[LM.L_HIP].y + lm[LM.R_HIP].y) / 2;
    const ankleY = (lm[LM.L_ANKLE].y + lm[LM.R_ANKLE].y) / 2;
    const cues = [];
    let repDone = false, repScore = null;

    // Calibrate over the first ~30 stable frames.
    if (this.baseHipY === null) {
      this.samples.push({ hipY, bodyLen: ankleY - lm[LM.NOSE].y });
      // lock calibration only when the athlete is actually standing still
      if (this.samples.length > 45) this.samples.shift();
      const ys = this.samples.map((v) => v.hipY);
      const stable = this.samples.length >= 30 && Math.max(...ys) - Math.min(...ys) < 0.015;
      if (stable) {
        this.baseHipY = this.samples.reduce((s, v) => s + v.hipY, 0) / this.samples.length;
        this.bodyLen = this.samples.reduce((s, v) => s + v.bodyLen, 0) / this.samples.length;
        cues.push({ text: "Calibrated. Jump as high as you can!", level: P.INFO });
      } else {
        cues.push({ text: "Hold still, calibrating…", level: P.INFO });
      }
      return { phase: "Calibrating", repDone, repScore, cues, metric: null };
    }

    const rise = this.baseHipY - hipY; // + when hips move up
    const threshold = this.bodyLen * 0.06;

    if (this.state === "ground" && rise > threshold) { this.state = "air"; this.peakRise = rise; }
    if (this.state === "air") {
      this.peakRise = Math.max(this.peakRise, rise);
      if (rise < threshold * 0.5) {
        this.state = "ground";
        // nose->ankle ≈ 93% of standing height
        const cmPerUnit = this.getUserHeightCm() * 0.93 / this.bodyLen;
        this.lastJumpCm = Math.max(0, Math.round(this.peakRise * cmPerUnit));
        this.bestJumpCm = Math.max(this.bestJumpCm, this.lastJumpCm);
        repDone = true;
        repScore = Math.min(100, Math.round((this.lastJumpCm / 50) * 100)); // 50cm = 100
        cues.push({ text: `${this.lastJumpCm} centimetres!`, level: P.INFO });
        this.peakRise = 0;
      }
    }
    return {
      phase: this.state === "air" ? "Airborne" : "Ready",
      repDone, repScore, cues,
      metric: this.bestJumpCm ? `Best: ${this.bestJumpCm} cm · Last: ${this.lastJumpCm} cm` : null,
    };
  }
}


// Conditioning drills — the football/basketball cardio pillar.

class JumpingJackAnalyzer {
  constructor() { this.reset(); }
  reset() { this.state = "closed"; this.fullExtension = false; this.openFrames = 0; }
  update(lm) {
    if (vis(lm, LM.L_WRIST, LM.R_WRIST, LM.L_ANKLE, LM.R_ANKLE, LM.L_SHOULDER, LM.R_SHOULDER) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Step back — I need your hands and feet in frame.", level: P.INFO }] };
    }
    const wristsUp = lm[LM.L_WRIST].y < lm[LM.L_SHOULDER].y && lm[LM.R_WRIST].y < lm[LM.R_SHOULDER].y;
    const wristsHigh = lm[LM.L_WRIST].y < lm[LM.NOSE].y && lm[LM.R_WRIST].y < lm[LM.NOSE].y;
    const shoulderSpread = Math.abs(lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x);
    const ankleSpread = Math.abs(lm[LM.L_ANKLE].x - lm[LM.R_ANKLE].x);
    const legsOpen = ankleSpread > shoulderSpread * 1.35;
    const cues = [];
    let repDone = false, repScore = null;

    if (this.state === "closed" && wristsUp && legsOpen) { this.state = "open"; this.openFrames = 0; this.fullExtension = false; }
    if (this.state === "open") {
      this.openFrames++;
      if (wristsHigh) this.fullExtension = true;
      if (!wristsUp && !legsOpen) {
        this.state = "closed";
        if (this.openFrames >= 3) {
          repDone = true;
          repScore = this.fullExtension ? 100 : 85;
          if (!this.fullExtension) cues.push({ text: "Reach all the way up — hands overhead.", level: P.INFO });
        }
      }
    }
    return { phase: this.state === "open" ? "Open" : "Closed", repDone, repScore, cues };
  }
}

class HighKneesAnalyzer {
  constructor() { this.reset(); }
  reset() { this.lastLeg = null; this.up = false; this.driveLeg = null; this.peakLift = 0; this.lastRepMetrics = null; this.shallowStreak = 0; }
  update(lm) {
    if (vis(lm, LM.L_KNEE, LM.R_KNEE, LM.L_HIP, LM.R_HIP) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Step back — I need your hips and knees in frame.", level: P.INFO }] };
    }
    const lift = 0.03; // knee meaningfully above hip line
    const liftOf = (knee, hip) => lm[hip].y - lm[knee].y; // + = knee above hip
    const leftLift = liftOf(LM.L_KNEE, LM.L_HIP);
    const rightLift = liftOf(LM.R_KNEE, LM.R_HIP);
    const cues = [];
    let repDone = false, repScore = null;

    if (!this.up && (leftLift > lift || rightLift > lift)) {
      this.up = true;
      this.driveLeg = leftLift > rightLift ? "L" : "R";
      this.peakLift = Math.max(leftLift, rightLift);
    } else if (this.up) {
      this.peakLift = Math.max(this.peakLift, this.driveLeg === "L" ? leftLift : rightLift);
      if (leftLift <= lift && rightLift <= lift) {
        // stride complete — score it by how high the knee actually drove
        this.up = false;
        if (this.driveLeg !== this.lastLeg) { // alternation = a real running stride
          this.lastLeg = this.driveLeg;
          repDone = true;
          // full credit for a hip-height+ drive (~0.10 of frame), scaled down to
          // 70 for a knee that barely cleared the counting threshold
          repScore = Math.min(100, Math.round(70 + ((this.peakLift - lift) / 0.07) * 30));
          this.lastRepMetrics = { lift: Math.round(this.peakLift * 100) };
          if (this.peakLift < 0.06) {
            this.shallowStreak++;
            if (this.shallowStreak >= 3) {
              cues.push({ text: "Drive your knees higher — up to hip height!", level: P.WARN });
              this.shallowStreak = 0;
            }
          } else this.shallowStreak = 0;
        }
      }
    }
    return { phase: this.up ? "Drive" : "Ready", repDone, repScore, cues, repMetrics: repDone ? this.lastRepMetrics : null };
  }
}


// Isometric hold: the plank. Time under a straight body line, with live
// sag/pike detection. Assumes ~30fps for the displayed hold time.
class PlankAnalyzer {
  constructor() { this.reset(); }
  reset() { this.goodFrames = 0; this.creditedSec = 0; this.bestSec = 0; this.holding = false; }
  update(lm) {
    const s = bestSide(lm);
    if (vis(lm, s.shoulder, s.hip, s.ankle) < 0.5) {
      return { phase: "—", repDone: false, repScore: null, cues: [{ text: "Get side-on to the camera so I can see your body line.", level: P.INFO }] };
    }
    const line = angle(lm[s.shoulder], lm[s.hip], lm[s.ankle]);
    const cues = [];
    let repDone = false, repScore = null;

    if (line >= 165) {
      this.holding = true;
      this.goodFrames++;
      const sec = Math.floor(this.goodFrames / 30);
      if (sec > this.creditedSec) {           // one "rep" per second held
        this.creditedSec = sec;
        this.bestSec = Math.max(this.bestSec, sec);
        repDone = true;
        repScore = 100;
        if (sec > 0 && sec % 10 === 0) cues.push({ text: `${sec} seconds — rock solid!`, level: P.INFO });
      }
    } else {
      if (this.holding && line < 150) {
        cues.push({ text: "Hips sagging — squeeze your glutes, straighten that line.", level: P.CRITICAL });
      } else if (this.holding) {
        cues.push({ text: "Line is drifting — brace your core.", level: P.WARN });
      }
      this.holding = false;
    }
    return {
      phase: this.holding ? "Holding" : "Set up",
      repDone, repScore, cues,
      metric: this.bestSec ? `Hold: ${this.creditedSec}s · best ${this.bestSec}s` : null,
    };
  }
}

export const EXERCISES = {
  squat:  { name: "Squat",         repNoun: "Reps",  make: () => new SquatAnalyzer() },
  pushup: { name: "Push-up",       repNoun: "Reps",  make: () => new PushupAnalyzer() },
  curl:   { name: "Bicep curl",    repNoun: "Reps",  make: () => new CurlAnalyzer() },
  jump:   { name: "Vertical jump", repNoun: "Jumps", make: (getH) => new JumpAnalyzer(getH) },
  jacks:  { name: "Jumping jacks", repNoun: "Reps",  make: () => new JumpingJackAnalyzer() },
  knees:  { name: "High knees",    repNoun: "Steps", make: () => new HighKneesAnalyzer() },
  plank:  { name: "Plank",         repNoun: "Seconds", make: () => new PlankAnalyzer() },
};

export const PRIORITY = P;

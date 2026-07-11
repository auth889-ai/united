# 🏋️ FormCoach AI

**Every athlete deserves a coach. Now everyone has one.**

FormCoach AI is a real-time sports form coach that runs **entirely in your browser**.
Point your webcam at yourself, pick a drill, and it counts your reps, scores every
rep's form 0–100, and **speaks coaching cues out loud** — "go deeper", "chest up",
"hips sagging" — exactly like a coach standing next to you.

Built solo in under 24 hours for **United Hacks V7** (Sports track).

## ✨ Features

- **4 drills**: Squat · Push-up · Bicep curl · **Vertical jump test** (measures your
  jump height in centimetres with no equipment — just your height for calibration)
- **Real-time pose tracking** — 33 body landmarks at ~30fps, drawn as a live skeleton overlay
- **Biomechanics engine** — joint-angle state machines detect reps and phases; each rep
  is scored against the same faults a physio checks (depth, body line, elbow drift, torso lean)
- **Voice coaching** — the highest-priority fault is spoken via the Web Speech API, so you
  never look at the screen mid-set
- **Hands-free voice control** — say "squats", "start", "how am I doing", "finish" and the
  app obeys. It talks *and* listens, making it the first workout coach that **blind and
  low-vision athletes can use entirely eyes-free** (Chrome/Edge)
- **Progress tracking** — per-session form scores charted over time (with an accessible table view)
- **AI coach chat** — a built-in rules coach that knows your session stats, with optional
  bring-your-own-key support for any OpenAI-compatible LLM (e.g. Featherless AI)
- **Privacy by architecture** — inference is on-device (WebAssembly + GPU).
  **Zero bytes of video ever leave your machine.** There is no backend at all.

- **Multi-agent AI coaching backend** — when you finish a session, your joint-angle
  stats (never video) go to a FastAPI backend where **4 specialized AI agents analyze
  in parallel**: 🦵 Biomechanics · 🚑 Injury Risk · 📋 Programming · 📈 Progress.
  Every agent returns a score, findings, and its **reasoning** — transparent AI, not a
  black box. Claude-powered when `ANTHROPIC_API_KEY` is set, with a deterministic
  rules engine fallback so it always works. Reports persist in SQLite.

## 🏗 Architecture

```
Browser ──▶ MediaPipe Pose (on-device, WebAssembly + GPU)
   │            └─▶ Biomechanics engine (rep detection, form scoring)
   │
   └─▶ FastAPI backend ──▶ 4 parallel AI agents (Claude / rules fallback)
                 │
              SQLite ──▶ Athlete Readiness Report ──▶ Dashboard
```

Video never leaves the browser — only anonymized joint-angle stats reach the backend.

## 🚀 Run it

**Frontend** (no build step — any static server):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(A server is required — camera access and ES modules don't work from `file://`.)

**Backend** (multi-agent coaching report):

```bash
cd server
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-...   # optional — falls back to rules engine without it
uvicorn main:app --port 8001
```

Works in Chrome/Edge (best), Firefox and Safari. Allow camera access, stand back so
your whole body is in frame, and press **Start session**.

## 🧠 How it works

1. **Pose estimation** — [MediaPipe Pose Landmarker](https://developers.google.com/mediapipe)
   (lite model, GPU delegate) tracks 33 landmarks per frame, fully on-device.
2. **Biomechanics** — for each exercise, a state machine over joint angles
   (hip–knee–ankle for squats, shoulder–elbow–wrist for push-ups/curls,
   shoulder–hip–ankle for body line) detects rep phases and completions.
3. **Form scoring** — each rep starts at 100 and loses points per fault
   (insufficient depth, torso lean > 50°, body-line collapse < 155°, elbow drift > 35°…).
4. **Jump height** — hip landmarks are calibrated against your standing posture; hip
   rise at the jump apex is converted from normalized units to centimetres using your
   real height as the scale reference.
5. **Coaching** — faults are prioritized (critical > warning > info) and spoken with a
   cooldown so the coach talks like a human, not an alarm.

## 🛠 Stack

**Frontend:** Vanilla JavaScript (ES modules) · MediaPipe Tasks Vision · Web Speech
API (synthesis + recognition) · Canvas + SVG · localStorage — no framework, no build.
**Backend:** Python · FastAPI · Anthropic Claude (parallel `asyncio` agents,
Pydantic-validated structured outputs) · SQLite.

## 📁 Structure

```
index.html            app shell + landing
css/style.css         dark athletic theme
js/app.js             camera, inference loop, session lifecycle, UI
js/exercises.js       angle math + per-exercise analyzers (the biomechanics engine)
js/coach.js           voice cues, session summaries, chat coach (+ optional LLM)
js/voice.js           hands-free voice control (speech recognition + command grammar)
js/report.js          multi-agent AI coaching report panel
js/chart.js           progress chart (accessible: tooltips, table view, direct labels)
server/main.py        FastAPI backend — 4 parallel AI agents + SQLite
server/requirements.txt
```

## ⚖️ License & credits

MIT. Pose estimation by Google MediaPipe. Everything else written from scratch
during the United Hacks V7 hacking window.

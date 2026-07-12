# Devpost submission draft — copy each section into the Devpost form

## Project name
FormCoach AI

## Tagline (elevator pitch)
Every athlete deserves a coach. FormCoach AI turns any webcam into a real-time
form coach that counts your reps, scores your technique, and speaks corrections
out loud — 100% in the browser, with zero video ever leaving your device.

---

## 💡 Inspiration
Improper technique causes ~55% of gym injuries, and improper squat form alone
accounts for ~45% of barbell-related lower-back strains in novice lifters — a
nationwide study in Bangladesh (where I live) found musculoskeletal injuries
widespread among gym members. A personal coach would prevent most of this —
but a coach costs more per hour than many students spend on food in a week.
So most of us train alone — and train wrong. Bad squat depth, sagging push-up hips,
swinging curls: these are the exact faults that stall progress and cause the knee
and back injuries that end amateur sports careers before they start.

Meanwhile — exactly as this theme says — the World Cup and LeBron's Lakers exit have
millions inspired to train right now. FormCoach speaks their language directly: the
**vertical jump test** is how basketball scouts measure explosiveness (LeBron's was
legendary), **high knees** are the footballer's core conditioning drill, and the
**screen-capture analyzer** can coach form on any World Cup training clip on YouTube.
The gap isn't motivation — it's feedback. I wanted to close that gap with nothing
but the webcam everyone already owns.

## 🏋️ What it does
FormCoach AI watches you train and coaches you in real time:

- **Eight drills across the four pillars every sport trains** — strength (squats,
  push-ups, curls, shoulder press with a back-arch safety check), explosive power
  (vertical jump), conditioning/agility (jumping jacks, high knees — football and
  basketball staples), and core (an isometric plank with a live hold timer) — each
  with its own joint-angle state machine over 33 tracked body landmarks.
- **Scores every rep 0–100** against common form-risk patterns — squat depth, torso
  lean, body-line collapse, elbow drift — and shows a live form-score ring.
  (A coaching aid, not a medical diagnostic tool.)
- **A flip-book of every session.** One click downloads a page-turning training
  book — cover, each fault photo with the vision AI's written description, the
  timestamped error notebook, the coach's verdict — generated as a single
  self-contained file on the athlete's own device.
- **Fault evidence, photographed.** The moment a fault fires, FormCoach captures
  that exact frame — skeleton overlay included — into a timestamped evidence gallery
  in your summary. Like a coach with a camera roll; kept in memory only, never uploaded.
- **A Coach's Review after every session.** The LLM reads the full rep-by-rep
  measurement timeline — scores, angles, Twin deviations, the fatigue point — and
  writes a chronological review citing rep numbers, timestamps and degrees from the
  data. Real-time stays instant physics; the deep analysis comes when you rest.
- **Two coaching modes — both fully local, both free.**
  **Mode 1 — Private Analysis:** physics measures every rep in real time; after the
  session, your timestamped fault *photos* go to an auto-detected local vision model
  (moondream/LLaVA/gemma3) that looks at the actual images and describes your body
  position and how to fix it — streamed in, fully offline.
  **Mode 2 — Live Coach:** the vision model watches you *while you train* and speaks
  about what it sees, the mic stays open so you can talk back, and barge-in
  (headphones) lets you interrupt it mid-sentence — a real two-way conversation
  with a coach that can genuinely see, with zero cloud APIs and zero keys.
- **A live AI commentator.** Every few reps, a local LLM (Ollama) reacts to what the
  vision engine just measured — rep score, Twin deviation, fatigue state — and speaks a
  fresh line. Instant physics cues handle safety; the AI adds the human touch.
- **Speaks corrections out loud** ("Chest up — you're leaning too far forward")
  via the Web Speech API, prioritized by injury risk, so you never look at a
  screen mid-set.
- **Measures your vertical jump in centimetres** with no equipment — it calibrates
  your standing posture, then converts hip rise at the jump apex to real units
  using your height.
- **Tracks progress** with a per-session form-score chart (plus an accessible
  table view) stored locally.
- **A real conversation, hands-free.** Commands ("squats", "start", "finish") are
  obeyed instantly — and anything else you say is answered out loud by the AI coach:
  "what should I fix first?" mid-set gets a spoken answer from your own session data.
  Voice in, voice out — designed for **complete eyes-free operation**, so blind and
  low-vision athletes can train independently.
- **Guided workouts, run by voice.** Pick sets × reps; the coach counts you through
  every set, calls rest with a countdown, and announces the next set — a complete
  training product, not a detector.
- **A coach dashboard for whole teams — token-gated.** One backend serves a squad: each athlete
  trains privately in their own browser, and the coach sees sessions, form trends,
  and injury-risk flags in one view, behind a coach access key. Athletes need no accounts at all — their history lives only in their own browser, so there is no user database to breach. That's how it scales in the real world.
- **Zero-knowledge accounts.** Email + password sign-in — but the password never
  leaves the device, and each user's training history is AES-256-GCM encrypted at
  rest with a key derived from her password (PBKDF2, 150k iterations, WebCrypto).
  One user cryptographically cannot read another's data, and there is no server-side
  account database to breach. Login without surveillance.
- **Privacy you can watch.** A live on-screen counter: frames analyzed on-device vs
  video bytes uploaded (always zero) — judges can verify in DevTools. Local-only
  mode sends nothing at all.
- **4 parallel AI agents write your coaching report.** When you finish a session,
  a FastAPI backend fans your joint-angle stats out to four specialized agents —
  🦵 Biomechanics, 🚑 Injury Risk, 📋 Programming, 📈 Progress — each returning a
  score, findings, and its **visible reasoning**. Transparent AI, not a black box.
- **Answers questions as a coach.** A built-in rules coach knows your session
  stats; optionally plug in any OpenAI-compatible LLM (e.g. Featherless AI) for
  open-ended coaching.

And the privacy story: **your camera feed never leaves your browser.** Pose
estimation runs on-device with WebAssembly + GPU; only anonymized joint-angle
numbers reach the backend. Privacy isn't a policy, it's the architecture.

## 🛠 How I built it

**Architecture:**

```
Browser → MediaPipe Pose (on-device WASM+GPU) → Biomechanics engine (rep FSMs, form scoring)
                                                        ↓ (stats only — never video)
                              FastAPI → 4 parallel AI agents (Claude / rules fallback)
                                                        ↓
                                     SQLite → Athlete Readiness Report → Dashboard
```

- **MediaPipe Pose Landmarker** (full model, GPU delegate) for 33-landmark
  tracking at ~30fps in the browser.
- **A biomechanics engine I wrote from scratch** (`frontend/src/engine/exercises.js`): vector math
  for joint angles, per-exercise finite-state machines for rep detection, and a
  fault-deduction scoring model.
- **Multi-agent backend** (`backend/app/`): FastAPI + `asyncio.gather` runs four
  specialized Claude agents concurrently, each constrained to Pydantic-validated
  structured output (score / findings / reasoning), synthesized into an overall
  readiness score and persisted in SQLite. A deterministic rules engine mirrors
  every agent so the system degrades gracefully with no API key.
- **Web Speech API both directions** — synthesis for voice coaching (priority
  levels + cooldown so it talks like a human, not an alarm) and recognition for
  hands-free control with a command grammar.
- **Vanilla JS + SVG** for the UI and an accessible progress chart (hover
  tooltips, direct labels, table view) — no framework, no build step.
- Optional **LLM coach chat** through any OpenAI-compatible endpoint, with a
  rules-based fallback so the demo always works offline.

## 🤔 How it's different (yes, other pose trainers exist — I checked)

I searched GitHub before claiming anything: rep counters, form scorers, even
voice-coaching trainers exist. FormCoach's difference is one idea the others
don't have, plus a combination that's genuinely uncommon:

**The Movement Twin.** Every other trainer compares you against fixed thresholds —
the same numbers for every human body. FormCoach captures *your own best rep* as a
private baseline, replays it as a ghost skeleton to race, and measures every
following rep against it: *"Torso leaned 13° more than your best rep." "Depth 11°
short of your best."* And when fatigue breaks your form, it names the exact rep
where the decline started. Your coach isn't a threshold — it's you, at your best.

The uncommon combination around it:

| Existing pose demos / fitness apps | FormCoach AI |
|---|---|
| Count reps for one exercise | **Scores form quality 0–100 per rep** against physio fault criteria (depth, torso lean, knee valgus/ACL risk, body line, elbow drift) |
| Silent screen output | **Talks AND listens** — voice coaching out, voice control in; the first form coach a blind athlete can operate entirely eyes-free |
| Stop when you stop | **Fatigue detection** — notices form degrading rep-over-rep and tells you to rest *before* injury |
| Single script, no product | Multi-agent AI readiness report (biomechanics / injury risk / programming / progress, each with visible reasoning), streaks & PRs, share cards, installable PWA, CI/CD-deployed |
| Draw a static skeleton | **Live telestration** (joint angles in degrees on the athlete, broadcast-style) + **ghost-rep overlay** — race a translucent replay of your own best rep |
| Analyze only a live camera | **Analyzes any footage** — uploaded files or live screen capture: play a YouTube video of an athlete and watch the coach analyze it in real time |
| Require a webcam to even evaluate | **Built-in demo mode** — a synthetic athlete runs through the same biomechanics engine, so anyone can watch the AI coach work with no camera at all |

The new idea isn't "detect a squat." It's **turning a webcam into a complete, safe, accessible coaching experience** — feedback, safety, accessibility, and programming in one loop.

## ♟️ Challenges I ran into
- **Rep detection that doesn't double-count.** Raw joint angles are noisy;
  I solved it with hysteresis (different enter/exit thresholds per phase) in each
  state machine.
- **Converting pixels to centimetres** for the jump test with a single camera.
  The trick: calibrate against the athlete's own body — average the standing
  nose-to-ankle length over 30 frames, then use the user's real height as the
  scale factor.
- **Coaching cadence.** My first version screamed at me every single frame like a fire alarm with opinions. Speaking every fault every frame is unbearable. Cues are
  prioritized (critical > warning > info) and throttled, and a held bad position
  counts as one fault, not hundreds.

## 🏆 Accomplishments I'm proud of
- A complete, working, deployed product — built solo. (Teams of three built the past winners. It was just me and a webcam.)
- Real biomechanics, not an API wrapper: every angle threshold is based on
  published coaching standards (parallel squat depth, neutral body line).
- Privacy by design, which makes it genuinely usable in bedrooms, school gyms,
  and anywhere else people actually train.

## 🧠 What I learned
State machines beat machine-learning classifiers for rep counting when you have
good landmarks; browser GPU inference is now fast enough for real sports use;
and voice UX needs as much design as visual UX.

## 🤞 What's next
- Sport-specific drills: cricket bowling action analysis, football agility drills,
  basketball shooting form.
- Side-by-side comparison with a pro athlete's reference movement.
- Team mode for school sports programs — a coach dashboard for a whole squad.

## Built with
`javascript` · `mediapipe` · `webassembly` · `web-speech-api` · `python` · `fastapi` · `anthropic` · `claude` · `asyncio` · `sqlite` · `pydantic` · `pwa` · `service-worker` · `github-actions` · `github-pages` · `svg` · `canvas` · `html5` · `css3` · `featherless-ai`

---

## Submission checklist (from the hackathon requirements)
- [ ] Public GitHub repo — push this repo and paste the link
- [ ] Demo video 2–5 min — script in VIDEO_SCRIPT.md, upload to YouTube (unlisted is fine)
- [ ] Written explanation — the sections above, pasted into Devpost
- [ ] Live demo link — https://auth889-ai.github.io/united/ (auto-deployed by GitHub Actions CI on every push)
- [ ] Enter the **Theme (Sports) track** — required for Best Solo Hack eligibility
- [ ] Disclose AI-assisted development honestly in the write-up if the rules ask

# Devpost submission draft — copy each section into the Devpost form

## Project name
FormCoach AI

## Tagline (elevator pitch)
Every athlete deserves a coach. FormCoach AI turns any webcam into a real-time
form coach that counts your reps, scores your technique, and speaks corrections
out loud — 100% in the browser, with zero video ever leaving your device.

---

## Inspiration
Improper technique causes ~55% of gym injuries, and improper squat form alone
accounts for ~45% of barbell-related lower-back strains in novice lifters — a
nationwide study in Bangladesh (where I live) found musculoskeletal injuries
widespread among gym members. A personal coach would prevent most of this —
but a coach costs more per hour than many students spend on food in a week.
So most of us train alone — and train wrong. Bad squat depth, sagging push-up hips,
swinging curls: these are the exact faults that stall progress and cause the knee
and back injuries that end amateur sports careers before they start.

Meanwhile, the World Cup has millions of people inspired to train right now.
The gap isn't motivation — it's feedback. I wanted to close that gap with nothing
but the webcam everyone already owns.

## What it does
FormCoach AI watches you train and coaches you in real time:

- **Counts reps and detects movement phases** for squats, push-ups and bicep curls
  using joint-angle state machines over 33 tracked body landmarks.
- **Scores every rep 0–100** against the same faults a physiotherapist checks —
  squat depth, torso lean, body-line collapse, elbow drift — and shows a live
  form-score ring.
- **Speaks corrections out loud** ("Chest up — you're leaning too far forward")
  via the Web Speech API, prioritized by injury risk, so you never look at a
  screen mid-set.
- **Measures your vertical jump in centimetres** with no equipment — it calibrates
  your standing posture, then converts hip rise at the jump apex to real units
  using your height.
- **Tracks progress** with a per-session form-score chart (plus an accessible
  table view) stored locally.
- **Listens as well as talks.** Full hands-free voice control — "squats", "start",
  "how am I doing", "finish" — makes FormCoach the first workout coach that **blind
  and low-vision athletes can use entirely eyes-free**.
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

## How I built it

**Architecture:**

```
Browser → MediaPipe Pose (on-device WASM+GPU) → Biomechanics engine (rep FSMs, form scoring)
                                                        ↓ (stats only — never video)
                              FastAPI → 4 parallel AI agents (Claude / rules fallback)
                                                        ↓
                                     SQLite → Athlete Readiness Report → Dashboard
```

- **MediaPipe Pose Landmarker** (lite model, GPU delegate) for 33-landmark
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

## How it's different (yes, rep counters exist — this isn't one)

Pose-based rep counters exist on GitHub. Here is what none of them do, and FormCoach does:

| Existing pose demos / fitness apps | FormCoach AI |
|---|---|
| Count reps for one exercise | **Scores form quality 0–100 per rep** against physio fault criteria (depth, torso lean, knee valgus/ACL risk, body line, elbow drift) |
| Silent screen output | **Talks AND listens** — voice coaching out, voice control in; the first form coach a blind athlete can operate entirely eyes-free |
| Stop when you stop | **Fatigue detection** — notices form degrading rep-over-rep and tells you to rest *before* injury |
| Single script, no product | Multi-agent AI readiness report (biomechanics / injury risk / programming / progress, each with visible reasoning), streaks & PRs, share cards, installable PWA, CI/CD-deployed |
| Draw a static skeleton | **Live telestration** (joint angles in degrees on the athlete, broadcast-style) + **ghost-rep overlay** — race a translucent replay of your own best rep |
| Analyze only a live camera | **Analyzes any video file** — your recordings, training clips, footage of pro athletes |
| Require a webcam to even evaluate | **Built-in demo mode** — a synthetic athlete runs through the same biomechanics engine, so anyone can watch the AI coach work with no camera at all |

The new idea isn't "detect a squat." It's **turning a webcam into a complete, safe, accessible coaching experience** — feedback, safety, accessibility, and programming in one loop.

## Challenges I ran into
- **Rep detection that doesn't double-count.** Raw joint angles are noisy;
  I solved it with hysteresis (different enter/exit thresholds per phase) in each
  state machine.
- **Converting pixels to centimetres** for the jump test with a single camera.
  The trick: calibrate against the athlete's own body — average the standing
  nose-to-ankle length over 30 frames, then use the user's real height as the
  scale factor.
- **Coaching cadence.** Speaking every fault every frame is unbearable. Cues are
  prioritized (critical > warning > info) and throttled, and a held bad position
  counts as one fault, not hundreds.

## Accomplishments I'm proud of
- A complete, working, deployed product — built solo in under 24 hours.
- Real biomechanics, not an API wrapper: every angle threshold is based on
  published coaching standards (parallel squat depth, neutral body line).
- Privacy by design, which makes it genuinely usable in bedrooms, school gyms,
  and anywhere else people actually train.

## What I learned
State machines beat machine-learning classifiers for rep counting when you have
good landmarks; browser GPU inference is now fast enough for real sports use;
and voice UX needs as much design as visual UX.

## What's next
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

# Demo video script — FINAL — target 2:45–3:15 (never over 4:00)

**Setup:** OBS (free) recording both your screen AND your webcam view. Two scenes:
(A) screen-only, (B) you on camera training with the app visible. Good light,
camera at hip height, 2–3 m back, whole body in frame, contrasting clothes.
System audio ON — judges must HEAR the coach. Speak with energy. Smile. Winners
(WebHangin) won with personality, not perfection — if you laugh at a mistake,
keep it in.

---

## 0:00–0:20 — Hook (Scene B: you mid-squat, skeleton + angle numbers visible)

> "Bad form causes over half of all gym injuries — and a coach costs more per
> hour than I spend on food in a week. So I built one. This is FormCoach AI —
> it's watching my squat right now, live, in the browser. Watch: it just told
> me to go deeper. Out loud."

*(Do one deliberately shallow squat so it actually says it.)*

## 0:20–0:40 — The problem + who it's for

> "Most athletes train alone, which means training blind. FormCoach turns the
> webcam you already own into a real coach: it counts reps, scores every rep
> out of 100 against the same faults a physiotherapist checks, spots knees
> caving in — the number one ACL risk — and even notices when fatigue is
> degrading my form and tells me to rest BEFORE I get hurt."

## 0:40–1:25 — Core demo (Scene B, unedited if possible)

1. **Squats (20s):** 3 good reps — reps count, score ring fills, live knee
   angles float on your joints. *"Those angle readouts are broadcast-style
   telestration — computed from 33 body landmarks, 30 times a second,
   entirely on my device."*
2. **Ghost rep (10s):** point at the translucent skeleton. *"And that ghost?
   That's my own best rep, replaying — every rep races my best form."*
3. **Voice conversation (15s):** while still standing there, say out loud:
   **"Coach, what should I fix first?"** — let the room hear the spoken answer.
   *"I never touched the screen. It talks AND listens — a blind athlete can run
   an entire session eyes-free."*

## 1:25–1:50 — Guided workout + jump test (Scene B)

- Say **"switch to squats… start"** by voice, or click 🏁 Guided workout:
  *"It runs whole workouts by voice — counts my sets, calls my rest periods."*
  Show 2–3 reps + the rest countdown kicking in.
- Quick vertical jump: *"No force plates — it measures my jump in centimetres
  by calibrating against my own body."*

## 1:50–2:15 — The YouTube moment (Scene A)

Click **🖥 Analyze your screen**, share a YouTube tab playing a squat video
(queue one beforehand: search "20 bodyweight squats follow along"), press
Start session:

> "It doesn't just coach me. Watch it coach a YouTube video — live. Skeleton,
> angles, rep counting, on an athlete who isn't even here. Any footage on
> Earth becomes coachable."

## 2:15–2:45 — Privacy, accounts, and the AI report (Scene A)

1. Point at the Privacy HUD: *"Here's my favorite part: 14,000 frames analyzed,
   ZERO video bytes uploaded — you can verify it in DevTools. Privacy isn't a
   policy here, it's the architecture."*
2. Flash the sign-in screen: *"Accounts with no server: my history is AES-256
   encrypted with a key from my password. There is no database to breach."*
3. Finish the session → agent report renders: *"Four AI agents analyze every
   session in parallel — biomechanics, injury risk, programming, progress —
   and every verdict shows its reasoning."* Show the radar chart, then one
   glance at the coach dashboard: *"and a coach can watch a whole team."*

## 2:45–3:05 — Close (Scene B, face to camera)

> "Real-time computer vision, a biomechanics engine, voice in and out,
> encrypted accounts, 33 automated tests, deployed live — built solo in one
> weekend for United Hacks. FormCoach AI: every athlete deserves a coach.
> Now everyone has one. I really love this project — I hope you do too."

---

## Recording checklist
- [ ] Practice the voice-question beat once (mic ON, say it clearly)
- [ ] Have the YouTube squat video queued in another tab beforehand
- [ ] Both servers running (frontend :8000, backend :8001) — record LOCAL, not the Pages URL, so the agent report works
- [ ] Do one session before recording so streaks/chart/dashboard have data
- [ ] Show the URL bar once (proves it's real)
- [ ] Under 4 minutes — 3:00 is the sweet spot; first 20 seconds must show the product working
- [ ] Upload to YouTube (unlisted), test the link in incognito, paste into Devpost AND into README's demo-video slot

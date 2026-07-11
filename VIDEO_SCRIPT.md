# Demo video script — target 2:30–3:00 (judges stop watching long videos)

**Setup:** Record with OBS (free) or any screen recorder + your phone if needed.
Two scenes: (A) screen recording of the app, (B) you training in front of the
webcam with the app visible. Scene B *is* the money shot — the live skeleton
overlay while you squat is what judges remember. Speak with energy. Smile.

---

## 0:00–0:20 — The hook (say this over Scene B footage, you mid-squat with skeleton overlay)

> "A personal coach costs $50 an hour. This one is free, lives in your browser,
> and is watching my squat right now. It just told me to go deeper — out loud.
> This is FormCoach AI: a real-time sports form coach that needs nothing but
> the webcam you already own."

*(Devpost's own judges say the elevator pitch must be in the first few seconds —
this does it in 20.)*

## 0:20–0:50 — The problem

> "Most athletes train alone, and training alone means training blind. Bad squat
> depth, sagging push-up hips — these faults stall your progress and cause the
> knee and back injuries that end amateur careers. The problem isn't motivation.
> It's feedback. Coaches are expensive, wearables are extra hardware, and fitness
> apps just play videos AT you. None of them watch YOU."

## 0:50–2:00 — Live demo (the core — all Scene B, real-time, unedited if possible)

Do these on camera, narrating:

1. **Squats (30s):** Do 3 good squats — reps count up, score ring fills, coach
   says numbers. Then do 1 shallow squat → app says "Too shallow — aim to get
   thighs near parallel" and the score drops. Say: *"It caught that instantly —
   that's a joint-angle state machine over 33 body landmarks, running at 30
   frames per second, entirely on my device."*
2. **Vertical jump (25s):** Switch to jump test, hold still to calibrate, jump.
   > "No force plates, no equipment — it calibrates against my own body
   > proportions and just measured my jump at __ centimetres."
3. **Voice control (15s):** Toggle the mic and — without touching anything — say
   *"switch to squats"*, *"start"*, *"how am I doing?"*. The app obeys and answers
   out loud. Say: *"It talks AND listens. The whole workout works eyes-free —
   which makes this the first form coach a blind athlete can actually use."*
4. **Finish → multi-agent report (20s):** Say *"finish"* → summary cards + the
   AI Coaching Report renders. *"My joint-angle stats — never my video — go to a
   backend where four specialized AI agents analyze in parallel: biomechanics,
   injury risk, programming, and progress. Every verdict shows its reasoning.
   Transparent AI, not a black box."*

## 2:00–2:25 — Progress + AI coach (Scene A, screen only)

> "Sessions build a form-score history, so you can watch your technique trend up.
> And the coach chat knows my numbers — I ask 'what should I fix first' and it
> answers from MY session data. It even supports plugging in any LLM, like
> sponsor Featherless AI."

## 2:25–2:50 — The kicker + close

> "Here's my favorite part: there is no backend. Pose estimation runs in
> WebAssembly on the GPU, so zero bytes of video ever leave your device.
> Privacy isn't a policy here — it's the architecture.
>
> FormCoach AI: every athlete deserves a coach. Now everyone has one.
> Built solo, in 24 hours, for United Hacks V7."

---

## Recording checklist
- [ ] Good lighting, camera at hip height, 2–3 m back, full body visible
- [ ] Wear clothing that contrasts with the background (tracking looks better)
- [ ] System audio ON so judges hear the voice coaching — it's the wow moment
- [ ] Show the URL bar during the live demo (proves it's real and deployed)
- [ ] Keep it UNDER 3 minutes; upload to YouTube as unlisted; test the link in incognito
- [ ] First 15 seconds must show the product working — no title cards, no slides

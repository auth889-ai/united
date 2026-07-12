"""Local athlete memory for the voice coach.

This mirrors the Memobase pattern from test3: compact events are archived, then
a focused memory context is injected into the coach prompt. Exact session data
stays in this app's SQLite database instead of requiring a separate service.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone

import httpx

from . import agents, db
from .models import Session


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _session_key(athlete: str, session: Session) -> str:
    return f"{athlete}|{session.date}|{session.exercise}|{session.reps}|{session.avgScore}"


def _session_event_text(session: Session) -> str:
    faults = ", ".join(f"{k} ({v}x)" for k, v in session.faults.items()) or "no repeated faults"
    lines = [
        f"{session.exercise}: {session.reps} reps, average form {session.avgScore}/100, faults: {faults}.",
    ]
    if session.bestJumpCm:
        lines.append(f"Best vertical jump: {session.bestJumpCm} cm.")
    if session.errorLog:
        details = "; ".join(
            f"rep {e.rep} at {e.at}s: {e.text}" for e in session.errorLog[:8]
        )
        lines.append(f"Fault notebook: {details}.")
    if session.visionShots:
        notes = "; ".join(
            f"{v.stamp or v.at}s: {v.note}" for v in session.visionShots[:4] if v.note
        )
        if notes:
            lines.append(f"Visual analysis: {notes}.")
    elif session.visionNote:
        lines.append(f"Visual analysis: {session.visionNote[:700]}")
    return " ".join(lines)


def sync_sessions(athlete: str, sessions: list[Session]) -> int:
    if not athlete:
        athlete = "Solo athlete"
    conn = db.connect()
    changed = 0
    for session in sessions:
        session.athlete = session.athlete or athlete
        key = _session_key(athlete, session)
        content = _session_event_text(session)
        payload = session.model_dump()
        cur = conn.execute(
            """INSERT OR IGNORE INTO memory_events
               (athlete, event_key, created_at, event_type, content, data_json)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (athlete, key, session.date or _now(), "training_session", content, json.dumps(payload)),
        )
        changed += cur.rowcount
    conn.commit()
    conn.close()
    return changed


def remember_turn(athlete: str, role: str, content: str) -> None:
    conn = db.connect()
    conn.execute(
        "INSERT INTO coach_turns (athlete, created_at, role, content) VALUES (?, ?, ?, ?)",
        (athlete or "Solo athlete", _now(), role, content[:4000]),
    )
    conn.commit()
    conn.close()


def _rows_for(athlete: str) -> list[dict]:
    conn = db.connect()
    rows = conn.execute(
        """SELECT created_at, content, data_json FROM memory_events
           WHERE athlete = ? ORDER BY created_at DESC LIMIT 80""",
        (athlete or "Solo athlete",),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _recent_turns(athlete: str) -> list[dict[str, str]]:
    conn = db.connect()
    rows = conn.execute(
        """SELECT role, content FROM coach_turns
           WHERE athlete = ? ORDER BY id DESC LIMIT 10""",
        (athlete or "Solo athlete",),
    ).fetchall()
    conn.close()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def memory_context(athlete: str, question: str = "") -> str:
    rows = _rows_for(athlete)
    sessions = []
    for row in rows:
        try:
            sessions.append(json.loads(row["data_json"]))
        except json.JSONDecodeError:
            pass

    fault_counts: Counter[str] = Counter()
    exercise_counts: Counter[str] = Counter()
    best_score = 0
    best_jump = 0
    for s in sessions:
        exercise_counts[s.get("exercise", "Unknown")] += 1
        best_score = max(best_score, int(s.get("avgScore") or 0))
        best_jump = max(best_jump, int(s.get("bestJumpCm") or 0))
        fault_counts.update(s.get("faults") or {})

    latest = rows[:8]
    relevant = []
    q = question.lower()
    if q:
      for row in rows:
          if any(word and word in row["content"].lower() for word in q.split()):
              relevant.append(row)
          if len(relevant) >= 5:
              break

    lines = [
        "# Athlete Memory",
        f"Athlete: {athlete or 'Solo athlete'}",
        f"Sessions remembered: {len(sessions)}",
    ]
    if exercise_counts:
        lines.append("Drills trained: " + ", ".join(f"{k} ({v})" for k, v in exercise_counts.most_common()))
    if fault_counts:
        lines.append("Most repeated faults: " + ", ".join(f"{k} ({v}x)" for k, v in fault_counts.most_common(6)))
    if best_score:
        lines.append(f"Best average form score: {best_score}/100")
    if best_jump:
        lines.append(f"Best remembered vertical jump: {best_jump} cm")
    if latest:
        lines.append("\n## Latest Session Events")
        lines.extend(f"- {r['content']}" for r in latest)
    if relevant:
        lines.append("\n## Question-Relevant Events")
        lines.extend(f"- {r['content']}" for r in relevant)
    turns = _recent_turns(athlete)
    if turns:
        lines.append("\n## Recent Coach Conversation")
        lines.extend(f"- {t['role']}: {t['content']}" for t in turns)
    return "\n".join(lines)


def fallback_answer(question: str, context: str) -> str:
    q = question.lower()
    if "fault" in q or "error" in q or "mistake" in q or "fix" in q:
        return (
            "I remember your session faults. Start with the most repeated fault listed in memory, "
            "because repeated mistakes cost more than one bad rep. Do the next set slower, pause at "
            "the hardest position, and stop the set when the same fault appears twice."
        )
    if "progress" in q or "improve" in q:
        return (
            "Your progress answer is in the remembered session trend: compare today's form score with "
            "your best remembered score, then keep the same drill difficulty until you can average 85 or higher."
        )
    if "plan" in q or "next" in q:
        return (
            "Next session: warm up, do two easy technique sets, then three working sets. Keep one cue only: "
            "fix your most repeated remembered fault before adding reps."
        )
    return (
        "I can answer from your remembered training history. Ask about your biggest fault, your progress, "
        "or what to do next, and I will use the saved sessions and fault notebook."
    )


async def coach_chat(athlete: str, question: str, sessions: list[Session], chat_history: list[dict[str, str]]) -> dict:
    sync_sessions(athlete, sessions)
    context = memory_context(athlete, question)
    remember_turn(athlete, "user", question)

    messages = [
        {
            "role": "system",
            "content": (
                "You are FormCoach, a voice-first coach for blind and low-vision athletes. "
                "Use the athlete memory below as ground truth. Answer conversationally in 2-5 short sentences. "
                "Name the remembered fault/session evidence when relevant. Never invent stats.\n\n"
                + context
            ),
        },
        *chat_history[-8:],
        {"role": "user", "content": question},
    ]

    if agents._ollama:
        try:
            async with httpx.AsyncClient(timeout=35.0) as http:
                res = await http.post(
                    f"{agents.OLLAMA_URL}/api/chat",
                    json={"model": agents.OLLAMA_MODEL, "stream": False, "messages": messages},
                )
                res.raise_for_status()
                text = res.json()["message"]["content"].strip()
                remember_turn(athlete, "assistant", text)
                return {"text": text, "engine": f"ollama:{agents.OLLAMA_MODEL}", "memory": context}
        except Exception:
            pass

    text = fallback_answer(question, context)
    remember_turn(athlete, "assistant", text)
    engine = "memory-rules" if agents.engine_name() != "offline" else "memory-offline"
    return {"text": text, "engine": engine, "memory": context}

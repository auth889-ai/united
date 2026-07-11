"""FormCoach AI — multi-agent coaching backend.

Pose estimation stays on-device in the browser; only anonymized session
stats (joint-angle metrics, rep counts, fault tallies) arrive here. Four
specialized AI agents analyze each session in parallel and return an
explainable report: every agent shows its score, findings, and reasoning.

Runs Claude-powered when ANTHROPIC_API_KEY is set; otherwise falls back to
deterministic rule-based agents so the demo always works.

    pip install -r requirements.txt
    uvicorn main:app --port 8001
"""

import asyncio
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import anthropic
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent / "formcoach.db"
MODEL = "claude-opus-4-8"

app = FastAPI(title="FormCoach AI — Multi-Agent Coaching API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # hackathon demo; lock down for production
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------- models


class Session(BaseModel):
    date: str
    exercise: str
    reps: int
    avgScore: int
    faults: dict[str, int] = {}
    bestJumpCm: int = 0


class AnalyzeRequest(BaseModel):
    session: Session
    history: list[Session] = []


class AgentReport(BaseModel):
    """Structured output every agent must produce — the 'transparent AI' part."""

    score: int = Field(ge=0, le=100, description="0-100 score for this agent's dimension")
    findings: list[str] = Field(description="2-4 short, specific findings")
    reasoning: str = Field(description="One sentence: how the data led to this verdict")


AGENTS = [
    {
        "key": "biomechanics",
        "icon": "🦵",
        "name": "Biomechanics Agent",
        "prompt": (
            "You are a biomechanics analyst. Score the athlete's movement technique "
            "from the joint-angle fault data (each fault key is a coaching cue that "
            "fired, with its count). Focus on movement quality only."
        ),
    },
    {
        "key": "injury",
        "icon": "🚑",
        "name": "Injury Risk Agent",
        "prompt": (
            "You are an injury-prevention specialist. Map each recorded fault to the "
            "specific injury risk it creates (e.g. forward torso lean under load -> "
            "lumbar stress; knees caving -> ACL/MCL stress; hips sagging in push-ups "
            "-> lower-back strain). Score 100 = very low risk."
        ),
    },
    {
        "key": "programming",
        "icon": "📋",
        "name": "Programming Agent",
        "prompt": (
            "You are a strength & conditioning programmer. Based on this session and "
            "the athlete's history trend, prescribe the next week of training: sets, "
            "reps, and the one cue to prioritize. Score = readiness to progress load."
        ),
    },
    {
        "key": "progress",
        "icon": "📈",
        "name": "Progress Agent",
        "prompt": (
            "You are a progress analyst. Compare this session against the athlete's "
            "history: is form trending up, flat, or down? Call out personal records "
            "(reps, form score, jump height). Score = momentum, 50 = flat trend."
        ),
    },
]

# ---------------------------------------------------------------- storage


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS reports (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             created_at TEXT NOT NULL,
             exercise TEXT NOT NULL,
             reps INTEGER NOT NULL,
             avg_score INTEGER NOT NULL,
             report_json TEXT NOT NULL
           )"""
    )
    return conn


# ---------------------------------------------------------------- agents

_client: anthropic.AsyncAnthropic | None = None
if os.environ.get("ANTHROPIC_API_KEY"):
    _client = anthropic.AsyncAnthropic()


def _fallback_report(agent: dict, session: Session, history: list[Session]) -> AgentReport:
    """Deterministic analysis so the API (and demo) works with no LLM key."""
    faults = session.faults or {}
    total_faults = sum(faults.values())
    top = max(faults.items(), key=lambda kv: kv[1])[0] if faults else None

    if agent["key"] == "biomechanics":
        score = session.avgScore
        findings = [f'Most frequent fault: "{top}" ({faults[top]}x).'] if top else [
            "No repeated technique faults detected this session."
        ]
        findings.append(f"Average rep quality {session.avgScore}/100 across {session.reps} reps.")
        reasoning = "Score derived from per-rep joint-angle deductions."
    elif agent["key"] == "injury":
        score = max(0, 100 - total_faults * 8)
        findings = [f'"{k}" occurred {v}x — repeated exposure raises joint stress.' for k, v in list(faults.items())[:3]] or [
            "No fault patterns associated with elevated injury risk."
        ]
        reasoning = "Risk estimated from fault frequency and type."
    elif agent["key"] == "programming":
        ready = session.avgScore >= 85
        score = session.avgScore
        findings = [
            ("Progress load/reps: form is consistent above the 85 threshold." if ready
             else "Hold current difficulty; quality first — target 85+ average."),
            f"Next week: 3 sessions of 3x{max(5, session.reps)} {session.exercise.lower()}s.",
        ]
        if top:
            findings.append(f'Dedicate one warm-up set purely to fixing: "{top}".')
        reasoning = "Prescription keyed to the 85/100 progression threshold."
    else:  # progress
        prev = [h.avgScore for h in history[:-1] if h.exercise == session.exercise]
        if prev:
            delta = session.avgScore - (sum(prev) / len(prev))
            score = max(0, min(100, int(50 + delta * 2)))
            trend = "up" if delta > 2 else "down" if delta < -2 else "flat"
            findings = [f"Form score is trending {trend} ({delta:+.0f} vs your average)."]
        else:
            score, findings = 50, ["First recorded session for this exercise — baseline set."]
        if session.bestJumpCm:
            findings.append(f"Best jump this session: {session.bestJumpCm} cm.")
        reasoning = "Momentum computed against session history."

    return AgentReport(score=score, findings=findings, reasoning=reasoning)


async def _llm_report(agent: dict, session: Session, history: list[Session]) -> AgentReport:
    payload = {
        "session": session.model_dump(),
        "recent_history": [h.model_dump() for h in history[-6:]],
    }
    response = await _client.messages.parse(
        model=MODEL,
        max_tokens=1000,
        system=(
            f"{agent['prompt']} You are one of four parallel agents inside FormCoach AI, "
            "a webcam form-coaching app. Base every claim strictly on the JSON data "
            "provided — never invent stats. Be specific and encouraging."
        ),
        messages=[{"role": "user", "content": json.dumps(payload)}],
        output_format=AgentReport,
    )
    return response.parsed_output


async def run_agent(agent: dict, session: Session, history: list[Session]) -> dict:
    report: AgentReport
    engine = "rules"
    if _client is not None:
        try:
            report = await _llm_report(agent, session, history)
            engine = "claude"
        except (anthropic.APIError, anthropic.APIConnectionError):
            report = _fallback_report(agent, session, history)
    else:
        report = _fallback_report(agent, session, history)
    return {
        "key": agent["key"],
        "icon": agent["icon"],
        "name": agent["name"],
        "engine": engine,
        **report.model_dump(),
    }


# ---------------------------------------------------------------- routes


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "llm": _client is not None, "model": MODEL if _client else None}


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest) -> dict:
    # All four agents run in parallel — one slow agent never blocks the others.
    agents = await asyncio.gather(*(run_agent(a, req.session, req.history) for a in AGENTS))
    overall = round(sum(a["score"] for a in agents) / len(agents))
    report = {
        "overall": overall,
        "verdict": ("Ready to progress" if overall >= 85
                    else "Solid — refine technique" if overall >= 70
                    else "Focus on quality"),
        "agents": agents,
    }

    conn = db()
    conn.execute(
        "INSERT INTO reports (created_at, exercise, reps, avg_score, report_json) VALUES (?,?,?,?,?)",
        (
            datetime.now(timezone.utc).isoformat(),
            req.session.exercise,
            req.session.reps,
            req.session.avgScore,
            json.dumps(report),
        ),
    )
    conn.commit()
    conn.close()
    return report


@app.get("/api/reports")
def reports(limit: int = 20) -> list[dict]:
    conn = db()
    rows = conn.execute(
        "SELECT created_at, exercise, reps, avg_score, report_json FROM reports ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [
        {
            "created_at": r[0],
            "exercise": r[1],
            "reps": r[2],
            "avg_score": r[3],
            "report": json.loads(r[4]),
        }
        for r in rows
    ]

"""API routes."""

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter

from . import agents, db
from .models import AnalyzeRequest

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict:
    return {"ok": True, "llm": agents.llm_enabled(), "model": agents.MODEL if agents.llm_enabled() else None}


@router.post("/analyze")
async def analyze(req: AnalyzeRequest) -> dict:
    # All four agents run in parallel — one slow agent never blocks the others.
    results = await asyncio.gather(
        *(agents.run_agent(a, req.session, req.history) for a in agents.AGENTS)
    )
    overall = round(sum(a["score"] for a in results) / len(results))
    report = {
        "overall": overall,
        "verdict": ("Ready to progress" if overall >= 85
                    else "Solid — refine technique" if overall >= 70
                    else "Focus on quality"),
        "agents": results,
    }

    conn = db.connect()
    conn.execute(
        "INSERT INTO reports (created_at, exercise, reps, avg_score, report_json, athlete) VALUES (?,?,?,?,?,?)",
        (
            datetime.now(timezone.utc).isoformat(),
            req.session.exercise,
            req.session.reps,
            req.session.avgScore,
            json.dumps(report),
            req.session.athlete,
        ),
    )
    conn.commit()
    conn.close()
    return report


@router.get("/reports")
def reports(limit: int = 20) -> list[dict]:
    conn = db.connect()
    rows = conn.execute(
        "SELECT created_at, exercise, reps, avg_score, report_json, athlete FROM reports ORDER BY id DESC LIMIT ?",
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
            "athlete": r[5],
        }
        for r in rows
    ]

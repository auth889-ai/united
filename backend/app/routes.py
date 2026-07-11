"""API routes."""

import asyncio
import json
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from . import agents, db
from .models import AnalyzeRequest

router = APIRouter(prefix="/api")

# Team data (all athletes) is coach-only. Set COACH_KEY in the environment;
# the default keeps the local demo one-click.
COACH_KEY = os.environ.get("COACH_KEY", "coach-demo")


@router.get("/health")
def health() -> dict:
    return {"ok": True, "llm": agents.llm_enabled(), "engine": agents.engine_name()}


@router.post("/analyze")
async def analyze(req: AnalyzeRequest) -> dict:
    # All four agents run in parallel — one slow agent never blocks the others.
    try:
        results = await asyncio.gather(
            *(agents.run_agent(a, req.session, req.history) for a in agents.AGENTS)
        )
    except agents.NoEngineError as err:
        raise HTTPException(status_code=503, detail=str(err))
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
def reports(limit: int = 20, key: str = "") -> list[dict]:
    if key != COACH_KEY:
        raise HTTPException(status_code=403, detail="Coach access key required")
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

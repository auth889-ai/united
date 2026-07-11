"""The four coaching agents.

Each agent analyzes one dimension of a training session and returns a
Pydantic-validated AgentReport (score / findings / reasoning). Agents run
Claude-powered when ANTHROPIC_API_KEY is set; a deterministic rules engine
mirrors every agent so the API degrades gracefully with no key.
"""

import json
import os

import anthropic
import httpx

from .models import AgentReport, Session

MODEL = "claude-opus-4-8"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")


def _ollama_available() -> bool:
    try:
        return httpx.get(f"{OLLAMA_URL}/api/tags", timeout=1.0).status_code == 200
    except Exception:
        return False


_ollama = _ollama_available()

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

_client: anthropic.AsyncAnthropic | None = None
if os.environ.get("ANTHROPIC_API_KEY"):
    _client = anthropic.AsyncAnthropic()


def llm_enabled() -> bool:
    return _client is not None or _ollama


def engine_name() -> str:
    if _client is not None:
        return "claude"
    if _ollama:
        return f"ollama:{OLLAMA_MODEL}"
    if os.environ.get("FORMCOACH_ALLOW_RULES") == "1":
        return "rules"
    return "offline"


async def ollama_report(agent: dict, session: Session, history: list[Session]) -> AgentReport:
    """Local, private generative agent via Ollama (no key, nothing leaves the machine)."""
    payload = {
        "session": session.model_dump(),
        "recent_history": [h.model_dump() for h in history[-6:]],
    }
    prompt = (
        f"{agent['prompt']} Base every claim strictly on this JSON data — never invent stats.\n"
        f"DATA: {json.dumps(payload)}\n"
        'Reply with ONLY a JSON object: {"score": <0-100 int>, '
        '"findings": [<2-4 short specific strings>], "reasoning": "<one sentence>"}'
    )
    async with httpx.AsyncClient(timeout=30.0) as http:
        res = await http.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "format": "json",
                "stream": False,
            },
        )
        res.raise_for_status()
        return AgentReport.model_validate_json(res.json()["message"]["content"])


def rules_report(agent: dict, session: Session, history: list[Session]) -> AgentReport:
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
        findings = [
            f'"{k}" occurred {v}x — repeated exposure raises joint stress.'
            for k, v in list(faults.items())[:3]
        ] or ["No fault patterns associated with elevated injury risk."]
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


async def llm_report(agent: dict, session: Session, history: list[Session]) -> AgentReport:
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


class NoEngineError(RuntimeError):
    """Raised when no AI engine is reachable (AI-only mode)."""


async def run_agent(agent: dict, session: Session, history: list[Session]) -> dict:
    report: AgentReport
    engine = "rules"
    if _client is not None:
        report = await llm_report(agent, session, history)
        engine = "claude"
    elif _ollama:
        report = await ollama_report(agent, session, history)
        engine = f"ollama:{OLLAMA_MODEL}"
    elif os.environ.get("FORMCOACH_ALLOW_RULES") == "1":
        # deterministic engine retained for CI test determinism only
        report = rules_report(agent, session, history)
    else:
        raise NoEngineError(
            "AI engine offline — start Ollama (ollama serve) or set ANTHROPIC_API_KEY."
        )
    return {
        "key": agent["key"],
        "icon": agent["icon"],
        "name": agent["name"],
        "engine": engine,
        **report.model_dump(),
    }

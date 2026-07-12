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


def _installed_models() -> list[str]:
    try:
        res = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=1.0)
        if res.status_code != 200:
            return []
        return [m["name"] for m in res.json().get("models", [])]
    except Exception:
        return []


_installed = _installed_models()
_ollama = bool(_installed)

# Strongest installed model wins unless OLLAMA_MODEL pins one explicitly.
_PREFERRED = ["llama3.1:8b", "llama3.2:latest", "llama3.2"]


def _pick_model() -> str:
    pinned = os.environ.get("OLLAMA_MODEL")
    if pinned:
        return pinned
    for want in _PREFERRED:
        if want in _installed:
            return want
    return _installed[0] if _installed else "llama3.2"


OLLAMA_MODEL = _pick_model()

AGENTS = [
    {
        "key": "biomechanics",
        "icon": "🦵",
        "name": "Biomechanics Agent",
        "prompt": (
            "You are the Biomechanics Agent — a movement-technique analyst. "
            "In DATA, session.faults counts how many times each joint-angle fault fired "
            "(insufficient_depth = squat above parallel; torso_lean = trunk pitched too far "
            "forward; body_line_sag = hips dropped out of the head-heel line; elbow_drift = "
            "elbows flared). session.avgScore is the physics engine's 0-100 average rep quality. "
            "Score anchors: 90-100 clean technique (at most one rare fault); 70-89 solid with "
            "one or two recurring faults; 50-69 clear technique breakdown; below 50 frequent "
            "multiple faults. Start from avgScore and adjust by fault severity. "
            "Each finding must name one fault key from the data with its exact count and one "
            "short fix cue a coach would shout."
        ),
    },
    {
        "key": "injury",
        "icon": "🚑",
        "name": "Injury Risk Agent",
        "prompt": (
            "You are the Injury Risk Agent — an injury-prevention specialist. Map each fault "
            "in DATA to the tissue it stresses: torso_lean under load -> lumbar spine; "
            "knees_in / valgus -> ACL and MCL; body_line_sag -> lower-back hyperextension; "
            "elbow_drift -> shoulder impingement; insufficient_depth alone is a quality issue, "
            "not an injury risk — do not list it as dangerous. "
            "Score = safety: start at 100 and subtract about 5-8 points per occurrence of a "
            "genuinely risky fault; never go below 20 for bodyweight training. "
            "Each finding: fault name, its count, and the joint or tissue at risk. "
            "You describe risk patterns — never diagnose."
        ),
    },
    {
        "key": "programming",
        "icon": "📋",
        "name": "Programming Agent",
        "prompt": (
            "You are the Programming Agent — a strength and conditioning planner. From DATA, "
            "prescribe next week concretely: exact sets x reps for this exercise, the ONE cue "
            "to prioritize (the most frequent fault), and the promotion rule (progress "
            "difficulty only after averaging 85+ form for two sessions). "
            "Score = readiness to progress: 85-100 progress now; 70-84 hold difficulty and fix "
            "the top fault; below 70 reduce difficulty or slow the tempo. Base it on "
            "session.avgScore and the fault counts. Findings must contain the actual "
            "prescription with numbers, e.g. '3 sessions of 3x12 squats, tempo 3-1-1'."
        ),
    },
    {
        "key": "progress",
        "icon": "📈",
        "name": "Progress Agent",
        "prompt": (
            "You are the Progress Agent — a trend analyst. Compare session.avgScore with the "
            "avgScore values in recent_history for the SAME exercise. "
            "CAREFUL WITH DIRECTION: if today's avgScore is HIGHER than the history average, "
            "form IMPROVED; if lower, it declined. Compute the difference before writing. "
            "Score = momentum: 50 is flat; add about 4 points per point of improvement, "
            "subtract about 4 per point of decline, clamp 0-100. Empty history = 50 (baseline). "
            "Call out personal records only if today's value really beats every history value "
            "(reps, avgScore, bestJumpCm). Every finding must quote the exact numbers compared, "
            "e.g. 'squat form 74 today vs 68 last time (+6, improving)'."
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
    system = (
        f"{agent['prompt']}\n"
        "Hard rules: use ONLY numbers that appear in DATA — never invent stats, reps, dates "
        "or history. Re-check every comparison's direction (higher score = better) before "
        "stating it. Tone: specific, encouraging, honest. "
        'Reply with ONLY a JSON object: {"score": <0-100 int>, '
        '"findings": [<2-4 short specific strings>], "reasoning": "<one sentence>"}. '
        "Every findings item must be a plain sentence string — never a nested object."
    )
    # 4 agents queue on one local GPU; the last in line waits for the first three.
    async with httpx.AsyncClient(timeout=180.0) as http:
        res = await http.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": f"DATA: {json.dumps(payload)}"},
                ],
                "format": "json",
                "stream": False,
                # modest num_ctx: without it Ollama allocates the model's full
                # 64k window and an 8B model swaps instead of generating
                "options": {"temperature": 0.2, "num_ctx": 4096},
            },
        )
        res.raise_for_status()
        raw = json.loads(res.json()["message"]["content"])
        # Small local models sometimes emit findings as objects — flatten to sentences.
        findings = []
        for item in raw.get("findings", []):
            if isinstance(item, dict):
                findings.append(" — ".join(str(v) for v in item.values() if v not in (None, "")))
            elif item:
                findings.append(str(item))
        raw["findings"] = findings or ["No specific findings returned."]
        return AgentReport.model_validate(raw)


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
        try:
            report = await ollama_report(agent, session, history)
            engine = f"ollama:{OLLAMA_MODEL}"
        except Exception:
            # One flaky LLM reply must never sink the whole report.
            report = rules_report(agent, session, history)
            engine = "rules-fallback"
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

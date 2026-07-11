"""Pydantic schemas shared across the API."""

from pydantic import BaseModel, Field


class Session(BaseModel):
    date: str
    exercise: str
    reps: int
    avgScore: int
    faults: dict[str, int] = {}
    bestJumpCm: int = 0
    athlete: str = "Solo athlete"


class AnalyzeRequest(BaseModel):
    session: Session
    history: list[Session] = []


class AgentReport(BaseModel):
    """Structured output every agent must produce — the 'transparent AI' part."""

    score: int = Field(ge=0, le=100, description="0-100 score for this agent's dimension")
    findings: list[str] = Field(description="2-4 short, specific findings")
    reasoning: str = Field(description="One sentence: how the data led to this verdict")

"""Pydantic schemas shared across the API."""

from pydantic import BaseModel, Field


class FaultEvent(BaseModel):
    at: int = 0
    rep: int = 0
    text: str = ""


class VisionShotNote(BaseModel):
    at: int = 0
    stamp: str = ""
    fault: str = ""
    note: str = ""


class Session(BaseModel):
    date: str
    exercise: str
    reps: int
    avgScore: int
    faults: dict[str, int] = Field(default_factory=dict)
    bestJumpCm: int = 0
    athlete: str = "Solo athlete"
    shortDate: str = ""
    errorLog: list[FaultEvent] = Field(default_factory=list)
    visionNote: str = ""
    visionShots: list[VisionShotNote] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    session: Session
    history: list[Session] = Field(default_factory=list)


class MemorySyncRequest(BaseModel):
    athlete: str = "Solo athlete"
    sessions: list[Session] = Field(default_factory=list)


class CoachChatRequest(BaseModel):
    athlete: str = "Solo athlete"
    question: str
    sessions: list[Session] = Field(default_factory=list)
    chatHistory: list[dict[str, str]] = Field(default_factory=list)


class AgentReport(BaseModel):
    """Structured output every agent must produce — the 'transparent AI' part."""

    score: int = Field(ge=0, le=100, description="0-100 score for this agent's dimension")
    findings: list[str] = Field(description="2-4 short, specific findings")
    reasoning: str = Field(description="One sentence: how the data led to this verdict")

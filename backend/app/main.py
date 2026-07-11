"""FormCoach AI — multi-agent coaching backend.

Pose estimation stays on-device in the browser; only anonymized session
stats (joint-angle metrics, rep counts, fault tallies) arrive here. Four
specialized AI agents analyze each session in parallel and return an
explainable report: every agent shows its score, findings, and reasoning.

    pip install -r requirements.txt
    uvicorn app.main:app --port 8001
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .dashboard import router as dashboard_router
from .routes import router


def create_app() -> FastAPI:
    app = FastAPI(
        title="FormCoach AI — Multi-Agent Coaching API",
        description="4 parallel AI agents turn joint-angle session stats into an explainable athlete readiness report.",
        version="1.0.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # hackathon demo; lock down for production
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.include_router(dashboard_router)
    return app


app = create_app()

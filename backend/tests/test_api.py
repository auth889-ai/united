"""API test suite — run with: pytest backend/tests -v"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

SESSION = {
    "date": "2026-07-11",
    "exercise": "Squat",
    "reps": 12,
    "avgScore": 78,
    "faults": {"Chest up — you're leaning too far forward.": 3},
    "bestJumpCm": 0,
}


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_analyze_returns_four_agents():
    r = client.post("/api/analyze", json={"session": SESSION, "history": [SESSION]})
    assert r.status_code == 200
    body = r.json()
    assert len(body["agents"]) == 4
    assert {a["key"] for a in body["agents"]} == {"biomechanics", "injury", "programming", "progress"}
    for agent in body["agents"]:
        assert 0 <= agent["score"] <= 100
        assert agent["findings"], "every agent must produce findings"
        assert agent["reasoning"], "every agent must expose its reasoning"
    assert 0 <= body["overall"] <= 100
    assert body["verdict"]


def test_analyze_flags_fault_in_injury_report():
    r = client.post("/api/analyze", json={"session": SESSION, "history": []})
    injury = next(a for a in r.json()["agents"] if a["key"] == "injury")
    assert any("leaning" in f for f in injury["findings"])


def test_reports_persist():
    before = len(client.get("/api/reports?limit=100&key=coach-demo").json())
    client.post("/api/analyze", json={"session": SESSION, "history": []})
    after = len(client.get("/api/reports?limit=100&key=coach-demo").json())
    assert after == before + 1


def test_reports_require_coach_key():
    assert client.get("/api/reports").status_code == 403
    assert client.get("/api/reports?key=wrong").status_code == 403
    assert client.get("/api/reports?key=coach-demo").status_code == 200


def test_analyze_rejects_bad_payload():
    r = client.post("/api/analyze", json={"session": {"exercise": "Squat"}})
    assert r.status_code == 422


def test_dashboard_serves():
    r = client.get("/dashboard")
    assert r.status_code == 200
    assert "Coach Dashboard" in r.text


def test_reports_carry_athlete():
    client.post("/api/analyze", json={"session": {**SESSION, "athlete": "Test Athlete"}, "history": []})
    latest = client.get("/api/reports?limit=1&key=coach-demo").json()[0]
    assert latest["athlete"] == "Test Athlete"

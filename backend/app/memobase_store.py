"""Long-term athlete memory via a self-hosted Memobase server (Docker).

Each athlete maps to a deterministic Memobase user (UUID5 of their name), so
"Jannat" always resumes the same memory. Sessions and coach conversations are
archived as ChatBlobs; Memobase's LLM (local Ollama) distills them into a
structured athlete profile — recurring faults, PRs, injuries, goals, coaching
preferences — which the voice coach injects into its prompt. Runs entirely on
localhost; if the server is down, the app falls back to SQLite memory alone.
"""

from __future__ import annotations

import os
import uuid

MEMOBASE_URL = os.environ.get("MEMOBASE_PROJECT_URL", "http://localhost:8019")
MEMOBASE_KEY = os.environ.get("MEMOBASE_API_KEY", "secret")
MEMOBASE_VERSION = os.environ.get("MEMOBASE_API_VERSION", "api/v1")
SYNC_WRITES = os.environ.get("MEMOBASE_SYNC_WRITES", "0") == "1"

_client = None
_checked = False


def _get_client():
    global _client, _checked
    if _checked:
        return _client
    _checked = True
    try:
        from memobase import MemoBaseClient

        client = MemoBaseClient(
            project_url=MEMOBASE_URL,
            api_key=MEMOBASE_KEY,
            api_version=MEMOBASE_VERSION,
        )
        if client.ping():
            _client = client
    except Exception:
        _client = None
    return _client


def available() -> bool:
    return _get_client() is not None


def _user(athlete: str):
    client = _get_client()
    if client is None:
        return None
    name = athlete or "Solo athlete"
    uid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"formcoach:{name}"))
    try:
        return client.get_user(uid)
    except Exception:
        pass
    try:
        client.add_user(data={"athlete": name}, id=uid)
        return client.get_user(uid, no_get=True)
    except Exception:
        return None


def record_session(athlete: str, text: str, date: str = "") -> None:
    """Archive one finished training session into the athlete's memory."""
    user = _user(athlete)
    if user is None:
        return
    try:
        from memobase import ChatBlob

        message = {"role": "user", "content": f"I finished a training session. {text}"}
        if date:
            message["created_at"] = date
        user.insert(ChatBlob(messages=[message]))
        user.flush(sync=SYNC_WRITES)
    except Exception:
        pass


def record_chat(athlete: str, question: str, answer: str) -> None:
    """Archive one coach conversation turn pair."""
    user = _user(athlete)
    if user is None:
        return
    try:
        from memobase import ChatBlob

        user.insert(
            ChatBlob(
                messages=[
                    {"role": "user", "content": question[:2000]},
                    {"role": "assistant", "content": answer[:2000], "alias": "FormCoach"},
                ]
            )
        )
        user.flush(sync=SYNC_WRITES)
    except Exception:
        pass


def athlete_context(athlete: str, question: str = "") -> str:
    """Distilled long-term profile + relevant events for the coach prompt."""
    user = _user(athlete)
    if user is None:
        return ""
    try:
        chats = [{"role": "user", "content": question}] if question else None
        return user.context(max_token_size=900, chats=chats) or ""
    except Exception:
        return ""

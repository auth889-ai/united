"""SQLite persistence for coaching reports."""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "formcoach.db"


def connect() -> sqlite3.Connection:
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

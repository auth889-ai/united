"""SQLite persistence for coaching reports."""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "formcoach.db"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
    try:  # migrate pre-athlete databases
        conn.execute("ALTER TABLE reports ADD COLUMN athlete TEXT NOT NULL DEFAULT 'Solo athlete'")
    except sqlite3.OperationalError:
        pass
    conn.execute(
        """CREATE TABLE IF NOT EXISTS memory_events (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             athlete TEXT NOT NULL,
             event_key TEXT NOT NULL UNIQUE,
             created_at TEXT NOT NULL,
             event_type TEXT NOT NULL,
             content TEXT NOT NULL,
             data_json TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS coach_turns (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             athlete TEXT NOT NULL,
             created_at TEXT NOT NULL,
             role TEXT NOT NULL,
             content TEXT NOT NULL
           )"""
    )
    return conn

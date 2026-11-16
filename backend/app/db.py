"""Neon PostgreSQL data-access layer.

Operational course, question, attempt, and mastery data is read from/written
to Neon. The trained BKT parameter JSON remains local model configuration.

Column mappings used by the existing algorithms:
    attempts.is_correct   -> correct (0/1 integer)
    attempts.attempted_at -> timestamp
    courses.article_url   -> content_url
"""

import pandas as pd
from sqlalchemy import create_engine, text
import os
import json
import datetime
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is missing. Add it to the project-root .env file; "
        "do not hardcode database credentials in source code."
    )

engine = create_engine(DATABASE_URL, pool_pre_ping=True)

# This directory is used only for the already-trained BKT model parameters.
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def get_questions_df():
    """Return active question-bank rows from Neon for quiz selection."""
    query = text("""
        SELECT question_id, question_text, options, correct_answer,
               domain, subdomain, difficulty, status, topic
        FROM public.questions
        WHERE status = 'active'
    """)
    return pd.read_sql(query, engine)


def get_courses_df():
    """Return the course bank from Neon in the schema expected by the recommender."""
    query = text("""
        SELECT course_id, title, subdomain, difficulty,
               prerequisite_subdomains, description, est_duration_min,
               article_url
        FROM public.courses
    """)
    df = pd.read_sql(query, engine)
    # The UI and recommender use content_url internally; Neon stores article_url.
    return df.rename(columns={"article_url": "content_url"})


def get_attempt_history(user_id: str, subdomain: str = None):
    """Returns a user's attempt history, optionally filtered to one subdomain.
    Columns returned: user_id, question_id, subdomain, correct, timestamp
    (renamed from is_correct / attempted_at to match internal usage)."""
    query = "SELECT user_id, question_id, subdomain, is_correct, attempted_at FROM public.attempts WHERE user_id = :user_id"
    params = {"user_id": user_id}
    if subdomain:
        query += " AND subdomain = :subdomain"
        params["subdomain"] = subdomain
    query += " ORDER BY attempted_at ASC"

    df = pd.read_sql(text(query), engine, params=params)
    df = df.rename(columns={"is_correct": "correct", "attempted_at": "timestamp"})
    # is_correct is boolean in Postgres -- convert to 0/1 int for BKT
    df["correct"] = df["correct"].astype(int)
    return df


def get_question_details(question_id: str):
    """Return trusted assessment metadata for a question from Neon."""
    query = text("""
        SELECT question_id, question_text, options, correct_answer,
               subdomain, difficulty
        FROM public.questions
        WHERE question_id = :qid AND status = 'active'
    """)
    with engine.connect() as conn:
        row = conn.execute(query, {"qid": question_id}).mappings().first()
    return dict(row) if row else None


def insert_attempts(new_attempts: list[dict]):
    """Insert new attempt rows. Each dict: user_id, question_id,
    correct, timestamp -- (mapped to canonical DB fields).
    NOTE: attempts.difficulty is NOT NULL in the real schema but our
    AssessRequest doesn't currently collect it -- defaulting to the
    question's own difficulty via a lookup join. If that's not desired,
    add difficulty to the /assess request payload instead."""
    if not new_attempts:
        return

    with engine.begin() as conn:
        for row in new_attempts:
            # look up difficulty from the questions table since attempts.difficulty is NOT NULL
            question_result = conn.execute(text("""
                                    SELECT subdomain, difficulty
                                    FROM public.questions
                                    WHERE question_id = :qid
                                """),
                                {"qid": row["question_id"]},
                            ).fetchone()

            if not question_result:
                raise ValueError(
                    f"Question '{row['question_id']}' does not exist"
                )

            subdomain, difficulty = question_result
            conn.execute(
                text("""
                    INSERT INTO public.attempts (user_id, question_id, subdomain, difficulty, is_correct, attempted_at)
                    VALUES (:user_id, :question_id, :subdomain, :difficulty, :is_correct, :attempted_at)
                """),
                {
                    "user_id": row["user_id"],
                    "question_id": row["question_id"],
                    "subdomain": subdomain,
                    "difficulty": difficulty,
                    "is_correct": bool(row["correct"]),
                    "attempted_at": row.get("timestamp", datetime.datetime.utcnow().isoformat()),
                },
            )


def get_mastery_state(user_id: str):
    """Returns current mastery scores for a user: {subdomain: mastery_score}."""
    query = text("SELECT subdomain, mastery_score FROM public.mastery_state WHERE user_id = :user_id")
    df = pd.read_sql(query, engine, params={"user_id": user_id})
    return dict(zip(df["subdomain"], df["mastery_score"].astype(float)))


def upsert_mastery_state(user_id: str, mastery: dict):
    """Write/update mastery scores for a user. mastery: {subdomain: score}."""
    now = datetime.datetime.utcnow()
    with engine.begin() as conn:
        for subdomain, score in mastery.items():
            conn.execute(
                text("""
                    INSERT INTO public.mastery_state (user_id, subdomain, mastery_score, last_updated)
                    VALUES (:user_id, :subdomain, :mastery_score, :last_updated)
                    ON CONFLICT (user_id, subdomain)
                    DO UPDATE SET mastery_score = :mastery_score, last_updated = :last_updated
                """),
                {
                    "user_id": user_id,
                    "subdomain": subdomain,
                    "mastery_score": float(score),
                    "last_updated": now,
                },
            )


def get_bkt_params():
    """Load the trained BKT parameters (fit once, offline, via train_bkt.py).
    This stays as a local JSON file -- these are model parameters, not
    per-user data, so there's no need to store them in Postgres."""
    path = os.path.join(DATA_DIR, "bkt_params.json")
    with open(path) as f:
        return json.load(f)
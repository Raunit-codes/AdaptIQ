"""
Quiz Selection & Assembly — chooses which questions go into a learner's next
quiz, and shuffles them into a servable quiz object.

It's a rules-based selection algorithm (filter
+ sample from the question bank), following from the recommendation model's
output. 

Flow of this: 
  1. First-ever quiz for a user -> hardcoded diagnostic quiz (not this script)
  2. BKT scores that quiz -> mastery vector
  3. Recommendation model -> priority_recommendations (weak subdomains,
     got a course), extra_recommendations (secondary weak / stretch subdomain)
  4. THIS SCRIPT -> builds the next quiz using:
       - repeat of previously-wrong questions in priority/secondary subdomains
       - NEW questions (not seen before) in priority/secondary subdomains
       - NEW questions only (no repeats) in the stretch subdomain
  5. Learner takes quiz -> results appended to attempt history -> back to BKT

USAGE: python -m backend.app.build_quiz (from project root; reads Neon data)
Requires: pandas, numpy (pip install pandas numpy --break-system-packages)
"""

import pandas as pd
import numpy as np


# How many NEW questions to add per subdomain type (tune as needed)
NEW_QUESTIONS_PER_PRIORITY_SUBDOMAIN = 2   # priority + secondary weak subdomains
NEW_QUESTIONS_PER_STRETCH_SUBDOMAIN = 2    # stretch subdomain


def get_wrong_question_ids(attempt_history_df, user_id, subdomain):
    """
    attempt_history_df: DataFrame of past attempts with columns
        user_id, question_id, subdomain, correct, timestamp
    Returns the question_ids this user got WRONG last time, for this subdomain,
    from their most recent quiz attempt on that subdomain.
    """
    user_sub_history = attempt_history_df[
        (attempt_history_df["user_id"] == user_id)
        & (attempt_history_df["subdomain"] == subdomain)
    ].sort_values("timestamp")

    if user_sub_history.empty:
        return []

    # "most recent quiz" = attempts sharing the latest timestamp batch.
    # Simplify: treat the last N rows with the same date/session marker as one quiz.
    # If you log a quiz_id/session_id, use that instead -- more robust than time-grouping.
    parsed_ts = pd.to_datetime(user_sub_history["timestamp"], format="mixed")
    latest_timestamp = parsed_ts.max()
    # naive same-session grouping: attempts within 30 min of the latest one
    session_cutoff = latest_timestamp - pd.Timedelta(minutes=30)
    last_quiz = user_sub_history[parsed_ts >= session_cutoff]

    wrong = last_quiz[last_quiz["correct"] == 0]["question_id"].tolist()
    return wrong


def get_seen_question_ids(attempt_history_df, user_id, subdomain):
    """All question_ids this user has ever been shown for this subdomain --
    used to exclude from 'new' question selection."""
    seen = attempt_history_df[
        (attempt_history_df["user_id"] == user_id)
        & (attempt_history_df["subdomain"] == subdomain)
    ]["question_id"].unique().tolist()
    return seen


def sample_new_questions(questions_df, subdomain, exclude_ids, n, difficulty=None):
    """Pick n unseen questions for a subdomain, optionally near a target difficulty."""
    pool = questions_df[
        (questions_df["subdomain"] == subdomain)
        & (~questions_df["question_id"].isin(exclude_ids))
    ]
    if pool.empty:
        return []

    if difficulty is not None and "difficulty" in pool.columns:
        # prefer questions close to the target difficulty, fall back to whatever's left
        pool = pool.copy()
        pool["diff_gap"] = (pool["difficulty"] - difficulty).abs()
        pool = pool.sort_values("diff_gap")

    n = min(n, len(pool))
    return pool.head(n)["question_id"].tolist() if difficulty is not None else \
        pool.sample(n=n, random_state=None)["question_id"].tolist()


def build_next_quiz(user_id, recommendation_output, mastery, questions_df, attempt_history_df):
    """
    recommendation_output: dict from recommend_courses() --
        {"priority_recommendations": [...], "extra_recommendations": [...],
         "targeted_subdomains": [...]}
    mastery: {subdomain: mastery_score} from BKT
    questions_df: full question bank
    attempt_history_df: full attempt log (user_id, question_id, subdomain, correct, timestamp)

    Returns a quiz object: list of question_ids, shuffled, ready to serve.
    Also returns metadata (which subdomain / why each question was picked) --
    useful for debugging/logging, strip before sending to frontend.
    """
    quiz_pool = []  # list of dicts: {question_id, subdomain, reason}

    priority_subs = [r["subdomain"] for r in recommendation_output["priority_recommendations"]]
    secondary_subs = [
        r["subdomain"] for r in recommendation_output["extra_recommendations"]
        if r.get("reason") == "secondary_weakness"
    ]
    stretch_subs = [
        r["subdomain"] for r in recommendation_output["extra_recommendations"]
        if r.get("reason") == "stretch"
    ]

    # Priority + secondary weak subdomains: repeat wrong + add new
    # dedupe subdomains -- a subdomain could appear in both priority and
    # secondary lists (e.g. recommend_courses picked it twice for different
    # courses); process each targeted subdomain only once here.
    seen_subdomains = set()
    for subdomain in priority_subs + secondary_subs:
        if subdomain in seen_subdomains:
            continue
        seen_subdomains.add(subdomain)
        wrong_ids = get_wrong_question_ids(attempt_history_df, user_id, subdomain)
        for qid in wrong_ids:
            quiz_pool.append({"question_id": qid, "subdomain": subdomain, "reason": "repeat_wrong"})

        seen_ids = get_seen_question_ids(attempt_history_df, user_id, subdomain)
        target_diff = None
        if subdomain in mastery:
            target_diff = round(1 + mastery[subdomain] * 4)  # map 0-1 mastery -> 1-5 difficulty
        new_ids = sample_new_questions(
            questions_df, subdomain, exclude_ids=set(wrong_ids) | set(seen_ids),
            n=NEW_QUESTIONS_PER_PRIORITY_SUBDOMAIN, difficulty=target_diff,
        )
        for qid in new_ids:
            quiz_pool.append({"question_id": qid, "subdomain": subdomain, "reason": "new_priority"})

    # Stretch subdomain: NEW questions only, no repeats (there's nothing to repeat --
    # it's new ground by definition)
    for subdomain in stretch_subs:
        if subdomain in seen_subdomains:
            continue
        seen_subdomains.add(subdomain)
        seen_ids = get_seen_question_ids(attempt_history_df, user_id, subdomain)
        target_diff = None
        if subdomain in mastery:
            # stretch = slightly above current mastery-implied difficulty
            target_diff = min(5, round(1 + mastery[subdomain] * 4) + 1)
        new_ids = sample_new_questions(
            questions_df, subdomain, exclude_ids=seen_ids,
            n=NEW_QUESTIONS_PER_STRETCH_SUBDOMAIN, difficulty=target_diff,
        )
        for qid in new_ids:
            quiz_pool.append({"question_id": qid, "subdomain": subdomain, "reason": "stretch_new"})

    # Safety net: dedupe by question_id in case any path above produced an
    # overlap (keeps first occurrence, which favors "repeat_wrong" reasons
    # since those are added first per subdomain).
    dedup_pool = []
    seen_qids = set()
    for q in quiz_pool:
        if q["question_id"] not in seen_qids:
            dedup_pool.append(q)
            seen_qids.add(q["question_id"])
    quiz_pool = dedup_pool

    # ---- Part 2: assemble + shuffle ----
    rng = np.random.default_rng()
    quiz_pool_shuffled = list(quiz_pool)
    rng.shuffle(quiz_pool_shuffled)

    # Build the actual servable quiz -- join back to question bank for full content,
    # exclude correct_answer from what goes to frontend
    quiz_question_ids = [q["question_id"] for q in quiz_pool_shuffled]
    quiz_questions = questions_df[questions_df["question_id"].isin(quiz_question_ids)]
    # preserve shuffle order
    # Some question_ids in history may no longer exist in the current question
    # bank (e.g. removed/edited) -- filter to what's actually available rather
    # than crashing, and drop those from the shuffled order too.
    available_ids = set(quiz_questions["question_id"])
    quiz_question_ids = [qid for qid in quiz_question_ids if qid in available_ids]
    quiz_pool_shuffled = [q for q in quiz_pool_shuffled if q["question_id"] in available_ids]
    quiz_questions = quiz_questions.set_index("question_id").loc[quiz_question_ids].reset_index()

    servable_quiz = quiz_questions[["question_id", "question_text", "options", "subdomain", "difficulty"]].to_dict(
        orient="records"
    )

    return {
        "user_id": user_id,
        "quiz": servable_quiz,             # send this to frontend (no correct_answer)
        "selection_metadata": quiz_pool_shuffled,  # for your own debugging/logging only
    }


if __name__ == "__main__":
    # Run from the project root with:
    #   ADAPTIQ_TEST_USER_ID=<existing-user-id> python -m backend.app.build_quiz
    # All questions, courses, mastery, and attempt history are fetched from Neon.
    import os
    from . import db
    from .recommend_courses import recommend_courses

    user_id = os.getenv("ADAPTIQ_TEST_USER_ID")
    if not user_id:
        raise SystemExit(
            "Set ADAPTIQ_TEST_USER_ID to an existing user_id with mastery data in Neon."
        )

    mastery = db.get_mastery_state(user_id)
    if not mastery:
        raise SystemExit(
            f"No mastery data exists for {user_id!r}; complete the diagnostic quiz first."
        )

    courses_df = db.get_courses_df()
    questions_df = db.get_questions_df()
    attempt_history_df = db.get_attempt_history(user_id)
    recommendation_output = recommend_courses(mastery, courses_df, n_priority=3, n_extra=1)
    result = build_next_quiz(
        user_id, recommendation_output, mastery, questions_df, attempt_history_df
    )

    print("Servable quiz (question content is loaded from Neon):")
    for question in result["quiz"]:
        print(f"  {question}")
    print("\nSelection metadata (debug only):")
    for metadata in result["selection_metadata"]:
        print(f"  {metadata}")

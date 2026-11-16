"""
Course recommendation model — cosine-similarity based content matching.

Given a learner's BKT mastery vector (per subdomain), recommends courses:
  - top 2-3 courses from the 2-3 weakest subdomains (priority weaknesses)
  - 1-2 additional courses: either a "stretch" course (subdomain the
    learner is already decent at, but a harder module) or a course from a
    lower-priority weak subdomain -- adds breadth beyond the top weaknesses
  - difficulty matched to the learner's current mastery in each targeted
    subdomain (not intentionally harder/easier)

Also returns which subdomains were targeted, so the quiz-selection logic
knows what to test next (the quiz following these recommendations should
cover the subdomains/courses just assigned).

USAGE: python -m backend.app.recommend_courses (from project root; reads courses from Neon)
Requires: pandas, numpy (pip install pandas numpy --break-system-packages)
"""

import pandas as pd
import numpy as np


SUBDOMAINS = ["Phishing", "Password Hygiene", "Social Engineering", "Data Handling", "Incident Reporting"]

# How mastery maps to a target difficulty level (1-5). Tune if it doesn't feel right.
def mastery_to_difficulty(mastery):
    if mastery < 0.3:
        return 1
    elif mastery < 0.5:
        return 2
    elif mastery < 0.7:
        return 3
    elif mastery < 0.85:
        return 4
    else:
        return 5


def course_vector(subdomain, difficulty):
    """One-hot subdomain + normalized difficulty -> feature vector."""
    vec = [1.0 if s == subdomain else 0.0 for s in SUBDOMAINS]
    vec.append(difficulty / 5.0)
    return np.array(vec)


def target_vector(subdomain, target_difficulty):
    """Same shape as course_vector -- represents what we're looking for."""
    return course_vector(subdomain, target_difficulty)


def cosine_sim(a, b):
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom > 0 else 0.0


def prereqs_satisfied(course_row, mastery, threshold=0.6):
    """Hard filter: if a course lists prerequisite subdomains, only include
    it if the learner's mastery on ALL of them is above threshold."""
    prereqs = course_row.get("prerequisite_subdomains")

    # Normalize every possible shape this field could arrive in:
    # None, NaN (float), "" , [], a list of strings, or a comma-separated string.
    if prereqs is None:
        return True
    if isinstance(prereqs, float) and pd.isna(prereqs):
        return True
    if isinstance(prereqs, (list, tuple)):
        if len(prereqs) == 0:
            return True
        prereq_list = [str(p).strip() for p in prereqs if str(p).strip()]
    elif isinstance(prereqs, str):
        if not prereqs.strip():
            return True
        prereq_list = [p.strip() for p in prereqs.strip("{}[]").split(",") if p.strip()]
    else:
        # unexpected type -- fail safe by not blocking the course
        return True

    if not prereq_list:
        return True
    return all(mastery.get(p, 0.0) >= threshold for p in prereq_list)


def recommend_top_course_for_subdomain(courses_df, subdomain, target_difficulty, mastery, exclude_ids=None):
    """Return the single best-matching course for one subdomain, or None."""
    exclude_ids = exclude_ids or set()
    candidates = courses_df[
        (courses_df["subdomain"] == subdomain) & (~courses_df["course_id"].isin(exclude_ids))
    ]
    if candidates.empty:
        return None

    tgt = target_vector(subdomain, target_difficulty)
    best_course, best_score = None, -1.0

    for _, row in candidates.iterrows():
        if not prereqs_satisfied(row, mastery):
            continue
        vec = course_vector(row["subdomain"], row["difficulty"])
        score = cosine_sim(tgt, vec)
        if score > best_score:
            best_score, best_course = score, row

    if best_course is None:
        return None
    description = best_course.get("description")
    content_url = best_course.get("content_url", best_course.get("article_url"))
    duration = best_course.get("est_duration_min")

    return {
        "course_id": best_course["course_id"],
        "title": best_course["title"],
        "subdomain": best_course["subdomain"],
        "difficulty": int(best_course["difficulty"]),
        "similarity": round(best_score, 4),
        # Additional metadata comes from the same Neon course row.
        "description": None if pd.isna(description) else description,
        "content_url": None if pd.isna(content_url) else content_url,
        "est_duration_min": None if pd.isna(duration) else int(duration),
    }


def recommend_courses(mastery, courses_df, n_priority=3, n_extra=1):
    """
    mastery: dict {subdomain: mastery_score (0-1)}  <- BKT output
    courses_df: DataFrame of the course bank
    n_priority: how many top-weakness courses to recommend (2-3)
    n_extra: how many additional courses (stretch or lower-priority weak area)

    Returns: {
      "priority_recommendations": [...],   # top weakest subdomains
      "extra_recommendations": [...],      # stretch or secondary weak area
      "targeted_subdomains": [...]         # feed this into next quiz selection
    }
    """
    # rank subdomains by weakness (ascending mastery = most weak first)
    ranked = sorted(mastery.items(), key=lambda kv: kv[1])
    weakest = ranked[:n_priority]                 # e.g. top 3 weakest
    remainder = ranked[n_priority:]                # everything else, still weakest-first

    priority_recs = []
    used_course_ids = set()
    targeted_subdomains = []

    for subdomain, m_score in weakest:
        target_diff = mastery_to_difficulty(m_score)
        rec = recommend_top_course_for_subdomain(
            courses_df, subdomain, target_diff, mastery, exclude_ids=used_course_ids
        )
        if rec:
            priority_recs.append(rec)
            used_course_ids.add(rec["course_id"])
            targeted_subdomains.append(subdomain)

    # Extra recommendation(s): mix of "stretch" (strongest subdomain, harder
    # course) and "secondary weakness" (next weakest not already covered)
    extra_recs = []

    if remainder:
        # secondary weak area -- pick the next weakest not already targeted
        sub, m_score = remainder[0]
        target_diff = mastery_to_difficulty(m_score)
        rec = recommend_top_course_for_subdomain(
            courses_df, sub, target_diff, mastery, exclude_ids=used_course_ids
        )
        if rec:
            rec["reason"] = "secondary_weakness"
            extra_recs.append(rec)
            used_course_ids.add(rec["course_id"])
            targeted_subdomains.append(sub)

    if len(extra_recs) < n_extra:
        # stretch course: strongest subdomain, but a harder module than current level
        strongest_subdomain, strongest_mastery = max(mastery.items(), key=lambda kv: kv[1])
        stretch_diff = min(5, mastery_to_difficulty(strongest_mastery) + 1)
        rec = recommend_top_course_for_subdomain(
            courses_df, strongest_subdomain, stretch_diff, mastery, exclude_ids=used_course_ids
        )
        if rec:
            rec["reason"] = "stretch"
            extra_recs.append(rec)
            targeted_subdomains.append(strongest_subdomain)

    return {
        "priority_recommendations": priority_recs,
        "extra_recommendations": extra_recs,
        "targeted_subdomains": targeted_subdomains,  # next quiz should cover these
    }


if __name__ == "__main__":
    # Run from the project root with:
    #   python -m backend.app.recommend_courses
    # Courses are loaded from Neon via the same data-access layer as FastAPI.
    from . import db

    courses_df = db.get_courses_df()
    example_mastery = {
        "Phishing": 0.32,
        "Password Hygiene": 0.81,
        "Social Engineering": 0.55,
        "Data Handling": 0.60,
        "Incident Reporting": 0.28,
    }
    result = recommend_courses(example_mastery, courses_df, n_priority=3, n_extra=1)
    print("Priority recommendations (top weaknesses):")
    for recommendation in result["priority_recommendations"]:
        print(f"  {recommendation}")
    print("\nExtra recommendations:")
    for recommendation in result["extra_recommendations"]:
        print(f"  {recommendation}")
    print(f"\nTargeted subdomains: {result['targeted_subdomains']}")

"""
FastAPI service for the Adaptive Cybersecurity Training System.


BKT parameters are loaded from data/bkt_params.json.
BKT prediction is performed by train_bkt.py.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import List
import datetime
from . import db
from .train_bkt import predict_mastery_sequence
from .recommend_courses import recommend_courses
from .build_quiz import build_next_quiz
from .ai_tutor import get_tutor_reply, TutorAnswer

# APP

app = FastAPI(
    title="AdaptIQ — Adaptive Cybersecurity Training API",
    version="1.0.0"
)


 # CORS
 
# React/Vite normally runs on localhost:5173.
# This allows the browser to call FastAPI from the frontend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
 # REQUEST / RESPONSE SCHEMAS
 
class AttemptIn(BaseModel):
    question_id: str
    answer: str


class AssessRequest(BaseModel):
    user_id: str
    new_attempts: List[AttemptIn]


class AssessResponse(BaseModel):
    user_id: str
    mastery: dict[str, float]
    results: list[dict]


class RecommendRequest(BaseModel):
    user_id: str


class MasteryResponse(BaseModel):
    user_id: str
    mastery: dict[str, float]


class NextQuizResponse(BaseModel):
    user_id: str
    quiz: list[dict]


class TutorMessage(BaseModel):
    role: str
    content: str = Field(..., min_length=1, max_length=4000)

    @field_validator("role")
    @classmethod
    def role_must_be_supported(cls, value):
        if value not in {"user", "assistant"}:
            raise ValueError("role must be 'user' or 'assistant'")
        return value


class TutorChatRequest(BaseModel):
    messages: List[TutorMessage] = Field(..., min_length=1, max_length=12)


class TutorChatResponse(BaseModel):
    answer: TutorAnswer


 # HEALTH CHECK
 
@app.get("/health")
def health():
    return {
        "status": "ok"
    }


 # GET /mastery
 
@app.get("/mastery", response_model=MasteryResponse)
def get_mastery(user_id: str):
    """
    Get the learner's currently stored mastery state.

    React calls this when the application loads.
    """

    mastery = db.get_mastery_state(user_id)

    return MasteryResponse(
        user_id=user_id,
        mastery=mastery
    )


 # POST /assess
 
@app.post("/assess", response_model=AssessResponse)
def assess(payload: AssessRequest):

    user_id = payload.user_id

    if not payload.new_attempts:
        raise HTTPException(
            status_code=400,
            detail="new_attempts cannot be empty"
        )

     # 1. Validate answers against Neon and save canonical attempts
 
    now = datetime.datetime.now(datetime.timezone.utc)
    new_rows = []
    results = []
    touched_subdomains = set()

    for attempt in payload.new_attempts:
        question = db.get_question_details(attempt.question_id)
        if not question:
            raise HTTPException(
                status_code=404,
                detail=f"Active question '{attempt.question_id}' was not found"
            )

        options = question["options"] or []
        if isinstance(options, str):
            # Support legacy rows where options were stored as JSON text.
            import json
            try:
                options = json.loads(options)
            except json.JSONDecodeError:
                options = [part.strip() for part in options.split(";") if part.strip()]

        if attempt.answer not in options:
            raise HTTPException(
                status_code=400,
                detail=f"Submitted answer is not a valid option for '{attempt.question_id}'"
            )

        is_correct = attempt.answer == question["correct_answer"]
        touched_subdomains.add(question["subdomain"])
        new_rows.append({
            "user_id": user_id,
            "question_id": attempt.question_id,
            "correct": int(is_correct),
            "timestamp": now.isoformat(),
        })
        results.append({
            "question_id": attempt.question_id,
            "correct": is_correct,
            "correct_answer": question["correct_answer"],
            "subdomain": question["subdomain"],
        })

    try:
        db.insert_attempts(new_rows)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

     # 2. Load already-trained BKT parameters
 
    bkt_params = db.get_bkt_params()

    updated_mastery = {}

     # 3. Run BKT prediction using COMPLETE history
 
    for subdomain in touched_subdomains:

        if subdomain not in bkt_params:
            print(
                f"WARNING: No BKT parameters found for "
                f"subdomain '{subdomain}'"
            )
            continue

        history_df = db.get_attempt_history(
            user_id=user_id,
            subdomain=subdomain
        )

        if history_df.empty:
            continue

        history_df = history_df.sort_values("timestamp")

        sequence = history_df["correct"].tolist()

        trace = predict_mastery_sequence(
            sequence,
            bkt_params[subdomain]
        )

        if trace:
            updated_mastery[subdomain] = trace[-1]

     # 4. Preserve mastery for untouched domains
 
    existing_mastery = db.get_mastery_state(user_id)

    full_mastery = {
        **existing_mastery,
        **updated_mastery
    }

     # 5. Save updated mastery into Neon
 
    if updated_mastery:
        db.upsert_mastery_state(
            user_id,
            updated_mastery
        )

     # 6. Return mastery to React
 
    return AssessResponse(
        user_id=user_id,
        mastery=full_mastery,
        results=results,
    )


 # POST /recommend
 
@app.post("/recommend")
def recommend(payload: RecommendRequest):

    user_id = payload.user_id

    mastery = db.get_mastery_state(user_id)

    if not mastery:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No mastery data exists for user '{user_id}'. "
                "Complete the diagnostic quiz first."
            )
        )

    courses_df = db.get_courses_df()

    result = recommend_courses(
        mastery,
        courses_df,
        n_priority=3,
        n_extra=1
    )

    result["user_id"] = user_id

    return result


 # POST /ai-tutor/chat
 
@app.post("/ai-tutor/chat", response_model=TutorChatResponse)
def ai_tutor_chat(payload: TutorChatRequest):
    """Answer tutor questions with ChatGroq and Tavily-backed search."""
    messages = [message.model_dump() for message in payload.messages]
    if messages[-1]["role"] != "user":
        raise HTTPException(
            status_code=400,
            detail="The last message must have role 'user'.",
        )
    try:
        answer = get_tutor_reply(messages)
    except RuntimeError as exc:
        # Includes missing credentials and agent configuration problems.
        message = str(exc)
        if "not configured" in message:
            raise HTTPException(status_code=503, detail=message) from exc
        print(f"AI tutor runtime error: {message}")
        raise HTTPException(
            status_code=502,
            detail="The AI tutor could not generate a response. Check backend logs.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        print(f"AI tutor request failed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="The AI tutor request failed. Check API keys, provider limits, and backend logs.",
        ) from exc

    return TutorChatResponse(answer=answer)


 # GET /next-quiz
 
@app.get(
    "/next-quiz",
    response_model=NextQuizResponse
)
def next_quiz(user_id: str):

    mastery = db.get_mastery_state(user_id)

    # New learners receive a short diagnostic quiz drawn from Neon.
    # Once the first assessment is submitted, normal adaptive selection starts.
    if not mastery:
        questions_df = db.get_questions_df()
        questions_df = questions_df[questions_df["status"] == "active"]
        if questions_df.empty:
            raise HTTPException(status_code=404, detail="No active questions are available")
        quiz = []
        for _, row in questions_df.sort_values(["subdomain", "difficulty"]).groupby("subdomain", sort=False).head(1).head(5).iterrows():
            options = row["options"]
            if isinstance(options, str):
                import json
                try:
                    options = json.loads(options)
                except json.JSONDecodeError:
                    options = [part.strip() for part in options.split(";") if part.strip()]
            quiz.append({
                "question_id": row["question_id"],
                "question_text": row["question_text"],
                "options": options,
                "subdomain": row["subdomain"],
                "difficulty": int(row["difficulty"]),
            })
        return NextQuizResponse(user_id=user_id, quiz=quiz)

     # Load data from Neon
 
    courses_df = db.get_courses_df()

    questions_df = db.get_questions_df()

    attempt_history_df = db.get_attempt_history(
        user_id
    )

     # Determine weak areas
 
    recommendation_output = recommend_courses(
        mastery,
        courses_df,
        n_priority=3,
        n_extra=1
    )

     # Build adaptive quiz
 
    result = build_next_quiz(
        user_id,
        recommendation_output,
        mastery,
        questions_df,
        attempt_history_df
    )

    return NextQuizResponse(
        user_id=user_id,
        quiz=result["quiz"]
    )
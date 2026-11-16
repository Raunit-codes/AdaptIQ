# AdaptIQ frontend/backend integration changes

Only frontend/backend integration files were changed. Model parameters, course recommendation logic, quiz selection logic, styling, and unrelated UI components were preserved.

## Run locally

From the project root, activate your existing virtual environment and install backend dependencies if needed:

```bash
python -m pip install fastapi uvicorn sqlalchemy psycopg2-binary pandas python-dotenv numpy
python -m uvicorn backend.app.main:app --reload
```

In a second terminal, from the project root:

```bash
npm install
npm run dev
```

The frontend uses `http://127.0.0.1:8000` by default. Override with `VITE_API_BASE_URL` if needed.

The backend expects a project-root `.env` containing `DATABASE_URL=...`. This archive intentionally does not include credentials or your `.env`.

## Integration flow

- Frontend loads mastery from `GET /mastery?user_id=test_user_001`.
- Frontend gets quiz questions from `GET /next-quiz?user_id=test_user_001`.
- New learners with no saved mastery receive a diagnostic quiz assembled from active Neon questions.
- Frontend submits `question_id` and the selected answer text to `POST /assess`.
- Backend validates the answer against Neon, derives the canonical subdomain, writes the attempt, runs the existing trained BKT parameters over the user's full history, saves mastery, and returns the result/correct answer for UI feedback.
- Once mastery exists, `/next-quiz` uses the existing recommendation and quiz-selection modules.

## Notes

- `test_user_001` must already exist in the Neon `users` table because attempts reference the user.
- Questions must be active and have `options` containing the submitted option text.
- The BKT model is not retrained by these changes.
- Build check passed with `npm run build`; Python backend files passed `python -m compileall -q backend/app`.

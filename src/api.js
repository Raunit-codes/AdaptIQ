
const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

export const DEMO_USER_ID = "test_user_001";

async function request(url, options = {}) {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `${response.status} ${response.statusText}: ${text}`
    );
  }

  return response.json();
}

// Backend health check
export async function checkBackend() {
  return request("/health");
}

// Fetch adaptive quiz from FastAPI
export async function getNextQuiz(userId = DEMO_USER_ID) {
  return request(
    `/next-quiz?user_id=${encodeURIComponent(userId)}`
  );
}

// Fetch mastery scores from Neon through FastAPI
export async function getMastery(userId = DEMO_USER_ID) {
  return request(
    `/mastery?user_id=${encodeURIComponent(userId)}`
  );
}

// Submit answers for assessment and BKT updates
export async function submitAssessment(payload) {
  return request("/assess", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// Fetch personalized course recommendations
export async function getRecommendations(userId = DEMO_USER_ID) {
  return request("/recommend", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

// AI Tutor: LangChain + ChatGroq + Tavily via FastAPI
export async function askAITutor(messages) {
  return request("/ai-tutor/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
}

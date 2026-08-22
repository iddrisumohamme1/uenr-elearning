# File: backend/app/main.py
# Purpose: FastAPI application entry point for the UENR E-Learning backend.
#
# Run from the backend/ directory:
#   uvicorn app.main:app --reload --port 8001
# or:
#   python -m app.main

import os
import ssl
import traceback

# Only bypass SSL in development to avoid [SSL: CERTIFICATE_VERIFY_FAILED].
# In production this must NOT be set — it disables all certificate validation.
if os.getenv("APP_ENV", "development") == "development":
    try:
        ssl._create_default_https_context = ssl._create_unverified_context
    except AttributeError:
        pass

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.routes import auth, courses, engagement, recommendations, micro_questions, users, analytics, quiz, materials, students, attendance, messages, assignments, resources, study

app = FastAPI(title=settings.APP_NAME)

# --- CORS: allow the frontend (Live Server, file://, etc.) to call the API ---
allow_origins = ["*"] if settings.CORS_ORIGINS.strip() == "*" else [
    o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=False,  # frontend uses bearer tokens, not cookies
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Global error guard -------------------------------------------------------
# Registered AFTER CORSMiddleware so it runs INSIDE it: an unhandled exception
# is converted to a JSON 500 here and still passes back through the CORS layer.
# Without this, bare 500s skip CORS headers entirely (ServerErrorMiddleware sits
# outside user middleware) and the browser reports them as
# "blocked by CORS policy", hiding the real error.
@app.middleware("http")
async def unhandled_exception_guard(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

# --- Routers ---
app.include_router(auth.router)
app.include_router(courses.router)
app.include_router(users.router)
app.include_router(engagement.router)
app.include_router(recommendations.router)
app.include_router(micro_questions.router)
app.include_router(analytics.router)
app.include_router(quiz.router)
app.include_router(materials.router)
app.include_router(students.router)
app.include_router(attendance.router)
app.include_router(messages.router)
app.include_router(assignments.router)
app.include_router(resources.router)
app.include_router(study.router)


@app.get("/")
def root():
    return {"service": settings.APP_NAME, "status": "running"}


@app.get("/api/health")
def health():
    """Quick check that the server is up and Supabase creds are present."""
    return {
        "status": "ok",
        "environment": settings.APP_ENV,
        "supabase_configured": settings.is_configured,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8001, reload=True)

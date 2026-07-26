# File: backend/app/routes/quiz.py
# Purpose: Quiz creation, submission, and retrieval.
# Lecturers create quizzes for their courses; students submit attempts.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from app.core.security import get_current_user, require_role
from app.database import get_admin_client

router = APIRouter(prefix="/api/quiz", tags=["quiz"])


class QuestionInput(BaseModel):
    question_text: str
    options: List[str]
    correct_option: int


class QuizCreateRequest(BaseModel):
    course_id: str
    title: str
    time_limit: Optional[int] = None
    questions: List[QuestionInput]


class QuizSubmission(BaseModel):
    student_id: str
    course_id: str
    quiz_id: str
    score: float
    max_score: float
    time_taken: float


@router.post("/create", status_code=201)
def create_quiz(payload: QuizCreateRequest, user=Depends(require_role("lecturer"))):
    """
    Create a quiz with questions for a course.
    Lecturers can only create quizzes for their own courses.
    """
    admin = get_admin_client()

    # Verify course belongs to this lecturer
    try:
        course_resp = (
            admin.table("courses")
            .select("id, lecturer_id, department")
            .eq("id", payload.course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        course = course_data[0]
        if course.get("lecturer_id") != user["id"]:
            raise HTTPException(status_code=403, detail="You can only create quizzes for your own courses.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    if not payload.questions:
        raise HTTPException(status_code=400, detail="A quiz must have at least one question.")

    # Create the quiz
    try:
        quiz_resp = (
            admin.table("quizzes")
            .insert({
                "course_id": payload.course_id,
                "title": payload.title,
                "time_limit": payload.time_limit,
            })
            .execute()
        )
        quiz_data = getattr(quiz_resp, "data", []) or []
        if not quiz_data:
            raise HTTPException(status_code=500, detail="Quiz was not created.")
        quiz = quiz_data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create quiz: {exc}")

    # Insert questions
    for q in payload.questions:
        try:
            admin.table("questions").insert({
                "quiz_id": quiz["id"],
                "question_text": q.question_text,
                "options": q.options,
                "correct_option": q.correct_option,
            }).execute()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to create question: {exc}")

    return {
        "status": "success",
        "quiz_id": quiz["id"],
        "title": quiz["title"],
        "questions_count": len(payload.questions),
    }


@router.get("/course/{course_id}")
def get_course_quizzes(course_id: str, user=Depends(get_current_user)):
    """Return all quizzes for a course, including questions."""
    admin = get_admin_client()

    # Verify access
    try:
        course_resp = (
            admin.table("courses")
            .select("id, department")
            .eq("id", course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        if course_data[0].get("department") != user.get("department"):
            raise HTTPException(status_code=403, detail="Access denied to this course.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    try:
        quizzes_resp = (
            admin.table("quizzes")
            .select("*")
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .execute()
        )
        quizzes = getattr(quizzes_resp, "data", []) or []

        # Fetch questions for each quiz
        for quiz in quizzes:
            questions_resp = (
                admin.table("questions")
                .select("id, question_text, options, correct_option")
                .eq("quiz_id", quiz["id"])
                .execute()
            )
            quiz["questions"] = getattr(questions_resp, "data", []) or []

        return {"course_id": course_id, "quizzes": quizzes}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/submit")
def submit_quiz(payload: QuizSubmission, user=Depends(get_current_user)):
    """Records a quiz attempt by a student."""
    # Students can only submit their own quiz attempts
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only submit their own quiz attempts.")
    admin = get_admin_client()

    try:
        admin.table("quiz_results").insert({
            "student_id": payload.student_id,
            "quiz_id": payload.quiz_id,
            "score": payload.score,
            "total_questions": int(payload.max_score),
        }).execute()
        return {"status": "success", "message": "Quiz submitted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/student/{student_id}")
def get_student_quizzes(student_id: str, user=Depends(get_current_user)):
    """Get all quiz results for a student."""
    if user["id"] != student_id and user.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=403, detail="Access denied.")

    try:
        admin = get_admin_client()
        resp = (
            admin.table("quiz_results")
            .select("*, quizzes(title, course_id)")
            .eq("student_id", student_id)
            .order("submitted_at", desc=True)
            .execute()
        )
        return {"student_id": student_id, "results": resp.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

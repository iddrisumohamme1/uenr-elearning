# File: backend/app/routes/quiz.py
# Purpose: Quiz creation, submission, and retrieval.
# Lecturers create quizzes for their courses; students submit attempts.

import io
import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry
from app.routes.recommendations import RECOMMEND_THRESHOLD, record_auto_recommendation
from app.services.material_content import material_text_from_url
from app.services.quiz_generator import quiz_ai
from app.services.insight_messages import push_insight_message
from app.routes.engagement import _run_classification

router = APIRouter(prefix="/api/quiz", tags=["quiz"])


def _is_mock_quiz(quiz_data) -> bool:
    """True when the AI call failed and the mock fallback was returned."""
    try:
        obj = (quiz_data or {}).get("objective") or []
        return bool(obj) and str(obj[0].get("question", "")).startswith("Mock")
    except Exception:
        return True


def _sanitize_quiz(quiz_data) -> dict:
    """Strip answer keys from quiz_data before sending it to the client."""
    return {
        "objective": [
            {"question": q.get("question"), "options": q.get("options", [])}
            for q in (quiz_data or {}).get("objective", [])
        ],
        "theory": [
            {"question": q.get("question")}
            for q in (quiz_data or {}).get("theory", [])
        ],
    }


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
    quiz_id: str
    answers: dict  # Example: {"objective": [0, 2, 1, 3, 0], "theory": ["answer 1", "answer 2"]}


@router.post("/create", status_code=201)
def create_quiz(payload: QuizCreateRequest, user=Depends(require_role("lecturer", "hod"))):
    """
    Create a quiz with questions for a course.
    Lecturers can only create quizzes for their own courses; HODs may create
    quizzes for any course within their department.
    """
    admin = get_admin_client()

    # Verify access to the course
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, lecturer_id, department")
            .eq("id", payload.course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        course = course_data[0]
        if user.get("role") == "hod":
            if course.get("department") != user.get("department"):
                raise HTTPException(status_code=403, detail="You can only create quizzes for courses in your department.")
        elif course.get("lecturer_id") != user["id"]:
            raise HTTPException(status_code=403, detail="You can only create quizzes for your own courses.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    if not payload.questions:
        raise HTTPException(status_code=400, detail="A quiz must have at least one question.")

    # Create the quiz
    try:
        quiz_resp = with_retry(
            lambda c: c.table("quizzes")
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
            with_retry(
                lambda c, q=q: c.table("questions").insert({
                    "quiz_id": quiz["id"],
                    "question_text": q.question_text,
                    "options": q.options,
                    "correct_option": q.correct_option,
                }).execute()
            )
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
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, department")
            .eq("id", course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        if user.get("role") == "student":
            enroll_resp = with_retry(
                lambda c: c.table("enrollments")
                .select("id")
                .eq("student_id", user["id"])
                .eq("course_id", course_id)
                .execute()
            )
            if not (getattr(enroll_resp, "data", []) or []):
                raise HTTPException(status_code=403, detail="Access denied to this course.")
        elif course_data[0].get("department") != user.get("department"):
            raise HTTPException(status_code=403, detail="Access denied to this course.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    try:
        quizzes_resp = with_retry(
            lambda c: c.table("quizzes")
            .select("*")
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .execute()
        )
        quizzes = getattr(quizzes_resp, "data", []) or []

        # Fetch questions for each quiz
        for quiz in quizzes:
            questions_resp = with_retry(
                lambda c, quiz=quiz: c.table("questions")
                .select("id, question_text, options, correct_option")
                .eq("quiz_id", quiz["id"])
                .order("id")
                .execute()
            )
            quiz["questions"] = getattr(questions_resp, "data", []) or []
            # Answers are graded server-side; never ship correct_option to students.
            if user.get("role") == "student":
                for q in quiz["questions"]:
                    q.pop("correct_option", None)

        return {"course_id": course_id, "quizzes": quizzes}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/generate")
def generate_ai_quiz(course_id: str, material_id: str, user=Depends(get_current_user)):
    """
    Called when a student finishes reading a material. Generates a fresh AI quiz
    from the material's actual content (title, description and extracted file text).
    Every attempt produces a brand-new quiz so no two logins share questions.
    """
    admin = get_admin_client()

    # 1. Fetch material content and extract text from the actual file.
    material_text = ""
    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("title, description, content_url, content_type")
            .eq("id", material_id)
            .execute()
        )
        mat_data = getattr(mat_resp, "data", [])
        if mat_data:
            mat = mat_data[0]
            material_text = f"{mat.get('title', '')} - {mat.get('description', '')}".strip()
            content_url = mat.get("content_url") or ""
            content_type = (mat.get("content_type") or "").lower()
            if content_url:
                extracted = material_text_from_url(content_url, content_type)
                if extracted:
                    material_text = f"{material_text}\n{extracted}"
    except Exception as e:
        print(f"[quiz] Could not fetch material content: {e}")

    if not material_text:
        material_text = "Standard introduction to the course concepts."

    # 2. No shared cache: generate fresh for this student every attempt.
    today_str = str(date.today())
    quiz_data = quiz_ai.generate_quiz(material_content=material_text[:30000], num_objective=10, num_theory=2)

    if _is_mock_quiz(quiz_data):
        raise HTTPException(status_code=503, detail="AI quiz generation failed. Please try again later.")

    # 3. Save to database, tagged to this student attempt.
    try:
        insert_resp = with_retry(
            lambda c: c.table("generated_quizzes").insert({
                "course_id": course_id,
                "material_id": material_id,
                "quiz_data": quiz_data,
                "generated_for_date": today_str,
                "generated_for_student_id": user["id"],
            }).execute()
        )
        quiz_id = getattr(insert_resp, "data", [])[0]["id"]
        return {"quiz_id": quiz_id, "quiz": _sanitize_quiz(quiz_data)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save generated quiz: {exc}")


@router.post("/submit")
def submit_quiz(payload: QuizSubmission, user=Depends(require_role("student"))):
    """
    Records an AI quiz submission. Objective questions are auto-scored; theory
    (short-answer) questions are graded by the AI against their rubrics. The
    final score combines both, weighted by question count.
    Manual (lecturer-created) quizzes are graded server-side by
    ``_submit_manual_quiz`` so students never receive correct_answer indicators.
    """
    admin = get_admin_client()

    try:
        # Manual (lecturer-created) quizzes submit a flat "manual" answer list;
        # AI quizzes submit {"objective": [...], "theory": [...]}. Route the
        # former to server-side grading so students never see correct_option.
        manual_answers = (
            payload.answers.get("manual")
            if isinstance(payload.answers, dict) and payload.answers.get("manual") is not None
            else None
        )
        if manual_answers is not None:
            return _submit_manual_quiz(payload, manual_answers, user, admin)

        quiz_resp = with_retry(lambda c: c.table("generated_quizzes").select("quiz_data, course_id").eq("id", payload.quiz_id).execute())
        quiz_data = getattr(quiz_resp, "data", [])
        if not quiz_data:
            raise HTTPException(status_code=404, detail="Quiz not found")

        data = quiz_data[0]["quiz_data"]
        course_id = quiz_data[0].get("course_id")
        correct_answers = [q["correct_answer_index"] for q in data.get("objective", [])]
        submitted_obj = payload.answers.get("objective", [])

        # Objective scoring
        correct = 0
        for i, ans in enumerate(submitted_obj):
            if i < len(correct_answers) and ans == correct_answers[i]:
                correct += 1
        objective_total = len(correct_answers)

        # Theory scoring (AI-graded against the rubrics)
        theory_qs = data.get("theory", [])
        theory_answers = payload.answers.get("theory", [])
        theory_review = [
            {
                "question": q.get("question", ""),
                "answer": theory_answers[i] if i < len(theory_answers) else "",
                "rubric": q.get("suggested_answer_rubric", ""),
            }
            for i, q in enumerate(theory_qs)
        ]
        graded = quiz_ai.grade_theory(theory_review)
        theory_scores = graded.get("scores", [])
        theory_feedback = graded.get("feedback", [])
        theory_avg = round(
            sum(theory_scores) / len(theory_scores) * 100, 1) if theory_scores else None

        # Count theory questions the student left blank — these reduce the mark.
        unanswered_theory = sum(
            1 for i, q in enumerate(theory_qs)
            if not (theory_answers[i] if i < len(theory_answers) else "").strip()
        )

        # Combined percentage: every question carries equal weight
        total_weight = objective_total + len(theory_scores)
        if total_weight:
            raw = correct + sum(theory_scores)
            percentage = round(raw / total_weight * 100, 1)
        else:
            percentage = 0

        if percentage >= 80:
            comp_level = "Good"
        elif percentage >= 50:
            comp_level = "Moderate"
        else:
            comp_level = "Low"

        stored_answers = {
            "objective": submitted_obj,
            "theory": theory_answers,
            "theory_scores": theory_scores,
            "theory_feedback": theory_feedback,
        }

        sub_resp = with_retry(lambda c: c.table("quiz_submissions").insert({
            "student_id": user["id"],
            "quiz_id": payload.quiz_id,
            "answers": stored_answers,
            "score": percentage,
            "comprehension_level": comp_level
        }).execute())
        sub_rows = getattr(sub_resp, "data", []) or []
        submission_id = sub_rows[0]["id"] if sub_rows else None

        # Refresh the stored comprehension/engagement classification now that a
        # fresh quiz score exists, so the dashboard label reflects reality
        # instead of waiting for the next study session. Never blocks the
        # student-facing response.
        if course_id:
            try:
                _run_classification(admin, user["id"], course_id)
            except Exception as e:
                print(f"[quiz] post-submit re-classify skipped: {e}")

        # Auto-recommend study resources when the student underperforms. The
        # query is built from the course title + material title so the semantic
        # search can pull in related material from anywhere in the resource pool.
        recommended_count = 0
        if percentage < RECOMMEND_THRESHOLD and course_id:
            weak_concept = "course quiz material"
            try:
                cresp = with_retry(
                    lambda c: c.table("courses").select("title").eq("id", course_id).limit(1).execute()
                )
                cdata = getattr(cresp, "data", []) or []
                if cdata:
                    weak_concept = cdata[0].get("title") or weak_concept
            except Exception:
                pass
            try:
                mat_resp = with_retry(
                    lambda c: c.table("generated_quizzes")
                    .select("material_id")
                    .eq("id", payload.quiz_id)
                    .limit(1)
                    .execute()
                )
                mat_rows = getattr(mat_resp, "data", []) or []
                mat_id = mat_rows[0].get("material_id") if mat_rows else None
                if mat_id:
                    mresp = with_retry(
                        lambda c: c.table("materials")
                        .select("title")
                        .eq("id", mat_id)
                        .limit(1)
                        .execute()
                    )
                    mrows = getattr(mresp, "data", []) or []
                    if mrows and mrows[0].get("title"):
                        weak_concept = f"{weak_concept}: {mrows[0]['title']}"
            except Exception:
                pass
            try:
                created = record_auto_recommendation(
                    student_id=user["id"],
                    course_id=course_id,
                    submission_id=submission_id,
                    score=percentage,
                    weak_concept=weak_concept,
                )
                recommended_count = len(created)
            except Exception as e:
                print(f"[Quiz] Auto-recommendation skipped: {e}")

        # Notify the student in their inbox about this quiz result.
        try:
            push_insight_message(
                admin, user["id"], course_id,
                kind="quiz", score=percentage, comprehension_level=comp_level,
            )
        except Exception as e:
            print(f"[Quiz] Insight message skipped: {e}")

        return {
            "status": "success",
            "score": percentage,
            "correct": correct,
            "total": objective_total,
            "theory_avg": theory_avg,
            "unanswered_theory": unanswered_theory,
            "recommended_count": recommended_count,
            "theory_feedback": theory_feedback,
            "comprehension_level": comp_level,
            "message": "Quiz submitted and scored successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _submit_manual_quiz(payload: QuizSubmission, submitted_answers, user, admin):
    """Grade a lecturer-created quiz fully server-side.

    ``submitted_answers`` is a flat list of selected option indices in question
    order (matching the ``id``-ordered questions served by get_course_quizzes).
    The scoring index is the stored ``correct_option`` value, which is never
    leaked to the client.
    """
    quiz_resp = with_retry(
        lambda c: c.table("quizzes")
        .select("id, course_id, title")
        .eq("id", payload.quiz_id)
        .execute()
    )
    quiz_rows = getattr(quiz_resp, "data", []) or []
    if not quiz_rows:
        raise HTTPException(status_code=404, detail="Quiz not found")
    course_id = quiz_rows[0].get("course_id")

    enroll_resp = with_retry(
        lambda c: c.table("enrollments")
        .select("id")
        .eq("student_id", user["id"])
        .eq("course_id", course_id)
        .execute()
    )
    if not (getattr(enroll_resp, "data", []) or []):
        raise HTTPException(status_code=403, detail="Access denied to this course.")

    questions_resp = with_retry(
        lambda c: c.table("questions")
        .select("id, correct_option")
        .eq("quiz_id", payload.quiz_id)
        .order("id")
        .execute()
    )
    questions = getattr(questions_resp, "data", []) or []

    correct = sum(
        1 for i, q in enumerate(questions)
        if i < len(submitted_answers) and submitted_answers[i] == q.get("correct_option")
    )
    total = len(questions)
    percentage = round(correct / total * 100, 1) if total else 0.0

    if percentage >= 80:
        comp_level = "Good"
    elif percentage >= 50:
        comp_level = "Moderate"
    else:
        comp_level = "Low"

    insert_resp = with_retry(
        lambda c: c.table("quiz_submissions").insert({
            "student_id": user["id"],
            "quiz_id": payload.quiz_id,
            "answers": {"manual": submitted_answers},
            "score": percentage,
            "comprehension_level": comp_level,
        }).execute()
    )
    insert_rows = getattr(insert_resp, "data", []) or []

    # Notify the student in their inbox about this quiz result.
    try:
        push_insight_message(
            admin, user["id"], course_id,
            kind="quiz", score=percentage, comprehension_level=comp_level,
        )
    except Exception as e:
        print(f"[Quiz] Insight message skipped: {e}")

    return {
        "status": "success",
        "score": percentage,
        "correct": correct,
        "total": total,
        "comprehension_level": comp_level,
        "message": "Quiz submitted and scored successfully",
        "submission_id": insert_rows[0]["id"] if insert_rows else None,
    }


@router.get("/student/{student_id}")
def get_student_quizzes(student_id: str, user=Depends(get_current_user)):
    """Get all AI quiz results (with review) for a student."""
    if user["id"] != student_id and user.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=403, detail="Access denied.")

    try:
        subs_resp = with_retry(
            lambda c: c.table("quiz_submissions")
            .select("id, quiz_id, answers, score, comprehension_level, submitted_at")
            .eq("student_id", student_id)
            .order("submitted_at", desc=True)
            .execute()
        )
        subs = getattr(subs_resp, "data", []) or []

        if not subs:
            return {"student_id": student_id, "results": [], "summary": {}}

        quiz_ids = list({s["quiz_id"] for s in subs})
        quizzes_resp = with_retry(
            lambda c: c.table("generated_quizzes")
            .select("id, course_id, material_id, quiz_data")
            .in_("id", quiz_ids)
            .execute()
        )
        quizzes = getattr(quizzes_resp, "data", []) or []
        quiz_map = {q["id"]: q for q in quizzes}

        course_ids = list({q["course_id"] for q in quizzes if q.get("course_id")})
        material_ids = list({q["material_id"] for q in quizzes if q.get("material_id")})

        course_map = {}
        if course_ids:
            courses = with_retry(
                lambda c: c.table("courses").select("id, title, code").in_("id", course_ids).execute()
            ).data or []
            course_map = {c["id"]: c for c in courses}

        material_map = {}
        if material_ids:
            materials = with_retry(
                lambda c: c.table("materials").select("id, title").in_("id", material_ids).execute()
            ).data or []
            material_map = {m["id"]: m for m in materials}

        results = []
        for s in subs:
            quiz = quiz_map.get(s["quiz_id"]) or {}
            quiz_data = quiz.get("quiz_data") or {}
            answers = s.get("answers") or {}

            review_objective = []
            for i, q in enumerate((quiz_data.get("objective") or [])):
                chosen = answers.get("objective", [])[i] if i < len(answers.get("objective", [])) else None
                correct_idx = q.get("correct_answer_index")
                review_objective.append({
                    "question": q.get("question"),
                    "options": q.get("options", []),
                    "chosen_index": chosen,
                    "correct_index": correct_idx,
                    "correct": chosen == correct_idx,
                })

            review_theory = []
            for i, q in enumerate((quiz_data.get("theory") or [])):
                review_theory.append({
                    "question": q.get("question"),
                    "answer": answers.get("theory", [])[i] if i < len(answers.get("theory", [])) else "",
                    "rubric": q.get("suggested_answer_rubric", ""),
                    "score": answers.get("theory_scores", [])[i] if i < len(answers.get("theory_scores", [])) else None,
                    "feedback": answers.get("theory_feedback", [])[i] if i < len(answers.get("theory_feedback", [])) else "",
                })

            course = course_map.get(quiz.get("course_id")) or {}
            material = material_map.get(quiz.get("material_id")) or {}

            results.append({
                "id": s["id"],
                "quiz_id": s["quiz_id"],
                "score": float(s["score"]),
                "comprehension_level": s["comprehension_level"],
                "submitted_at": s.get("submitted_at"),
                "course_id": quiz.get("course_id"),
                "course_title": course.get("title"),
                "course_code": course.get("code"),
                "material_id": quiz.get("material_id"),
                "material_title": material.get("title"),
                "review": {
                    "objective": review_objective,
                    "theory": review_theory,
                },
            })

        scores = [r["score"] for r in results]
        summary = {
            "count": len(scores),
            "average": round(sum(scores) / len(scores), 1),
            "best": max(scores),
            "latest": scores[0] if scores else None,
        }
        return {"student_id": student_id, "results": results, "summary": summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

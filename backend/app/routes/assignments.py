# File: backend/app/routes/assignments.py
# Purpose: Assignments with on-time submission tracking and AI auto-grading
# for per-student assignments generated when a student downloads a material.

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry
from app.routes.recommendations import RECOMMEND_THRESHOLD, record_auto_recommendation
from app.services.grades import letter_grade
from app.services.material_content import material_text_from_url
from app.services.quiz_generator import quiz_ai

router = APIRouter(prefix="/api/assignments", tags=["assignments"])


class AssignmentCreateRequest(BaseModel):
    course_id: str
    title: str
    instructions: Optional[str] = None
    due_date: Optional[str] = None  # ISO date (YYYY-MM-DD)
    week_number: Optional[int] = None
    questions: Optional[dict] = None  # AI-generated question set to attach


class GenerateQuestionsRequest(BaseModel):
    course_id: str
    topic: str = ""
    num_objective: int = 5
    num_theory: int = 2
    difficulty: str = "medium"  # easy | medium | hard


class AssignmentSubmitRequest(BaseModel):
    assignment_id: str
    content: str = ""
    answers: Optional[dict] = None  # {"objective": [idx...], "theory": ["text"...]}


def _is_mock_quiz(quiz_data) -> bool:
    """True when the AI call failed and the mock fallback was returned."""
    try:
        obj = (quiz_data or {}).get("objective") or []
        return bool(obj) and str(obj[0].get("question", "")).startswith("Mock")
    except Exception:
        return True


def _sanitize_questions(questions) -> dict:
    """Strip answer keys from an auto-assignment question set before sending it to students."""
    return {
        "objective": [
            {"question": q.get("question"), "options": q.get("options", [])}
            for q in (questions or {}).get("objective", [])
        ],
        "theory": [
            {"question": q.get("question")}
            for q in (questions or {}).get("theory", [])
        ],
    }


def _check_course_scope(admin, course_id, user, allow_student=False):
    """Ensure the user is allowed to access this course. Returns course row."""
    try:
        course_resp = with_retry(
            lambda c: c.table("courses")
            .select("id, title, department, lecturer_id")
            .eq("id", course_id)
            .execute()
        )
        course_data = getattr(course_resp, "data", []) or []
        if not course_data:
            raise HTTPException(status_code=404, detail="Course not found.")
        course = course_data[0]

        if user["role"] == "student":
            if not allow_student:
                raise HTTPException(status_code=403, detail="Access denied to this course.")
            enroll_resp = with_retry(
                lambda c: c.table("enrollments")
                .select("id")
                .eq("student_id", user["id"])
                .eq("course_id", course_id)
                .execute()
            )
            if not (getattr(enroll_resp, "data", []) or []):
                raise HTTPException(status_code=403, detail="Access denied to this course.")
        elif user["role"] == "hod":
            if course.get("department") != user.get("department"):
                raise HTTPException(status_code=403, detail="You can only manage courses in your department.")
        elif course.get("lecturer_id") != user["id"]:
            raise HTTPException(status_code=403, detail="You can only manage your own courses.")

        return course
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")


@router.post("/create", status_code=201)
def create_assignment(payload: AssignmentCreateRequest, user=Depends(require_role("lecturer", "hod"))):
    """Lecturers/HODs create an assignment for a course."""
    admin = get_admin_client()
    _check_course_scope(admin, payload.course_id, user)

    due = payload.due_date
    if due:
        try:
            date.fromisoformat(due)
        except ValueError:
            raise HTTPException(status_code=400, detail="due_date must be a valid date (YYYY-MM-DD).")

    try:
        row = {
            "course_id": payload.course_id,
            "title": payload.title,
            "instructions": payload.instructions,
            "due_date": due,
            "week_number": payload.week_number,
        }
        if payload.questions:
            row["questions"] = payload.questions
        insert_resp = with_retry(
            lambda c: c.table("assignments").insert(row).execute()
        )
        assignment = (getattr(insert_resp, "data", []) or [])[0]
        return {"status": "success", "assignment": assignment}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create assignment: {exc}")


@router.post("/generate-questions")
def generate_questions(payload: GenerateQuestionsRequest, user=Depends(require_role("lecturer", "hod"))):
    """Generate assignment questions from course material using AI.
    Returns the question set so the lecturer can review before attaching."""
    admin = get_admin_client()
    _check_course_scope(admin, payload.course_id, user)

    # Gather text from all uploaded materials for this course for context
    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, title, description, content_url, content_type")
            .eq("course_id", payload.course_id)
            .execute()
        )
        materials = getattr(mat_resp, "data", []) or []
    except Exception:
        materials = []

    material_chunks = []
    material_titles = []
    for mat in materials:
        material_titles.append(mat.get("title", ""))
        text = f"{mat.get('title', '')} - {mat.get('description', '')}".strip()
        content_url = mat.get("content_url") or ""
        content_type = (mat.get("content_type") or "").lower()
        if content_url:
            extracted = material_text_from_url(content_url, content_type)
            if extracted:
                text = f"{text}\n{extracted}"
        if text.strip():
            material_chunks.append(text[:15000])  # per-material cap

    combined_material = "\n\n".join(material_chunks) if material_chunks else ""

    # Build context with topic + difficulty instructions
    difficulty_map = {
        "easy": "Focus on recall and basic comprehension. Use simple, direct phrasing.",
        "medium": "Mix comprehension and application. Include some analytical questions.",
        "hard": "Focus on analysis, evaluation, and synthesis. Use multi-step reasoning.",
    }
    difficulty_instruction = difficulty_map.get(payload.difficulty, difficulty_map["medium"])

    num_obj = max(1, min(20, payload.num_objective))
    num_theory = max(0, min(10, payload.num_theory))

    quiz_data = quiz_ai.generate_quiz(
        material_content=combined_material[:30000] if combined_material else payload.topic,
        num_objective=num_obj,
        num_theory=num_theory,
    )

    if _is_mock_quiz(quiz_data):
        raise HTTPException(
            status_code=503,
            detail="AI question generation is unavailable. Check API key configuration.",
        )

    return {
        "status": "success",
        "questions": quiz_data,
        "material_titles": [t for t in material_titles if t],
        "num_objective": len(quiz_data.get("objective", [])),
        "num_theory": len(quiz_data.get("theory", [])),
    }


def _load_material_text(admin, material_id: str) -> str:
    """Fetch a material's title/description/file text for assignment generation."""
    try:
        mat_resp = with_retry(
            lambda c: c.table("materials")
            .select("title, description, content_url, content_type")
            .eq("id", material_id)
            .execute()
        )
        mat_data = getattr(mat_resp, "data", [])
        if not mat_data:
            return ""
        mat = mat_data[0]
        text = f"{mat.get('title', '')} - {mat.get('description', '')}".strip()
        content_url = mat.get("content_url") or ""
        content_type = (mat.get("content_type") or "").lower()
        if content_url:
            extracted = material_text_from_url(content_url, content_type)
            if extracted:
                text = f"{text}\n{extracted}"
        return text
    except Exception as exc:
        print(f"[assignments] Could not load material content: {exc}")
        return ""


_AUTO_GEN_LOCKS = set()


def _auto_generate_for_student(admin, user):
    """Guard against concurrent auto-generation for the same student (the
    sidebar pending-count badge and the assignments page both trigger it).
    Returns [] while another request is already generating."""
    student_id = user["id"]
    if student_id in _AUTO_GEN_LOCKS:
        return []
    _AUTO_GEN_LOCKS.add(student_id)
    try:
        return _auto_generate_impl(admin, user)
    finally:
        _AUTO_GEN_LOCKS.discard(student_id)


def _auto_generate_impl(admin, user):
    """
    Creates a per-student AI assignment for every material the student has
    downloaded but does not yet have an auto-generated assignment for.
    Returns the list of newly created assignment rows (empty when none).
    """
    try:
        dl_resp = with_retry(
            lambda c: c.table("material_downloads")
            .select("material_id, course_id")
            .eq("student_id", user["id"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch downloads: {exc}")

    downloads = getattr(dl_resp, "data", []) or []
    if not downloads:
        return []

    by_material = {d["material_id"]: d["course_id"] for d in downloads}

    try:
        existing_resp = with_retry(
            lambda c: c.table("assignments")
            .select("source_material_id")
            .eq("student_id", user["id"])
            .eq("auto_generated", True)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch existing assignments: {exc}")

    existing = {a["source_material_id"] for a in (getattr(existing_resp, "data", []) or [])}

    created = []
    for material_id, course_id in by_material.items():
        if material_id in existing:
            continue
        material_text = _load_material_text(admin, material_id)
        if not material_text:
            material_text = "Standard introduction to the course concepts."

        quiz_data = quiz_ai.generate_quiz(material_content=material_text[:30000], num_objective=10, num_theory=2)
        if _is_mock_quiz(quiz_data):
            continue

        title_line = material_text.splitlines()[0] if material_text else "material"
        try:
            insert_resp = with_retry(
                lambda c: c.table("assignments").insert({
                    "course_id": course_id,
                    "title": f"Assignment: {title_line[:80]}",
                    "instructions": "Answer the questions based on the downloaded material. Objective questions are scored automatically; theory answers are graded by the AI.",
                    "auto_generated": True,
                    "source_material_id": material_id,
                    "student_id": user["id"],
                    "questions": quiz_data,
                }).execute()
            )
            created.append((getattr(insert_resp, "data", []) or [])[0])
        except Exception as exc:
            print(f"[assignments] Failed to auto-generate for material {material_id}: {exc}")

    return created


@router.post("/auto-generate", status_code=201)
def auto_generate_assignments(user=Depends(require_role("student"))):
    """
    Creates a per-student AI assignment for every material the student has
    downloaded but does not yet have an auto-generated assignment for.
    """
    admin = get_admin_client()
    created = _auto_generate_for_student(admin, user)
    return {
        "status": "success",
        "created": len(created),
        "assignments": [_sanitize_questions(a.get("questions")) for a in created],
    }


@router.get("/pending-count")
def pending_assignment_count(user=Depends(require_role("student"))):
    """
    Count of assignments the student has not yet submitted (manual ones plus
    their own auto-generated ones). Runs auto-generation first so a material
    downloaded on another page surfaces here immediately after login.
    """
    admin = get_admin_client()
    _auto_generate_for_student(admin, user)

    try:
        enroll_resp = with_retry(
            lambda c: c.table("enrollments")
            .select("course_id")
            .eq("student_id", user["id"])
            .execute()
        )
        course_ids = [e["course_id"] for e in (getattr(enroll_resp, "data", []) or []) if e.get("course_id")]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch enrollments: {exc}")

    if not course_ids:
        return {"pending_count": 0}

    try:
        assign_resp = with_retry(
            lambda c: c.table("assignments")
            .select("id, auto_generated, student_id")
            .in_("course_id", course_ids)
            .execute()
        )
        assignments = getattr(assign_resp, "data", []) or []
        visible = [
            a for a in assignments
            if not a.get("auto_generated") or a.get("student_id") == user["id"]
        ]
        if not visible:
            return {"pending_count": 0}

        assign_ids = [a["id"] for a in visible]
        subs_resp = with_retry(
            lambda c: c.table("assignment_submissions")
            .select("assignment_id")
            .eq("student_id", user["id"])
            .in_("assignment_id", assign_ids)
            .execute()
        )
        submitted = {s["assignment_id"] for s in (getattr(subs_resp, "data", []) or [])}
        pending = sum(1 for a in visible if a["id"] not in submitted)
        return {"pending_count": pending}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to count pending assignments: {exc}")


@router.get("/course/{course_id}")
def get_course_assignments(course_id: str, user=Depends(get_current_user)):
    """
    List assignments for a course.
    Students see their own submission + on-time status; lecturers/HODs see submission counts.
    """
    admin = get_admin_client()
    is_student = user["role"] == "student"
    _check_course_scope(admin, course_id, user, allow_student=True)

    try:
        resp = with_retry(
            lambda c: c.table("assignments")
            .select("id, course_id, title, instructions, due_date, week_number, created_at, auto_generated, source_material_id, student_id")
            .eq("course_id", course_id)
            .order("created_at", desc=True)
            .execute()
        )
        all_assignments = getattr(resp, "data", []) or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch assignments: {exc}")

    # Auto-generated assignments are per-student: students see shared ones plus
    # their own; lecturers/HODs only see the shared (manually created) ones.
    if is_student:
        assignments = [a for a in all_assignments if not a.get("auto_generated") or a.get("student_id") == user["id"]]
    else:
        assignments = [a for a in all_assignments if not a.get("auto_generated")]

    if not assignments:
        return {"course_id": course_id, "assignments": []}

    # Material titles for auto-generated assignments
    source_ids = [a["source_material_id"] for a in assignments if a.get("source_material_id")]
    material_titles = {}
    if source_ids:
        try:
            mres = with_retry(
                lambda c: c.table("materials").select("id, title").in_("id", source_ids).execute()
            )
            for m in getattr(mres, "data", []) or []:
                material_titles[m["id"]] = m["title"]
        except Exception:
            pass

    assignment_ids = [a["id"] for a in assignments]
    result = []

    # The questions blob (with answer keys) is needed for:
    #  - auto-generated assignments (per-student)
    #  - lecturer-created assignments with questions (shared with the class)
    questions_by_id = {}
    if is_student:
        q_ids = [
            a["id"] for a in assignments
            if (a.get("auto_generated") and a.get("student_id") == user["id"])
            or (not a.get("auto_generated") and a.get("questions"))
        ]
        if q_ids:
            try:
                qres = with_retry(
                    lambda c: c.table("assignments")
                    .select("id, questions")
                    .in_("id", q_ids)
                    .execute()
                )
                for q in getattr(qres, "data", []) or []:
                    if q.get("questions"):
                        questions_by_id[q["id"]] = q["questions"]
            except Exception:
                pass

    try:
        subs_resp = with_retry(
            lambda c: c.table("assignment_submissions")
            .select("assignment_id, student_id, content, submitted_at, score, letter_grade, feedback")
            .in_("assignment_id", assignment_ids)
            .execute()
        )
        submissions = getattr(subs_resp, "data", []) or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch submissions: {exc}")

    for a in assignments:
        row = {
            "id": a["id"],
            "course_id": a["course_id"],
            "title": a["title"],
            "instructions": a["instructions"],
            "due_date": a["due_date"],
            "week_number": a["week_number"],
            "created_at": a["created_at"],
            "auto_generated": a.get("auto_generated", False),
            "source_material_id": a.get("source_material_id"),
            "source_material_title": material_titles.get(a.get("source_material_id")),
        }
        if is_student and questions_by_id.get(a["id"]):
            row["questions"] = _sanitize_questions(questions_by_id.get(a["id"]))
        course_subs = [s for s in submissions if s["assignment_id"] == a["id"]]
        if is_student:
            mine = next((s for s in course_subs if s["student_id"] == user["id"]), None)
            row["submitted"] = mine is not None
            row["on_time"] = _is_on_time(mine.get("submitted_at"), a.get("due_date")) if mine else None
            row["submitted_at"] = mine.get("submitted_at") if mine else None
            row["score"] = mine.get("score") if mine else None
            row["letter_grade"] = mine.get("letter_grade") if mine else None
            row["feedback"] = mine.get("feedback") if mine else None
        else:
            row["submission_count"] = len(course_subs)
            row["on_time_count"] = sum(
                1 for s in course_subs if _is_on_time(s.get("submitted_at"), a.get("due_date"))
            )
        result.append(row)

    return {"course_id": course_id, "assignments": result}


def _is_on_time(submitted_at, due_date):
    """True when submitted before/on the due date. No due date → always on time."""
    if not submitted_at or not due_date:
        return True
    try:
        sub_date = str(submitted_at)[:10]
        return sub_date <= str(due_date)[:10]
    except Exception:
        return True


@router.post("/submit", status_code=201)
def submit_assignment(payload: AssignmentSubmitRequest, user=Depends(require_role("student"))):
    """Student submits an assignment; on-time status is computed automatically.
    Auto-generated assignments are AI-graded immediately (objective auto-scored,
    theory graded against the rubrics) and get a letter grade."""
    admin = get_admin_client()
    try:
        assign_resp = with_retry(
            lambda c: c.table("assignments")
            .select("course_id, due_date, auto_generated, student_id, questions, title")
            .eq("id", payload.assignment_id)
            .execute()
        )
        assignment = (getattr(assign_resp, "data", []) or [])
        if not assignment:
            raise HTTPException(status_code=404, detail="Assignment not found.")
        assignment = assignment[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch assignment: {exc}")

    _check_course_scope(admin, assignment["course_id"], user, allow_student=True)

    has_questions = bool(assignment.get("questions"))
    is_auto = bool(assignment.get("auto_generated"))
    if is_auto:
        if assignment.get("student_id") != user["id"]:
            raise HTTPException(status_code=403, detail="This assignment is not for you.")
    if has_questions and not payload.answers:
        raise HTTPException(status_code=400, detail="This assignment requires structured answers.")

    try:
        insert_payload = {
            "assignment_id": payload.assignment_id,
            "student_id": user["id"],
            "content": payload.content or "",
        }

        if has_questions:
            questions = assignment.get("questions") or {}
            correct_answers = [q["correct_answer_index"] for q in questions.get("objective", [])]
            submitted_obj = payload.answers.get("objective", []) or []
            correct = sum(
                1 for i, ans in enumerate(submitted_obj)
                if i < len(correct_answers) and ans == correct_answers[i]
            )
            objective_total = len(correct_answers)

            theory_qs = questions.get("theory", [])
            theory_answers = payload.answers.get("theory", []) or []
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

            total_weight = objective_total + len(theory_scores)
            if total_weight:
                percentage = round((correct + sum(theory_scores)) / total_weight * 100, 1)
            else:
                percentage = 0.0

            summary = graded.get("summary") or "Your theory answers were graded against the model answers."
            feedback_text = (
                f"Score {percentage}% ({letter_grade(percentage)}). "
                f"Objective: {correct}/{objective_total}. Theory: {summary}"
            )

            insert_payload["answers"] = {
                "objective": submitted_obj,
                "theory": theory_answers,
                "theory_scores": theory_scores,
                "theory_feedback": theory_feedback,
            }
            insert_payload["score"] = percentage
            insert_payload["letter_grade"] = letter_grade(percentage)
            insert_payload["feedback"] = feedback_text
            insert_payload["graded_at"] = datetime.utcnow().isoformat() + "Z"
        else:
            if not payload.content.strip():
                raise HTTPException(status_code=400, detail="Submission content cannot be empty.")

        insert_resp = with_retry(
            lambda c: c.table("assignment_submissions").insert(insert_payload).execute()
        )
        submission = (getattr(insert_resp, "data", []) or [])[0]
        response = {
            "status": "success",
            "on_time": _is_on_time(submission.get("submitted_at"), assignment.get("due_date")),
            "message": "Assignment submitted.",
        }
        if has_questions:
            response["score"] = submission.get("score")
            response["letter_grade"] = submission.get("letter_grade")
            response["feedback"] = submission.get("feedback")
            response["message"] = "Assignment submitted and graded."

            # Auto-recommend study resources when the student underperforms.
            # The query is built from the course + source material titles so the
            # semantic search pulls in related material from the whole pool.
            if percentage < RECOMMEND_THRESHOLD:
                weak_concept = "course assignment material"
                try:
                    cresp = with_retry(
                        lambda c: c.table("courses").select("title").eq("id", assignment["course_id"]).limit(1).execute()
                    )
                    cdata = getattr(cresp, "data", []) or []
                    if cdata and cdata[0].get("title"):
                        weak_concept = cdata[0]["title"]
                except Exception:
                    pass
                try:
                    mat_id = assignment.get("source_material_id")
                    if mat_id:
                        mresp = with_retry(
                            lambda c: c.table("materials").select("title").eq("id", mat_id).limit(1).execute()
                        )
                        mrows = getattr(mresp, "data", []) or []
                        if mrows and mrows[0].get("title"):
                            weak_concept = f"{weak_concept}: {mrows[0]['title']}"
                except Exception:
                    pass
                try:
                    created = record_auto_recommendation(
                        student_id=user["id"],
                        course_id=assignment["course_id"],
                        submission_id=submission.get("id"),
                        score=percentage,
                        weak_concept=weak_concept,
                    )
                    if created:
                        response["recommendations"] = created
                        response["recommended_count"] = len(created)
                except Exception as exc:
                    print(f"[assignments] Auto-recommendation skipped: {exc}")
        return response
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to submit assignment. You may have already submitted. {exc}")


@router.get("/{assignment_id}/submissions")
def get_assignment_submissions(assignment_id: str, user=Depends(require_role("lecturer", "hod"))):
    """Lecturers/HODs view all submissions for an assignment with student names."""
    admin = get_admin_client()
    try:
        assign_resp = with_retry(
            lambda c: c.table("assignments").select("id, course_id, due_date").eq("id", assignment_id).execute()
        )
        assignment = (getattr(assign_resp, "data", []) or [])
        if not assignment:
            raise HTTPException(status_code=404, detail="Assignment not found.")
        assignment = assignment[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch assignment: {exc}")

    _check_course_scope(admin, assignment["course_id"], user)

    try:
        subs_resp = with_retry(
            lambda c: c.table("assignment_submissions")
            .select("id, student_id, content, submitted_at, score, letter_grade, feedback, users!student_id(full_name)")
            .eq("assignment_id", assignment_id)
            .order("submitted_at", desc=True)
            .execute()
        )
        submissions = getattr(subs_resp, "data", []) or []
        for s in submissions:
            s["on_time"] = _is_on_time(s.get("submitted_at"), assignment.get("due_date"))
            name = s.get("users")
            if isinstance(name, dict):
                s["student_name"] = name.get("full_name")
            s.pop("users", None)
        return {"assignment_id": assignment_id, "submissions": submissions}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch submissions: {exc}")

# File: backend/app/routes/courses.py
# Purpose: Course listing and enrollment endpoints for department-specific access.

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, get_storage_client, with_retry

router = APIRouter(prefix="/api/courses", tags=["courses"])


class CourseOut(BaseModel):
    id: str
    code: str | None = None
    title: str
    lecturer_name: str | None = None
    lecturer_id: str | None = None
    level: int | None = None
    semester: str | None = None


class CatalogCourseOut(CourseOut):
    department: str | None = None


class EnrollmentRequest(BaseModel):
    student_id: str
    course_id: str


class CourseCreateRequest(BaseModel):
    title: str
    code: str
    description: str | None = None
    lecturer_id: str
    level: int | None = None
    semester: str | None = None


class CourseUpdateRequest(BaseModel):
    lecturer_id: str | None = None
    level: int | None = None
    semester: str | None = None

    class Config:
        # Allow distinguishing "field absent" from "explicitly null".
        extra = "forbid"


@router.post("/create", response_model=CourseOut)
def create_course(payload: CourseCreateRequest, user=Depends(require_role("hod"))):
    """Allow the HOD to create a course for their own department."""
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()
    try:
        lecturer_resp = with_retry(
            lambda c: c.table("users")
            .select("id, full_name, role, department")
            .eq("id", payload.lecturer_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturer: {exc}")

    lecturer_data = getattr(lecturer_resp, "data", []) or []
    if not lecturer_data:
        raise HTTPException(status_code=404, detail="Lecturer not found.")

    lecturer = lecturer_data[0]
    if lecturer.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=400, detail="Selected user is not a lecturer.")
    if lecturer.get("department") != user["department"]:
        raise HTTPException(status_code=403, detail="Lecturer must belong to the HOD's department.")

    try:
        insert_response = with_retry(
            lambda c: c.table("courses").insert({
                "code": payload.code,
                "title": payload.title,
                "description": payload.description,
                "department": user["department"],
                "lecturer_id": payload.lecturer_id,
                "level": payload.level,
                "semester": payload.semester,
            }).execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create course: {exc}")

    course_data = getattr(insert_response, "data", []) or []
    course = course_data[0] if course_data else {}
    return CourseOut(
        id=course.get("id"),
        code=course.get("code"),
        title=course.get("title"),
        lecturer_id=payload.lecturer_id,
        lecturer_name=lecturer.get("full_name"),
        level=payload.level,
        semester=payload.semester,
    )


def _get_department_course(course_id: str, department: str, admin):
    """Fetch a course row and confirm it belongs to the given department."""
    try:
        resp = with_retry(
            lambda c: c.table("courses")
            .select("id, code, title, lecturer_id, department")
            .eq("id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    rows = getattr(resp, "data", []) or []
    if not rows:
        raise HTTPException(status_code=404, detail="Course not found.")
    if rows[0].get("department") != department:
        raise HTTPException(status_code=403, detail="Course does not belong to your department.")
    return rows[0]


def _resolve_lecturer(payload_lecturer_id: str, department: str, admin):
    """Validate a lecturer id and return the user row, or 404/400/403 on failure."""
    if not payload_lecturer_id:
        return None
    try:
        lecturer_resp = with_retry(
            lambda c: c.table("users")
            .select("id, full_name, role, department")
            .eq("id", payload_lecturer_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturer: {exc}")

    lecturer_data = getattr(lecturer_resp, "data", []) or []
    if not lecturer_data:
        raise HTTPException(status_code=404, detail="Lecturer not found.")

    lecturer = lecturer_data[0]
    if lecturer.get("role") not in ("lecturer", "hod"):
        raise HTTPException(status_code=400, detail="Selected user is not a lecturer.")
    if lecturer.get("department") != department:
        raise HTTPException(status_code=403, detail="Lecturer must belong to the HOD's department.")
    return lecturer


@router.patch("/{course_id}", response_model=CourseOut)
def update_course_assignment(course_id: str, payload: CourseUpdateRequest, user=Depends(require_role("hod"))):
    """Assign or resign a lecturer on one of the HOD's courses.

    Provide a `lecturer_id` to assign (or reassign) the course to that
    lecturer; pass `lecturer_id: null` to resign the current lecturer and
    leave the course unassigned.
    """
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()
    course = _get_department_course(course_id, user["department"], admin)
    lecturer = _resolve_lecturer(payload.lecturer_id, user["department"], admin) if payload.lecturer_id else None

    # Only update the fields the caller actually provided, so a partial PATCH
    # never wipes out values the requester didn't mean to touch.
    updates = {}
    provided = payload.model_fields_set
    if "lecturer_id" in provided:
        updates["lecturer_id"] = payload.lecturer_id
    if "level" in provided:
        updates["level"] = payload.level
    if "semester" in provided:
        updates["semester"] = payload.semester

    if not updates:
        raise HTTPException(status_code=400, detail="No updatable fields provided.")

    try:
        update_response = with_retry(
            lambda c: c.table("courses")
            .update(updates)
            .eq("id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update course: {exc}")

    updated_data = getattr(update_response, "data", []) or []
    updated = updated_data[0] if updated_data else course
    return CourseOut(
        id=updated.get("id"),
        code=updated.get("code"),
        title=updated.get("title"),
        lecturer_id=updated.get("lecturer_id"),
        lecturer_name=lecturer.get("full_name") if lecturer else None,
        level=updated.get("level"),
        semester=updated.get("semester"),
    )


@router.delete("/{course_id}")
def delete_course(course_id: str, user=Depends(require_role("hod"))):
    """Delete one of the HOD's courses and everything tied to it.

    Removes the course row plus its enrollments, materials (and storage
    files), quizzes, questions, quiz results, and engagement logs so no
    orphaned rows are left behind.
    """
    if not user.get("department"):
        raise HTTPException(status_code=400, detail="HOD department is not configured.")

    admin = get_admin_client()
    course = _get_department_course(course_id, user["department"], admin)

    try:
        materials_resp = with_retry(
            lambda c: c.table("materials")
            .select("id, content_url")
            .eq("course_id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course materials: {exc}")
    material_rows = getattr(materials_resp, "data", []) or []

    try:
        quizzes_resp = with_retry(
            lambda c: c.table("quizzes")
            .select("id")
            .eq("course_id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course quizzes: {exc}")
    quiz_ids = [row["id"] for row in (getattr(quizzes_resp, "data", []) or []) if row.get("id")]

    try:
        # engagement_logs reference materials, so resolve material ids first.
        material_ids = [row["id"] for row in material_rows if row.get("id")]
        if material_ids:
            with_retry(
                lambda c: c.table("engagement_logs")
                .delete()
                .in_("material_id", material_ids)
                .execute()
            )
        if quiz_ids:
            with_retry(
                lambda c: c.table("questions")
                .delete()
                .in_("quiz_id", quiz_ids)
                .execute()
            )
            with_retry(
                lambda c: c.table("quiz_results")
                .delete()
                .in_("quiz_id", quiz_ids)
                .execute()
            )
            with_retry(
                lambda c: c.table("quizzes")
                .delete()
                .in_("id", quiz_ids)
                .execute()
            )
        with_retry(
            lambda c: c.table("materials")
            .delete()
            .eq("course_id", course_id)
            .execute()
        )
        with_retry(
            lambda c: c.table("enrollments")
            .delete()
            .eq("course_id", course_id)
            .execute()
        )
        with_retry(
            lambda c: c.table("courses")
            .delete()
            .eq("id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete course: {exc}")

    # Clean up the uploaded material files for this course in storage.
    for row in material_rows:
        content_url = row.get("content_url") or ""
        if content_url and "/materials/" in content_url:
            path = content_url.split("/materials/", 1)[-1].split("?")[0]
            if path:
                try:
                    get_storage_client().from_("materials").remove([path])
                except Exception:
                    pass

    return {"status": "ok", "message": f"Course {course.get('code') or course.get('title')} deleted."}


@router.get("/", response_model=List[CourseOut])
def list_department_courses(user=Depends(get_current_user)):
    """Return courses for the logged-in user's department.

    Every account is scoped to their own department. Accounts without a
    configured department (legacy students) see an empty catalog rather
    than every course.
    """
    department = user.get("department")
    admin = get_admin_client()
    if not department:
        return []

    try:
        lecturers = with_retry(
            lambda c: c.table("users")
            .select("id, full_name")
            .eq("department", department)
            .in_("role", ["lecturer", "hod"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturers: {exc}")

    lecturer_rows = getattr(lecturers, "data", []) or []
    lecturer_ids = [row["id"] for row in lecturer_rows if row.get("id")]
    if not lecturer_ids:
        return []

    lecturer_map = {row["id"]: row["full_name"] for row in lecturer_rows}

    try:
        courses_response = with_retry(
            lambda c: c.table("courses")
            .select("id, code, title, lecturer_id, level, semester")
            .eq("department", department)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query courses: {exc}")

    courses = getattr(courses_response, "data", []) or []
    return [
        CourseOut(
            id=course["id"],
            code=course.get("code"),
            title=course.get("title"),
            lecturer_id=course.get("lecturer_id"),
            lecturer_name=lecturer_map.get(course.get("lecturer_id")),
            level=course.get("level"),
            semester=course.get("semester"),
        )
        for course in courses
    ]


@router.get("/catalog", response_model=List[CatalogCourseOut])
def list_catalog_courses(user=Depends(get_current_user)):
    """Return the courses available to the logged-in student for browsing.

    Scoped to the student's own department so they only ever see their
    department's courses (not other departments'). Includes the department,
    academic level and semester so students can browse by level then semester.
    Accounts without a configured department (legacy students) see an empty
    catalogue rather than every course.
    """
    department = user.get("department")
    admin = get_admin_client()
    if not department:
        return []

    try:
        lecturers = with_retry(
            lambda c: c.table("users")
            .select("id, full_name")
            .eq("department", department)
            .in_("role", ["lecturer", "hod"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturers: {exc}")

    lecturer_map = {
        row["id"]: row["full_name"]
        for row in (getattr(lecturers, "data", []) or [])
        if row.get("id")
    }

    try:
        courses_response = with_retry(
            lambda c: c.table("courses")
            .select("id, code, title, department, lecturer_id, level, semester")
            .eq("department", department)
            .order("level", desc=False)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query courses: {exc}")

    courses = getattr(courses_response, "data", []) or []
    return [
        CatalogCourseOut(
            id=course["id"],
            code=course.get("code"),
            title=course.get("title"),
            department=course.get("department"),
            lecturer_id=course.get("lecturer_id"),
            lecturer_name=lecturer_map.get(course.get("lecturer_id")),
            level=course.get("level"),
            semester=course.get("semester"),
        )
        for course in courses
    ]


@router.get("/mine", response_model=List[CourseOut])
def list_my_courses(user=Depends(require_role("lecturer", "hod"))):
    """Return only courses assigned to the logged-in lecturer (or teaching HOD)."""
    admin = get_admin_client()
    try:
        courses_response = with_retry(
            lambda c: c.table("courses")
            .select("id, code, title, lecturer_id, level, semester")
            .eq("lecturer_id", user["id"])
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturer courses: {exc}")

    courses = getattr(courses_response, "data", []) or []
    return [
        CourseOut(
            id=course["id"],
            code=course.get("code"),
            title=course.get("title"),
            lecturer_id=course.get("lecturer_id"),
            lecturer_name=user.get("full_name"),
            level=course.get("level"),
            semester=course.get("semester"),
        )
        for course in courses
    ]


@router.post("/enroll")
def enroll_course(payload: EnrollmentRequest, user=Depends(get_current_user)):
    """Enroll a student into a course only if it belongs to the user's department."""
    if user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Cannot enroll another user.")

    admin = get_admin_client()
    try:
        course_resp = with_retry(lambda c: c.table("courses").select("id, lecturer_id").eq("id", payload.course_id).execute())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query course: {exc}")

    course_data = getattr(course_resp, "data", []) or []
    if not course_data:
        raise HTTPException(status_code=404, detail="Course not found.")

    lecturer_id = course_data[0].get("lecturer_id")
    if not lecturer_id:
        raise HTTPException(status_code=400, detail="Course is not assigned to a lecturer.")

    # A department is required to enroll: students must be scoped to the
    # courses of their own department.
    department = user.get("department")
    if not department:
        raise HTTPException(status_code=400, detail="Department is required before enrolling in courses.")

    try:
        lecturer_resp = with_retry(lambda c: c.table("users").select("department").eq("id", lecturer_id).execute())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query lecturer: {exc}")

    lecturer_data = getattr(lecturer_resp, "data", []) or []
    if not lecturer_data or lecturer_data[0].get("department") != department:
        raise HTTPException(status_code=403, detail="Cannot enroll in a course outside your department.")

    try:
        with_retry(lambda c: c.table("enrollments").insert({
            "student_id": payload.student_id,
            "course_id": payload.course_id,
        }).execute())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Enrollment failed: {exc}")

    return {"status": "ok", "message": "Successfully enrolled."}


@router.delete("/{course_id}/enroll")
def unenroll_course(course_id: str, user=Depends(get_current_user)):
    """Remove the logged-in student's enrollment in a course."""
    admin = get_admin_client()
    try:
        existing = with_retry(
            lambda c: c.table("enrollments")
            .select("id")
            .eq("student_id", user["id"])
            .eq("course_id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query enrollment: {exc}")

    if not (getattr(existing, "data", []) or []):
        raise HTTPException(status_code=404, detail="You are not enrolled in this course.")

    try:
        with_retry(
            lambda c: c.table("enrollments")
            .delete()
            .eq("student_id", user["id"])
            .eq("course_id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to unenroll: {exc}")

    return {"status": "ok", "message": "Successfully unenrolled."}


@router.get("/{course_id}/students")
def get_enrolled_students(course_id: str, user=Depends(require_role("lecturer", "hod"))):
    """
    Returns the list of students enrolled in a specific course.
    Lecturers can use this to see the number of students enrolled.
    """
    admin = get_admin_client()
    
    # Optional: Verify course belongs to the lecturer/HOD's department
    
    try:
        resp = with_retry(
            lambda c: c.table("enrollments")
            .select("student_id, users!student_id(full_name, email)")
            .eq("course_id", course_id)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch enrolled students: {exc}")
        
    enrollments = getattr(resp, "data", []) or []
    return {
        "course_id": course_id,
        "total_enrolled": len(enrollments),
        "students": [
            {
                "student_id": row["student_id"],
                "full_name": row["users"]["full_name"] if row.get("users") else None,
                "email": row["users"]["email"] if row.get("users") else None
            }
            for row in enrollments
        ]
    }


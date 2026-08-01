# File: backend/app/routes/courses.py
# Purpose: Course listing and enrollment endpoints for department-specific access.

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List

from app.core.security import get_current_user, require_role
from app.database import get_admin_client, with_retry

router = APIRouter(prefix="/api/courses", tags=["courses"])


class CourseOut(BaseModel):
    id: str
    code: str | None = None
    title: str
    lecturer_name: str | None = None
    lecturer_id: str | None = None


class EnrollmentRequest(BaseModel):
    student_id: str
    course_id: str


class CourseCreateRequest(BaseModel):
    title: str
    code: str
    description: str | None = None
    lecturer_id: str


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
    )


@router.get("/", response_model=List[CourseOut])
def list_department_courses(user=Depends(get_current_user)):
    """Return courses for the logged-in user's department.

    Students (and any account without a configured department) see every course;
    lecturers and HODs only see courses from their own department.
    """
    department = user.get("department")
    admin = get_admin_client()
    try:
        if department:
            lecturers = with_retry(
                lambda c: c.table("users")
                .select("id, full_name")
                .eq("department", department)
                .in_("role", ["lecturer", "hod"])
                .execute()
            )
        else:
            lecturers = with_retry(
                lambda c: c.table("users")
                .select("id, full_name")
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
        if department:
            courses_response = with_retry(
                lambda c: c.table("courses")
                .select("id, code, title, lecturer_id")
                .eq("department", department)
                .execute()
            )
        else:
            courses_response = with_retry(
                lambda c: c.table("courses")
                .select("id, code, title, lecturer_id")
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
            .select("id, code, title, lecturer_id")
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

    # Only enforce the department gate for accounts that have a department
    # (lecturers/HODs). Students are often registered without one and may
    # enroll in any course.
    department = user.get("department")
    if department:
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

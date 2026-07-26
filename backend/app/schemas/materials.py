# File: backend/app/schemas/materials.py
# Purpose: Schemas for learning materials API requests and responses.

from pydantic import BaseModel
from typing import List


class MaterialOut(BaseModel):
    id: str
    title: str
    description: str | None = None
    content_url: str
    content_type: str | None = None
    created_at: str | None = None


class MaterialCreateResponse(BaseModel):
    id: str
    title: str
    description: str | None = None
    content_url: str
    content_type: str | None = None
    course_id: str


class CourseMaterialsResponse(BaseModel):
    course_id: str
    course_title: str
    materials: List[MaterialOut]

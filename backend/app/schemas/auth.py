# File: backend/app/schemas/auth.py
# Purpose: Request/response models for the auth endpoints.

import re
from datetime import date
from typing import Optional

from pydantic import BaseModel, EmailStr, field_validator

# Roles allowed in the system (mirrors the DB CHECK constraint on users.role).
ALLOWED_ROLES = {"student", "lecturer", "hod"}

# Real-name characters only: letters, spaces, hyphens, apostrophes and dots.
# Digits and any other symbol are rejected.
NAME_REGEX = r"^[A-Za-z\s\-'.]+$"

# UENR-owned email domains. These are explicitly allowed in addition to any
# well-formed general email (gmail.com, yahoo.com, ...).
UENR_DOMAINS = {"uenr.edu.gh", "uenr.edu", "uenr.gov.gh"}

# Strong password: 8+ chars, at least one uppercase, one lowercase, one digit
# and one special character.
PASSWORD_REGEX = r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s]).{8,}$"


def _is_uenr_email(email: str) -> bool:
    """True when the email belongs to an allowed UENR domain."""
    lower = (email or "").strip().lower()
    try:
        domain = lower.split("@", 1)[1]
    except IndexError:
        return False
    return domain in UENR_DOMAINS


def _validate_email(email: str) -> str:
    """Enforce a valid email with a real domain — either a UENR address or a
    well-formed general address whose final label is a recognised TLD."""
    email = (email or "").strip()
    if not email:
        raise ValueError("Please enter your email address.")
    # Pydantic's EmailStr already checks the overall format; here we enforce
    # the domain policy on top of it.
    if _is_uenr_email(email):
        return email
    # General address: local part then a real, well-formed domain with at
    # least two labels and a recognised TLD (com, org, net, edu, gov, gh, ...).
    if not re.match(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$", email):
        raise ValueError("Please enter a valid email address with a real domain (e.g. name@domain.com).")
    if not re.search(r"\.(com|org|net|edu|gov|io|int|mil|gh|uk|us|co|ca|au|ng|za|com\.gh|edu\.gh|org\.gh|gov\.gh|co\.uk|org\.uk|ac\.uk)$", email, re.IGNORECASE):
        raise ValueError("Please enter a valid email address with a real domain (e.g. name@domain.com).")
    if ".." in email or "@@" in email:
        raise ValueError("Please enter a valid email address with a real domain (e.g. name@domain.com).")
    return email


def _validate_full_name(name: str) -> str:
    """Reject empty names and any name containing digits or symbols."""
    name = (name or "").strip()
    if not name:
        raise ValueError("Please enter your full name.")
    if not re.fullmatch(NAME_REGEX, name):
        raise ValueError("Name must contain only letters, spaces, hyphens, apostrophes or a dot — no numbers or symbols.")
    if len(name) > 100:
        raise ValueError("Name must be 100 characters or fewer.")
    return name


def _validate_password(password: str) -> str:
    """Require a strong password: 8+ chars with uppercase, lowercase, a digit
    and a special character."""
    if not password:
        raise ValueError("Please enter a password.")
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters long.")
    if not re.search(r"[a-z]", password):
        raise ValueError("Password must contain at least one lowercase letter.")
    if not re.search(r"[A-Z]", password):
        raise ValueError("Password must contain at least one uppercase letter.")
    if not re.search(r"\d", password):
        raise ValueError("Password must contain at least one number.")
    if not re.search(r"[^A-Za-z0-9\s]", password):
        raise ValueError("Password must contain at least one special character (e.g. !@#$%^&*).")
    return password


class RegisterRequest(BaseModel):
    full_name: str
    email: EmailStr
    password: str
    role: str
    department: Optional[str] = None

    _check_name = field_validator("full_name")(_validate_full_name)
    _check_email = field_validator("email")(_validate_email)
    _check_password = field_validator("password")(_validate_password)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    full_name: str
    email: str
    role: str
    department: Optional[str] = None
    avatar_url: Optional[str] = None
    date_of_birth: Optional[str] = None
    index_number: Optional[str] = None
    staff_id: Optional[str] = None
    phone: Optional[str] = None


class ProfileUpdate(BaseModel):
    """Self-served profile edits from the Settings page."""
    full_name: Optional[str] = None
    date_of_birth: Optional[str] = None  # ISO date (YYYY-MM-DD), cleared to null when empty
    index_number: Optional[str] = None   # students only
    staff_id: Optional[str] = None       # lecturers/hods only
    phone: Optional[str] = None

    @field_validator("full_name")
    @classmethod
    def _validate_profile_name(cls, v):
        if v is None:
            return v
        return _validate_full_name(v)

    @field_validator("date_of_birth")
    @classmethod
    def _validate_date_of_birth(cls, v):
        if v is None:
            return v
        dob = (v or "").strip()
        # Empty string clears the field (Settings page sends "" to unset it).
        if not dob:
            return ""
        try:
            dob_parsed = date.fromisoformat(dob)
        except ValueError:
            raise ValueError("Date of birth must be a valid date (YYYY-MM-DD).")
        if dob_parsed >= date.today():
            raise ValueError("Date of birth cannot be today or in the future.")
        if dob_parsed.year < 1900:
            raise ValueError("Date of birth is too far in the past.")
        return dob


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserOut


class RefreshRequest(BaseModel):
    refresh_token: str

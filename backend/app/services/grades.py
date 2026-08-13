# File: backend/app/services/grades.py
# Purpose: Shared letter-grade scale used across quizzes, auto-graded
# assignments, and predicted grades.

GRADE_SCALE = (
    (80, "A"),
    (75, "B+"),
    (70, "B"),
    (65, "C+"),
    (60, "C"),
    (55, "D+"),
    (50, "D"),
    (0, "F"),
)


def letter_grade(percentage):
    """Map a 0-100 percentage to a letter grade.

    A=80-100, B+=75-79, B=70-74, C+=65-69, C=60-64,
    D+=55-59, D=50-54, F=0-49.
    Returns None for a None/invalid input.
    """
    if percentage is None:
        return None
    try:
        pct = float(percentage)
    except (TypeError, ValueError):
        return None
    for threshold, grade in GRADE_SCALE:
        if pct >= threshold:
            return grade
    return "F"

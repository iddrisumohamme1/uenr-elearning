# File: backend/app/routes/micro_questions.py
# Purpose: Rule-Based Template-Driven Micro-Question Module.
#          Diagnoses conceptual gaps in real-time by generating targeted comprehension
#          checks based on the student's engagement class and current topic.
#
# Design:
#   - Engagement class 0 (At-Risk)  → easy questions   (rebuild confidence)
#   - Engagement class 1 (Moderate) → medium questions  (reinforce concepts)
#   - Engagement class 2 (High)     → hard questions    (deeper challenge)
#   - Answers are NEVER sent to the client; verified server-side via /verify.

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import io
import random
import re
import time
from collections import Counter

import httpx

from app.database import get_admin_client, with_retry
from app.core.security import get_current_user

router = APIRouter(prefix="/api/micro-questions", tags=["micro_questions"])

# ── In-memory answer store ─────────────────────────────────────────────────────
# session_id → { answer_list: [(question_text, correct_index)], topic, difficulty }
# Sessions are auto-purged after _SESSION_TTL seconds.
_answer_store: dict = {}
_SESSION_TTL = 3600  # 1 hour


def _purge_stale_sessions():
    global _answer_store
    now = time.time()
    _answer_store = {
        sid: data for sid, data in _answer_store.items()
        if now - data.get("timestamp", 0) < _SESSION_TTL
    }


# ── Question Bank ──────────────────────────────────────────────────────────────
QUESTION_BANK = {
    # ── DATABASES ──────────────────────────────────────────────────────────────
    "databases": {
        "easy": [
            {
                "question": "What does SQL stand for?",
                "options": ["Structured Query Language", "Simple Query Logic", "Sequential Queue Language", "System Query Layer"],
                "answer": 0,
                "hint": "SQL is the standard language for relational database management."
            },
            {
                "question": "Which SQL command is used to retrieve data from a table?",
                "options": ["INSERT", "SELECT", "UPDATE", "DELETE"],
                "answer": 1,
                "hint": "Think about the operation that 'reads' data."
            },
            {
                "question": "What type of database stores data in tables with rows and columns?",
                "options": ["Graph Database", "Relational Database", "Document Database", "Key-Value Store"],
                "answer": 1,
                "hint": "This is the most common type, using SQL."
            },
            {
                "question": "What does a PRIMARY KEY constraint ensure?",
                "options": ["Each row can have duplicate values", "Each row is uniquely identified", "The column can contain NULLs", "Data is automatically deleted"],
                "answer": 1,
                "hint": "No two rows can share the same primary key value."
            },
        ],
        "medium": [
            {
                "question": "What is the purpose of the Primary Key in a relational database?",
                "options": ["It speeds up query processing", "It uniquely identifies each row in a table", "It links two tables together", "It stores encrypted passwords"],
                "answer": 1,
                "hint": "Each record must have a unique identifier."
            },
            {
                "question": "In which normal form (NF) does a table need to eliminate partial dependencies?",
                "options": ["1NF", "2NF", "3NF", "BCNF"],
                "answer": 1,
                "hint": "Partial dependencies occur when non-key attributes depend on part of a composite key."
            },
            {
                "question": "What does a FOREIGN KEY do?",
                "options": ["Encrypts the column data", "Creates a link between two tables", "Prevents NULL values", "Generates unique IDs automatically"],
                "answer": 1,
                "hint": "It references the primary key of another table."
            },
            {
                "question": "Which SQL clause is used to filter rows after aggregation?",
                "options": ["WHERE", "HAVING", "GROUP BY", "ORDER BY"],
                "answer": 1,
                "hint": "WHERE filters before grouping; this clause filters after."
            },
        ],
        "hard": [
            {
                "question": "What is a B-Tree index most efficient for?",
                "options": ["Full-text search queries", "Range queries and exact lookups", "Storing large binary objects", "Aggregating hash values"],
                "answer": 1,
                "hint": "B-Trees maintain sorted order, making range operations efficient."
            },
            {
                "question": "In 3NF, a transitive dependency means:",
                "options": ["A non-key column determines another non-key column", "The primary key is a composite key", "All columns are part of the primary key", "The table has no foreign keys"],
                "answer": 0,
                "hint": "3NF eliminates dependencies where a non-key attribute depends on another non-key attribute."
            },
            {
                "question": "What is the time complexity of a B-Tree lookup?",
                "options": ["O(n)", "O(log n)", "O(n^2)", "O(1)"],
                "answer": 1,
                "hint": "B-Trees are balanced, so height grows logarithmically."
            },
        ],
    },

    # ── PROGRAMMING ────────────────────────────────────────────────────────────
    "programming": {
        "easy": [
            {
                "question": "What does a pointer store in C/C++?",
                "options": ["A value", "A memory address", "A function", "A string"],
                "answer": 1,
                "hint": "Pointers are variables that point to a location in memory."
            },
            {
                "question": "Which data structure follows Last-In-First-Out (LIFO)?",
                "options": ["Queue", "Stack", "Linked List", "Tree"],
                "answer": 1,
                "hint": "Think of a stack of plates."
            },
            {
                "question": "What does the 'return' keyword do in a function?",
                "options": ["Loops back to the start", "Sends a value back to the caller", "Terminates the program", "Declares a variable"],
                "answer": 1,
                "hint": "It passes the result back to where the function was called."
            },
        ],
        "medium": [
            {
                "question": "What is the time complexity of binary search?",
                "options": ["O(n)", "O(n^2)", "O(log n)", "O(1)"],
                "answer": 2,
                "hint": "Binary search halves the search space with each step."
            },
            {
                "question": "In object-oriented programming, what is polymorphism?",
                "options": ["An object having multiple states", "The ability of different objects to respond to the same interface", "A way to hide implementation details", "Creating copies of objects"],
                "answer": 1,
                "hint": "Think about how the same method name can behave differently."
            },
            {
                "question": "What is the purpose of a hash table?",
                "options": ["To sort elements in order", "To provide O(1) average-case lookups", "To store hierarchical data", "To prevent duplicate entries only"],
                "answer": 1,
                "hint": "Hash functions map keys directly to storage locations."
            },
            {
                "question": "What is recursion?",
                "options": ["A loop that never terminates", "A function that calls itself", "A way to allocate memory dynamically", "A sorting algorithm"],
                "answer": 1,
                "hint": "The function solves a smaller instance of the same problem."
            },
        ],
        "hard": [
            {
                "question": "In Dijkstra's shortest path algorithm, what data structure minimizes the time complexity?",
                "options": ["Queue", "Stack", "Min-Heap (Priority Queue)", "Linked List"],
                "answer": 2,
                "hint": "The key operation is always extracting the node with minimum distance."
            },
            {
                "question": "What is the time complexity of quicksort in the average case?",
                "options": ["O(n)", "O(n log n)", "O(n^2)", "O(log n)"],
                "answer": 1,
                "hint": "Each partition roughly halves the array."
            },
            {
                "question": "In concurrent programming, what is a race condition?",
                "options": ["Two processes competing for CPU time", "The output depends on the timing of uncontrollable events", "A deadlock between two threads", "Memory being allocated twice"],
                "answer": 1,
                "hint": "When timing affects correctness, you have a race condition."
            },
        ],
    },

    # ── MACHINE LEARNING ───────────────────────────────────────────────────────
    "machine_learning": {
        "easy": [
            {
                "question": "Which of the following is a supervised learning algorithm?",
                "options": ["K-Means Clustering", "Linear Regression", "PCA", "DBSCAN"],
                "answer": 1,
                "hint": "Supervised learning requires labeled training data."
            },
            {
                "question": "What is the goal of a classification model?",
                "options": ["Predict a continuous number", "Assign input data to predefined categories", "Reduce the number of features", "Generate new data samples"],
                "answer": 1,
                "hint": "Classification maps inputs to discrete labels."
            },
        ],
        "medium": [
            {
                "question": "What is the purpose of the activation function in a neural network?",
                "options": ["To normalize input data", "To introduce non-linearity so the network can learn complex patterns", "To reduce overfitting", "To optimize the learning rate"],
                "answer": 1,
                "hint": "Without this, a deep neural network would behave like a linear model."
            },
            {
                "question": "What is overfitting in machine learning?",
                "options": ["Model performs well on both training and test data", "Model learns noise in training data and fails on unseen data", "Model is too simple to capture patterns", "Model takes too long to train"],
                "answer": 1,
                "hint": "The model memorizes the training set instead of generalizing."
            },
            {
                "question": "What does the 'learning rate' control in gradient descent?",
                "options": ["How many epochs to train", "The step size when updating model weights", "The number of hidden layers", "The batch size for training"],
                "answer": 1,
                "hint": "Too large and you overshoot; too small and training is slow."
            },
        ],
        "hard": [
            {
                "question": "In XGBoost, what technique is used to prevent overfitting?",
                "options": ["Dropout layers", "L1 and L2 regularization on leaf weights", "Data augmentation", "Batch normalization"],
                "answer": 1,
                "hint": "XGBoost's objective function includes a regularization term."
            },
            {
                "question": "What is the vanishing gradient problem?",
                "options": ["Gradients become too large and explode", "Gradients shrink toward zero in deep networks, stalling learning", "The loss function has no gradient", "Data gradients are unevenly distributed"],
                "answer": 1,
                "hint": "Backpropagated signals get smaller through many layers."
            },
            {
                "question": "In a Two-Tower neural network, what is the primary advantage of separate towers?",
                "options": ["They use less memory", "Each tower can learn a different feature space before combining", "They eliminate the need for backpropagation", "They always outperform single-tower models"],
                "answer": 1,
                "hint": "Different input types benefit from separate representation learning."
            },
        ],
    },

    # ── SOFTWARE ENGINEERING ───────────────────────────────────────────────────
    "software_engineering": {
        "easy": [
            {
                "question": "What does version control track?",
                "options": ["Only the final version of files", "Changes to files over time", "Only binary files", "Only database records"],
                "answer": 1,
                "hint": "It records the history of all modifications."
            },
            {
                "question": "What is an API?",
                "options": ["A programming interface", "A set of rules for software components to communicate", "A type of database", "A testing framework"],
                "answer": 1,
                "hint": "API stands for Application Programming Interface."
            },
        ],
        "medium": [
            {
                "question": "What is the main benefit of continuous integration (CI)?",
                "options": ["It replaces manual testing entirely", "It detects integration issues early through automated builds and tests", "It eliminates the need for code reviews", "It only works for front-end code"],
                "answer": 1,
                "hint": "CI catches bugs before they reach production."
            },
            {
                "question": "In REST API design, what does the HTTP PUT method do?",
                "options": ["Creates a new resource", "Partially updates an existing resource", "Replaces an existing resource entirely", "Deletes a resource"],
                "answer": 2,
                "hint": "PUT is idempotent - it replaces the full resource."
            },
            {
                "question": "What is a design pattern?",
                "options": ["A CSS styling technique", "A reusable solution to a common software design problem", "A type of database schema", "A debugging tool"],
                "answer": 1,
                "hint": "Patterns like Singleton, Observer, and Factory are well-known examples."
            },
        ],
        "hard": [
            {
                "question": "What is the SOLID principle of Dependency Inversion?",
                "options": ["High-level modules should depend on low-level modules", "Abstractions should not depend on details; details should depend on abstractions", "Classes should be open for extension but closed for modification", "A class should have only one reason to change"],
                "answer": 1,
                "hint": "This is the 'D' in SOLID - it inverts the traditional dependency direction."
            },
            {
                "question": "What is the CAP theorem in distributed systems?",
                "options": ["A system can guarantee Consistency, Availability, and Partition tolerance simultaneously", "A distributed system can guarantee at most two of Consistency, Availability, and Partition tolerance", "Partition tolerance is always optional", "Consistency is never achievable in distributed systems"],
                "answer": 1,
                "hint": "You must choose trade-offs when the network partitions."
            },
        ],
    },

    # ── FORMAL METHODS ─────────────────────────────────────────────────────────
    "formal_methods": {
        "easy": [
            {
                "question": "What is formal specification?",
                "options": ["Writing code without comments", "Using mathematical notation to precisely define system behavior", "Creating UML diagrams", "Testing software with formal test cases"],
                "answer": 1,
                "hint": "Formal methods use mathematical rigor to specify requirements."
            },
            {
                "question": "Which of these is a formal specification language?",
                "options": ["Python", "Z Notation", "HTML", "CSS"],
                "answer": 1,
                "hint": "Z is a formal specification language based on set theory."
            },
        ],
        "medium": [
            {
                "question": "What is model checking?",
                "options": ["Running unit tests on a model", "Systematically exploring all states of a finite-state model to verify properties", "Training a machine learning model", "Checking database integrity"],
                "answer": 1,
                "hint": "It exhaustively checks whether a model satisfies a temporal logic formula."
            },
            {
                "question": "What is the difference between verification and validation?",
                "options": ["They are the same thing", "Verification asks 'Are we building the product right?'; Validation asks 'Are we building the right product?'", "Verification is for hardware; validation is for software", "Verification uses tests; validation uses proofs"],
                "answer": 1,
                "hint": "One checks conformance to spec; the other checks fitness for purpose."
            },
        ],
        "hard": [
            {
                "question": "In temporal logic, what does 'always eventually P' mean?",
                "options": ["P is true in the initial state only", "P is true right now", "P will be true infinitely often", "P is never true"],
                "answer": 2,
                "hint": "This property ensures P occurs repeatedly, not just once."
            },
            {
                "question": "What is a weakest precondition in program verification?",
                "options": ["The strongest condition under which a program fails", "The least restrictive condition that guarantees a postcondition holds", "A condition that is always false", "The initial state of a program"],
                "answer": 1,
                "hint": "It gives the minimum requirements for a program to be correct."
            },
        ],
    },

    # ── GENERAL (CS fundamentals) ─────────────────────────────────────────────
    "general": {
        "easy": [
            {
                "question": "Which protocol is used for secure data transmission over the internet?",
                "options": ["HTTP", "FTP", "HTTPS", "SMTP"],
                "answer": 2,
                "hint": "The 'S' stands for Secure."
            },
            {
                "question": "What does CPU stand for?",
                "options": ["Central Processing Unit", "Computer Personal Unit", "Central Program Utility", "Core Processing Unit"],
                "answer": 0,
                "hint": "It's the 'brain' of the computer."
            },
        ],
        "medium": [
            {
                "question": "What is the difference between a process and a thread in an operating system?",
                "options": ["A process is lighter; a thread uses more memory", "A process is an independent program; threads share the process memory space", "They are identical concepts with different names", "Threads are faster but cannot run in parallel"],
                "answer": 1,
                "hint": "Think about memory isolation versus sharing."
            },
            {
                "question": "What is the purpose of an operating system's virtual memory?",
                "options": ["To increase physical RAM capacity", "To use disk space as an extension of RAM", "To encrypt all data in memory", "To prevent multiple programs from running"],
                "answer": 1,
                "hint": "It allows programs to use more memory than physically available."
            },
        ],
        "hard": [
            {
                "question": "In the CAP theorem, which two properties can a distributed system guarantee simultaneously?",
                "options": ["Consistency and Availability always", "Any two of: Consistency, Availability, Partition Tolerance", "Only Partition Tolerance and one other", "All three simultaneously in modern systems"],
                "answer": 1,
                "hint": "CAP states you can only fully guarantee 2 of the 3 properties."
            },
            {
                "question": "What is the difference between concurrency and parallelism?",
                "options": ["They are the same concept", "Concurrency is handling multiple tasks at once; parallelism is executing multiple tasks at once", "Parallelism is only possible on multi-core CPUs", "Concurrency requires threads; parallelism requires processes"],
                "answer": 1,
                "hint": "Concurrency is about structure; parallelism is about execution."
            },
        ],
    },
}

# Map engagement class to difficulty
DIFFICULTY_MAP = {
    0: "easy",
    1: "medium",
    2: "hard",
}

# ── Content-aware question generation ─────────────────────────────────────────
# When the material the student is viewing is a readable PDF, questions are
# generated from the material's actual sentences (cloze style) so the checks
# reflect the content being studied. The static QUESTION_BANK remains the
# fallback when no text can be extracted (videos, image-only PDFs, etc.).

_FALLBACK_TERMS = [
    "Algorithm", "Database", "Compilation", "Recursion", "Encryption",
    "Protocol", "Framework", "Interface", "Compiler", "Neural Network",
    "Data Structure", "Gradient Descent", "Sorting", "Query", "Concurrency",
    "Abstraction", "Polymorphism", "Encapsulation", "Syntax", "Iteration",
    "Authentication", "Normalization", "Latency", "Throughput", "Semantics",
]

_STOPWORDS = {
    "about", "above", "after", "again", "against", "also", "been",
    "before", "being", "below", "between", "both", "could", "does",
    "doing", "during", "each", "else", "from", "have", "having",
    "here", "into", "just", "like", "more", "most", "much", "must",
    "only", "other", "over", "same", "should", "such", "than", "that",
    "their", "them", "then", "there", "these", "they", "this", "those",
    "through", "under", "using", "very", "were", "what", "when", "where",
    "which", "while", "with", "would", "your", "its", "you", "are",
    "not", "will", "can", "all", "any", "was", "has", "may", "also",
}

_ALNUM_RE = re.compile(r"[A-Za-z][A-Za-z0-9'+\-]*")
_PHRASE_RE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")


def _fetch_material_content(content_url: str) -> bytes | None:
    """Download a material file from Supabase storage."""
    if not content_url:
        return None
    try:
        with httpx.Client(timeout=30, follow_redirects=True, verify=False) as client:
            r = client.get(content_url)
            r.raise_for_status()
            return r.content
    except Exception as exc:
        print(f"[micro-questions] Failed to download material: {exc}")
        return None


def _extract_pdf_text(content: bytes) -> str:
    """Extract readable text from a PDF byte stream."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(content))
        pages = []
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if text:
                pages.append(text)
        return re.sub(r"\s+", " ", " ".join(pages)).strip()
    except Exception as exc:
        print(f"[micro-questions] PDF text extraction failed: {exc}")
        return ""


def _is_content_word(word: str) -> bool:
    return len(word) >= 4 and word.lower() not in _STOPWORDS


def _rank_key_terms(text: str) -> list:
    """Return [(display_term, count)] ordered rarest/longest first."""
    tokens = _ALNUM_RE.findall(text)
    word_counts = Counter(t.lower() for t in tokens if _is_content_word(t))

    term_counts: dict = {}
    term_display: dict = {}

    for w_lower, count in word_counts.items():
        if count >= 2 or len(w_lower) >= 7:
            term_counts[w_lower] = count
            term_display[w_lower] = w_lower.title()

    for m in _PHRASE_RE.finditer(text):
        key = m.group(0).lower()
        term_counts[key] = term_counts.get(key, 0) + 1
        term_display[key] = m.group(0)

    ranked = sorted(term_counts.items(), key=lambda kv: (kv[1], -len(kv[0])))
    return [(term_display[k], count) for k, count in ranked]


def _in_sentence(term: str, sentence: str) -> bool:
    return re.search(r"\b" + re.escape(term) + r"\b", sentence, re.IGNORECASE) is not None


def _blank_term(sentence: str, term: str) -> str:
    pattern = re.compile(r"\b" + re.escape(term) + r"\b", re.IGNORECASE)
    return pattern.sub("______", sentence, count=1)


def _pick_term_for_difficulty(sent_terms: list, difficulty: str) -> str:
    # sent_terms are rarest-first; hard blanks a rare term, easy a common one.
    if difficulty == "easy":
        return sent_terms[-1]
    if difficulty == "hard":
        return sent_terms[0]
    return sent_terms[len(sent_terms) // 2]


def _build_options(blank: str, sentence: str, ranked_terms: list) -> list:
    distractors = []
    for display, _count in ranked_terms:
        if len(distractors) >= 3:
            break
        if display.lower() == blank.lower():
            continue
        if _in_sentence(display, sentence):
            continue
        if display not in distractors:
            distractors.append(display)
    for term in _FALLBACK_TERMS:
        if len(distractors) >= 3:
            break
        if term.lower() != blank.lower() and term not in distractors:
            distractors.append(term)

    options = [blank] + distractors[:3]
    random.shuffle(options)
    return options


def _generate_questions_from_text(text: str, num: int, difficulty: str) -> list:
    """Generate cloze (fill-in-the-blank) MCQs from the material's own sentences."""
    text = re.sub(r"\s+", " ", text).strip()[:30000]
    if len(text) < 60:
        return []

    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text)]
    candidates = []
    for s in sentences:
        tokens = _ALNUM_RE.findall(s)
        content_words = [t for t in tokens if _is_content_word(t)]
        if len(content_words) < 3:
            continue
        if 8 <= len(tokens) <= 40:
            candidates.append(s)

    if not candidates:
        return []

    ranked = _rank_key_terms(text)
    if not ranked:
        return []

    questions = []
    for sentence in candidates:
        if len(questions) >= num:
            break
        sent_terms = [d for d, _c in ranked if _in_sentence(d, sentence)]
        if not sent_terms:
            continue
        blank = _pick_term_for_difficulty(sent_terms, difficulty)
        cloze = _blank_term(sentence, blank)
        if len(cloze) < 15:
            continue
        options = _build_options(blank, sentence, ranked)
        if len(set(o.lower() for o in options)) < 4:
            continue
        questions.append({
            "question": f"Complete the sentence: \"{cloze}\"",
            "options": options,
            "answer": options.index(blank),
            "hint": "This key term appears in the material you are currently reading.",
        })
    return questions


class MicroQuestionRequest(BaseModel):
    student_id: str
    engagement_class: int
    num_questions: Optional[int] = 3
    course_id: Optional[str] = None
    material_id: Optional[str] = None
    material_title: Optional[str] = ""
    material_description: Optional[str] = ""


class MicroQuestionResponse(BaseModel):
    student_id: str
    topic: str
    difficulty: str
    session_id: str
    source: str = "bank"
    questions: List[dict]


class AnswerItem(BaseModel):
    question_index: int
    selected_option: int


class VerifyRequest(BaseModel):
    student_id: str
    session_id: str
    answers: List[AnswerItem]


@router.post("/generate", response_model=MicroQuestionResponse)
def generate_micro_questions(payload: MicroQuestionRequest, user=Depends(get_current_user)):
    """
    Generates micro-questions based on:
    - Engagement class 0 (At-Risk)  -> easy   questions (rebuild confidence)
    - Engagement class 1 (Moderate) -> medium questions (reinforce concepts)
    - Engagement class 2 (High)     -> hard   questions (deeper challenge)

    Fetches the actual material and course content from Supabase to generate
    questions targeted to the specific material being viewed.
    """
    # Students can only generate micro-questions for themselves
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only generate questions for their own sessions.")

    _purge_stale_sessions()

    if payload.engagement_class not in [0, 1, 2]:
        raise HTTPException(status_code=400, detail="engagement_class must be 0, 1, or 2.")

    difficulty = DIFFICULTY_MAP[payload.engagement_class]
    num = max(1, min(payload.num_questions or 3, 5))

    # Fetch material and course content from Supabase for targeted questions
    material_text = ""
    topic = "general"
    content_url = ""
    content_type = ""
    extracted_text = ""

    try:
        admin = get_admin_client()

        # Fetch material details (including the stored file so we can read its text)
        if payload.material_id:
            mat_resp = with_retry(
                lambda c: c.table("materials")
                .select("title, description, content_url, content_type, course_id")
                .eq("id", payload.material_id)
                .execute()
            )
            mat_data = getattr(mat_resp, "data", []) or []
            if mat_data:
                mat = mat_data[0]
                material_text = f"{mat.get('title', '')} {mat.get('description', '')}".strip()
                content_url = mat.get("content_url") or ""
                content_type = (mat.get("content_type") or "").lower()
                payload.course_id = payload.course_id or mat.get("course_id")

        # Fetch course details
        if payload.course_id:
            course_resp = with_retry(
                lambda c: c.table("courses").select("title, department").eq("id", payload.course_id).execute()
            )
            course_data = getattr(course_resp, "data", []) or []
            if course_data:
                course = course_data[0]
                material_text = f"{course.get('title', '')} {material_text}".strip()

        # Also use frontend-provided text
        if payload.material_title:
            material_text = f"{material_text} {payload.material_title}".strip()
        if payload.material_description:
            material_text = f"{material_text} {payload.material_description}".strip()

        # Download the actual material file and extract its text.
        if content_url:
            raw = _fetch_material_content(content_url)
            if raw:
                if "pdf" in content_type:
                    extracted_text = _extract_pdf_text(raw)
                elif "text" in content_type:
                    try:
                        extracted_text = raw.decode("utf-8", errors="ignore").strip()
                    except Exception:
                        extracted_text = ""

    except Exception as e:
        print(f"[micro-questions] Could not fetch material/course data: {e}")
        material_text = f"{payload.material_title} {payload.material_description}".strip()

    # Detect topic from the material content (extracted text is the richest signal).
    topic = _detect_topic_from_content(f"{material_text} {extracted_text}".lower()[:4000])

    # Prefer questions generated from the material's actual content.
    generated = _generate_questions_from_text(extracted_text, num, difficulty) if extracted_text else []

    if generated:
        selected = generated
        source = "content"
    else:
        pool = QUESTION_BANK[topic].get(difficulty, [])

        if len(pool) < num:
            all_questions = []
            for diff_tier in ["easy", "medium", "hard"]:
                all_questions.extend(QUESTION_BANK[topic].get(diff_tier, []))
            pool = all_questions

        if not pool:
            raise HTTPException(status_code=404, detail=f"No questions found for topic '{topic}'.")

        selected = random.sample(pool, min(num, len(pool)))
        source = "bank"

    # Store correct answers server-side as ordered list
    session_id = f"mq_{payload.student_id}_{int(time.time() * 1000)}"
    _answer_store[session_id] = {
        "answer_list": [(q["question"], q["answer"]) for q in selected],
        "topic": topic,
        "difficulty": difficulty,
        "timestamp": time.time(),
        "material_id": payload.material_id,
        "course_id": payload.course_id,
        "engagement_class": payload.engagement_class,
        "source": source,
    }

    # Strip 'answer' field before sending to client
    safe_questions = [
        {"index": idx, "question": q["question"], "options": q["options"], "hint": q["hint"]}
        for idx, q in enumerate(selected)
    ]

    return MicroQuestionResponse(
        student_id=payload.student_id,
        topic=topic,
        difficulty=difficulty,
        session_id=session_id,
        source=source,
        questions=safe_questions,
    )


def _detect_topic_from_content(text: str) -> str:
    """Detect topic from material title and description."""
    if any(kw in text for kw in ["database", "sql", "dbms", "relational", "mongo", "normalization", "table", "query"]):
        return "databases"
    if any(kw in text for kw in ["program", "code", "algorithm", "data structure", "java", "python", "c++", "software", "function", "variable"]):
        return "programming"
    if any(kw in text for kw in ["machine learn", "deep learn", "neural", "ai ", "artificial", "ml ", "tensorflow", "model", "training"]):
        return "machine_learning"
    if any(kw in text for kw in ["design pattern", "api", "rest", "ci/cd", "testing", "agile", "version control", "git"]):
        return "software_engineering"
    if any(kw in text for kw in ["formal", "specification", "verification", "validation", "model check", "temporal logic"]):
        return "formal_methods"
    return "general"


@router.post("/verify")
def verify_answers(payload: VerifyRequest, user=Depends(get_current_user)):
    """
    Verifies student answers server-side. Returns per-question correctness
    and an overall score. Results are persisted to micro_question_results.
    """
    # Students can only verify their own sessions
    if user.get("role") == "student" and user["id"] != payload.student_id:
        raise HTTPException(status_code=403, detail="Students can only verify their own sessions.")

    _purge_stale_sessions()

    session = _answer_store.get(payload.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session expired or invalid.")

    answer_list = session.get("answer_list", [])
    results = []
    correct_count = 0

    for ans in payload.answers:
        if 0 <= ans.question_index < len(answer_list):
            _, correct_idx = answer_list[ans.question_index]
            is_correct = ans.selected_option == correct_idx
            if is_correct:
                correct_count += 1
            results.append({
                "question_index": ans.question_index,
                "correct": is_correct,
                "correct_option": correct_idx,
            })
        else:
            results.append({"question_index": ans.question_index, "correct": False, "correct_option": -1})

    total = len(payload.answers)
    score = round(correct_count / max(total, 1) * 100)

    # Persist the result so lecturers can review comprehension performance.
    try:
        with_retry(lambda c: c.table("micro_question_results").insert({
            "student_id": payload.student_id,
            "course_id": session.get("course_id"),
            "material_id": session.get("material_id"),
            "session_id": payload.session_id,
            "topic": session.get("topic", "general"),
            "difficulty": session.get("difficulty", "medium"),
            "source": session.get("source", "bank"),
            "total": total,
            "correct": correct_count,
            "score": score,
            "engagement_class": session.get("engagement_class"),
        }).execute())
    except Exception as e:
        print(f"[micro-questions] Could not persist result: {e}")

    _answer_store.pop(payload.session_id, None)

    if score >= 80:
        recommendation = "Excellent! You have a strong grasp of this material."
    elif score >= 50:
        recommendation = "Good effort. Review the topics you missed and try again."
    else:
        recommendation = "Keep practicing. Consider reviewing the course materials for this topic."

    return {
        "student_id": payload.student_id,
        "topic": session.get("topic", "general"),
        "difficulty": session.get("difficulty", "medium"),
        "total": total,
        "correct": correct_count,
        "score": score,
        "results": results,
        "recommendation": recommendation,
    }


@router.get("/topics")
def list_topics():
    """Returns the available question topics."""
    return {"topics": list(QUESTION_BANK.keys())}

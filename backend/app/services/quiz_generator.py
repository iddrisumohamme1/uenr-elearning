# File: backend/app/services/quiz_generator.py
# Purpose: AI integration for generating quizzes from course material.
# Prefers Groq (OpenAI-compatible) when GROQ_API_KEY is set,
# otherwise falls back to the Google Gemini API (google-genai SDK).

import json
import re

import httpx
from google import genai

from app.core.config import settings

GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions"


class QuizGeneratorService:
    def __init__(self):
        self.api_key = settings.GEMINI_API_KEY
        self.model = settings.GEMINI_MODEL or "gemini-3.6-flash"
        self.groq_key = settings.GROQ_API_KEY
        self.groq_model = settings.GROQ_MODEL or "llama-3.3-70b-versatile"
        if self.api_key:
            self.client = genai.Client(api_key=self.api_key)
        else:
            self.client = None

    @property
    def _available(self) -> bool:
        """True when at least one AI provider is configured."""
        return bool(self.groq_key) or self.client is not None

    def _complete(self, user_content: str) -> str:
        """Return the model's text output for ``user_content`` ("" on failure)."""
        if self._uses_groq:
            return self._groq_complete(user_content)
        return self._gemini_complete(user_content)

    @property
    def _uses_groq(self) -> bool:
        return bool(self.groq_key)

    def _gemini_complete(self, user_content: str) -> str:
        if not self.client:
            return ""
        try:
            response = self.client.models.generate_content(
                model=self.model,
                contents=user_content,
            )
            return (response.text or "").strip()
        except Exception as e:
            print(f"[AI] Gemini error: {e}")
            return ""

    def _groq_complete(self, user_content: str) -> str:
        try:
            resp = httpx.post(
                GROQ_BASE,
                headers={
                    "Authorization": f"Bearer {self.groq_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.groq_model,
                    "messages": [{"role": "user", "content": user_content}],
                    "temperature": 0.4,
                },
                timeout=90,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            return (content or "").strip()
        except Exception as e:
            print(f"[AI] Groq error: {e}")
            return ""

    def generate_quiz(self, material_content: str, num_objective: int = 5, num_theory: int = 2) -> dict:
        """
        Generates a quiz (objective + theory) from the provided material text
        using the configured AI provider.
        """
        if not self._available:
            # Fallback mock for testing if no key is provided
            return self._mock_quiz(num_objective, num_theory)

        prompt = f"""
        You are an expert academic instructor. I will provide you with the text of a course material.
        Your task is to generate a quiz based ONLY on this material. 
        
        The quiz must include:
        1. {num_objective} objective (multiple-choice) questions.
        2. {num_theory} theory (short answer) questions.

        You MUST return ONLY a raw JSON object with the following schema:
        {{
            "objective": [
                {{
                    "question": "Question text...",
                    "options": ["A", "B", "C", "D"],
                    "correct_answer_index": 0
                }}
            ],
            "theory": [
                {{
                    "question": "Theory question text...",
                    "suggested_answer_rubric": "Key points that should be in the answer."
                }}
            ]
        }}

        Do NOT include any markdown formatting like ```json or anything outside the JSON object.

        Course Material:
        {material_content}
        """

        for attempt in range(2):
            result_text = self._complete(prompt)
            if not result_text:
                if attempt == 0:
                    prompt = prompt + (
                        f"\n\nIMPORTANT: Return ONLY valid JSON with exactly "
                        f"{num_objective} objective and {num_theory} theory questions."
                    )
                    continue
                break

            try:
                quiz = self._extract_json(result_text)
                if not isinstance(quiz, dict):
                    quiz = {}
                quiz.setdefault("objective", [])
                quiz.setdefault("theory", [])

                # The model sometimes drops the theory block. Retry once,
                # explicitly demanding the missing questions.
                if attempt == 0 and (
                    len(quiz["objective"]) < num_objective or not quiz["theory"]
                ):
                    prompt = prompt + (
                        f"\n\nIMPORTANT: The previous output was incomplete. You MUST return "
                        f"exactly {num_objective} objective questions and exactly "
                        f"{num_theory} theory (short-answer) questions in the requested JSON "
                        f"schema. Do not omit the theory array."
                    )
                    continue

                return quiz

            except Exception as e:
                print(f"[AI] Error parsing quiz: {e}")
                if attempt == 0:
                    prompt = prompt + (
                        f"\n\nIMPORTANT: Return ONLY valid JSON with exactly "
                        f"{num_objective} objective and {num_theory} theory questions."
                    )
                    continue

        return self._mock_quiz(num_objective, num_theory)

    @staticmethod
    def _clean_fences(text: str) -> str:
        """Strip markdown code fences a model may wrap its JSON in."""
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        return text.strip()

    @staticmethod
    def _extract_json(text: str):
        """Best-effort parse of a JSON object that may have extra prose around it."""
        text = QuizGeneratorService._clean_fences(text)
        try:
            return json.loads(text)
        except Exception:
            pass
        for open_ch, close_ch in (("{", "}"), ("[", "]")):
            start = text.find(open_ch)
            end = text.rfind(close_ch)
            if start != -1 and end > start:
                try:
                    return json.loads(text[start : end + 1])
                except Exception:
                    continue
        raise ValueError("No valid JSON found in model output")

    def grade_theory(self, items) -> dict:
        """
        Grade short-answer theory responses against their marking rubrics
        using the configured AI provider.

        items: list of {"question", "answer", "rubric"}.
        Returns {"scores": [0..1 ...], "feedback": [...], "average": float}
        """
        if not self._available or not items:
            return self._fallback_theory_grade(items)

        payload = [
            {
                "question": it.get("question", ""),
                "answer": it.get("answer", ""),
                "rubric": it.get("rubric", ""),
            }
            for it in items
        ]

        prompt = f"""
        You are a strict but fair academic marker. Grade each student answer against
        its marking rubric.

        Return ONLY a JSON object:
        {{"results": [{{"score": 0.0, "feedback": "..."}}, ...]}}

        - "score" is a number from 0 to 1 (0 = no marks, 1 = full marks). Use partial
          credit such as 0.3, 0.5 or 0.75 where the answer is partially correct.
        - "feedback" is 1-2 sentences explaining the mark and what was missing.
        - Provide exactly one result per question, in the same order.

        Questions, answers and rubrics:
        {json.dumps(payload, ensure_ascii=False)}
        """

        scores = [0.0] * len(items)
        feedback = [""] * len(items)

        text = self._complete(prompt)
        if not text:
            return self._fallback_theory_grade(items)

        try:
            data = self._extract_json(text)
            results = data.get("results", [])
            for i, r in enumerate(results[: len(items)]):
                try:
                    sc = float(r.get("score", 0))
                    scores[i] = max(0.0, min(1.0, sc))
                except Exception:
                    scores[i] = 0.5
                feedback[i] = str(r.get("feedback", ""))
        except Exception as e:
            print(f"[AI] Error parsing theory grades: {e}")
            return self._fallback_theory_grade(items)

        # Hard rule: an unanswered theory question can never earn marks, no
        # matter what the AI returned. This guarantees a blank answer reduces
        # the student's overall percentage.
        for i, it in enumerate(items):
            if not (it.get("answer") or "").strip():
                scores[i] = 0.0
                feedback[i] = "No answer given. The question was left unanswered, so no marks were awarded."

        avg = round(sum(scores) / len(scores), 3) if scores else 0.0
        return {"scores": scores, "feedback": feedback, "average": avg}

    def _fallback_theory_grade(self, items):
        """Rubric-free fallback when AI grading is unavailable."""
        scores, feedback = [], []
        for it in items:
            answer = (it.get("answer") or "").strip()
            scores.append(0.5 if answer else 0.0)
            feedback.append(
                "Partial credit for your attempt; review against the rubric."
                if answer
                else "No answer given."
            )
        avg = round(sum(scores) / len(scores), 3) if scores else 0.0
        return {"scores": scores, "feedback": feedback, "average": avg}

    def generate_resource(self, material_content: str, resource_type: str) -> str:
        """
        Generates a study resource (summary, key points or practice questions)
        from a course material's text. Returns plain text ready to be published.
        """
        if not self._available:
            return ""

        prompts = {
            "summary": (
                "Write a concise but complete study summary of this course material. "
                "Structure it with clear section headings, explain every core concept in "
                "simple student-friendly language, and end with a short 'Key takeaways' list."
            ),
            "key_points": (
                "Extract the key points of this course material as a structured revision sheet. "
                "Use a bullet list of the most important concepts, terms and definitions. "
                "Keep each bullet to one clear idea and order them by importance."
            ),
            "practice_questions": (
                "Create 5 practice questions based on this course material to help a student "
                "check their understanding. Mix objective and short-answer questions. "
                "Label each question Q1..Q5, and after each question provide the correct answer "
                "or a model answer with the key points a marker should look for."
            ),
        }
        instruction = prompts.get(resource_type, prompts["summary"])

        prompt = f"""
        You are an expert academic instructor preparing extra study material for students.
        {instruction}

        Return ONLY the study material as plain text with no introductory or closing commentary.

        Course Material:
        {material_content}
        """

        text = self._complete(prompt)
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        return text

    def ask_tutor(self, question: str, material_context: str = "") -> str:
        """
        Answers a student's question with a tutoring-style explanation. When
        ``material_context`` is provided the answer is grounded in that course
        material. Returns plain text, or "" if the AI is unavailable.
        """
        if not self._available:
            return ""

        if material_context and material_context.strip():
            prompt = f"""
            You are a helpful university tutor. A student is asking a question related
            to a course. Answer clearly and concisely in student-friendly language.

            Answer using ONLY the course material below when it covers the topic.
            If the material does not cover the question, say so briefly and then give a
            short general explanation.

            Return ONLY the answer as plain text, no commentary or meta text.

            --- COURSE MATERIAL ---
            {material_context}

            --- QUESTION ---
            {question}
            """
        else:
            prompt = f"""
            You are a helpful university tutor. A student has asked a question about a
            course topic. Answer clearly and concisely in student-friendly language,
            with a short example where it helps understanding.

            Return ONLY the answer as plain text, no commentary or meta text.

            --- QUESTION ---
            {question}
            """

        return self._complete(prompt)

    def _mock_quiz(self, num_objective: int, num_theory: int) -> dict:
        """Fallback mock quiz if API fails or key is missing."""
        return {
            "objective": [
                {
                    "question": f"Mock Objective Question {i+1}?",
                    "options": ["Option A", "Option B", "Option C", "Option D"],
                    "correct_answer_index": 0
                } for i in range(num_objective)
            ],
            "theory": [
                {
                    "question": f"Mock Theory Question {i+1}?",
                    "suggested_answer_rubric": "Student should mention X and Y."
                } for i in range(num_theory)
            ]
        }


# Singleton instance
quiz_ai = QuizGeneratorService()

# File: backend/app/core/config.py
# Purpose: Centralised application settings, loaded from backend/.env.
# Uses pydantic-settings so values come from environment variables / .env file.

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Supabase ---
    # Project URL, e.g. https://xxxx.supabase.co
    SUPABASE_URL: str = ""
    # Public anon key — used for user sign-in (RLS applies).
    SUPABASE_ANON_KEY: str = ""
    # Service role key — server-side only, bypasses RLS. NEVER expose to the browser.
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    # Google Gemini API key for AI quiz generation (leave empty for mock quizzes).
    GEMINI_API_KEY: str = ""
    # Gemini model used for quiz generation.
    GEMINI_MODEL: str = "gemini-3.6-flash"

    # Groq API key — preferred provider when set (OpenAI-compatible).
    # When empty, the service falls back to Gemini.
    GROQ_API_KEY: str = ""
    # Groq model id, e.g. "llama-3.3-70b-versatile".
    GROQ_MODEL: str = "openai/gpt-oss-120b"

    # --- Heavy ML model switches ---
    # On small instances (e.g. Render 512 MB free tier) keep these False so
    # PyTorch (sentence-transformers) and TensorFlow never load into memory.
    # When disabled the services fall back to lightweight TF-IDF search and a
    # heuristic engagement analyzer.
    SEMANTIC_SEARCH_ENABLED: bool = True
    ENGAGEMENT_ML_ENABLED: bool = True

    # Office→PDF conversion at upload time (LibreOffice headless). Hosts
    # without soffice degrade gracefully to the embedded viewer fallback.
    DOC_CONVERSION_ENABLED: bool = True

    # --- App ---
    APP_NAME: str = "UENR E-Learning Platform"
    APP_ENV: str = "development"

    # Comma-separated list of allowed frontend origins for CORS.
    # "*" allows any origin (fine for local dev; tighten for production).
    CORS_ORIGINS: str = "*"

    # --- YouTube Data API ---
    # API key for the YouTube Data API v3, used to fetch live video
    # recommendations. Leave empty to fall back to the curated resource pool.
    YOUTUBE_API_KEY: str = ""

    @property
    def is_configured(self) -> bool:
        """True when the minimum Supabase credentials are present."""
        return bool(self.SUPABASE_URL and self.SUPABASE_SERVICE_ROLE_KEY)


settings = Settings()

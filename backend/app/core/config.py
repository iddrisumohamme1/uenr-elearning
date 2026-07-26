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

    # --- App ---
    APP_NAME: str = "UENR E-Learning Platform"
    APP_ENV: str = "development"

    # Comma-separated list of allowed frontend origins for CORS.
    # "*" allows any origin (fine for local dev; tighten for production).
    CORS_ORIGINS: str = "*"

    @property
    def is_configured(self) -> bool:
        """True when the minimum Supabase credentials are present."""
        return bool(self.SUPABASE_URL and self.SUPABASE_SERVICE_ROLE_KEY)


settings = Settings()

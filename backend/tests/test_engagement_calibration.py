# File: backend/tests/test_engagement_calibration.py
# Purpose: Unit tests for the platform-aware engagement calibration. The
#          Two-Tower model (trained on OULAD) saturates to At-Risk for this
#          platform's minute-scale telemetry, so the stored engagement class
#          is decided by calibrate_engagement(). These tests pin that mapping.
#
# Run from the backend/ directory:
#   ..\venv\Scripts\python.exe -m pytest tests\test_engagement_calibration.py -q

from app.services.engagement_features import calibrate_engagement


def _features(**overrides):
    base = {
        "total_activities": 0.0,
        "unique_materials": 0.0,
        "active_days": 0.0,
        "avg_daily_activity": 0.0,
        "activity_per_registered_day": 0.0,
        "days_since_last_activity": 200.0,
        "assessment_count": 0.0,
    }
    base.update(overrides)
    return base


def test_no_telemetry_is_at_risk_even_with_outlier_features():
    features = _features(
        active_days=90.0, avg_daily_activity=5000.0,
        unique_materials=50.0, assessment_count=9.0,
    )
    assert calibrate_engagement(features, telemetry_count=0) == (0, "At-Risk")


def test_computer_graphics_profile_at_risk():
    features = _features(
        active_days=1.0, avg_daily_activity=1.1,
        unique_materials=1.0, assessment_count=2.0,
        days_since_last_activity=5.0,
    )
    # raw = 1*30 + 1.1*2 + 1*15 + 2*12 - 5*4 = 51.2 -> At-Risk
    assert calibrate_engagement(features, telemetry_count=3) == (0, "At-Risk")


def test_research_methods_profile_moderate():
    features = _features(
        active_days=5.0, avg_daily_activity=8.23,
        unique_materials=2.0, assessment_count=3.0,
        days_since_last_activity=0.0,
    )
    # raw = 5*30 + 8.23*2 + 2*15 + 3*12 = 232.46 -> Moderate
    assert calibrate_engagement(features, telemetry_count=10) == (1, "Moderate")


def test_heavy_profile_highly_engaged():
    features = _features(
        active_days=20.0, avg_daily_activity=45.0,
        unique_materials=30.0, assessment_count=5.0,
        days_since_last_activity=0.0,
    )
    # raw = 20*30 + 45*2 + 30*15 + 5*12 = 1200 -> Highly Engaged
    assert calibrate_engagement(features, telemetry_count=100) == (2, "Highly Engaged")


def test_assessment_count_capped_at_five():
    features = _features(
        active_days=1.0, avg_daily_activity=1.0,
        unique_materials=1.0, assessment_count=500.0,
        days_since_last_activity=0.0,
    )
    # capped raw = 30 + 2 + 15 + 5*12 = 107 -> Moderate, not Highly Engaged
    assert calibrate_engagement(features, telemetry_count=10) == (1, "Moderate")
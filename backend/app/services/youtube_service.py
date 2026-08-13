# File: backend/app/services/youtube_service.py
# Purpose: Thin wrapper around the YouTube Data API v3 `search` endpoint.
#          Returns live video results for a query so the recommendation engine
#          can surface up-to-date tutorials instead of only curated links.
#          Degrades gracefully to an empty list when no API key is configured.

import time

import httpx

from app.core.config import settings

YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
CACHE_TTL_SECONDS = 3600

_cache = {}


def search_youtube(query: str, max_results: int = 5) -> list:
    """Search YouTube for educational videos matching `query`.

    Results are cached per normalized query for CACHE_TTL_SECONDS to avoid
    burning through the daily quota. Returns [] when no key is configured
    or when the upstream call fails.
    """
    api_key = settings.YOUTUBE_API_KEY
    if not api_key:
        return []

    cache_key = " ".join(query.lower().split())
    cached = _cache.get(cache_key)
    if cached and time.time() - cached["ts"] < CACHE_TTL_SECONDS:
        return cached["items"]

    params = {
        "part": "snippet",
        "type": "video",
        "maxResults": max(1, min(max_results, 10)),
        "q": query,
        "key": api_key,
    }

    try:
        resp = httpx.get(YOUTUBE_SEARCH_URL, params=params, timeout=4.0)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        print(f"[YouTube] Search failed for query {query!r}: {e}")
        return []

    items = []
    for item in payload.get("items", []):
        video_id = (item.get("id") or {}).get("videoId")
        snippet = item.get("snippet") or {}
        if not video_id:
            continue
        items.append({
            "id": f"yt:{video_id}",
            "title": snippet.get("title", "Untitled video"),
            "description": snippet.get("description", ""),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "channel": snippet.get("channelTitle", ""),
            "thumbnails": snippet.get("thumbnails") or {},
            "published_at": snippet.get("publishedAt", ""),
        })

    if items:
        _cache[cache_key] = {"ts": time.time(), "items": items}
        print(f"[YouTube] Found {len(items)} videos for query {query!r}.")
    return items

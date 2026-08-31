# File: backend/app/services/web_article_service.py
# Purpose: Thin keyless wrapper around Bing's RSS web-search feed.
#          Returns live article results for a query so the recommendation
#          system can surface fresh reading material alongside live YouTube
#          videos. No API key is required.
#
# NOTE: Originally built against the Wikipedia API, but Wikimedia serves an
#       HTTP 403 to this deployment's IP (verified across en/fr.wikipedia and
#       mirrors, even with a real browser User-Agent). Bing's RSS search works
#       from this network and returns genuine educational pages (including
#       Wikipedia links) plus a concise snippet, so it replaces Wikipedia.
#       Degrades gracefully to an empty list on any failure.

import hashlib
import html
import time
import xml.etree.ElementTree as ET

import httpx

BING_SEARCH_URL = "https://www.bing.com/search"
CACHE_TTL_SECONDS = 1800

# Bing serves the same page to scripted agents as it does to browsers, so a
# descriptive desktop UA is all that's needed.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

_cache = {}

# Stopwords that never carry topical signal; the query's remaining words must
# actually appear in a result for it to be kept (Bing partial-phrase matching
# otherwise drifts toward unrelated shopping/spam pages).
_STOPWORDS = {
    "the", "and", "for", "of", "to", "a", "in", "on", "is", "are", "what",
    "why", "how", "with", "this", "that", "its", "it", "be", "by", "from",
}

# Domains that should never surface in an education feed even if Bing ranks
# them. Matched as substrings against the resolved host.
_SPAM_HOST_FRAGMENTS = (
    "bokep", "porn", "xxx", "sex", "casino", "gambling", "slot", "escort",
    "dating", "viagra", "alfatah", "daraz", "ebay", "alibaba",
)

# TLDs whose content we can't vouch for from an uncurated search feed.
_SPAM_TLDS = {".tokyo", ".online", ".shop", ".xyz", ".top", ".club", ".site"}


def _significant_terms(query: str) -> list:
    """Tokens (punctuation-normalized) that must appear in a result for it to
    count as relevant."""
    import re
    words = re.split(r"[^a-z0-9]+", query.lower())
    return [w for w in words if len(w) >= 3 and w not in _STOPWORDS]


def _host_blocked(host: str) -> bool:
    h = host.lower()
    if any(frag in h for frag in _SPAM_HOST_FRAGMENTS):
        return True
    return any(h.endswith(tld) for tld in _SPAM_TLDS)


def _relevant(url: str, title: str, description: str, terms: list) -> bool:
    """Keep only results that share real topical vocabulary with the query.

    Requires two distinct query terms to match when the query has two or more
    (a single shared word like "machine" admits unrelated shopping links);
    single-term queries just need their one term to appear.
    """
    if not terms:
        return True
    haystack = f"{url} {title} {description}".lower()
    matched = sum(1 for t in terms if t in haystack)
    threshold = 2 if len(terms) >= 2 else 1
    return matched >= threshold


def _text(node) -> str:
    return "".join(node.itertext()).strip() if node is not None else ""


def _clean(text: str) -> str:
    """Strip a snippet value and HTML-unescape the entities Bing sends."""
    if not text:
        return ""
    return html.unescape(text)


def _item_id(url: str) -> str:
    """Stable, collision-safe key derived from the article URL."""
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    return f"web:{digest}"


def _parse_rss(resp, limit: int) -> list:
    """Extract (url, title, description) triples from a Bing RSS document.

    Handles both the namespaced RDF feed (channel > item > link/title/
    description) and the plain RSS 2.0 feed (rss > channel > item with
    <link>, <title>, <description> children), matching elements by local name
    so namespace prefixes never break the parse.
    """
    root = ET.fromstring(resp.text.encode("utf-8", "ignore"))

    def children_by_local(node, name):
        return [c for c in list(node) if c.tag.rsplit("}", 1)[-1] == name]

    items = []
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1] != "item":
            continue
        url = _text(children_by_local(item, "link")[0] if children_by_local(item, "link") else None)
        title = _text(children_by_local(item, "title")[0] if children_by_local(item, "title") else None)
        desc = _text(children_by_local(item, "description")[0] if children_by_local(item, "description") else None)
        if url and title:
            items.append((url, _clean(title), _clean(desc)))
        if len(items) >= limit:
            break
    return items


def search_articles(query: str, max_results: int = 5) -> list:
    """Search the web for educational articles matching `query`.

    Results are cached per normalized query for CACHE_TTL_SECONDS. Returns []
    when the upstream call fails or returns nothing usable.
    """
    cache_key = " ".join(query.lower().split())
    cached = _cache.get(cache_key)
    if cached and time.time() - cached["ts"] < CACHE_TTL_SECONDS:
        return cached["items"]

    limit = max(1, min(max_results, 10))
    headers = {"User-Agent": USER_AGENT}
    items = []
    terms = _significant_terms(query)

    try:
        resp = httpx.get(
            BING_SEARCH_URL,
            params={"q": query, "format": "rss", "count": limit},
            headers=headers,
            timeout=6.0,
            follow_redirects=True,
        )
        resp.raise_for_status()
        triples = _parse_rss(resp, limit * 3)
    except Exception as e:
        print(f"[Articles] Search failed for query {query!r}: {e}")
        return []

    from urllib.parse import urlparse

    for url, title, description in triples:
        host = urlparse(url).netloc
        if not host:
            continue
        if _host_blocked(host):
            continue
        if not _relevant(url, title, description, terms):
            continue
        channel = host.replace("www.", "") if host else "Web"
        items.append({
            "id": _item_id(url),
            "title": title,
            "description": (description or "")[:400],
            "url": url,
            "source": "article",
            "type": "Article",
            "channel": channel,
            "thumbnails": {},
            "published_at": "",
        })
        if len(items) >= limit:
            break

    if items:
        _cache[cache_key] = {"ts": time.time(), "items": items}
        print(f"[Articles] Found {len(items)} articles for query {query!r}.")
    return items
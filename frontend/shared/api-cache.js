/*
   SESSION DATA CACHE (persist-until-reload)
   frontend/shared/api-cache.js

   Revisited pages paint instantly from sessionStorage and stay persistent:
   navigating between pages does NOT hit the server again while the cached
   copy is younger than API_CACHE_TTL_MS. The data only refreshes when the
   browser is actually reloaded, the cache ages past the TTL, or a mutation
   invalidates the key. sessionStorage survives page navigation within the
   browser session and clears itself when the tab closes.

   Usage (after session.js):
     <script src="../shared/api-cache.js"></script>
     await swrGet('my-courses', url, renderCourses);
     swrGet('nav-unread', url, onFresh, { forceRefresh: true }); // always fresh
     invalidateApiCache('assignments'); // after mutations
*/

const API_CACHE_PREFIX = 'uenr:api:';

/* Cached copies older than this quietly revalidate once in the background,
   then persist again — protects tabs left open for hours. */
const API_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * True when the current page load came from an explicit browser reload
 * (F5 / reload button) rather than a sidebar-link or back/forward navigation.
 */
function isReloadNavigation() {
    try {
        const entries = performance.getEntriesByType && performance.getEntriesByType('navigation');
        if (entries && entries.length) return entries[0].type === 'reload';
    } catch (_) { /* fall through to legacy API */ }
    return typeof performance !== 'undefined' &&
        performance.navigation &&
        performance.navigation.type === 1;
}

function apiCacheUserScope() {
    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    return user && user.id ? `${user.id}` : 'anon';
}

/**
 * Read a cache entry. Returns { data, age } on hit (age in ms) or null.
 * Entries written before the timestamp wrapper existed are accepted as
 * brand-new data so a mid-session upgrade never loses the cache.
 */
function readApiCache(name) {
    try {
        const raw = sessionStorage.getItem(API_CACHE_PREFIX + apiCacheUserScope() + ':' + name);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 't' in parsed && 'd' in parsed) {
            return { data: parsed.d, age: Math.max(0, Date.now() - parsed.t) };
        }
        return { data: parsed, age: 0 };
    } catch (_) {
        return null;
    }
}

function writeApiCache(name, data) {
    try {
        sessionStorage.setItem(
            API_CACHE_PREFIX + apiCacheUserScope() + ':' + name,
            JSON.stringify({ t: Date.now(), d: data })
        );
    } catch (_) {
        /* quota or private-mode errors are non-fatal */
    }
}

/**
 * Persistent-until-reload GET over authFetch.
 * - Cache hit: onFresh(cached) fires immediately (instant paint).
 * - The network request only runs when it should: an explicit browser
 *   reload, a cache older than API_CACHE_TTL_MS, opts.forceRefresh, or
 *   no cached copy at all. Plain page-to-page navigation serves the
 *   persisted copy and touches nothing.
 * - A fresh response updates the cache and calls onFresh(fresh) again.
 * - If the network fails but a cached copy exists, the cached copy is
 *   returned instead of throwing so pages still render.
 *
 * @param {string} name - cache key for this dataset (unique per endpoint)
 * @param {string} url - API URL passed to authFetch
 * @param {(data: object) => void} [onFresh] - render callback; must be idempotent
 * @param {{ forceRefresh?: boolean }} [opts] - forceRefresh skips persistence
 * @returns {Promise<object>} freshest available data
 */
async function swrGet(name, url, onFresh, opts = {}) {
    const hit = readApiCache(name);
    if (hit && typeof onFresh === 'function') onFresh(hit.data);

    const stale = !hit || hit.age > API_CACHE_TTL_MS;
    const revalidate = stale || isReloadNavigation() || opts.forceRefresh === true;
    if (!revalidate) return hit.data;

    let res;
    try {
        res = await authFetch(url);
    } catch (err) {
        if (hit) return hit.data;
        throw err;
    }

    if (!res.ok) {
        if (hit) return hit.data;
        let detail = `Request failed (${res.status})`;
        try { detail = (await res.json()).detail || detail; } catch (_) {}
        throw new Error(detail);
    }

    const data = await res.json();
    writeApiCache(name, data);
    if (typeof onFresh === 'function') onFresh(data);
    return data;
}

/**
 * Remove cached API data. Call after mutations that change what the
 * cached endpoints would return.
 * @param {string} [prefix] - optional key prefix, e.g. 'assignments';
 *                             omitted clears everything for this session scope
 */
function invalidateApiCache(prefix) {
    const base = API_CACHE_PREFIX + apiCacheUserScope();
    const doomed = [];
    for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(prefix ? `${base}:${prefix}` : base)) doomed.push(k);
    }
    doomed.forEach(k => sessionStorage.removeItem(k));
}

/**
 * Wipe every cached API payload regardless of scope — used on login/logout
 * so account switches never see another student's data.
 */
function clearAllApiCache() {
    const doomed = [];
    for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(API_CACHE_PREFIX)) doomed.push(k);
    }
    doomed.forEach(k => sessionStorage.removeItem(k));
}

/**
 * Raw cache access for views assembled from several endpoints (e.g. the
 * assignments page combines courses + per-course lists). Read returns null
 * on miss; write failures are non-fatal.
 */
function cachedRead(name) {
    const hit = readApiCache(name);
    return hit ? hit.data : null;
}

function cachedWrite(name, data) {
    writeApiCache(name, data);
}

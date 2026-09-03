/* 
   SESSION MANAGEMENT
   frontend/shared/session.js
   
   Shared utility that handles:
   - Login state detection
   - Automatic token refresh when expired (401)
   - Role-based access guards
   
   Usage:
     <script src="../shared/session.js"></script>
     <script>
       requireSession('student').then(user => {
           // user is valid, proceed with page logic
       });
     </script>
*/

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8001'
    : 'https://uenr-elearning-api.onrender.com';

// Sessions last this long since login (ms). Enforced on every page load, so a
// refresh past the lifetime logs the user out instead of keeping them in.
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const SESSION_START_KEY = 'session_start';

function getSessionStart() {
    const raw = localStorage.getItem(SESSION_START_KEY);
    return raw ? Number(raw) : 0;
}

function isSessionExpired() {
    const start = getSessionStart();
    return start > 0 && Date.now() - start > SESSION_LIFETIME_MS;
}

/**
 * Attempt to refresh the access token using the stored refresh token.
 * Returns the new user object on success, null on failure.
 */
async function refreshAccessToken() {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) return null;

    try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        });

        if (!res.ok) return null;

        const data = await res.json();
        localStorage.setItem('token', data.access_token);
        localStorage.setItem('refresh_token', data.refresh_token);
        localStorage.setItem('user', JSON.stringify(data.user));
        return data.user;
    } catch (err) {
        console.error('[session] Refresh failed:', err);
        return null;
    }
}

/**
 * Require a valid session. Checks localStorage and validates the role.
 * Token validation happens lazily on first API call via authFetch.
 *
 * Accepts one or more allowed roles, e.g. requireSession('lecturer', 'hod').
 * @param {...string} allowedRoles - e.g. 'student', 'lecturer', 'hod'
 * @returns {Promise<object>} The user object if session is valid
 */
async function requireSession(...allowedRoles) {
    const user = JSON.parse(localStorage.getItem('user'));
    const token = localStorage.getItem('token');

    if (!user || !token) {
        window.location.href = '../auth/login.html';
        throw new Error('No session');
    }

    // Enforce the session lifetime: a refresh past the limit clears the
    // session and forces a fresh login.
    if (isSessionExpired()) {
        clearSession();
        window.location.href = '../auth/login.html?reason=expired';
        throw new Error('Session expired');
    }

    // Sessions started before this check existed have no start time — begin
    // the clock now instead of logging them out immediately.
    if (!getSessionStart()) {
        localStorage.setItem(SESSION_START_KEY, String(Date.now()));
    }

    // Role guard: redirect to correct dashboard if wrong role
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        window.location.href = `../${user.role}/dashboard.html`;
        throw new Error('Wrong role');
    }

    return user;
}

/**
 * Wrapped fetch that automatically handles 401 by refreshing the token
 * and retrying the request once.
 *
 * @param {string} url 
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function authFetch(url, options = {}) {
    const token = getToken();
    const headers = { ...options.headers };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    let res = await fetch(url, { ...options, headers });

    // If 401, try refresh and retry once
    if (res.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
            headers['Authorization'] = `Bearer ${getToken()}`;
            res = await fetch(url, { ...options, headers });
        }
    }

    return res;
}

/**
 * Clear all session data and redirect to login.
 */
function clearSession() {
    localStorage.removeItem('token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('user');
    localStorage.removeItem(SESSION_START_KEY);
    if (typeof clearAllApiCache === 'function') clearAllApiCache();
}

/**
 * Get the current user from localStorage (synchronous).
 */
function getCurrentUser() {
    const user = JSON.parse(localStorage.getItem('user'));
    return user || null;
}

/**
 * Get the current access token (synchronous).
 */
function getToken() {
    return localStorage.getItem('token');
}

/**
 * Attach logout handler to a button element.
 */
function attachLogout(buttonId) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.addEventListener('click', () => {
        clearSession();
        window.location.href = '../auth/login.html';
    });
}

/**
 * Show unread-count badges on sidebar nav links for students with pending
 * messages or auto-generated resource recommendations.
 * Runs automatically on every page that includes session.js.
 */
function addNavBadge(link, count) {
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.textContent = count > 9 ? '9+' : count;
    link.appendChild(badge);
}

async function initNavBadges() {
    const user = getCurrentUser();
    if (!user || user.role !== 'student') return;

    const navLinks = Array.from(document.querySelectorAll('.nav-link'));
    const findLink = hrefPart => navLinks.find(a => (a.getAttribute('href') || '').includes(hrefPart));
    const onRecPage = window.location.pathname.includes('recommendations.html');

    // "My Progress" is meaningless before the student enrols in anything —
    // hide it until they have at least one course. Fail open on API errors.
    const progressLink = findLink('progress.html');
    if (progressLink) {
        swrGet('nav-stats', `${API_BASE}/api/students/${user.id}/stats`, stats => {
            if (!stats.enrolled_courses) progressLink.style.display = 'none';
        }, { forceRefresh: true }).catch(err => console.error('[session] Progress link check failed:', err));
    }

    // Unread messages → badge on the Inbox link.
    const inboxLink = findLink('inbox.html');
    if (inboxLink && !inboxLink.querySelector('.nav-badge')) {
        swrGet('nav-unread', `${API_BASE}/api/messages/unread-count`, data => {
            if (data.unread_count > 0) addNavBadge(inboxLink, data.unread_count);
        }, { forceRefresh: true }).catch(err => console.error('[session] Inbox badge check failed:', err));
    }

    // Pending recommendations → badge on the Recommendations link (skipped on
    // the recommendations page itself, which marks them read).
    if (!onRecPage) {
        const recLink = findLink('recommendations.html');
        if (recLink && !recLink.querySelector('.nav-badge')) {
            swrGet('nav-rec-notifs', `${API_BASE}/api/recommendations/notifications`, data => {
                if (data.unread_count > 0) addNavBadge(recLink, data.unread_count);
            }, { forceRefresh: true }).catch(err => console.error('[session] Recommendation badge check failed:', err));
        }
    }

    // Pending assignments → badge on the Assignments link. The endpoint runs
    // auto-generation first, so a freshly downloaded material shows up as a
    // to-do assignment right after login.
    const assignLink = findLink('assignments.html');
    if (assignLink && !assignLink.querySelector('.nav-badge')) {
        swrGet('nav-pending', `${API_BASE}/api/assignments/pending-count`, data => {
            if (data.pending_count > 0) addNavBadge(assignLink, data.pending_count);
        }, { forceRefresh: true }).catch(err => console.error('[session] Assignments badge check failed:', err));
    }
}

/**
 * Timezone-aware greeting rendered on the role dashboards. The platform
 * serves Ghanaian students, so the greeting is computed from the Africa/Accra
 * clock rather than the visitor's local time — a machine set to another
 * timezone previously showed "Good afternoon" at Ghanaian midnight.
 * Falls back to local time when Intl timezone data is unavailable.
 */
function ghanaGreeting(firstName = '') {
    let hour;
    try {
        hour = Number(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Accra',
            hour: 'numeric',
            hourCycle: 'h23',
        }).format(new Date()));
    } catch (_) {
        hour = new Date().getHours();
    }
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = String(firstName || '').trim();
    return name ? `${greeting}, ${name}` : greeting;
}

document.addEventListener('DOMContentLoaded', initNavBadges);

/**
 * Toggle a button's busy (loading) state.
 *
 * Expects the button to contain a persistent label element carrying the text
 * (`.btn-label`) and a spinner element (`.btn-spinner`, hidden by default).
 * While busy the label text is made invisible with `visibility:hidden` — it
 * still occupies its layout space, so the button keeps its exact size and the
 * centered spinner (overlaid via `.btn-loading .btn-spinner`) never moves.
 * On completion the original label/state is restored.
 *
 * @param {HTMLButtonElement} btn
 * @param {boolean} busy
 */
function setButtonBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = Boolean(busy);
    btn.classList.toggle('btn-loading', busy);
    const label = btn.querySelector('.btn-label');
    const spinner = btn.querySelector('.btn-spinner');
    if (label) label.style.visibility = busy ? 'hidden' : '';
    if (spinner) spinner.hidden = !busy;
}

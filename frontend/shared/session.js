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

    // Unread messages → badge on the Inbox link.
    const inboxLink = findLink('inbox.html');
    if (inboxLink && !inboxLink.querySelector('.nav-badge')) {
        try {
            const res = await authFetch(`${API_BASE}/api/messages/unread-count`);
            if (res.ok) {
                const data = await res.json();
                if (data.unread_count > 0) addNavBadge(inboxLink, data.unread_count);
            }
        } catch (err) {
            console.error('[session] Inbox badge check failed:', err);
        }
    }

    // Pending recommendations → badge on the Recommendations link (skipped on
    // the recommendations page itself, which marks them read).
    if (!onRecPage) {
        const recLink = findLink('recommendations.html');
        if (recLink && !recLink.querySelector('.nav-badge')) {
            try {
                const res = await authFetch(`${API_BASE}/api/recommendations/notifications`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.unread_count > 0) addNavBadge(recLink, data.unread_count);
                }
            } catch (err) {
                console.error('[session] Recommendation badge check failed:', err);
            }
        }
    }

    // Pending assignments → badge on the Assignments link. The endpoint runs
    // auto-generation first, so a freshly downloaded material shows up as a
    // to-do assignment right after login.
    const assignLink = findLink('assignments.html');
    if (assignLink && !assignLink.querySelector('.nav-badge')) {
        try {
            const res = await authFetch(`${API_BASE}/api/assignments/pending-count`);
            if (res.ok) {
                const data = await res.json();
                if (data.pending_count > 0) addNavBadge(assignLink, data.pending_count);
            }
        } catch (err) {
            console.error('[session] Assignments badge check failed:', err);
        }
    }
}

document.addEventListener('DOMContentLoaded', initNavBadges);

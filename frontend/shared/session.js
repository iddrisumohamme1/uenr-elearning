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

const API_BASE = 'http://localhost:8000';

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
 * @param {string} requiredRole - Optional: 'student', 'lecturer', or 'hod'
 * @returns {Promise<object>} The user object if session is valid
 */
async function requireSession(requiredRole) {
    const user = JSON.parse(localStorage.getItem('user'));
    const token = localStorage.getItem('token');

    if (!user || !token) {
        window.location.href = '../auth/login.html';
        throw new Error('No session');
    }

    // Role guard: redirect to correct dashboard if wrong role
    if (requiredRole && user.role !== requiredRole) {
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

/*
   AUTH MODULE LOGIC
   frontend/auth/auth.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const loginForm = document.getElementById('login-form');

    // If a stored session exists, validate it against the server before
    // auto-redirecting. Stale localStorage data must not hijack the login screen.
    if (loginForm) {
        const existingUser = JSON.parse(localStorage.getItem('user'));
        const existingToken = localStorage.getItem('token');
        if (existingUser && existingToken) {
            try {
                const user = await refreshAccessToken();
                if (user) {
                    window.location.href = `../${user.role}/dashboard.html`;
                    return;
                }
            } catch (err) {
                console.warn('[auth] Stored session invalid, showing login form.');
            }
            clearSession();
        }
    }

    const roleCards = document.querySelectorAll('.role-card');
    let selectedRole = 'student';
    let isSubmitting = false;

    roleCards.forEach(card => {
        card.addEventListener('click', () => {
            roleCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            selectedRole = card.dataset.role;
        });
    });

    // Handle Login
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isSubmitting) return;

            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const btn = loginForm.querySelector('.btn-auth');

            if (!email || !password) {
                showToast('Please fill in all fields.', 'warning');
                return;
            }

            isSubmitting = true;
            btn.classList.add('btn-loading');
            btn.textContent = 'Signing in...';

            try {
                const response = await fetch(`${API_BASE}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();
                if (response.ok) {
                    localStorage.setItem('token', data.access_token);
                    localStorage.setItem('refresh_token', data.refresh_token);
                    localStorage.setItem('user', JSON.stringify(data.user));
                    const role = data.user.role;
                    showToast('Login successful. Redirecting...', 'success');
                    setTimeout(() => {
                        window.location.href = `../${role}/dashboard.html`;
                    }, 700);
                } else {
                    showToast('Login failed: ' + (data.detail || 'Invalid credentials'), 'error');
                    isSubmitting = false;
                    btn.classList.remove('btn-loading');
                    btn.textContent = 'Sign In';
                }
            } catch (err) {
                console.error('Login error:', err);
                showToast('Server connection failed.', 'error');
                isSubmitting = false;
                btn.classList.remove('btn-loading');
                btn.textContent = 'Sign In';
            }
        });
    }

    // Handle Registration
    const registerForm = document.getElementById('register-form');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isSubmitting) return;

            const fullname = document.getElementById('fullname').value;
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const department = document.getElementById('department') ? document.getElementById('department').value : null;
            const btn = registerForm.querySelector('.btn-auth');

            if (!fullname || !email || !password) {
                showToast('Please fill in all required fields.', 'warning');
                return;
            }

            isSubmitting = true;
            btn.classList.add('btn-loading');
            btn.textContent = 'Creating account...';

            try {
                const response = await fetch(`${API_BASE}/api/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        full_name: fullname, 
                        email, 
                        password, 
                        role: selectedRole,
                        department: department
                    })
                });

                const data = await response.json();
                if (response.ok) {
                    showToast('Registration successful! Redirecting to login...', 'success');
                    setTimeout(() => {
                        window.location.href = 'login.html';
                    }, 900);
                } else {
                    showToast('Registration failed: ' + (data.detail || 'Unable to create account'), 'error');
                    isSubmitting = false;
                    btn.classList.remove('btn-loading');
                    btn.textContent = 'Create Account';
                }
            } catch (err) {
                console.error('Registration error:', err);
                showToast('Server connection failed.', 'error');
                isSubmitting = false;
                btn.classList.remove('btn-loading');
                btn.textContent = 'Create Account';
            }
        });
    }
});

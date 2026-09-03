/*
   AUTH MODULE LOGIC
   frontend/auth/auth.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    // Wake a sleeping backend (e.g. Render free tier) while the user is typing
    // their credentials so the actual login isn't delayed by a cold start.
    fetch(`${API_BASE}/api/health`).catch(() => {});

    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    // Show/hide password toggles (shared by login and register forms)
    document.querySelectorAll('.password-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.closest('.password-wrap').querySelector('input');
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.querySelector('.bi').className = 'bi ' + (show ? 'bi-eye-slash' : 'bi-eye');
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        });
    });

    // Always start with a clean form — no stale values from a previous visit
    // or browser autofill. Chrome autofills saved credentials AFTER
    // DOMContentLoaded, so a plain reset() is not enough: keep the inputs
    // readonly (autofill skips readonly fields) until the user actually
    // touches one, then unlock it.
    const activeForm = loginForm || registerForm;
    if (activeForm) {
        const inputs = Array.from(activeForm.querySelectorAll('input'));
        const unlock = (inp) => inp.removeAttribute('readonly');
        inputs.forEach((inp) => {
            inp.setAttribute('readonly', '');
            inp.addEventListener('focus', () => unlock(inp), { once: true });
            inp.addEventListener('pointerdown', () => unlock(inp), { once: true });
        });
        activeForm.querySelectorAll('.password-toggle').forEach((btn) => {
            btn.addEventListener('pointerdown', () => {
                const inp = btn.closest('.password-wrap').querySelector('input');
                if (inp) unlock(inp);
            }, { once: true });
        });
        activeForm.reset();
        // Safety net: never leave a field locked if focus events are missed.
        setTimeout(() => inputs.forEach(unlock), 3000);
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reason') === 'expired') {
        showToast('Your session expired. Please log in again.', 'info');
    }

    // If a stored session exists, validate it against the server before
    // auto-redirecting. Stale localStorage data must not hijack the login screen.
    if (loginForm) {
        const existingUser = JSON.parse(localStorage.getItem('user'));
        const existingToken = localStorage.getItem('token');
        if (existingUser && existingToken) {
            if (isSessionExpired()) {
                clearSession();
            } else {
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
    }

    // Field-level validation helpers (used by the register form)
    const setError = (input, message) => {
        input.classList.add('invalid');
        const errorEl = document.getElementById(input.id + '-error');
        if (errorEl) errorEl.textContent = message;
    };
    const clearError = (input) => {
        input.classList.remove('invalid');
        const errorEl = document.getElementById(input.id + '-error');
        if (errorEl) errorEl.textContent = '';
    };
    const clearErrors = (form) => form.querySelectorAll('.form-input').forEach(clearError);

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
            setButtonBusy(btn, true);

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
                    localStorage.setItem('session_start', String(Date.now()));
                    const role = data.user.role;
                    showToast('Login successful.', 'success');
                    window.location.href = `../${role}/dashboard.html`;
                } else {
                    showToast('Login failed: ' + (data.detail || 'Invalid credentials'), 'error');
                    isSubmitting = false;
                    setButtonBusy(btn, false);
                }
            } catch (err) {
                console.error('Login error:', err);
                showToast('Server connection failed.', 'error');
                isSubmitting = false;
                setButtonBusy(btn, false);
            }
        });
    }

    // Handle Registration
    if (registerForm) {
        const fullnameInput = document.getElementById('fullname');
        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('password');
        const confirmPasswordInput = document.getElementById('confirm_password');
        const departmentSelect = document.getElementById('department');

        // Clear a field's error as soon as the user fixes it
        registerForm.querySelectorAll('.form-input').forEach((inp) => {
            inp.addEventListener('input', () => clearError(inp));
            inp.addEventListener('change', () => clearError(inp));
        });

        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isSubmitting) return;

            const fullname = fullnameInput.value.trim();
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const confirmPassword = confirmPasswordInput.value;
            const department = departmentSelect ? departmentSelect.value : null;
            const btn = registerForm.querySelector('.btn-auth');
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            clearErrors(registerForm);
            let firstInvalid = null;
            const flag = (input, message) => {
                setError(input, message);
                if (!firstInvalid) firstInvalid = input;
            };

            if (!fullname) flag(fullnameInput, 'Please enter your full name.');
            if (!email) flag(emailInput, 'Please enter your email address.');
            else if (!emailRegex.test(email)) flag(emailInput, 'Please enter a valid email address.');
            if (!password) flag(passwordInput, 'Please enter a password.');
            else if (password.length < 6) flag(passwordInput, 'Password must be at least 6 characters.');
            if (!confirmPassword) flag(confirmPasswordInput, 'Please confirm your password.');
            else if (password && confirmPassword !== password) flag(confirmPasswordInput, 'Passwords do not match.');
            if ((selectedRole === 'lecturer' || selectedRole === 'hod') && !department) {
                flag(departmentSelect, 'Department is required for lecturer and HOD accounts.');
            }

            if (firstInvalid) {
                firstInvalid.focus();
                showToast('Please fix the highlighted fields.', 'warning');
                return;
            }

            isSubmitting = true;
            setButtonBusy(btn, true);

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
                    // Auto-login with the fresh credentials so the user lands
                    // straight on their dashboard instead of the login page.
                    showToast('Login successful.', 'success');
                    try {
                        // Supabase can briefly reject sign-ins for an account
                        // created moments ago (propagation lag), so retry a
                        // couple of times before falling back to the login page.
                        let loginData = null;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            if (attempt > 0) await new Promise(r => setTimeout(r, 1200));
                            const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ email, password })
                            });
                            loginData = await loginRes.json().catch(() => null);
                            if (loginRes.ok && loginData) break;
                            loginData = null;
                        }
                        if (loginData) {
                            localStorage.setItem('token', loginData.access_token);
                            localStorage.setItem('refresh_token', loginData.refresh_token);
                            localStorage.setItem('user', JSON.stringify(loginData.user));
                            localStorage.setItem('session_start', String(Date.now()));
                            window.location.href = `../${loginData.user.role}/dashboard.html`;
                            return;
                        }
                    } catch (err) {
                        console.warn('[auth] Auto-login failed, falling back to login page.', err);
                    }
                    setTimeout(() => {
                        window.location.href = 'login.html';
                    }, 900);
                } else {
                    const detail = data.detail || 'Unable to create account';
                    const message = /already (?:been )?registered|already exists|already taken|duplicate/i.test(detail)
                        ? 'An account with this email already exists.'
                        : 'Registration failed: ' + detail;
                    showToast(message, 'error');
                    isSubmitting = false;
                    setButtonBusy(btn, false);
                }
            } catch (err) {
                console.error('Registration error:', err);
                showToast('Server connection failed.', 'error');
                isSubmitting = false;
                setButtonBusy(btn, false);
            }
        });
    }
});

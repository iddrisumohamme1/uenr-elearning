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

    // Field-level validation helpers (used by the register form). Error <small>
    // elements start hidden via CSS (.field-error { display:none }) and are
    // revealed by toggling the .show class — the invalid border alone gives no
    // explanation, so both are applied together.
    const setError = (input, message) => {
        input.classList.add('invalid');
        const errorEl = document.getElementById(input.id + '-error');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.add('show');
        }
    };
    const clearError = (input) => {
        input.classList.remove('invalid');
        const errorEl = document.getElementById(input.id + '-error');
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.classList.remove('show');
        }
    };
    const clearErrors = (form) => form.querySelectorAll('.form-input').forEach(clearError);

    const roleCards = document.querySelectorAll('.role-card');
    let selectedRole = 'student';
    let isSubmitting = false;

    // Auto-append ".com" when the user leaves a domain without a dot:
    // "name@gmail" -> "name@gmail.com". Emails that already have a dot in
    // the domain (gmail.com, uenr.edu.gh, ...) are left untouched.
    const autoCompleteEmail = (value) => {
        const v = value.trim();
        if (!v.includes('@')) return v;
        const [local, domain] = v.split('@');
        if (local && domain && !domain.includes('.') && /^[A-Za-z0-9-]+$/.test(domain)) {
            return `${local}@${domain}.com`;
        }
        return v;
    };

    // UENR-owned email domains. Explicitly allowed in addition to any valid
    // general email (gmail.com, yahoo.com, ...).
    const UENR_DOMAINS = new Set(['uenr.edu.gh', 'uenr.edu', 'uenr.gov.gh']);

    const isValidEmail = (value) => {
        const email = (value || '').trim();
        if (!email) return false;
        const domain = email.split('@')[1];
        if (UENR_DOMAINS.has(domain)) return true;
        // General address: local part then a real, well-formed domain with at
        // least two labels and a recognised TLD (com, org, net, edu, gh, ...).
        if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email)) return false;
        if (!/\.(com|org|net|edu|gov|io|int|mil|gh|uk|us|co|ca|au|ng|za|com\.gh|edu\.gh|org\.gh|gov\.gh|co\.uk|org\.uk|ac\.uk)$/i.test(email)) return false;
        if (/\.\.|@@/.test(email)) return false;
        return true;
    };

    // Strong password check: 8+ chars with uppercase, lowercase, a number
    // and a special character.
    const isStrongPassword = (value) =>
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s]).{8,}$/.test(value || '');

    // 0-4 score used by the strength meter.
    const passwordScore = (value) => {
        const p = value || '';
        let score = 0;
        if (p.length >= 8) score++;
        if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
        if (/\d/.test(p)) score++;
        if (/[^A-Za-z0-9\s]/.test(p)) score++;
        return score;
    };

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

            const emailInput = document.getElementById('email');
            const email = autoCompleteEmail(emailInput.value);
            emailInput.value = email;
            const password = document.getElementById('password').value;
            const btn = loginForm.querySelector('.btn-auth');

            if (!email || !password) {
                showToast('Please fill in all fields.', 'warning');
                return;
            }
            if (!isValidEmail(email)) {
                showToast('Please enter a valid email address (e.g. name@domain.com or name@uenr.edu.gh).', 'warning');
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

        // Live password strength meter
        const strengthBar = document.getElementById('password-strength');
        const strengthText = document.getElementById('password-strength-text');
        const updateStrength = () => {
            if (!strengthBar || !strengthText) return;
            const score = passwordScore(passwordInput.value);
            const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
            const colors = ['#ff5a5a', '#ff8c42', '#ffc107', '#8bc34a', '#2ecc71'];
            strengthBar.className = 'strength-bar';
            if (passwordInput.value) {
                strengthBar.classList.add(`strength-${score}`);
                strengthBar.style.width = `${(score / 4) * 100}%`;
                strengthText.textContent = labels[score];
                strengthText.style.color = colors[score];
            } else {
                strengthBar.style.width = '0%';
                strengthText.textContent = '';
            }
        };
        passwordInput.addEventListener('input', updateStrength);

        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isSubmitting) return;

            const fullname = fullnameInput.value.trim();
            const email = autoCompleteEmail(emailInput.value.trim());
            emailInput.value = email;
            const password = passwordInput.value;
            const confirmPassword = confirmPasswordInput.value;
            const department = departmentSelect ? departmentSelect.value : null;
            const btn = registerForm.querySelector('.btn-auth');
            // Real-name characters only: letters, spaces, hyphens, apostrophes, dots.
            // Digits, @, underscores and any other symbol are rejected.
            const nameRegex = /^[A-Za-z\s\-'.]+$/;

            clearErrors(registerForm);
            let firstInvalid = null;
            const flag = (input, message) => {
                setError(input, message);
                if (!firstInvalid) firstInvalid = input;
            };

            if (!fullname) flag(fullnameInput, 'Please enter your full name.');
            else if (!nameRegex.test(fullname)) flag(fullnameInput, 'Name must contain only letters, spaces, hyphens or apostrophes — no numbers or symbols.');
            if (!email) flag(emailInput, 'Please enter your email address.');
            else if (!isValidEmail(email)) flag(emailInput, 'Please enter a valid email address — either a UENR address (e.g. name@uenr.edu.gh) or a real domain ending in .com, .org, .net, .edu, .gh, etc.');
            if (!password) flag(passwordInput, 'Please enter a password.');
            else if (!isStrongPassword(password)) flag(passwordInput, 'Password must be at least 8 characters with uppercase, lowercase, a number and a special character (e.g. !@#$%^&*).');
            if (!confirmPassword) flag(confirmPasswordInput, 'Please confirm your password.');
            else if (password && confirmPassword !== password) flag(confirmPasswordInput, 'Passwords do not match.');
            if (!department) flag(departmentSelect, 'Please select your school/department.');

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

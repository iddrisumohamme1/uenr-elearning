/*
   SETTINGS PAGE
   frontend/settings/settings.js

   Self-served profile edits. Loads the logged-in user's profile via
   GET /api/users/me, renders the identity card, and saves edits through
   PUT /api/users/me. Students get an index-number field; lecturers and
   HODs get a staff-ID field.
*/

(function () {
    const ROLE_LABELS = {
        student: 'Student',
        lecturer: 'Lecturer',
        hod: 'Head of Department',
    };

    const roleLabels = {
        student: { field: 'index', label: 'Index Number', placeholder: 'e.g. UEB3503022' },
        lecturer: { field: 'staff', label: 'Staff ID', placeholder: 'e.g. UENR/ST/2024/0001' },
        hod: { field: 'staff', label: 'Staff ID', placeholder: 'e.g. UENR/ST/2022/0009' },
    };

    function $(id) {
        return document.getElementById(id);
    }

    function setError(input, errorEl, message) {
        if (message) {
            input.classList.add('invalid');
            errorEl.textContent = message;
            errorEl.classList.add('show');
        } else {
            input.classList.remove('invalid');
            errorEl.classList.remove('show');
        }
    }

    function getRoleConfig(role) {
        return roleLabels[role] || roleLabels.student;
    }

    function renderIdentity(user) {
        const cfg = getRoleConfig(user.role);

        $('id-role').textContent = ROLE_LABELS[user.role] || user.role;
        $('id-full-name').textContent = user.full_name || '—';
        $('id-dept').textContent = user.department || '—';
        $('id-email').textContent = user.email || '—';

        // Identifier value differs by role.
        const idValue = user.role === 'student' ? user.index_number : user.staff_id;
        const idValEl = $('id-index');
        idValEl.textContent = idValue || '—';
        idValEl.classList.toggle('is-id', Boolean(idValue));

        // Avatar
        const img = $('id-avatar-img');
        const text = $('id-avatar-text');
        if (user.avatar_url) {
            img.src = user.avatar_url;
            img.style.display = 'block';
            text.style.display = 'none';
        } else {
            text.textContent = (user.full_name || 'U')[0].toUpperCase();
            text.style.display = 'flex';
            img.style.display = 'none';
        }

        // Top-bar avatar initial
        const topAvatar = document.querySelector('.top-bar .avatar');
        if (topAvatar) topAvatar.textContent = (user.full_name || 'U')[0].toUpperCase();

        // Role-appropriate ID field
        if (cfg.field === 'index') {
            $('staff-group').hidden = true;
            $('index-group').hidden = false;
            $('index-label').textContent = cfg.label;
        } else {
            $('index-group').hidden = true;
            $('staff-group').hidden = false;
            $('staff-label').textContent = cfg.label;
        }
    }

    function fillForm(user) {
        const cfg = getRoleConfig(user.role);
        $('full_name').value = user.full_name || '';
        $('email').value = user.email || '';
        $('date_of_birth').value = user.date_of_birth || '';
        $('phone').value = user.phone || '';

        const idInput = cfg.field === 'index' ? $('index_number') : $('staff_id');
        idInput.placeholder = cfg.placeholder;
        idInput.value = cfg.field === 'index' ? (user.index_number || '') : (user.staff_id || '');
    }

    function currentUser() {
        try {
            return JSON.parse(localStorage.getItem('user')) || null;
        } catch (err) {
            return null;
        }
    }

    // Human-readable date (e.g. "12 March 2001") or an em-dash when unset.
    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    }

    function formatPhone(phone) {
        return phone || '—';
    }

    function renderView(user) {
        const cfg = getRoleConfig(user.role);

        $('rv-name').textContent = user.full_name || '—';
        $('rv-id-label').textContent = cfg.label;
        const idValue = user.role === 'student' ? user.index_number : user.staff_id;
        $('rv-id').textContent = idValue || '—';
        $('rv-id').classList.toggle('rv-id-val', Boolean(idValue));
        $('rv-dept').textContent = user.department || '—';
        $('rv-dob').textContent = formatDate(user.date_of_birth);
        $('rv-phone').textContent = formatPhone(user.phone);
        $('rv-email').textContent = user.email || '—';
    }

    function openEdit() {
        const user = currentUser();
        if (user) fillForm(user);
        setError($('full_name'), $('full_name-error'), null);
        setError($('index_number'), $('index_number-error'), null);
        setError($('staff_id'), $('staff_id-error'), null);
        setError($('date_of_birth'), $('date_of_birth-error'), null);
        setError($('phone'), $('phone-error'), null);
        $('record-view').hidden = true;
        $('record-edit').hidden = false;
        $('full_name').focus();
    }

    function closeEdit() {
        $('record-edit').hidden = true;
        $('record-view').hidden = false;
        const user = currentUser();
        if (user) renderView(user);
    }

    function setSaving(saving) {
        setButtonBusy($('save-btn'), saving);
    }

    async function onSave(e) {
        e.preventDefault();

        const user = currentUser();
        if (!user) return;
        const cfg = getRoleConfig(user.role);

        // Clear prior field errors.
        ['full_name', 'index_number', 'staff_id', 'date_of_birth', 'phone'].forEach(id => {
            setError($(id), $(`${id}-error`), null);
        });

        const fullName = $('full_name').value.trim();
        if (!fullName) {
            setError($('full_name'), $('full_name-error'), 'Full name cannot be empty.');
            $('full_name').focus();
            return;
        }

        const payload = {
            full_name: fullName,
            date_of_birth: $('date_of_birth').value || '',
            phone: $('phone').value.trim(),
        };

        if (cfg.field === 'index') {
            payload.index_number = $('index_number').value.trim();
        } else {
            payload.staff_id = $('staff_id').value.trim();
        }

        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/api/users/me`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                const msg = data.detail || 'Could not save your changes.';

                // Surface unique-field conflicts on the field itself.
                if (msg.toLowerCase().includes('index number')) {
                    setError($('index_number'), $('index_number-error'), msg);
                } else if (msg.toLowerCase().includes('staff id')) {
                    setError($('staff_id'), $('staff_id-error'), msg);
                } else {
                    showToast(msg, 'error');
                }
                return;
            }

            // Merge the fresh profile into the stored user + re-render.
            user.full_name = data.full_name;
            user.date_of_birth = data.date_of_birth || null;
            user.index_number = data.index_number || null;
            user.staff_id = data.staff_id || null;
            user.phone = data.phone || null;
            localStorage.setItem('user', JSON.stringify(user));

            $('full_name').value = data.full_name;
            fillForm(user);
            renderIdentity(user);
            renderView(user);
            closeEdit();
            showToast('Your changes were saved.', 'success', { title: 'Profile updated' });
        } catch (err) {
            console.error('[settings] Save failed:', err);
            showToast('Could not reach the server. Please try again.', 'error');
        } finally {
            setSaving(false);
        }
    }

    function setThumbUploading(uploading) {
        const wrap = $('id-avatar-wrap');
        const overlay = wrap.querySelector('.id-avatar-overlay');
        wrap.classList.toggle('uploading', uploading);
        overlay.innerHTML = uploading
            ? '<span class="spinner"></span>'
            : '<i class="bi bi-camera-fill"></i><span>Change</span>';
    }

    function initAvatarUpload() {
        const wrap = $('id-avatar-wrap');
        const input = $('id-avatar-input');

        function trigger() { input.click(); }

        wrap.addEventListener('click', trigger);
        wrap.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                trigger();
            }
        });

        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('Only image files are allowed.', 'error');
                input.value = '';
                return;
            }
            if (file.size > 2 * 1024 * 1024) {
                showToast('Image must be under 2MB.', 'error');
                input.value = '';
                return;
            }

            // Live preview immediately.
            const reader = new FileReader();
            reader.onload = (ev) => {
                $('id-avatar-img').src = ev.target.result;
                $('id-avatar-img').style.display = 'block';
                $('id-avatar-text').style.display = 'none';
            };
            reader.readAsDataURL(file);

            setThumbUploading(true);
            try {
                const formData = new FormData();
                formData.append('file', file);

                const res = await authFetch(`${API_BASE}/api/users/profile/avatar`, {
                    method: 'POST',
                    body: formData,
                });

                const data = await res.json().catch(() => ({}));

                if (!res.ok) {
                    showToast(data.detail || 'Upload failed. Please try again.', 'error');
                    renderIdentity(currentUser());
                    return;
                }

                // Persist the new avatar into the stored user and refresh the UI.
                const user = currentUser() || {};
                user.avatar_url = data.avatar_url;
                localStorage.setItem('user', JSON.stringify(user));
                renderIdentity(user);
                showToast('Photo updated.', 'success', { title: 'Profile photo' });
            } catch (err) {
                console.error('[settings] Avatar upload failed:', err);
                showToast('Could not reach the server. Please try again.', 'error');
                renderIdentity(currentUser());
            } finally {
                setThumbUploading(false);
                input.value = '';
            }
        });
    }

    async function init() {
        // Guard requires any authenticated role. Redirects to login otherwise.
        const user = await requireSession().catch(() => null);
        if (!user) return;

        // Fill the static email + placeholder immediately from localStorage,
        // then refresh from the server for the most current values.
        renderIdentity(user);
        renderView(user);

        try {
            const res = await authFetch(`${API_BASE}/api/users/me`, { method: 'GET' });
            if (res.ok) {
                const fresh = await res.json();
                const current = currentUser() || {};
                Object.assign(current, fresh);
                localStorage.setItem('user', JSON.stringify(current));
                renderIdentity(current);
                renderView(current);
                fillForm(current);
            } else {
                // Fall back to localStorage data if the fetch fails.
                fillForm(user);
            }
        } catch (err) {
            fillForm(user);
        }

        $('profile-form').addEventListener('submit', onSave);
        $('edit-btn').addEventListener('click', openEdit);
        $('cancel-btn').addEventListener('click', closeEdit);
        attachLogout('logout-btn');

        // Clear "in use" field errors as the user retypes.
        ['index_number', 'staff_id'].forEach(id => {
            $(id).addEventListener('input', () => setError($(id), $(`${id}-error`), null));
        });

        initAvatarUpload();
        initProfilePopup();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

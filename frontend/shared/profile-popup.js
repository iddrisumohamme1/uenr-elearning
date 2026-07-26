/*
   PROFILE POPUP
   frontend/shared/profile-popup.js
   Handles profile popup with image upload and dark/light mode toggle.
   Include <script src="../shared/profile-popup.js"></script> after session.js.
   
   Usage: Call initProfilePopup() after DOM is ready.
*/

function initProfilePopup() {
    const user = JSON.parse(localStorage.getItem('user'));
    if (!user) return;

    // Insert popup HTML into body
    const overlay = document.createElement('div');
    overlay.className = 'profile-popup-overlay';
    overlay.id = 'profile-popup-overlay';
    overlay.innerHTML = `
        <div class="profile-popup">
            <div class="profile-popup-header">
                <h2>Profile & Settings</h2>
                <button class="profile-popup-close" id="profile-popup-close">&times;</button>
            </div>
            <div class="profile-popup-body">
                <div class="profile-avatar-section">
                    <div class="profile-avatar" id="profile-avatar" title="Click to upload photo">
                        <span id="profile-avatar-text">${(user.full_name || 'U')[0].toUpperCase()}</span>
                        <img id="profile-avatar-img" style="display:none" />
                        <div class="profile-avatar-edit">Change Photo</div>
                        <input type="file" id="profile-avatar-input" accept="image/*" />
                    </div>
                    <div class="profile-info">
                        <div class="name" id="profile-name">${user.full_name || 'User'}</div>
                        <div class="email" id="profile-email">${user.email || ''}</div>
                        <span class="role-badge">${user.role || 'student'}</span>
                    </div>
                </div>

                <div class="profile-settings">
                    <h3>Appearance</h3>
                    <div class="setting-row">
                        <div class="setting-label">
                            <span class="icon">${getTheme() === 'dark' ? '🌙' : '☀️'}</span>
                            <span id="theme-label">${getTheme() === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
                        </div>
                        <div class="theme-toggle ${getTheme() === 'dark' ? 'active' : ''}" id="theme-toggle-btn"></div>
                    </div>
                </div>

                <div class="profile-status" id="profile-status"></div>
                <button class="profile-save-btn" id="profile-save-btn" style="display:none">Save Photo</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Load existing profile photo
    if (user.avatar_url) {
        const img = document.getElementById('profile-avatar-img');
        const text = document.getElementById('profile-avatar-text');
        img.src = user.avatar_url;
        img.style.display = 'block';
        text.style.display = 'none';
    }

    // Make all avatar elements in the page clickable
    document.querySelectorAll('.avatar, .user-profile').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => openProfilePopup());
    });

    // Open popup on avatar click in top bar
    const topBarAvatar = document.querySelector('.user-profile');
    if (topBarAvatar) {
        topBarAvatar.addEventListener('click', openProfilePopup);
    }

    // Close popup
    document.getElementById('profile-popup-close').addEventListener('click', closeProfilePopup);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeProfilePopup();
    });

    // Theme toggle
    document.getElementById('theme-toggle-btn').addEventListener('click', () => {
        const newTheme = toggleTheme();
        const btn = document.getElementById('theme-toggle-btn');
        const label = document.getElementById('theme-label');
        const icon = label.previousElementSibling;
        btn.classList.toggle('active', newTheme === 'dark');
        label.textContent = newTheme === 'dark' ? 'Dark Mode' : 'Light Mode';
        icon.textContent = newTheme === 'dark' ? '🌙' : '☀️';
    });

    // Avatar upload
    const avatarInput = document.getElementById('profile-avatar-input');
    const avatarEl = document.getElementById('profile-avatar');
    const saveBtn = document.getElementById('profile-save-btn');
    let selectedFile = null;

    avatarEl.addEventListener('click', () => avatarInput.click());

    avatarInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        selectedFile = file;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = document.getElementById('profile-avatar-img');
            const text = document.getElementById('profile-avatar-text');
            img.src = ev.target.result;
            img.style.display = 'block';
            text.style.display = 'none';
        };
        reader.readAsDataURL(file);
        saveBtn.style.display = 'block';
        document.getElementById('profile-status').textContent = '';
    });

    // Save photo
    saveBtn.addEventListener('click', async () => {
        if (!selectedFile) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Uploading...';
        const statusEl = document.getElementById('profile-status');
        statusEl.textContent = '';
        statusEl.className = 'profile-status';

        try {
            const formData = new FormData();
            formData.append('file', selectedFile);

            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE}/api/users/profile/avatar`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || 'Upload failed');
            }

            const data = await res.json();
            // Update stored user with new avatar
            user.avatar_url = data.avatar_url;
            localStorage.setItem('user', JSON.stringify(user));

            statusEl.textContent = 'Photo updated!';
            statusEl.className = 'profile-status success';
            saveBtn.style.display = 'none';
            selectedFile = null;
        } catch (err) {
            statusEl.textContent = err.message;
            statusEl.className = 'profile-status error';
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Photo';
        }
    });
}

function openProfilePopup() {
    const overlay = document.getElementById('profile-popup-overlay');
    if (overlay) overlay.classList.add('open');
}

function closeProfilePopup() {
    const overlay = document.getElementById('profile-popup-overlay');
    if (overlay) overlay.classList.remove('open');
}

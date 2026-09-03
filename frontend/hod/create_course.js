/*
   HOD COURSE CREATION LOGIC
   frontend/hod/create_course.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    const lecturerSelect = document.getElementById('lecturer-select');
    const form = document.getElementById('create-course-form');
    const submitBtn = document.getElementById('btn-text').parentElement;

    function setSubmitting(submitting) {
        setButtonBusy(submitBtn, submitting);
    }

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'H').charAt(0).toUpperCase();

    async function loadLecturers() {
        try {
            const response = await authFetch(`${API_BASE}/api/users/lecturers`);
            const lecturers = await response.json();
            lecturerSelect.innerHTML = `
                <option value="" disabled selected>Select a department lecturer</option>
                ${lecturers.map(lecturer => `
                    <option value="${lecturer.id}">${escapeHTML(lecturer.full_name)}${lecturer.id === user.id ? ' (you)' : ''}</option>
                `).join('')}
            `;
        } catch (err) {
            console.error('Error loading lecturers:', err);
            lecturerSelect.innerHTML = '<option value="" disabled>Select lecturers unavailable</option>';
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('course-title').value.trim();
        const code = document.getElementById('course-code').value.trim();
        const description = document.getElementById('course-description').value.trim();
        const lecturerId = lecturerSelect.value;
        const level = document.getElementById('course-level').value ? Number(document.getElementById('course-level').value) : null;
        const semester = document.getElementById('course-semester').value || null;

        if (!title || !code || !lecturerId) {
            showToast('Please complete the course title, code, and lecturer selection.', 'warning');
            return;
        }

        setSubmitting(true);
        try {
            const response = await authFetch(`${API_BASE}/api/courses/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, code, description, lecturer_id: lecturerId, level, semester })
            });

            const data = await response.json();
            if (response.ok) {
                // The dashboard caches the course catalog — drop it so the new
                // course shows up when we land there.
                invalidateApiCache('hod-catalog');
                invalidateApiCache('lect-my-courses');
                showToast('Course created successfully.', 'success');
                window.location.href = 'dashboard.html';
                return;
            }
            setSubmitting(false);
            showToast('Failed to create course: ' + (data.detail || data.message || 'Unknown error'), 'error');
        } catch (err) {
            setSubmitting(false);
            console.error('Create course error:', err);
            showToast('Server connection failed.', 'error');
        }
    });

    await loadLecturers();
});

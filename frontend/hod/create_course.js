/*
   HOD COURSE CREATION LOGIC
   frontend/hod/create_course.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;

    const lecturerSelect = document.getElementById('lecturer-select');
    const form = document.getElementById('create-course-form');

    attachLogout('logout-btn');
    initProfilePopup();

    async function loadLecturers() {
        try {
            const response = await authFetch(`${API_BASE}/api/users/lecturers`);
            const lecturers = await response.json();
            lecturerSelect.innerHTML = `
                <option value="" disabled selected>Select a department lecturer</option>
                ${lecturers.map(lecturer => `
                    <option value="${lecturer.id}">${lecturer.full_name}</option>
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

        if (!title || !code || !lecturerId) {
            showToast('Please complete the course title, code, and lecturer selection.', 'warning');
            return;
        }

        try {
            const response = await authFetch(`${API_BASE}/api/courses/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, code, description, lecturer_id: lecturerId })
            });

            const data = await response.json();
            if (response.ok) {
                showToast('Course created successfully.', 'success');
                window.location.href = 'dashboard.html';
            } else {
                showToast('Failed to create course: ' + (data.detail || data.message || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Create course error:', err);
            showToast('Server connection failed.', 'error');
        }
    });

    await loadLecturers();
});

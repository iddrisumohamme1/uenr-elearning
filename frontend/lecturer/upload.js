/*
   LECTURER MATERIAL UPLOAD LOGIC
   frontend/lecturer/upload.js
   Loads courses from Supabase, handles file upload via FastAPI backend.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;
    const token = getToken();

    const courseSelect = document.getElementById('course-select');
    const form = document.getElementById('upload-form');

    attachLogout('logout-btn');
    initProfilePopup();

    async function loadCourses() {
        try {
            const response = await authFetch(`${API_BASE}/api/courses/`);
            const courses = await response.json();
            if (!Array.isArray(courses) || courses.length === 0) {
                courseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }

            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${courses.map(course => `
                    <option value="${course.id}">${course.title} (${course.code || 'No code'})</option>
                `).join('')}
            `;
        } catch (err) {
            console.error('Error loading courses:', err);
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const title = document.getElementById('title').value.trim();
        const description = document.getElementById('description').value.trim();
        const courseId = courseSelect.value;
        const fileInput = document.getElementById('file');

        if (!title || !courseId || !fileInput.files.length) {
            showToast('Please select a course, enter a title, and upload a file.', 'warning');
            return;
        }

        const formData = new FormData();
        formData.append('title', title);
        formData.append('description', description);
        formData.append('course_id', courseId);
        formData.append('file', fileInput.files[0]);

        try {
            const response = await authFetch(`${API_BASE}/api/materials/upload`, {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();
            if (response.ok) {
                showToast('Material uploaded successfully.', 'success');
                window.location.href = 'dashboard.html';
            } else {
                showToast('Upload failed: ' + (data.detail || data.message || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Upload failed: Server connection error.', 'error');
        }
    });

    await loadCourses();
});

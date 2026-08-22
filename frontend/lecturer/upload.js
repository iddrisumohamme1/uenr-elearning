/*
   LECTURER MATERIAL UPLOAD LOGIC
   frontend/lecturer/upload.js
   Loads courses from Supabase, handles file upload via FastAPI backend.
   The course dropdown uses the persist-until-reload cache; a successful
   upload drops the course's cached material list.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;
    const token = getToken();

    const courseSelect = document.getElementById('course-select');
    const form = document.getElementById('upload-form');
    const academicYear = document.getElementById('academic-year');

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();

    function setupOrganization() {
        const radios = document.querySelectorAll('input[name="organization"]');
        const weekField = document.getElementById('org-week-field');
        const unitField = document.getElementById('org-unit-field');
        const hint = document.getElementById('org-hint');
        const apply = (value) => {
            weekField.hidden = value !== 'week';
            unitField.hidden = value !== 'unit';
            if (value === 'week') hint.textContent = 'Materials are shown to students grouped under this week.';
            else if (value === 'unit') hint.textContent = 'Materials are shown to students grouped under this unit / part.';
            else hint.textContent = 'Materials are shown to students as whole-semester content (no week grouping).';
        };
        radios.forEach(r => r.addEventListener('change', () => apply(r.value)));
        apply(document.querySelector('input[name="organization"]:checked')?.value || 'week');
    }

    function loadAcademicYears() {
        const now = new Date().getFullYear();
        const options = [];
        for (let y = now; y >= now - 3; y--) {
            options.push(`<option value="${y}/${y + 1}">${y}/${y + 1}</option>`);
        }
        academicYear.innerHTML = `
            <option value="" disabled selected>Select academic year</option>
            ${options.join('')}
        `;
    }

    async function loadCourses() {
        try {
            const courses = await swrGet('catalog', `${API_BASE}/api/courses/`);
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
        const weekNumber = document.getElementById('week-number').value.trim();
        const unitLabel = document.getElementById('unit-label').value.trim();
        const organization = document.querySelector('input[name="organization"]:checked')?.value || 'week';
        const courseId = courseSelect.value;
        const semesterVal = document.getElementById('semester').value;
        const fileInput = document.getElementById('file');

        if (!title || !courseId || !academicYear.value || !semesterVal || !fileInput.files.length) {
            showToast('Select a course, academic year, semester, enter a title, and upload a file.', 'warning');
            return;
        }
        if (organization === 'week' && !weekNumber) {
            showToast('Enter the week number for this material.', 'warning');
            return;
        }
        if (organization === 'unit' && !unitLabel) {
            showToast('Enter a unit / part label for this material.', 'warning');
            return;
        }

        const semester = `${academicYear.value} - ${semesterVal}`;

        const formData = new FormData();
        formData.append('title', title);
        formData.append('description', description);
        formData.append('course_id', courseId);
        formData.append('semester', semester);
        if (organization === 'week') formData.append('week_number', weekNumber);
        if (organization === 'unit') formData.append('unit_label', unitLabel);
        formData.append('file', fileInput.files[0]);

        try {
            const response = await authFetch(`${API_BASE}/api/materials/upload`, {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();
            if (response.ok) {
                showToast('Material uploaded successfully.', 'success');
                // Drop the course's cached material list so the materials
                // page shows the new file right away.
                invalidateApiCache(`course-materials:${courseId}`);
                window.location.href = 'dashboard.html';
            } else {
                showToast('Upload failed: ' + (data.detail || data.message || 'Unknown error'), 'error');
            }
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Upload failed: Server connection error.', 'error');
        }
    });

    loadAcademicYears();
    await loadCourses();
    setupOrganization();
});

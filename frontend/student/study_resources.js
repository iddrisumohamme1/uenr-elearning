/*
   STUDENT STUDY RESOURCES READER
   frontend/student/study_resources.js
   Lists the study aids (summaries, key points, practice questions) that
   lecturers have published for the student's enrolled courses.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.getElementById('user-avatar').textContent = (user.full_name || 'S').charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    const courseSelect = document.getElementById('course-select');
    const resourceList = document.getElementById('resource-list');

    const FORMAT_LABELS = {
        summary: 'Summary',
        key_points: 'Key Points',
        practice_questions: 'Practice Questions',
    };
    const FORMAT_ICONS = {
        summary: 'bi-text-paragraph',
        key_points: 'bi-list-check',
        practice_questions: 'bi-pencil-square',
    };

    function escapeHTML(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function setLoading(message) {
        resourceList.innerHTML = `
            <div class="loading-wrapper loading-full">
                <div class="spinner"></div>
                <p>${message}</p>
            </div>
        `;
    }

    function renderResources(resources) {
        if (!resources.length) {
            resourceList.innerHTML = `
                <div class="reader-empty">
                    <i class="bi bi-file-earmark-text"></i>
                    <h3>Nothing published yet</h3>
                    <p class="text-muted">Your lecturer hasn't published any study resources for this course yet.</p>
                </div>
            `;
            return;
        }
        resourceList.innerHTML = resources.map(r => {
            const type = r.resource_type || 'summary';
            return `
                <article class="sheet" data-type="${type}">
                    <div class="sheet-head">
                        <span class="chip chip--${type}"><i class="bi ${FORMAT_ICONS[type] || 'bi-file-text'}"></i> ${escapeHTML(FORMAT_LABELS[type] || type)}</span>
                        <span class="sheet-date">${new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                    <h2 class="sheet-title">${escapeHTML(r.title)}</h2>
                    <div class="sheet-body">${renderMarkdown(r.content_text)}</div>
                </article>
            `;
        }).join('');
    }

    try {
        const courses = await swrGet('my-courses', `${API_BASE}/api/students/${user.id}/courses`, freshCourses => {
            if (!Array.isArray(freshCourses) || !freshCourses.length) return;
            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${freshCourses.map(c => `<option value="${c.id}">${c.code ? c.code + ' · ' : ''}${escapeHTML(c.title)}</option>`).join('')}
            `;
        });
        if (!Array.isArray(courses) || !courses.length) {
            courseSelect.innerHTML = '<option value="" disabled>You are not enrolled in any courses yet</option>';
            resourceList.innerHTML = `
                <div class="reader-empty">
                    <i class="bi bi-book"></i>
                    <h3>No courses yet</h3>
                    <p class="text-muted">Enroll in a course first, then come back to read its study resources.</p>
                </div>
            `;
            return;
        }
    } catch (err) {
        courseSelect.innerHTML = '<option value="" disabled>Unable to load your courses</option>';
        resourceList.innerHTML = `
            <div class="reader-empty">
                <i class="bi bi-cloud-download"></i>
                <h3>Could not load courses</h3>
                <p class="text-muted">Check your connection and refresh to try again.</p>
            </div>
        `;
        showToast('Unable to load your courses.', 'error');
        return;
    }

    courseSelect.addEventListener('change', async () => {
        const courseId = courseSelect.value;
        if (!courseId) return;
        // Cached copy paints instantly; uncached courses load from the server.
        const cachedData = cachedRead(`resources:${courseId}`);
        if (!cachedData) setLoading('Loading study resources…');
        try {
            const data = await swrGet(`resources:${courseId}`, `${API_BASE}/api/resources/course/${courseId}`);
            renderResources((data && data.resources) || []);
        } catch (err) {
            resourceList.innerHTML = `
                <div class="reader-empty">
                    <i class="bi bi-cloud-download"></i>
                    <h3>Could not load resources</h3>
                    <p class="text-muted">Something went wrong. Try selecting the course again.</p>
                </div>
            `;
            showToast('Unable to load resources.', 'error');
        }
    });
});

/*
   LECTURER STUDY RESOURCES PAGE LOGIC
   frontend/lecturer/resources.js
   "The Study Press" — choose a material, compose an AI study aid, prove it,
   then publish it for the class. GETs use the persist-until-reload cache;
   publish/delete drop the course's cached resource list before reloading.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer', 'hod').catch(() => null);
    if (!user) return;

    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    const courseSelect = document.getElementById('course-select');
    const materialSelect = document.getElementById('material-select');
    const generateBtn = document.getElementById('generate-btn');
    const genStatus = document.getElementById('gen-status');
    const preview = document.getElementById('preview');
    const previewType = document.getElementById('preview-type');
    const previewTitle = document.getElementById('preview-title');
    const previewCourse = document.getElementById('preview-course');
    const previewBody = document.getElementById('preview-body');
    const publishBtn = document.getElementById('publish-btn');
    const publishedList = document.getElementById('published-list');
    const deleteModal = document.getElementById('delete-modal');
    const deleteConfirmBtn = document.getElementById('delete-confirm-btn');

    const FORMAT_LABELS = {
        summary: 'Summary',
        key_points: 'Key Points',
        practice_questions: 'Practice Questions',
    };
    const FORMAT_CHIPS = {
        summary: 'bi-text-paragraph',
        key_points: 'bi-list-check',
        practice_questions: 'bi-pencil-square',
    };

    function escapeHTML(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    let selectedCourseId = null;
    let selectedMaterialId = null;
    let selectedCourseName = '';
    let pendingResource = null;
    let pendingDeleteId = null;

    const closeModal = (m) => { if (m) m.hidden = true; };
    document.querySelectorAll('.modal [data-close="true"]').forEach(btn =>
        btn.addEventListener('click', () => closeModal(btn.closest('.modal')))
    );

    function openDeleteModal(id) {
        pendingDeleteId = id;
        deleteModal.hidden = false;
    }

    function setStage(doneUpTo) {
        document.querySelectorAll('#stage-rail .stage').forEach((el, i) => {
            el.classList.toggle('is-done', i < doneUpTo);
            el.classList.toggle('is-active', i === doneUpTo);
        });
    }

    function selectedFormat() {
        const checked = document.querySelector('input[name="format"]:checked');
        return checked ? checked.value : 'summary';
    }

    async function loadCourses(preselectId) {
        try {
            const courses = await swrGet('lect-my-courses', `${API_BASE}/api/courses/mine`);
            if (!Array.isArray(courses) || !courses.length) {
                courseSelect.innerHTML = '<option value="" disabled>No courses assigned to you yet</option>';
                genStatus.textContent = 'You have no courses assigned yet. Ask an HOD to assign you one.';
                return;
            }
            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${courses.map(c => `<option value="${c.id}">${c.title} (${c.code || 'No code'})</option>`).join('')}
            `;
            if (preselectId && courses.some(c => c.id === preselectId)) {
                courseSelect.value = preselectId;
                courseSelect.dispatchEvent(new Event('change'));
            }
        } catch (err) {
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
            genStatus.textContent = 'Could not load your courses. Check your connection and try again.';
        }
    }

    async function loadMaterials(courseId) {
        materialSelect.innerHTML = '<option value="" disabled selected>Loading materials…</option>';
        try {
            const data = await swrGet(`course-materials:${courseId}`, `${API_BASE}/api/materials/course/${courseId}`);
            const materials = (data && data.materials) || [];
            if (!materials.length) {
                materialSelect.innerHTML = '<option value="" disabled>No materials for this course</option>';
                return;
            }
            materialSelect.innerHTML = `
                <option value="" disabled selected>Select a material</option>
                ${materials.map(m => {
                    const org = m.week_number != null ? `Week ${m.week_number}` : m.unit_label ? m.unit_label : 'Full course';
                    return `<option value="${m.id}">${m.semester ? m.semester + ' · ' : ''}${org} · ${m.title}</option>`;
                }).join('')}
            `;
        } catch (err) {
            materialSelect.innerHTML = '<option value="" disabled>Unable to load materials</option>';
        }
    }

    async function loadPublished(courseId) {
        publishedList.innerHTML = '<div class="loading-wrapper"><div class="spinner spinner-sm"></div><p>Loading resources…</p></div>';
        try {
            const data = await swrGet(`resources:${courseId}`, `${API_BASE}/api/resources/course/${courseId}`);
            const resources = (data && data.resources) || [];
            if (!resources.length) {
                publishedList.innerHTML = '<p class="text-muted">No published resources for this course yet.</p>';
                return;
            }
            publishedList.innerHTML = resources.map(r => {
                const type = r.resource_type || 'summary';
                return `
                    <article class="live-card">
                        <div class="live-card-top">
                            <span class="chip chip--${type}"><i class="bi ${FORMAT_CHIPS[type] || 'bi-file-text'}"></i> ${(FORMAT_LABELS[type] || type).replace('_', ' ')}</span>
                            <span class="live-date">${new Date(r.created_at).toLocaleDateString()}</span>
                        </div>
                        <h3>${escapeHTML(r.title)}</h3>
                        <div class="live-text">${escapeHTML(r.content_text)}</div>
                        <div class="live-foot">
                            <button class="btn-live-delete" data-id="${r.id}"><i class="bi bi-trash"></i> Remove</button>
                        </div>
                    </article>
                `;
            }).join('');

            publishedList.querySelectorAll('.btn-live-delete').forEach(btn => {
                btn.addEventListener('click', () => openDeleteModal(btn.dataset.id));
            });
        } catch (err) {
            publishedList.innerHTML = '<p class="text-muted">Unable to load published resources.</p>';
        }
    }

    function resetPreview() {
        preview.hidden = true;
        pendingResource = null;
    }

    deleteConfirmBtn.addEventListener('click', async () => {
        if (!pendingDeleteId) return;
        deleteConfirmBtn.disabled = true;
        deleteConfirmBtn.textContent = 'Removing…';
        try {
            const res = await authFetch(`${API_BASE}/api/resources/${pendingDeleteId}`, { method: 'DELETE' });
            if (res.ok) {
                showToast('Resource removed.', 'success');
                closeModal(deleteModal);
                invalidateApiCache(`resources:${selectedCourseId}`);
                loadPublished(selectedCourseId);
            } else {
                showToast('Could not remove resource.', 'error');
            }
        } catch (err) {
            showToast('Could not remove resource.', 'error');
        } finally {
            pendingDeleteId = null;
            deleteConfirmBtn.disabled = false;
            deleteConfirmBtn.innerHTML = '<i class="bi bi-trash"></i> Remove resource';
        }
    });

    courseSelect.addEventListener('change', () => {
        selectedCourseId = courseSelect.value;
        const opt = courseSelect.selectedOptions[0];
        selectedCourseName = opt ? opt.textContent.replace(/\s*\([^)]*\)\s*$/, '') : '';
        resetPreview();
        setStage(selectedCourseId ? 1 : 0);
        if (selectedCourseId) {
            loadMaterials(selectedCourseId);
            loadPublished(selectedCourseId);
            genStatus.textContent = '';
        } else {
            materialSelect.innerHTML = '<option value="" disabled selected>Select a course first</option>';
            genStatus.textContent = 'Pick a course to start.';
        }
    });

    materialSelect.addEventListener('change', () => {
        selectedMaterialId = materialSelect.value;
        resetPreview();
        genStatus.textContent = selectedMaterialId
            ? 'Choose a format, then generate a preview.'
            : 'Choose a material to continue.';
    });

    document.querySelectorAll('input[name="format"]').forEach(radio => {
        radio.addEventListener('change', resetPreview);
    });

    generateBtn.addEventListener('click', async () => {
        if (!selectedCourseId || !selectedMaterialId) {
            showToast('Select a course and a material first.', 'warning');
            genStatus.textContent = '';
            return;
        }
        generateBtn.disabled = true;
        generateBtn.textContent = 'Composing…';
        preview.hidden = true;
        try {
            const res = await authFetch(`${API_BASE}/api/resources/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ material_id: selectedMaterialId, resource_type: selectedFormat() }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                pendingResource = {
                    course_id: selectedCourseId,
                    material_id: selectedMaterialId,
                    title: data.title,
                    resource_type: data.resource_type,
                    content_text: data.content_text,
                };
                preview.dataset.type = data.resource_type;
                previewType.textContent = FORMAT_LABELS[data.resource_type] || data.resource_type;
                previewTitle.textContent = data.title;
                previewCourse.textContent = selectedCourseName;
                previewBody.textContent = data.content_text;
                preview.hidden = false;
                setStage(2);
                genStatus.textContent = 'Proof ready — review it, then publish .';
            } else {
                genStatus.textContent = data.detail || ' Generation failed. Try again.';
                showToast(data.detail || 'Generation failed. Try again.', 'error');
            }
        } catch (err) {
            genStatus.textContent = 'Generation failed. Try again.';
            showToast('Generation failed. Try again.', 'error');
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate preview';
        }
    });

    publishBtn.addEventListener('click', async () => {
        if (!pendingResource) return;
        publishBtn.disabled = true;
        publishBtn.textContent = 'Publishing…';
        try {
            const res = await authFetch(`${API_BASE}/api/resources/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingResource),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast('Published for students.', 'success');
                preview.hidden = true;
                pendingResource = null;
                setStage(1);
                invalidateApiCache(`resources:${selectedCourseId}`);
                loadPublished(selectedCourseId);
            } else {
                genStatus.textContent = data.detail || 'Could not publish resource.';
                showToast(data.detail || 'Could not publish resource.', 'error');
            }
        } catch (err) {
            genStatus.textContent = 'Could not publish resource.';
            showToast('Could not publish resource.', 'error');
        } finally {
            publishBtn.disabled = false;
            publishBtn.textContent = 'Publish for students';
        }
    });

    const params = new URLSearchParams(window.location.search);
    await loadCourses(params.get('course'));
});

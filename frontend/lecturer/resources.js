/* 
   LECTURER STUDY RESOURCES PAGE LOGIC
   frontend/lecturer/resources.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();

    const courseSelect = document.getElementById('course-select');
    const materialSelect = document.getElementById('material-select');
    const typeSelect = document.getElementById('type-select');
    const generateBtn = document.getElementById('generate-btn');
    const preview = document.getElementById('preview');
    const previewTitle = document.getElementById('preview-title');
    const previewBody = document.getElementById('preview-body');
    const publishBtn = document.getElementById('publish-btn');
    const publishedList = document.getElementById('published-list');

    let selectedCourseId = null;
    let selectedMaterialId = null;
    let selectedCourseName = '';
    let pendingResource = null;

    async function loadCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/courses/`);
            const courses = await res.json();
            if (!Array.isArray(courses) || !courses.length) {
                courseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }
            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${courses.map(c => `<option value="${c.id}">${c.title} (${c.code || 'No code'})</option>`).join('')}
            `;
        } catch (err) {
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    async function loadMaterials(courseId) {
        materialSelect.innerHTML = '<option value="" disabled selected>Loading materials...</option>';
        try {
            const res = await authFetch(`${API_BASE}/api/materials/course/${courseId}`);
            if (!res.ok) throw new Error('materials failed');
            const data = await res.json();
            const materials = data.materials || [];
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
            const res = await authFetch(`${API_BASE}/api/resources/course/${courseId}`);
            if (!res.ok) throw new Error('resources failed');
            const resources = res.json && (await res.json()).resources || [];
            if (!resources.length) {
                publishedList.innerHTML = '<p class="text-muted">No published resources for this course yet.</p>';
                return;
            }
            publishedList.innerHTML = resources.map(r => `
                <div class="resource-item">
                    <div class="resource-head">
                        <div>
                            <h4>${r.title}</h4>
                            <div class="resource-meta">${r.resource_type.replace('_', ' ')} · created ${new Date(r.created_at).toLocaleDateString()}</div>
                        </div>
                        <button class="btn-msg" data-id="${r.id}">Delete</button>
                    </div>
                    <div class="resource-text">${r.content_text}</div>
                </div>
            `).join('');

            publishedList.querySelectorAll('.btn-msg').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Delete this study resource?')) return;
                    const res = await authFetch(`${API_BASE}/api/resources/${btn.dataset.id}`, { method: 'DELETE' });
                    if (res.ok) {
                        showToast('Resource deleted.', 'success');
                        loadPublished(courseId);
                    } else {
                        showToast('Could not delete resource.', 'error');
                    }
                });
            });
        } catch (err) {
            publishedList.innerHTML = '<p class="text-muted">Unable to load published resources.</p>';
        }
    }

    courseSelect.addEventListener('change', () => {
        selectedCourseId = courseSelect.value;
        const opt = courseSelect.selectedOptions[0];
        selectedCourseName = opt ? opt.textContent : '';
        preview.hidden = true;
        pendingResource = null;
        if (selectedCourseId) {
            loadMaterials(selectedCourseId);
            loadPublished(selectedCourseId);
        }
    });

    materialSelect.addEventListener('change', () => {
        selectedMaterialId = materialSelect.value;
        preview.hidden = true;
        pendingResource = null;
    });

    generateBtn.addEventListener('click', async () => {
        if (!selectedCourseId || !selectedMaterialId) {
            showToast('Select a course and a material first.', 'warning');
            return;
        }
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating…';
        preview.hidden = true;
        try {
            const res = await authFetch(`${API_BASE}/api/resources/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ material_id: selectedMaterialId, resource_type: typeSelect.value }),
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
                previewTitle.textContent = `${data.title} · ${selectedCourseName}`;
                previewBody.textContent = data.content_text;
                preview.hidden = false;
            } else {
                showToast(data.detail || 'AI generation failed. Try again.', 'error');
            }
        } catch (err) {
            showToast('AI generation failed. Try again.', 'error');
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate preview';
        }
    });

    publishBtn.addEventListener('click', async () => {
        if (!pendingResource) return;
        publishBtn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/resources/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingResource),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast('Resource published for students.', 'success');
                preview.hidden = true;
                pendingResource = null;
                loadPublished(selectedCourseId);
            } else {
                showToast(data.detail || 'Could not publish resource.', 'error');
            }
        } catch (err) {
            showToast('Could not publish resource.', 'error');
        } finally {
            publishBtn.disabled = false;
        }
    });

    await loadCourses();
});

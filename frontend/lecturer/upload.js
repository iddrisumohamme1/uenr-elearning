/*
   LECTURER MATERIAL UPLOAD LOGIC
   frontend/lecturer/upload.js
   Loads courses from Supabase, handles file upload via FastAPI backend.
   Features: drag-and-drop, file preview, client-side validation,
   progress bar via XHR, live-region announcements, upload-another modal.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer').catch(() => null);
    if (!user) return;
    const token = getToken();

    /* ── DOM refs ─────────────────────────────────────────────────────── */
    const courseSelect   = document.getElementById('course-select');
    const form           = document.getElementById('upload-form');
    const academicYear   = document.getElementById('academic-year');
    const fileInput      = document.getElementById('file');
    const dropZone       = document.getElementById('drop-zone');
    const dropContent    = document.getElementById('drop-zone-content');
    const preview        = document.getElementById('file-preview');
    const previewIcon    = document.getElementById('file-preview-icon');
    const previewName    = document.getElementById('file-preview-name');
    const previewSize    = document.getElementById('file-preview-size');
    const previewRemove  = document.getElementById('file-preview-remove');
    const fileError      = document.getElementById('file-error');
    const progressWrap   = document.getElementById('upload-progress');
    const progressFill   = document.getElementById('upload-progress-fill');
    const progressText   = document.getElementById('upload-progress-text');
    const submitBtn      = document.getElementById('upload-submit');
    const liveRegion     = document.getElementById('upload-live');

    const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
    const ALLOWED_EXTS = new Set([
        '.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx',
        '.odt','.odp','.ods','.png','.jpg','.jpeg','.gif','.webp'
    ]);

    attachLogout('logout-btn');
    initProfilePopup();
    document.getElementById('user-avatar').textContent = (user.full_name || 'L').charAt(0).toUpperCase();

    /* ── Helpers ──────────────────────────────────────────────────────── */
    function announce(msg) { liveRegion.textContent = msg; }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function fileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        if (['pdf'].includes(ext))                    return 'bi-file-earmark-pdf';
        if (['doc','docx','odt'].includes(ext))       return 'bi-file-earmark-word';
        if (['ppt','pptx','odp'].includes(ext))       return 'bi-file-earmark-ppt';
        if (['xls','xlsx','ods'].includes(ext))       return 'bi-file-earmark-excel';
        if (['png','jpg','jpeg','gif','webp'].includes(ext)) return 'bi-file-earmark-image';
        return 'bi-file-earmark';
    }

    function getExt(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(i).toLowerCase() : '';
    }

    /* ── Organization radios ──────────────────────────────────────────── */
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

    /* ── Academic years ───────────────────────────────────────────────── */
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

    /* ── Courses ──────────────────────────────────────────────────────── */
    async function loadCourses() {
        try {
            const courses = await swrGet('catalog', `${API_BASE}/api/courses/`);
            if (!Array.isArray(courses) || courses.length === 0) {
                courseSelect.innerHTML = '<option value="" disabled>No courses available</option>';
                return;
            }
            courseSelect.innerHTML = `
                <option value="" disabled selected>Select a course</option>
                ${courses.map(c => `<option value="${c.id}">${c.title} (${c.code || 'No code'})</option>`).join('')}
            `;
        } catch (err) {
            console.error('Error loading courses:', err);
            courseSelect.innerHTML = '<option value="" disabled>Unable to load courses</option>';
        }
    }

    /* ── Client-side validation ───────────────────────────────────────── */
    function validateFile(file) {
        if (!file) return 'No file selected.';
        const ext = getExt(file.name);
        if (ext && !ALLOWED_EXTS.has(ext)) {
            return `${file.name} is not a supported file type. Upload a PDF, DOCX, PPTX, XLSX, PNG, or JPG.`;
        }
        if (file.size > MAX_SIZE) {
            return `${file.name} is ${formatBytes(file.size)} — the limit is 50 MB. Try compressing the file.`;
        }
        return null;
    }

    function showError(msg) {
        fileError.textContent = msg;
        fileError.hidden = false;
        dropZone.classList.add('drop-zone--error');
        announce('Error: ' + msg);
    }

    function clearError() {
        fileError.textContent = '';
        fileError.hidden = true;
        dropZone.classList.remove('drop-zone--error');
    }

    /* ── File preview ─────────────────────────────────────────────────── */
    function showPreview(file) {
        previewIcon.className = 'bi ' + fileIcon(file.name);
        previewName.textContent = file.name;
        previewSize.textContent = formatBytes(file.size);
        preview.hidden = false;
        dropZone.hidden = true;
        announce(`File selected: ${file.name}, ${formatBytes(file.size)}`);
    }

    function hidePreview() {
        preview.hidden = true;
        dropZone.hidden = false;
        fileInput.value = '';
        clearError();
    }

    function handleFile(file) {
        clearError();
        const err = validateFile(file);
        if (err) {
            showError(err);
            return;
        }
        showPreview(file);
    }

    /* ── Drop zone events ─────────────────────────────────────────────── */
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
    });

    previewRemove.addEventListener('click', hidePreview);

    // Drag-and-drop on the zone
    ['dragenter','dragover'].forEach(evt =>
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drop-zone--active'); })
    );
    ['dragleave','drop'].forEach(evt =>
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drop-zone--active'); })
    );
    dropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        if (file) {
            // Sync the native input so form validation stays consistent
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            handleFile(file);
        }
    });

    // Also allow drag on the whole page (not just the zone)
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) {
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            handleFile(file);
            dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });

    /* ── Upload via XHR with progress ─────────────────────────────────── */
    function uploadWithProgress(formData) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/api/materials/upload`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = pct + '%';
                    progressText.textContent = `Uploading — ${formatBytes(e.loaded)} of ${formatBytes(e.total)}`;
                }
            });

            xhr.addEventListener('load', () => {
                try {
                    const data = JSON.parse(xhr.responseText);
                    resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
                } catch {
                    resolve({ ok: false, status: xhr.status, data: { detail: 'Invalid server response.' } });
                }
            });

            xhr.addEventListener('error', () => reject(new Error('Network error')));
            xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

            xhr.send(formData);
        });
    }

    /* ── Form submit ──────────────────────────────────────────────────── */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const title       = document.getElementById('title').value.trim();
        const description = document.getElementById('description').value.trim();
        const weekNumber  = document.getElementById('week-number').value.trim();
        const unitLabel   = document.getElementById('unit-label').value.trim();
        const organization = document.querySelector('input[name="organization"]:checked')?.value || 'week';
        const courseId    = courseSelect.value;
        const semesterVal = document.getElementById('semester').value;
        const file        = fileInput.files[0];

        if (!title || !courseId || !academicYear.value || !semesterVal || !file) {
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

        // Client-side file validation (guard against bypassed drop-zone checks)
        const fileErr = validateFile(file);
        if (fileErr) { showError(fileErr); return; }

        const semester = `${academicYear.value} - ${semesterVal}`;

        const formData = new FormData();
        formData.append('title', title);
        formData.append('description', description);
        formData.append('course_id', courseId);
        formData.append('semester', semester);
        if (organization === 'week') formData.append('week_number', weekNumber);
        if (organization === 'unit') formData.append('unit_label', unitLabel);
        formData.append('file', file);

        // Show progress, disable button
        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading…';
        progressWrap.hidden = false;
        progressFill.style.width = '0%';
        progressFill.classList.remove('upload-progress__bar-fill--done');
        progressText.textContent = 'Uploading…';
        announce('Upload started.');

        try {
            const { ok, data } = await uploadWithProgress(formData);

            if (ok) {
                progressFill.style.width = '100%';
                progressFill.classList.add('upload-progress__bar-fill--done');
                progressText.textContent = 'Upload complete.';
                announce('Upload complete.');
                showToast('Material uploaded successfully.', 'success');
                invalidateApiCache(`course-materials:${courseId}`);
                showUploadAgainModal();
            } else {
                progressText.textContent = '';
                progressWrap.hidden = true;
                const msg = data.detail || data.message || 'Unknown error';
                showToast('Upload failed: ' + msg, 'error');
                announce('Upload failed: ' + msg);
            }
        } catch (err) {
            console.error('Upload error:', err);
            progressText.textContent = '';
            progressWrap.hidden = true;
            showToast('Upload failed: Server connection error.', 'error');
            announce('Upload failed. Server connection error.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Upload Material';
        }
    });

    /* ── Upload-another modal ─────────────────────────────────────────── */
    function showUploadAgainModal() {
        const modal = document.getElementById('upload-again-modal');

        document.getElementById('upload-again-yes').onclick = () => {
            modal.hidden = true;
            // Preserve course, year, semester — clear everything else
            document.getElementById('title').value = '';
            document.getElementById('description').value = '';
            document.getElementById('week-number').value = '';
            document.getElementById('unit-label').value = '';
            hidePreview();
            progressWrap.hidden = true;
            document.getElementById('title').focus();
            showToast('Ready — upload another file.', 'info');
            announce('Form ready. Upload another file.');
        };

        document.getElementById('upload-again-dashboard').onclick = () => {
            window.location.href = 'dashboard.html';
        };

        document.getElementById('upload-again-close').onclick = () => {
            modal.hidden = true;
            window.location.href = 'dashboard.html';
        };

        modal.addEventListener('click', (e) => {
            if (e.target === modal) window.location.href = 'dashboard.html';
        });

        modal.hidden = false;
    }

    /* ── Init ─────────────────────────────────────────────────────────── */
    loadAcademicYears();
    await loadCourses();
    setupOrganization();
});

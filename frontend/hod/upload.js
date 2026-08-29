/*
   HOD MATERIAL UPLOAD LOGIC
   frontend/hod/upload.js
   Loads courses from Supabase, handles single/multi-file upload via FastAPI backend.
   Features: drag-and-drop, file queue with per-file status, client-side validation,
   sequential XHR upload with progress, live-region announcements, upload-another modal.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('hod').catch(() => null);
    if (!user) return;
    const token = getToken();

    /* ── DOM refs ─────────────────────────────────────────────────────── */
    const courseSelect   = document.getElementById('course-select');
    const form           = document.getElementById('upload-form');
    const academicYear   = document.getElementById('academic-year');
    const fileInput      = document.getElementById('file');
    const dropZone       = document.getElementById('drop-zone');
    const fileError      = document.getElementById('file-error');
    const queueWrap      = document.getElementById('file-queue');
    const queueList      = document.getElementById('file-queue-list');
    const queueCount     = document.getElementById('file-queue-count');
    const queueClear     = document.getElementById('file-queue-clear');
    const progressWrap   = document.getElementById('upload-progress');
    const progressFill   = document.getElementById('upload-progress-fill');
    const progressText   = document.getElementById('upload-progress-text');
    const submitBtn      = document.getElementById('upload-submit');
    const submitText     = document.getElementById('upload-submit-text');
    const btnSpinner     = document.getElementById('btn-spinner');
    const liveRegion     = document.getElementById('upload-live');

    const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
    const ALLOWED_EXTS = new Set([,
        '.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx',
        '.odt','.odp','.ods','.png','.jpg','.jpeg','.gif','.webp',
        '.mp4','.webm','.ogg'
    ]);

    /* ── File queue state ─────────────────────────────────────────────── */
    // Each entry: { file, id, status:'waiting'|'uploading'|'done'|'failed', error?, xhr? }
    let fileQueue = [];
    let queueIdCounter = 0;
    let isUploading = false;

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
        if (['mp4','webm','ogg'].includes(ext))       return 'bi-file-earmark-play';
        return 'bi-file-earmark';
    }

    function getExt(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(i).toLowerCase() : '';
    }

    function titleFromFilename(name) {
        // Remove extension, replace underscores/dots/hyphens with spaces, title-case
        return name.replace(/\.[^.]+$/, '').replace(/[_.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
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
            const courses = await swrGet('my-courses', `${API_BASE}/api/courses/mine`);
            if (!Array.isArray(courses) || courses.length === 0) {
                courseSelect.innerHTML = '<option value="" disabled>No courses assigned to you yet</option>';
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
            return `${file.name} is not a supported file type. Upload a PDF, DOCX, PPTX, XLSX, PNG, JPG, or MP4.`;
        }
        if (file.size > MAX_SIZE) {
            return `${file.name} is ${formatBytes(file.size)} — the limit is 50 MB. Try compressing the file.`;
        }
        return null;
    }

    function clearError() {
        fileError.textContent = '';
        fileError.hidden = true;
        dropZone.classList.remove('drop-zone--error');
    }

    /* ── Queue rendering ──────────────────────────────────────────────── */
    function renderQueue() {
        const total = fileQueue.length;
        queueWrap.hidden = total === 0;
        queueCount.textContent = `${total} file${total !== 1 ? 's' : ''} selected`;

        queueList.innerHTML = fileQueue.map((entry, idx) => {
            const f = entry.file;
            const statusClass = `file-queue__status--${entry.status}`;
            const rowClass = `file-queue__row--${entry.status}`;
            const statusLabel = entry.status === 'waiting' ? 'Waiting'
                : entry.status === 'uploading' ? 'Uploading…'
                : entry.status === 'done' ? 'Done'
                : 'Failed';
            const removeDisabled = entry.status === 'uploading' ? 'disabled' : '';
            const removeHidden = entry.status === 'done' ? 'style="display:none"' : '';

            return `
                <div class="file-queue__row ${rowClass}" data-id="${entry.id}">
                    <i class="bi ${fileIcon(f.name)} file-queue__icon"></i>
                    <div class="file-queue__info">
                        <span class="file-queue__name">${f.name}</span>
                        <span class="file-queue__meta">${formatBytes(f.size)}</span>
                    </div>
                    <div class="file-queue__progress" ${entry.status === 'uploading' ? '' : 'hidden'}>
                        <div class="file-queue__progress-fill" data-progress-id="${entry.id}"></div>
                    </div>
                    <span class="file-queue__status ${statusClass}">${statusLabel}</span>
                    <button type="button" class="file-queue__remove" data-remove-id="${entry.id}"
                            ${removeDisabled} ${removeHidden}
                            aria-label="Remove ${f.name}"><i class="bi bi-x-lg"></i></button>
                </div>`;
        }).join('');

        // Wire remove buttons
        queueList.querySelectorAll('.file-queue__remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.removeId);
                removeFromQueue(id);
            });
        });
    }

    function addToQueue(files) {
        clearError();
        let added = 0;
        let rejected = 0;
        let lastError = '';

        for (const file of files) {
            const err = validateFile(file);
            if (err) {
                rejected++;
                lastError = err;
                continue;
            }
            fileQueue.push({
                file,
                id: ++queueIdCounter,
                status: 'waiting',
            });
            added++;
        }

        renderQueue();

        if (rejected && !added) {
            showToast(lastError, 'error');
            announce('Error: ' + lastError);
        } else if (rejected) {
            const msg = `${rejected} file${rejected > 1 ? 's' : ''} skipped: ${lastError}`;
            showToast(msg, 'warning');
            announce(msg);
        } else {
            announce(`${added} file${added > 1 ? 's' : ''} added to queue.`);
        }
    }

    function removeFromQueue(id) {
        const entry = fileQueue.find(e => e.id === id);
        if (entry && entry.xhr) entry.xhr.abort();
        fileQueue = fileQueue.filter(e => e.id !== id);
        renderQueue();
    }

    function clearQueue() {
        fileQueue.forEach(e => { if (e.xhr) e.xhr.abort(); });
        fileQueue = [];
        renderQueue();
    }

    queueClear.addEventListener('click', clearQueue);

    /* ── Drop zone events ─────────────────────────────────────────────── */
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            addToQueue(fileInput.files);
            fileInput.value = ''; // reset so same file can be re-added
        }
    });

    ['dragenter','dragover'].forEach(evt =>
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drop-zone--active'); })
    );
    ['dragleave','drop'].forEach(evt =>
        dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drop-zone--active'); })
    );
    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length) addToQueue(e.dataTransfer.files);
    });

    // Page-level drop fallback
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) {
            addToQueue(e.dataTransfer.files);
            dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });

    /* ── Upload single file via XHR ───────────────────────────────────── */
    function uploadFile(entry, formData) {
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            entry.xhr = xhr;
            xhr.open('POST', `${API_BASE}/api/materials/upload`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    // Update per-file progress bar
                    const fill = queueList.querySelector(`[data-progress-id="${entry.id}"]`);
                    if (fill) fill.style.width = pct + '%';
                }
            });

            xhr.addEventListener('load', () => {
                entry.xhr = null;
                try {
                    const data = JSON.parse(xhr.responseText);
                    resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
                } catch {
                    resolve({ ok: false, data: { detail: 'Invalid server response.' } });
                }
            });

            xhr.addEventListener('error', () => { entry.xhr = null; resolve({ ok: false, data: { detail: 'Network error.' } }); });
            xhr.addEventListener('abort', () => { entry.xhr = null; resolve({ ok: false, data: { detail: 'Cancelled.' } }); });

            xhr.send(formData);
        });
    }

    /* ── Sequential batch upload ──────────────────────────────────────── */
    async function uploadBatch() {
        const pending = fileQueue.filter(e => e.status === 'waiting' || e.status === 'failed');
        if (!pending.length) return;

        const title       = document.getElementById('title').value.trim();
        const description = document.getElementById('description').value.trim();
        const weekNumber  = document.getElementById('week-number').value.trim();
        const unitLabel   = document.getElementById('unit-label').value.trim();
        const organization = document.querySelector('input[name="organization"]:checked')?.value || 'week';
        const courseId    = courseSelect.value;
        const semesterVal = document.getElementById('semester').value;

        if (!courseId || !academicYear.value || !semesterVal) {
            showToast('Select a course, academic year, and semester.', 'warning');
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
        const total = pending.length;
        let succeeded = 0;
        let failed = 0;

        isUploading = true;
        submitBtn.disabled = true;
        btnSpinner.hidden = false;
        progressWrap.hidden = false;
        progressFill.style.width = '0%';
        progressFill.classList.remove('upload-progress__bar-fill--done');

        for (let i = 0; i < pending.length; i++) {
            const entry = pending[i];
            const fileTitle = title || titleFromFilename(entry.file.name);

            // Update entry status
            entry.status = 'uploading';
            entry.error = null;
            renderQueue();

            // Update overall progress
            const pct = Math.round(((i) / total) * 100);
            progressFill.style.width = pct + '%';
            progressText.textContent = `Uploading ${i + 1} of ${total} — ${entry.file.name}`;
            announce(`Uploading ${i + 1} of ${total}: ${entry.file.name}`);

            // Build FormData
            const formData = new FormData();
            formData.append('title', fileTitle);
            formData.append('description', description);
            formData.append('course_id', courseId);
            formData.append('semester', semester);
            if (organization === 'week') formData.append('week_number', weekNumber);
            if (organization === 'unit') formData.append('unit_label', unitLabel);
            formData.append('file', entry.file);

            const { ok, data } = await uploadFile(entry, formData);

            if (ok) {
                entry.status = 'done';
                succeeded++;
            } else {
                entry.status = 'failed';
                entry.error = data.detail || data.message || 'Upload failed';
                failed++;
            }
            renderQueue();
        }

        // Final progress
        progressFill.style.width = '100%';
        progressFill.classList.add('upload-progress__bar-fill--done');

        isUploading = false;
        submitBtn.disabled = false;
        btnSpinner.hidden = true;

        // Invalidate cache once for the course
        invalidateApiCache(`course-materials:${courseId}`);

        // Summary
        if (failed === 0) {
            progressText.textContent = `${succeeded} file${succeeded !== 1 ? 's' : ''} uploaded.`;
            submitText.textContent = 'Upload Material';
            announce(`Upload complete. ${succeeded} file${succeeded !== 1 ? 's' : ''} uploaded.`);
            showToast(`${succeeded} material${succeeded !== 1 ? 's' : ''} uploaded successfully.`, 'success');
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 900);
        } else {
            progressText.textContent = `${succeeded} of ${total} uploaded. ${failed} failed.`;
            submitText.textContent = 'Retry failed';
            announce(`Upload complete. ${succeeded} of ${total} uploaded. ${failed} failed.`);
            showToast(`${succeeded} of ${total} uploaded. ${failed} failed.`, failed > 0 ? 'warning' : 'success');
        }
    }

    /* ── Form submit ──────────────────────────────────────────────────── */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isUploading) return;

        // If no files in queue, check the native input (single-file fallback)
        if (!fileQueue.length && fileInput.files.length) {
            addToQueue(fileInput.files);
            fileInput.value = '';
        }

        if (!fileQueue.length) {
            showToast('Add at least one file to upload.', 'warning');
            return;
        }

        await uploadBatch();
    });

    /* ── Upload-another modal ─────────────────────────────────────────── */
    function showUploadAgainModal(succeeded, failed) {
        const modal = document.getElementById('upload-again-modal');
        const titleEl = document.getElementById('upload-again-title');
        const bodyEl = document.getElementById('upload-again-body');

        if (failed > 0) {
            titleEl.textContent = 'Upload complete';
            bodyEl.textContent = `${succeeded} file${succeeded !== 1 ? 's' : ''} uploaded. ${failed} failed. Retry failed files or upload more?`;
        } else {
            titleEl.textContent = `${succeeded} material${succeeded !== 1 ? 's' : ''} uploaded`;
            bodyEl.textContent = 'Upload more files to the same course?';
        }

        document.getElementById('upload-again-yes').onclick = () => {
            modal.hidden = true;
            // Remove done files, keep failed ones for retry
            fileQueue = fileQueue.filter(e => e.status === 'failed');
            renderQueue();
            progressWrap.hidden = true;
            submitText.textContent = fileQueue.length ? 'Retry failed' : 'Upload Material';
            document.getElementById('title').value = '';
            document.getElementById('description').value = '';
            document.getElementById('week-number').value = '';
            document.getElementById('unit-label').value = '';
            clearError();
            document.getElementById('title').focus();
            showToast('Ready — add more files or retry failed.', 'info');
            announce('Form ready. Add more files or retry failed uploads.');
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

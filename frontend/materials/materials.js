/*
   MATERIALS VIEWER + ENGAGEMENT CLASSIFICATION + MICRO-QUESTIONS
   frontend/materials/materials.js
   Tracks engagement telemetry, calls Two-Tower Neural Network classification,
   and shows micro-question popups when student is At-Risk.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    initProfilePopup();

    const queryParams = new URLSearchParams(window.location.search);
    const courseId = queryParams.get('id');
    const topicList = document.getElementById('topic-list');
    const materialList = document.getElementById('material-list');
    const contentViewer = document.getElementById('content-viewer');
    const contentPlaceholder = document.getElementById('content-placeholder');
    const materialTitle = document.getElementById('material-title');
    const modal = document.getElementById('micro-question-modal');
    const questionText = document.getElementById('question-text');
    const optionGrid = document.getElementById('option-grid');

    let selectedMaterial = null;
    let courseTitle = '';
    let isEmbeddedContent = false;
    let metrics = { mouseMovements: 0, scrollDepth: 0, clicks: 0, timeSpent: 0, idleTime: 0 };
    let lastActivity = Date.now();
    let isIdle = false;
    let classificationSent = false;

    function detectTopic(title) {
        const t = (title || '').toLowerCase();
        if (t.match(/database|sql|dbms|relational|mongo/)) return 'databases';
        if (t.match(/program|code|algorithm|data structure|java|python|c\+\+|software/)) return 'programming';
        if (t.match(/machine learn|deep learn|neural|ai |artificial|ml |tensorflow/)) return 'machine_learning';
        return 'general';
    }

    function fileTag(m) {
        const type = (m.content_type || '').toLowerCase();
        const url = (m.content_url || '').toLowerCase();
        if (type.startsWith('video/') || /\.(mp4|webm|ogg)$/.test(url)) return 'VID';
        if (type.startsWith('image/') || /\.(jpg|jpeg|png|gif|svg|webp)$/.test(url)) return 'IMG';
        if (type === 'application/pdf' || url.endsWith('.pdf')) return 'PDF';
        const ext = (url.split('?')[0].match(/\.(\w+)$/) || [])[1];
        if (ext) return ext.toUpperCase().slice(0, 4);
        if (type.startsWith('text/')) return 'TXT';
        return 'FILE';
    }

    function updateStatus(status) {
        document.getElementById('engagement-label').textContent = `Status: ${status}`;
        const dot = document.querySelector('.status-dot');
        if (dot) dot.style.background = status === 'Active' ? 'var(--clr-success)' : 'var(--clr-warning)';
    }

    function resetMetrics() {
        metrics = { mouseMovements: 0, scrollDepth: 0, clicks: 0, timeSpent: 0, idleTime: 0 };
        lastActivity = Date.now();
        isIdle = false;
        classificationSent = false;
        updateStatus('Active');
        startQuizReadyTimer();
    }

    function buildTopicList(topics) {
        if (!topicList) return;
        topicList.innerHTML = topics.map((t, i) => `
            <div class="topic-item ${i === 0 ? 'active' : ''}">${t}</div>
        `).join('');
    }

    function renderMaterials(materials) {
        const semesterGroups = new Map();
        (materials || []).forEach(material => {
            const semester = material.semester || 'Unassigned';
            if (!semesterGroups.has(semester)) semesterGroups.set(semester, []);
            semesterGroups.get(semester).push(material);
        });

        const semesterKeys = [...semesterGroups.keys()].sort((a, b) => {
            if (a === 'Unassigned') return 1;
            if (b === 'Unassigned') return -1;
            return a.localeCompare(b);
        });

        const filter = document.getElementById('semester-filter');
        if (filter) {
            const current = filter.value;
            filter.innerHTML = `<option value="all">All semesters</option>` +
                semesterKeys.map(s => `<option value="${s}">${s}</option>`).join('');
            filter.value = semesterKeys.includes(current) ? current : 'all';
        }

        const renderWeekGroups = (items) => {
            const groups = new Map();
            items.forEach(material => {
                let key = 'other';
                if (material.week_number != null) key = `week-${material.week_number}`;
                else if (material.unit_label) key = `unit-${material.unit_label}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(material);
            });

            const sortedKeys = [...groups.keys()].sort((a, b) => {
                if (a === 'other') return 1;
                if (b === 'other') return -1;
                const aIsWeek = a.startsWith('week-');
                const bIsWeek = b.startsWith('week-');
                if (aIsWeek !== bIsWeek) return aIsWeek ? -1 : 1;
                if (aIsWeek) return Number(a.slice(5)) - Number(b.slice(5));
                return a.localeCompare(b);
            });

            const groupLabel = (key) => {
                if (key === 'other') return 'Full course';
                if (key.startsWith('week-')) return `Week ${key.slice(5)}`;
                return key.slice(5);
            };

            return sortedKeys.map(key => `
                <div class="week-group">
                    <div class="week-label">${groupLabel(key)}</div>
                    ${groups.get(key).map(material => `
                        <div class="topic-item material-item" data-id="${material.id}" data-url="${material.content_url}" data-type="${material.content_type || ''}" data-week="${material.week_number != null ? material.week_number : ''}" data-semester="${material.semester || ''}">
                            <strong><span class="file-tag">${fileTag(material)}</span>${material.title}</strong>
                            <p class="material-desc">${material.description || material.content_type || 'Material'}</p>
                        </div>
                    `).join('')}
                </div>
            `).join('');
        };

        materialList.innerHTML = semesterKeys.map(semester => `
            <div class="semester-group" data-semester="${semester}">
                <div class="semester-label">${semester}</div>
                ${renderWeekGroups(semesterGroups.get(semester))}
            </div>
        `).join('');

        if (filter) {
            filter.onchange = () => {
                const value = filter.value;
                document.querySelectorAll('.semester-group').forEach(group => {
                    group.style.display = (value === 'all' || group.dataset.semester === value) ? '' : 'none';
                });
            };
        }

        document.querySelectorAll('.material-item').forEach(item => {
            item.addEventListener('click', () => {
                selectedMaterial = {
                    id: item.dataset.id,
                    url: item.dataset.url,
                    weekNumber: item.dataset.week !== '' ? Number(item.dataset.week) : null,
                    semester: item.dataset.semester || '',
                };
                const downloadBtn = document.getElementById('download-btn');
                if (downloadBtn) downloadBtn.style.display = 'inline-flex';
                resetMetrics();
                materialTitle.textContent = item.querySelector('strong').textContent;

                const target = contentViewer;
                target.innerHTML = '<div class="loading-wrapper"><div class="spinner"></div><p>Loading material...</p></div>';

                const contentType = item.dataset.type || '';
                const fileUrl = item.dataset.url;
                const proxyUrl = `${API_BASE}/api/materials/proxy?url=${encodeURIComponent(fileUrl)}`;
                const lowerUrl = fileUrl.toLowerCase();

                // Content rendered directly in the document (video, image, PDF.js
                // canvases) can have its scroll tracked. Anything inside an iframe
                // (Office viewer, txt/html/unknown) can't, so engagement scoring
                // relies on time + tab visibility instead.
                const isVideo = contentType.startsWith('video/') || !!lowerUrl.match(/\.(mp4|webm|ogg)$/);
                const isImage = contentType.startsWith('image/') || !!lowerUrl.match(/\.(jpg|jpeg|png|gif|svg|webp)$/);
                const isPdf = contentType === 'application/pdf' || lowerUrl.endsWith('.pdf');
                isEmbeddedContent = !isVideo && !isImage && !isPdf;

                // Video files: use <video> tag
                if (isVideo) {
                    target.innerHTML = `<video controls autoplay class="media-embed"><source src="${proxyUrl}" type="${contentType}"></video>`;
                }
                // Image files: use <img> tag
                else if (isImage) {
                    target.innerHTML = `<img src="${proxyUrl}" class="media-embed-img" />`;
                }
                // PDFs: render with PDF.js into the scrollable content area.
                // Native iframe PDF viewers don't touch-scroll reliably on mobile.
                else if (isPdf) {
                    target.innerHTML = '<div class="loading-wrapper"><div class="spinner"></div><p>Rendering PDF...</p></div>';
                    renderPdf(proxyUrl, target);
                }
                // Office docs (ppt, doc, xlsx): use Google Docs viewer for preview, with download option
                else if (lowerUrl.match(/\.(ppt|pptx|doc|docx|xls|xlsx|odp|ods|odt)$/)) {
                    const ext = lowerUrl.split('.').pop().toUpperCase();
                    const viewerUrl = `https://docs.google.com/gview?url=${encodeURIComponent(fileUrl)}&embedded=true`;
                    target.innerHTML = `
                        <div class="material-viewer-card">
                            <div class="material-viewer-header">
                                <span class="file-badge">${ext}</span>
                            </div>
                            <iframe src="${viewerUrl}" class="office-viewer-iframe"></iframe>
                        </div>`;
                }
                // Everything else: try iframe with proxy
                else {
                    const iframe = document.createElement('iframe');
                    iframe.className = 'media-embed';
                    iframe.style.display = 'none';
                    iframe.onload = () => { iframe.style.display = 'block'; };
                    target.innerHTML = '';
                    target.appendChild(iframe);
                    iframe.src = proxyUrl;
                }

                document.querySelectorAll('.material-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
            });
        });
    }

    async function fetchMaterials() {
        if (!courseId) {
            if (contentPlaceholder) contentPlaceholder.innerHTML = '<p>No course selected.</p>';
            return;
        }

        try {
            const res = await authFetch(`${API_BASE}/api/materials/course/${courseId}`);
            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.detail || 'Failed to load materials');
            }
            const data = await res.json();
            courseTitle = data.course_title || data.course_name || '';
            buildTopicList(['Overview', 'Materials']);
            renderMaterials(data.materials || []);
            if ((data.materials || []).length === 0) {
                materialList.innerHTML = '<div class="topic-item">No materials available yet.</div>';
                if (contentPlaceholder) contentPlaceholder.innerHTML = '<p>Materials will appear here once uploaded.</p>';
            }
        } catch (err) {
            console.error('Failed to load course materials:', err);
            materialList.innerHTML = '<div class="topic-item">Unable to load materials.</div>';
            if (contentPlaceholder) contentPlaceholder.innerHTML = `<p>${err.message}</p>`;
        }
    }

    // ── Engagement tracking ──────────────────────────────────────────────────
    // Track mouse, clicks, scroll on parent document
    document.addEventListener('mousemove', () => {
        metrics.mouseMovements++;
        lastActivity = Date.now();
        if (isIdle) { isIdle = false; updateStatus('Active'); }
    });

    document.addEventListener('click', () => { metrics.clicks++; lastActivity = Date.now(); });

    contentViewer.addEventListener('scroll', () => {
        const maxScroll = contentViewer.scrollHeight - contentViewer.clientHeight;
        const scrollPercent = maxScroll > 0 ? (contentViewer.scrollTop / maxScroll) * 100 : 0;
        metrics.scrollDepth = Math.max(metrics.scrollDepth, Math.round(scrollPercent));
        lastActivity = Date.now();

        const ribbonFill = document.getElementById('reading-ribbon-fill');
        if (ribbonFill) ribbonFill.style.height = `${Math.min(100, scrollPercent)}%`;
    });

    // Track tab visibility — counts as idle when tab is hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (!isIdle) { isIdle = true; metrics.idleTime++; updateStatus('Idle'); }
        } else {
            lastActivity = Date.now();
            if (isIdle) { isIdle = false; updateStatus('Active'); }
        }
    });

    // Track window focus/blur
    window.addEventListener('blur', () => {
        if (!isIdle) { isIdle = true; metrics.idleTime++; updateStatus('Idle'); }
    });
    window.addEventListener('focus', () => {
        lastActivity = Date.now();
        if (isIdle) { isIdle = false; updateStatus('Active'); }
    });

    // Track keyboard activity (works even when iframe has focus)
    document.addEventListener('keydown', () => {
        lastActivity = Date.now();
        if (isIdle) { isIdle = false; updateStatus('Active'); }
    });

    setInterval(() => {
        metrics.timeSpent++;
        if (Date.now() - lastActivity > 60000 && !isIdle) {
            isIdle = true;
            metrics.idleTime++;
            updateStatus('Idle');
        }
    }, 5000);

    // Send engagement log every 10 seconds
    setInterval(async () => {
        if (!user || !selectedMaterial) return;
        try {
            const res = await authFetch(`${API_BASE}/api/engagement/log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    student_id: user.id,
                    material_id: selectedMaterial.id,
                    course_id: courseId,
                    mouse_movements: metrics.mouseMovements,
                    scroll_depth: metrics.scrollDepth,
                    clicks: metrics.clicks,
                    time_spent: metrics.timeSpent,
                    idle_time: metrics.idleTime,
                    is_embedded: isEmbeddedContent,
                })
            });
            if (res.ok) {
                const result = await res.json();
                document.getElementById('pulse-bar').style.width = `${result.engagement_score}%`;
                const readingEl = document.getElementById('reading-time');
                if (readingEl) {
                    const mins = Math.floor(metrics.timeSpent / 60);
                    const secs = metrics.timeSpent % 60;
                    readingEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
                }
            }
        } catch (err) {
            console.error('Failed to sync engagement data:', err);
        }
    }, 30000);

    // ── Two-Tower classification (runs once after 60s of activity) ───────────
    async function classifyEngagement() {
        if (classificationSent || !courseId) return;
        classificationSent = true;

        try {
            const res = await authFetch(`${API_BASE}/api/engagement/auto-classify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    student_id: user.id,
                    course_id: courseId,
                    material_id: selectedMaterial?.id || null,
                })
            });

            if (res.ok) {
                const result = await res.json();
                updateStatus(result.engagement_label);
            }
        } catch (err) {
            console.error('Classification error:', err);
        }
    }

    // Trigger classification after 60 seconds of viewing
    setTimeout(classifyEngagement, 60000);

    // ── Micro-Question Popup ──────────────────────────────────────────────────
    let microRetryCount = 0;

    async function generateMicroQuestions(engagementClass) {
        try {
            const activeMatTitle = selectedMaterial ? document.querySelector('.material-item.active strong')?.textContent || '' : '';
            const activeMatDesc = selectedMaterial ? document.querySelector('.material-item.active .material-desc')?.textContent || '' : '';
            const res = await authFetch(`${API_BASE}/api/micro-questions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    student_id: user.id,
                    engagement_class: engagementClass,
                    num_questions: 3,
                    course_id: courseId,
                    material_id: selectedMaterial?.id || null,
                    material_title: activeMatTitle,
                    material_description: activeMatDesc,
                })
            });

            if (!res.ok) throw new Error('Failed to generate questions');
            const data = await res.json();
            showMicroQuestionModal(data);
        } catch (err) {
            console.error('Micro-question error:', err);
        }
    }

    function showMicroQuestionModal(data) {
        const questions = data.questions || [];
        if (questions.length === 0) return;

        let currentQ = 0;
        const collectedAnswers = [];

        function renderQuestion(index) {
            const q = questions[index];
            questionText.textContent = q.question;
            document.getElementById('mq-difficulty').textContent = `Question ${index + 1} of ${questions.length} (${data.difficulty})`;

            optionGrid.innerHTML = q.options.map((opt, i) => `
                <button class="option-btn" data-index="${i}">${opt}</button>
            `).join('');

            let hintEl = document.getElementById('mq-hint');
            if (!hintEl) {
                hintEl = document.createElement('p');
                hintEl.id = 'mq-hint';
                hintEl.className = 'mq-hint';
                optionGrid.after(hintEl);
            }
            hintEl.textContent = '';
            hintEl.style.display = 'none';

            const oldHintBtn = optionGrid.parentElement.querySelector('.mq-hint-btn');
            if (oldHintBtn) oldHintBtn.remove();
            const hintBtn = document.createElement('button');
            hintBtn.type = 'button';
            hintBtn.className = 'mq-hint-btn';
            hintBtn.textContent = 'Show Hint';
            hintBtn.onclick = () => { hintEl.textContent = `Hint: ${q.hint}`; hintEl.style.display = 'block'; };
            optionGrid.after(hintBtn);

            document.querySelectorAll('.option-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const selected = parseInt(btn.dataset.index);
                    collectedAnswers.push({ question_index: q.index, selected_option: selected });

                    document.querySelectorAll('.option-btn').forEach(b => b.style.pointerEvents = 'none');

                    setTimeout(() => {
                        if (currentQ < questions.length - 1) {
                            currentQ++;
                            renderQuestion(currentQ);
                        } else {
                            submitAndShowResults();
                        }
                    }, 600);
                });
            });
        }

        async function submitAndShowResults() {
            questionText.textContent = 'Checking answers...';
            optionGrid.innerHTML = '';
            document.getElementById('mq-hint')?.remove();
            optionGrid.parentElement.querySelector('.mq-hint-btn')?.remove();

            try {
                const res = await authFetch(`${API_BASE}/api/micro-questions/verify`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        student_id: user.id,
                        session_id: data.session_id,
                        answers: collectedAnswers,
                    }),
                });
                const result = await res.json();
                showResults(result);
            } catch (err) {
                questionText.textContent = 'Could not verify answers. Try again later.';
                const closeBtn = document.createElement('button');
                closeBtn.className = 'option-btn';
                closeBtn.textContent = 'Close';
                closeBtn.onclick = () => { modal.style.display = 'none'; };
                optionGrid.appendChild(closeBtn);
            }
        }

        function showResults(result) {
            questionText.textContent = `You got ${result.correct}/${result.total} correct (${result.score}%)`;
            document.getElementById('mq-difficulty').textContent =
                `${result.recommendation}`;

            optionGrid.innerHTML = '';

            result.results.forEach(r => {
                const row = document.createElement('div');
                row.className = 'mq-result-row';
                const q = questions[r.question_index];
                row.innerHTML = `<strong>Q${r.question_index + 1}:</strong> ${q.question}<br>
                    <span class="${r.correct ? 'mq-correct' : 'mq-incorrect'}">${r.correct ? 'Correct' : `Incorrect (Answer: ${q.options[r.correct_option]})`}</span>`;
                optionGrid.appendChild(row);
            });

            const closeBtn = document.createElement('button');
            closeBtn.className = 'option-btn mq-close-btn';
            closeBtn.textContent = result.score >= 50 ? 'Continue Learning' : 'Review Materials';
            closeBtn.style.marginTop = '12px';
            closeBtn.onclick = () => {
                modal.style.display = 'none';
                if (result.score < 50 && microRetryCount < 1) {
                    microRetryCount++;
                    const nextClass = data.difficulty === 'easy' ? 1 : data.difficulty === 'medium' ? 2 : 2;
                    generateMicroQuestions(nextClass);
                }
            };
            optionGrid.appendChild(closeBtn);
        }

        modal.style.display = 'flex';
        renderQuestion(0);
    }

    // Close modal on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    // ── AI Quiz Ready Timer ──────────────────────────────────────────────────
    // After the student has had time to read the material, show a "ready"
    // prompt that links to the AI comprehension quiz for this material.
    const QUIZ_READY_MINUTES = 20;
    let quizReadyTimer = null;
    let quizReadyInterval = null;
    let quizReadyAt = 0;

    function startQuizReadyTimer() {
        stopQuizReadyTimer();
        const hint = document.getElementById('quiz-ready-hint');
        const btn = document.getElementById('quiz-ready-btn');
        if (hint) hint.style.display = 'flex';
        if (btn) btn.style.display = 'none';
        quizReadyAt = Date.now() + QUIZ_READY_MINUTES * 60 * 1000;
        updateQuizCountdown();
        quizReadyTimer = setTimeout(showQuizReadyPrompt, QUIZ_READY_MINUTES * 60 * 1000);
        quizReadyInterval = setInterval(updateQuizCountdown, 1000);
    }

    function stopQuizReadyTimer() {
        if (quizReadyTimer) { clearTimeout(quizReadyTimer); quizReadyTimer = null; }
        if (quizReadyInterval) { clearInterval(quizReadyInterval); quizReadyInterval = null; }
    }

    function updateQuizCountdown() {
        const el = document.getElementById('quiz-countdown');
        if (!el) return;
        const remain = Math.max(0, quizReadyAt - Date.now());
        const min = Math.floor(remain / 60000);
        const sec = Math.floor((remain % 60000) / 1000);
        el.textContent = `Questions ready in ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')} · fresh each attempt`;
    }

    function showQuizReadyPrompt() {
        if (quizReadyInterval) clearInterval(quizReadyInterval);
        const btn = document.getElementById('quiz-ready-btn');
        const countdown = document.getElementById('quiz-countdown');
        if (countdown) countdown.textContent = 'Your comprehension questions are ready!';
        if (btn) btn.style.display = 'inline-block';
        const readyModal = document.getElementById('quiz-ready-modal');
        if (readyModal) readyModal.style.display = 'flex';
    }

    function hideQuizReadyPrompt() {
        const readyModal = document.getElementById('quiz-ready-modal');
        if (readyModal) readyModal.style.display = 'none';
    }

    function startAiQuiz() {
        if (!selectedMaterial) return;
        window.location.href = `../quiz/ai_quiz.html?course_id=${encodeURIComponent(courseId)}&material_id=${encodeURIComponent(selectedMaterial.id)}&title=${encodeURIComponent(materialTitle.textContent)}`;
    }

    // ── Download & auto-generated assignment ─────────────────────────────────
    // Downloading a material through the app records the download server-side
    // so an AI assignment is generated for this student on that material.
    async function triggerAutoGenerate() {
        try {
            await authFetch(`${API_BASE}/api/assignments/auto-generate`, { method: 'POST' });
        } catch (err) {
            console.error('Auto-generate failed:', err);
        }
    }

    async function downloadMaterial() {
        if (!selectedMaterial) return;
        const btn = document.getElementById('download-btn');
        if (btn) btn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/materials/download?id=${encodeURIComponent(selectedMaterial.id)}`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Download failed');
            }
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const filename = (disposition.match(/filename="?([^";]+)"?/) || [])[1] || 'material';
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);
            if (typeof showToast === 'function') {
                showToast('Material downloaded — an AI assignment will be generated for you.', 'success');
            }
            await triggerAutoGenerate();
        } catch (err) {
            console.error('Download error:', err);
            if (typeof showToast === 'function') showToast(err.message || 'Download failed.', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    document.getElementById('download-btn')?.addEventListener('click', downloadMaterial);

    document.getElementById('quiz-ready-btn')?.addEventListener('click', startAiQuiz);
    document.getElementById('quiz-ready-yes')?.addEventListener('click', () => { hideQuizReadyPrompt(); startAiQuiz(); });
    document.getElementById('quiz-ready-no')?.addEventListener('click', hideQuizReadyPrompt);
    document.getElementById('quiz-ready-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('quiz-ready-modal')) hideQuizReadyPrompt();
    });

    // ─── PDF.js rendering ────────────────────────────────────────────────────
    // Renders PDF pages as canvases that stack naturally inside the scrollable
    // .content-area, so PDFs scroll with touch on mobile like images do.
    let pdfjsPromise = null;

    function loadPdfJs() {
        if (!pdfjsPromise) {
            pdfjsPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = '../shared/vendor/pdfjs/pdf.min.js';
                script.onload = () => {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../shared/vendor/pdfjs/pdf.worker.min.js';
                    resolve(window.pdfjsLib);
                };
                script.onerror = () => {
                    pdfjsPromise = null;
                    reject(new Error('Failed to load PDF viewer'));
                };
                document.head.appendChild(script);
            });
        }
        return pdfjsPromise;
    }

    async function renderPdf(url, container) {
        try {
            const lib = await loadPdfJs();
            const pdf = await lib.getDocument({ url }).promise;
            container.innerHTML = '';
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = Math.min(1.5, container.clientWidth / baseViewport.width);
                const dpr = window.devicePixelRatio || 1;
                const viewport = page.getViewport({ scale: scale * dpr });
                const canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                canvas.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                container.appendChild(canvas);
            }
        } catch (err) {
            console.error('PDF render failed:', err);
            container.innerHTML = `
                <div class="pdf-error-card">
                    <p>This PDF could not be rendered in the browser.</p>
                    <a class="btn" href="${url}" download>Download PDF</a>
                </div>`;
        }
    }

    buildTopicList(['Overview']);
    await fetchMaterials();
});

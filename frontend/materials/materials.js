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
    }

    function buildTopicList(topics) {
        topicList.innerHTML = topics.map((t, i) => `
            <div class="topic-item ${i === 0 ? 'active' : ''}">${t}</div>
        `).join('');
    }

    function renderMaterials(materials) {
        materialList.innerHTML = materials.map(material => `
            <div class="topic-item material-item" data-id="${material.id}" data-url="${material.content_url}" data-type="${material.content_type || ''}">
                <strong>${material.title}</strong>
                <p class="material-desc">${material.description || material.content_type || 'Material'}</p>
            </div>
        `).join('');

        document.querySelectorAll('.material-item').forEach(item => {
            item.addEventListener('click', () => {
                selectedMaterial = { id: item.dataset.id, url: item.dataset.url };
                resetMetrics();
                materialTitle.textContent = item.querySelector('strong').textContent;

                const target = contentViewer;
                target.innerHTML = '<div class="loading-wrapper"><div class="spinner"></div><p>Loading material...</p></div>';

                const contentType = item.dataset.type || '';
                const fileUrl = item.dataset.url;
                const proxyUrl = `${API_BASE}/api/materials/proxy?url=${encodeURIComponent(fileUrl)}`;
                const lowerUrl = fileUrl.toLowerCase();

                // Detect embedded content (iframes where we can't track mouse/scroll)
                isEmbeddedContent = contentType === 'application/pdf' || lowerUrl.endsWith('.pdf')
                    || lowerUrl.match(/\.(ppt|pptx|doc|docx|xls|xlsx|odp|ods|odt)$/);

                // Video files: use <video> tag
                if (contentType.startsWith('video/') || lowerUrl.match(/\.(mp4|webm|ogg)$/)) {
                    target.innerHTML = `<video controls autoplay class="media-embed"><source src="${proxyUrl}" type="${contentType}"></video>`;
                }
                // Image files: use <img> tag
                else if (contentType.startsWith('image/') || lowerUrl.match(/\.(jpg|jpeg|png|gif|svg|webp)$/)) {
                    target.innerHTML = `<img src="${proxyUrl}" class="media-embed-img" />`;
                }
                // PDFs: use iframe (browsers render PDFs natively)
                else if (contentType === 'application/pdf' || lowerUrl.endsWith('.pdf')) {
                    const iframe = document.createElement('iframe');
                    iframe.className = 'media-embed';
                    iframe.style.display = 'none';
                    iframe.onload = () => { target.innerHTML = ''; target.appendChild(iframe); iframe.style.display = 'block'; };
                    iframe.src = proxyUrl;
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
                    iframe.onload = () => { target.innerHTML = ''; target.appendChild(iframe); iframe.style.display = 'block'; };
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
        const scrollPercent = (contentViewer.scrollTop / (contentViewer.scrollHeight - contentViewer.clientHeight)) * 100;
        metrics.scrollDepth = Math.max(metrics.scrollDepth, Math.round(scrollPercent));
        lastActivity = Date.now();
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

                // If At-Risk (class 0), trigger micro-question popup after a short delay
                if (result.engagement_class === 0) {
                    setTimeout(() => generateMicroQuestions(result.engagement_class), 3000);
                }
            }
        } catch (err) {
            console.error('Classification error:', err);
        }
    }

    // Trigger classification after 60 seconds of viewing
    setTimeout(classifyEngagement, 60000);

    // ── Micro-Question Popup ──────────────────────────────────────────────────
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
                if (result.score < 50) {
                    generateMicroQuestions(data.difficulty === 'easy' ? 0 : 1);
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

    buildTopicList(['Overview']);
    await fetchMaterials();
});

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
    if (courseId && window.aiTutor) aiTutor.setCourse(courseId); // pre-ground the tutor in this course
    const materialList = document.getElementById('material-list');
    const contentViewer = document.getElementById('content-viewer');
    const contentPlaceholder = document.getElementById('content-placeholder');
    const materialTitle = document.getElementById('material-title');
    const modal = document.getElementById('micro-question-modal');
    const questionText = document.getElementById('question-text');
    const optionGrid = document.getElementById('option-grid');

    // Mobile section switcher: Material | Contents (hidden on desktop via CSS)
    const viewerContainer = document.querySelector('.viewer-container');
    const viewTabs = document.querySelectorAll('.mobile-view-tabs .view-tab');
    viewTabs.forEach(tab => tab.addEventListener('click', () => {
        viewerContainer.dataset.mobileTab = tab.dataset.tab;
        viewTabs.forEach(t => t.classList.toggle('is-active', t === tab));
    }));

    let selectedMaterial = null;
    let courseTitle = '';
    let isEmbeddedContent = false;
    let metrics = { mouseMovements: 0, scrollDepth: 0, clicks: 0, timeSpent: 0, idleTime: 0, highlights: 0 };
    let lastActivity = Date.now();
    let isIdle = false;
    let classificationSent = false;
    let activeSeconds = 0;

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
        const statusWrap = document.querySelector('.engagement-status');
        if (statusWrap) statusWrap.classList.remove('is-waiting');
        const dot = document.querySelector('.status-dot');
        if (dot) dot.style.background = status === 'Active' ? 'var(--clr-success)' : 'var(--clr-warning)';
    }

    function resetMetrics() {
        metrics = { mouseMovements: 0, scrollDepth: 0, clicks: 0, timeSpent: 0, idleTime: 0, highlights: 0 };
        lastActivity = Date.now();
        isIdle = false;
        classificationSent = false;
        activeSeconds = 0;
        updateStatus('Active');
        hideAiInsight();
        setSessionHint('');
        showQuizBeacon();
    }

    // Small guidance line under the highlights count in the Session panel.
    function setSessionHint(text) {
        const el = document.getElementById('session-hint');
        if (!el) return;
        el.textContent = text || '';
        el.style.display = text ? 'block' : 'none';
    }

    // ── AI insight chip ───────────────────────────────────────────────────────
    // The Two-Tower prediction renders as a quiet, non-alarming chip beside
    // the status beacon. It never touches Active/Idle state or the dot color;
    // the full model label stays available on hover for the curious.
    const INSIGHT_COPY = {
        0: { text: 'Needs support', tone: 'low' },
        1: { text: 'Steady progress', tone: 'mid' },
        2: { text: 'On track', tone: 'high' },
    };
    const COMPREHENSION_COPY = ['Low comprehension', 'Moderate comprehension', 'Good comprehension'];

    function showAiInsight(result) {
        const chip = document.getElementById('ai-insight-chip');
        if (!chip) return;
        const eng = INSIGHT_COPY[result.engagement_class] || INSIGHT_COPY[1];
        const comp = COMPREHENSION_COPY[result.comprehension_class] ?? '';
        chip.textContent = `✦ ${eng.text}${comp ? ' · ' + comp : ''}`;
        chip.dataset.tone = eng.tone;
        chip.title = `${result.engagement_label}${result.comprehension_label ? ' — ' + result.comprehension_label : ''} (AI prediction)`;
        chip.style.display = 'inline-flex';
    }

    function hideAiInsight() {
        const chip = document.getElementById('ai-insight-chip');
        if (chip) chip.style.display = 'none';
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
                        <div class="topic-item material-item" data-id="${material.id}" data-url="${material.content_url}" data-render-url="${material.render_url || ''}" data-type="${material.content_type || ''}" data-week="${material.week_number != null ? material.week_number : ''}" data-semester="${material.semester || ''}">
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
                // Office docs may carry a server-generated PDF twin
                // (materials.render_url): it becomes the rendering surface,
                // while downloads keep using the original file.
                const renderUrl = item.dataset.renderUrl || '';
                const fileUrl = item.dataset.url;
                const proxyUrl = `${API_BASE}/api/materials/proxy?url=${encodeURIComponent(renderUrl || fileUrl)}`;
                const lowerUrl = (renderUrl || fileUrl).toLowerCase();

                // Content rendered directly in the document (video, image, PDF.js
                // canvases) can have its scroll tracked. Anything inside an iframe
                // (Office viewer, txt/html/unknown) can't, so engagement scoring
                // relies on time + tab visibility instead.
                const isVideo = contentType.startsWith('video/') || !!lowerUrl.match(/\.(mp4|webm|ogg)$/);
                const isImage = contentType.startsWith('image/') || !!lowerUrl.match(/\.(jpg|jpeg|png|gif|svg|webp)$/);
                const isPdf = !!renderUrl || contentType === 'application/pdf' || lowerUrl.endsWith('.pdf');
                isEmbeddedContent = !isVideo && !isImage && !isPdf;

                // Session-panel hint teaches the highlighting flow where it applies.
                if (isPdf) {
                    setSessionHint('Tip — select any passage to highlight it.');
                } else {
                    setSessionHint('Highlighting is available on PDF materials.');
                }

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
                    const renderToken = ++pdfRenderToken;
                    renderPdf(proxyUrl, target, renderToken).then(() => {
                        if (renderToken === pdfRenderToken) fetchSavedHighlights();
                    });
                }
                // Office docs (ppt, doc, xlsx): Google Docs viewer on desktop.
                // On phones the cross-origin iframe swallows touch events and
                // can't be scrolled, so hand off to the device viewer instead.
                else if (lowerUrl.match(/\.(ppt|pptx|doc|docx|xls|xlsx|odp|ods|odt)$/)) {
                    const ext = lowerUrl.split('.').pop().toUpperCase();
                    if (window.matchMedia('(max-width: 768px)').matches) {
                        const fileName = decodeURIComponent(fileUrl.split('/').pop().split('?')[0]) || 'this material';
                        target.innerHTML = `
                            <div class="material-download-card">
                                <span class="file-badge">${ext}</span>
                                <h3>${fileName}</h3>
                                <p>Inline slide preview isn't reliable on small screens. Open this material in your device's viewer, or download it.</p>
                                <button type="button" class="office-open-btn">Open material</button>
                                <button type="button" class="office-dl-btn"><i class="bi bi-download"></i> Download</button>
                            </div>`;
                        target.querySelector('.office-open-btn').addEventListener('click', () => {
                            window.open(proxyUrl, '_blank', 'noopener');
                        });
                        target.querySelector('.office-dl-btn').addEventListener('click', downloadMaterial);
                    } else {
                        const viewerUrl = `https://docs.google.com/gview?url=${encodeURIComponent(fileUrl)}&embedded=true`;
                        target.innerHTML = `
                            <div class="material-viewer-card">
                                <div class="material-viewer-header">
                                    <span class="file-badge">${ext}</span>
                                </div>
                                <iframe src="${viewerUrl}" class="office-viewer-iframe"></iframe>
                            </div>`;
                    }
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

                // On mobile, jump back to the reading surface so the freshly
                // selected material is visible immediately.
                if (window.matchMedia('(max-width: 768px)').matches) {
                    viewerContainer.dataset.mobileTab = 'material';
                    viewTabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === 'material'));
                }
            });
        });
    }

    async function fetchMaterials() {
        if (!courseId) {
            if (contentPlaceholder) contentPlaceholder.innerHTML = '<p class="content-empty">No course selected.</p>';
            return;
        }

        try {
            await swrGet(`course-materials:${courseId}`, `${API_BASE}/api/materials/course/${courseId}`, data => {
                courseTitle = data.course_title || data.course_name || '';
                renderMaterials(data.materials || []);
                if ((data.materials || []).length === 0) {
                    materialList.innerHTML = '<div class="topic-item">No materials available yet.</div>';
                    if (contentPlaceholder) contentPlaceholder.innerHTML = '<p class="content-empty">Materials will appear here once uploaded.</p>';
                }
            });
        } catch (err) {
            console.error('Failed to load course materials:', err);
            materialList.innerHTML = '<div class="topic-item">Unable to load materials.</div>';
            if (contentPlaceholder) contentPlaceholder.innerHTML = `<p class="content-empty">${err.message}</p>`;
        }
    }

    // ── Engagement tracking (material-area driven) ───────────────────────────
    // Engagement is earned by interacting with the reading surface itself:
    // clicking or scrolling the material flips the session Active. Activity
    // elsewhere on the page (sidebar, header, other tabs) never activates it.
    function markActivity() {
        lastActivity = Date.now();
        if (isIdle) { isIdle = false; updateStatus('Active'); }
    }

    contentViewer.addEventListener('mousemove', () => {
        metrics.mouseMovements++;
        markActivity();
    });

    contentViewer.addEventListener('click', () => {
        metrics.clicks++;
        markActivity();
    });

    // Scroll progress can come from the content pane (desktop app-frame) or
    // from the page itself — track whichever moves.
    function recordScrollProgress() {
        const paneMax = contentViewer.scrollHeight - contentViewer.clientHeight;
        const docMax = document.documentElement.scrollHeight - window.innerHeight;
        const panePct = paneMax > 10 ? (contentViewer.scrollTop / paneMax) * 100 : 0;
        const docPct = docMax > 10 ? (window.scrollY / docMax) * 100 : 0;
        const scrollPercent = Math.max(panePct, docPct);
        metrics.scrollDepth = Math.max(metrics.scrollDepth, Math.round(scrollPercent));
        markActivity();

        const ribbonFill = document.getElementById('reading-ribbon-fill');
        if (ribbonFill) ribbonFill.style.height = `${Math.min(100, scrollPercent)}%`;
    }

    contentViewer.addEventListener('scroll', recordScrollProgress);
    window.addEventListener('scroll', recordScrollProgress, { passive: true });

    // Hidden tab always counts as idle. Coming back does NOT auto-activate —
    // the student re-engages by touching the material again.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && !isIdle) {
            isIdle = true;
            metrics.idleTime++;
            updateStatus('Idle');
        }
    });

    // Embedded viewers (Office docs) swallow all pointer events inside their
    // iframe, so focus moving INTO the iframe is engagement, not idling.
    // For regular content, leaving the window counts as idle.
    window.addEventListener('blur', () => {
        if (!isEmbeddedContent && !isIdle) {
            isIdle = true;
            metrics.idleTime++;
            updateStatus('Idle');
        }
    });

    // Watchdog tick: accrues active time and flips to Idle after a minute
    // without material-area interaction. No countdowns live here.
    setInterval(() => {
        if (!isIdle) metrics.timeSpent++;

        if (document.hidden) return; // visibilitychange already handled it

        // Office-doc iframes swallow every pointer event, so once embedded
        // content idles there is no interaction that can wake it. A visible
        // tab is the only reactivation signal we can observe.
        if (isEmbeddedContent && isIdle) {
            isIdle = false;
            updateStatus('Active');
        }

        if (!isEmbeddedContent && Date.now() - lastActivity > 60000 && !isIdle) {
            // Regular content: no material interaction for a minute -> idle.
            // (Embedded viewers are exempt: focus inside their iframe looks
            // identical to an app switch, so visible tab = on-task.)
            isIdle = true;
            metrics.idleTime++;
            updateStatus('Idle');
        }

        if (!isIdle && selectedMaterial) activeSeconds = metrics.timeSpent;

        // Two-Tower classification fires once 60s of real engagement accrued.
        if (!classificationSent && activeSeconds >= 60) classifyEngagement();
    }, 5000);

    // Send engagement log every 30 seconds
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
                    highlights: metrics.highlights,
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
                showAiInsight(result);
            }
        } catch (err) {
            console.error('Classification error:', err);
        }
    }

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

    // ── Comprehension Check Beacon ────────────────────────────────────────────
    // Always available while a material is open — the student decides when
    // they're ready. No countdown, no pop-ups.
    function showQuizBeacon() {
        const banner = document.getElementById('quiz-ready-hint');
        const btn = document.getElementById('quiz-ready-btn');
        if (banner) banner.style.display = 'flex';
        if (btn) btn.style.display = 'inline-block';
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

    // ─── PDF.js rendering ────────────────────────────────────────────────────
    // Renders PDF pages as canvas + transparent selectable text layer, so PDFs
    // scroll naturally AND support text highlighting. Highlights are stored as
    // percentages of the rendered page, so they repaint correctly at any zoom
    // level, screen size, or device pixel ratio.
    let pdfjsPromise = null;
    let pdfPageRegistry = {};        // page number -> { wrap, hlLayer }
    let activeHighlightGroups = [];  // [{ id, pageNumber, rects, els }]
    let savedHighlights = [];        // rows fetched from the API
    let pdfRenderToken = 0;          // bumped on every selection so a slow render
                                     // of an old material can't clobber the new one

    const HL_COLORS = ['amber', 'green', 'blue'];

    function clearPdfHighlightState() {
        pdfPageRegistry = {};
        activeHighlightGroups = [];
        savedHighlights = [];
        updateHlCount();
    }

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

    async function renderPdf(url, container, token) {
        try {
            const lib = await loadPdfJs();
            const pdf = await lib.getDocument({ url }).promise;
            if (token !== pdfRenderToken) return; // another material was selected
            container.innerHTML = '';
            clearPdfHighlightState();

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                if (token !== pdfRenderToken) return;
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = Math.min(1.5, container.clientWidth / baseViewport.width);
                const dpr = window.devicePixelRatio || 1;
                const viewport = page.getViewport({ scale: scale * dpr });

                const wrap = document.createElement('div');
                wrap.className = 'pdf-page-wrap';
                wrap.dataset.page = i;
                wrap.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;

                const canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);

                // Highlight boxes sit under the text layer: selections always
                // land on text spans, never on the highlight itself.
                const hlLayer = document.createElement('div');
                hlLayer.className = 'pdf-highlight-layer';

                const textLayerDiv = document.createElement('div');
                textLayerDiv.className = 'pdf-text-layer';

                wrap.appendChild(canvas);
                wrap.appendChild(hlLayer);
                wrap.appendChild(textLayerDiv);
                container.appendChild(wrap);

                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                if (token !== pdfRenderToken) return;

                // Text layer uses CSS-pixel scale (no DPR) so its spans line up
                // with the displayed canvas, not its internal resolution.
                const cssViewport = page.getViewport({ scale });
                const textContent = await page.getTextContent();
                const textTask = lib.renderTextLayer({
                    textContentSource: textContent,
                    container: textLayerDiv,
                    viewport: cssViewport,
                });
                await textTask.promise;
                if (token !== pdfRenderToken) return;

                pdfPageRegistry[i] = { wrap, hlLayer };
            }

            paintSavedHighlights();
        } catch (err) {
            console.error('PDF render failed:', err);
            if (token !== pdfRenderToken) return; // superseded — don't clobber
            container.innerHTML = `
                <div class="pdf-error-card">
                    <p>This PDF could not be rendered in the browser.</p>
                    <a class="btn" href="${url}" download>Download PDF</a>
                </div>`;
        }
    }

    // ── Highlight helpers ─────────────────────────────────────────────────────

    // Merge per-span client rects into one box per visual line.
    function mergeLineRects(rects) {
        const sorted = [...rects].sort((a, b) => a.t - b.t || a.l - b.l);
        const lines = [];
        for (const r of sorted) {
            const line = lines.find(L => Math.abs(L.t - r.t) < Math.max(L.h, r.h) * 0.5);
            if (line) {
                const right = Math.max(line.l + line.w, r.l + r.w);
                const bottom = Math.max(line.t + line.h, r.t + r.h);
                line.l = Math.min(line.l, r.l);
                line.t = Math.min(line.t, r.t);
                line.w = right - line.l;
                line.h = bottom - line.t;
            } else {
                lines.push({ l: r.l, t: r.t, w: r.w, h: r.h });
            }
        }
        return lines
            .filter(r => r.w > 0.3 && r.h > 0.2)
            .map(r => ({
                l: +r.l.toFixed(2), t: +r.t.toFixed(2),
                w: +r.w.toFixed(2), h: +r.h.toFixed(2),
            }));
    }

    function paintHighlightGroup(hlLayer, rects, hid, color) {
        const els = [];
        for (const r of rects) {
            const div = document.createElement('div');
            div.className = 'pdf-highlight';
            if (hid) div.dataset.hid = hid;
            if (color && color !== 'amber') div.dataset.color = color;
            div.style.left = `${r.l}%`;
            div.style.top = `${r.t}%`;
            div.style.width = `${r.w}%`;
            div.style.height = `${r.h}%`;
            hlLayer.appendChild(div);
            els.push(div);
        }
        return els;
    }

    function registerHighlightGroup(id, pageNumber, rects, els) {
        activeHighlightGroups.push({ id, pageNumber, rects, els });
    }

    function paintSavedHighlights() {
        for (const h of savedHighlights) {
            const pageInfo = pdfPageRegistry[h.page_number];
            if (!pageInfo) continue;
            const rects = (h.rects || []).map(r => ({ l: r.l, t: r.t, w: r.w, h: r.h }));
            const els = paintHighlightGroup(pageInfo.hlLayer, rects, h.id, h.color);
            registerHighlightGroup(h.id, h.page_number, rects, els);
        }
    }

    async function fetchSavedHighlights() {
        if (!selectedMaterial || !courseId) return;
        try {
            const res = await authFetch(`${API_BASE}/api/highlights/material/${encodeURIComponent(selectedMaterial.id)}`);
            if (!res.ok) return;
            const data = await res.json();
            savedHighlights = data.highlights || [];
            paintSavedHighlights();
            updateHlCount();
        } catch (err) {
            console.error('Failed to load highlights:', err);
        }
    }

    function updateHlCount() {
        const el = document.getElementById('hl-count');
        if (el) el.textContent = `${savedHighlights.length} highlight${savedHighlights.length === 1 ? '' : 's'}`;
        const clearBtn = document.getElementById('hl-clear-btn');
        if (clearBtn) clearBtn.style.display = savedHighlights.length ? 'inline-flex' : 'none';
    }

    // Turn the current text selection into a persisted highlight.
    function commitPdfHighlight(color = 'amber') {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
        if (!selectedMaterial) return;

        const range = selection.getRangeAt(0);
        const anchorEl = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentElement
            : range.commonAncestorContainer;
        const layerEl = anchorEl ? anchorEl.closest('.pdf-text-layer') : null;
        if (!layerEl) return; // selection wasn't on a PDF page

        const wrap = layerEl.closest('.pdf-page-wrap');
        if (!wrap || !pdfPageRegistry[Number(wrap.dataset.page)]) return;
        const pageNumber = Number(wrap.dataset.page);
        const wrapRect = wrap.getBoundingClientRect();

        const raw = [];
        for (const r of range.getClientRects()) {
            if (r.width < 2 || r.height < 2) continue;
            raw.push({
                l: ((r.left - wrapRect.left) / wrapRect.width) * 100,
                t: ((r.top - wrapRect.top) / wrapRect.height) * 100,
                w: (r.width / wrapRect.width) * 100,
                h: (r.height / wrapRect.height) * 100,
            });
        }
        const rects = mergeLineRects(raw);
        if (!rects.length) return;

        const text = selection.toString().trim().slice(0, 2000);
        selection.removeAllRanges();

        // Optimistic paint while the record saves.
        const els = paintHighlightGroup(pdfPageRegistry[pageNumber].hlLayer, rects, null, color);

        authFetch(`${API_BASE}/api/highlights/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                material_id: selectedMaterial.id,
                course_id: courseId,
                page_number: pageNumber,
                rects,
                text,
                color,
            }),
        }).then(async res => {
            if (!res.ok) throw new Error('Save failed');
            const data = await res.json();
            const hid = data.highlight.id;
            els.forEach(el => { el.dataset.hid = hid; });
            savedHighlights.push(data.highlight);
            registerHighlightGroup(hid, pageNumber, rects, els);
            metrics.highlights++;
            updateHlCount();
            markActivity();
        }).catch(err => {
            console.error('Highlight save failed:', err);
            els.forEach(el => el.remove());
            if (typeof showToast === 'function') showToast('Could not save that highlight.', 'error');
        });
    }

    // ── Floating highlight toolbar ────────────────────────────────────────────
    // Selecting PDF text raises a small popup with three color swatches; the
    // highlight is only applied when a swatch is clicked (deliberate action,
    // no accidental marks). Driven by `selectionchange` so it also works on
    // touch devices, where `mouseup` never fires.
    const hlPop = document.createElement('div');
    hlPop.className = 'hl-pop';
    hlPop.innerHTML = `
        <span class="hl-pop-label"><i class="bi bi-highlighter"></i> Highlight</span>
        <div class="hl-pop-swatches">
            ${HL_COLORS.map(c => `<button type="button" class="hl-swatch hl-swatch-${c}" data-color="${c}" aria-label="Highlight in ${c}"></button>`).join('')}
        </div>`;
    document.body.appendChild(hlPop);

    function hideHlPop() {
        hlPop.classList.remove('is-visible');
    }

    function maybeShowHlPop() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideHlPop(); return; }
        const range = sel.getRangeAt(0);
        const anchorEl = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentElement
            : range.commonAncestorContainer;
        if (!anchorEl) { hideHlPop(); return; }
        if (!anchorEl.closest('.pdf-text-layer')) {
            hideHlPop();
            return;
        }

        let rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) {
            for (const r of range.getClientRects()) {
                if (r.width || r.height) { rect = r; break; }
            }
        }
        if (!rect || (!rect.width && !rect.height)) { hideHlPop(); return; }

        hlPop.classList.add('is-visible'); // visible before measuring
        const popRect = hlPop.getBoundingClientRect();
        const left = Math.min(
            Math.max(8, rect.left + rect.width / 2 - popRect.width / 2),
            window.innerWidth - popRect.width - 8
        );
        const above = rect.top - popRect.height - 8;
        hlPop.style.left = `${left}px`;
        hlPop.style.top = `${above > 8 ? above : rect.bottom + 8}px`;
    }

    let hlSelTimer = null;
    document.addEventListener('selectionchange', () => {
        clearTimeout(hlSelTimer);
        hlSelTimer = setTimeout(maybeShowHlPop, 120);
    });
    contentViewer.addEventListener('scroll', hideHlPop, { passive: true });
    window.addEventListener('resize', hideHlPop);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHlPop(); });
    document.addEventListener('pointerdown', (e) => {
        if (!hlPop.contains(e.target)) hideHlPop();
    });
    // Clicking a swatch must not collapse the selection it applies to.
    hlPop.addEventListener('mousedown', (e) => e.preventDefault());

    hlPop.querySelectorAll('.hl-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            commitPdfHighlight(btn.dataset.color);
            hideHlPop();
        });
    });

    // ── Highlight removal: hover a highlighted line → × badge appears ────────
    const hlDelBtn = document.createElement('button');
    hlDelBtn.type = 'button';
    hlDelBtn.className = 'pdf-highlight-del';
    hlDelBtn.setAttribute('aria-label', 'Remove highlight');
    hlDelBtn.innerHTML = '<i class="bi bi-x-lg"></i>';

    let hlDelTarget = null;

    function findHighlightGroupAt(wrap, xPct, yPct) {
        const pageNumber = Number(wrap.dataset.page);
        for (const group of activeHighlightGroups) {
            if (group.pageNumber !== pageNumber) continue;
            for (const r of group.rects) {
                if (xPct >= r.l - 0.4 && xPct <= r.l + r.w + 0.4 &&
                    yPct >= r.t - 0.6 && yPct <= r.t + r.h + 0.6) {
                    return group;
                }
            }
        }
        return null;
    }

    function hideHighlightDelete() {
        hlDelTarget = null;
        hlDelBtn.remove();
    }

    function repositionHighlightDelete(group, wrap) {
        const topRect = [...group.rects].sort((a, b) => a.t - b.t)[0];
        hlDelBtn.style.left = `calc(${Math.min(100, topRect.l + topRect.w)}% + 6px)`;
        hlDelBtn.style.top = `${topRect.t}%`;
    }

    contentViewer.addEventListener('mousemove', (e) => {
        const layerEl = e.target.closest ? e.target.closest('.pdf-text-layer') : null;
        const wrap = layerEl ? layerEl.closest('.pdf-page-wrap') : null;
        if (!wrap) { hideHighlightDelete(); return; }

        const rect = wrap.getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        const group = findHighlightGroupAt(wrap, xPct, yPct);

        if (!group) {
            if (hlDelTarget) hideHighlightDelete();
            return;
        }
        if (hlDelTarget !== group || !hlDelBtn.isConnected) {
            hlDelTarget = group;
            wrap.appendChild(hlDelBtn);
            hlDelBtn.style.display = 'inline-flex';
        }
        repositionHighlightDelete(group, wrap);
    });

    contentViewer.addEventListener('mouseleave', hideHighlightDelete);

    hlDelBtn.addEventListener('click', async () => {
        const group = hlDelTarget;
        if (!group || !group.id) return;
        try {
            const res = await authFetch(`${API_BASE}/api/highlights/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            group.els.forEach(el => el.remove());
            activeHighlightGroups = activeHighlightGroups.filter(g => g !== group);
            savedHighlights = savedHighlights.filter(h => h.id !== group.id);
            updateHlCount();
            hideHighlightDelete();
        } catch (err) {
            console.error('Highlight delete failed:', err);
            if (typeof showToast === 'function') showToast('Could not remove that highlight.', 'error');
        }
    });

    // ── Clear-all highlights (Session panel) ──────────────────────────────────
    const hlClearModal = document.getElementById('hl-clear-modal');
    const hlConfirmBtn = document.getElementById('hl-confirm-btn');

    document.getElementById('hl-clear-btn').addEventListener('click', () => {
        if (!savedHighlights.length) return;
        hlClearModal.style.display = 'flex';
    });
    document.getElementById('hl-cancel-btn').addEventListener('click', () => {
        hlClearModal.style.display = 'none';
    });
    hlClearModal.addEventListener('click', (e) => {
        if (e.target === hlClearModal) hlClearModal.style.display = 'none';
    });

    hlConfirmBtn.addEventListener('click', async () => {
        if (!selectedMaterial) return;
        hlConfirmBtn.disabled = true;
        hlConfirmBtn.textContent = 'Deleting…';
        try {
            const res = await authFetch(`${API_BASE}/api/highlights/material/${encodeURIComponent(selectedMaterial.id)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Clear failed');
            activeHighlightGroups.forEach(g => g.els.forEach(el => el.remove()));
            activeHighlightGroups = [];
            savedHighlights = [];
            metrics.highlights = 0;
            updateHlCount();
            hideHighlightDelete();
            hlClearModal.style.display = 'none';
            if (typeof showToast === 'function') showToast('All highlights removed.', 'success');
        } catch (err) {
            console.error('Highlight clear failed:', err);
            if (typeof showToast === 'function') showToast('Could not clear highlights.', 'error');
        } finally {
            hlConfirmBtn.disabled = false;
            hlConfirmBtn.textContent = 'Delete all';
        }
    });

    await fetchMaterials();
});

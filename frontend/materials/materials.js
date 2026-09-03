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
    const deepLinkMaterialId = queryParams.get('material_id');
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

    // Tablet drawer: on mid-size screens Contents slides over the reading
    // surface instead of squeezing it (769–1100px only, CSS-gated).
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const viewerScrim = document.getElementById('viewer-scrim');
    function setDrawer(open) {
        viewerContainer.classList.toggle('drawer-open', open);
        if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', String(open));
    }
    sidebarToggle?.addEventListener('click', () => {
        setDrawer(!viewerContainer.classList.contains('drawer-open'));
    });
    viewerScrim?.addEventListener('click', () => setDrawer(false));

    let selectedMaterial = null;
    let courseTitle = '';
    let isEmbeddedContent = false;
    let metrics = { mouseMovements: 0, scrollDepth: 0, clicks: 0, timeSpent: 0, idleTime: 0, highlights: 0, videoWatchSeconds: 0, videoCoveragePct: 0, videoSeeks: 0 };
    let lastActivity = Date.now();
    let isIdle = false;
    let classificationSent = false;
    let activeSeconds = 0;
    let activeSinceClassify = 0;   // active seconds accrued since the last classification
    let materialOpenSeconds = 0;   // wall-clock seconds since this material opened (idle or not)

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
        // Final refresh: capture this session's end state before switching
        // away to another material / closing the viewer.
        finalRefresh();
        metrics = { mouseMovements: 0, scrollDepth: 0, clicks: 0, timeSpent: 0, idleTime: 0, highlights: 0, videoWatchSeconds: 0, videoCoveragePct: 0, videoSeeks: 0 };
        lastActivity = Date.now();
        isIdle = false;
        classificationSent = false;
        activeSeconds = 0;
        activeSinceClassify = 0;
        materialOpenSeconds = 0;
        updateStatus('Active');
        hideAiInsight();
        setSessionHint('');
        showQuizBeacon();
    }

    // Best-effort final classification for the session that just ended. Fires
    // on session close to refresh an already-classified session, and also
    // performs the FIRST classification for sessions that never accumulated
    // 60 active seconds (e.g. long-but-passive reading) as long as the
    // material was open for a meaningful amount of time. keepalive lets the
    // request survive page unload; failures are silently ignored.
    function finalRefresh() {
        if (!courseId) return;
        if (classificationSent) {
            if (activeSinceClassify < 60) return;
        } else if (materialOpenSeconds < 60) {
            return;
        }
        const body = JSON.stringify({
            student_id: user.id,
            course_id: courseId,
            material_id: selectedMaterial?.id || null,
        });
        try {
            const headers = { 'Content-Type': 'application/json' };
            const token = typeof getToken === 'function' ? getToken() : null;
            if (token) headers['Authorization'] = `Bearer ${token}`;
            fetch(`${API_BASE}/api/engagement/auto-classify`, {
                method: 'POST',
                headers,
                body,
                keepalive: true,
            }).catch(() => {});
        } catch (err) { /* ignore */ }
    }

    // Small guidance line under the highlights count in the Session panel.
    function setSessionHint(text) {
        const el = document.getElementById('session-hint');
        if (!el) return;        el.textContent = text || '';
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
        chip.textContent = `✦ ${eng.text}${comp ? ' · ' + comp : ''} · AI insight`;
        chip.setAttribute('role', 'link');
        chip.setAttribute('tabindex', '0');
        chip.title = 'Open this AI insight in your inbox, where you can message the assistant.';
        chip.dataset.tone = eng.tone;
        chip.style.display = 'inline-flex';
        if (!chip.dataset.bound) {
            chip.dataset.bound = 'true';
            const openInbox = () => { window.location.href = '../student/inbox.html'; };
            chip.addEventListener('click', openInbox);
            chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInbox(); } });
        }
    }

    function hideAiInsight() {
        const chip = document.getElementById('ai-insight-chip');
        if (chip) chip.style.display = 'none';
    }

    function renderMaterials(materials) {
        // Flattened list: show every material in the course as one plain list,
        // preserving the backend's ordering (semester, then week/unit).
        materialList.innerHTML = (materials || []).map(material => `
            <div class="topic-item material-item" data-id="${material.id}" data-url="${material.content_url}" data-render-url="${material.render_url || ''}" data-type="${material.content_type || ''}" data-week="${material.week_number != null ? material.week_number : ''}" data-semester="${material.semester || ''}">
                <strong><span class="file-tag">${fileTag(material)}</span><span class="material-title">${escapeHtml(material.title)}</span></strong>
                ${material.description ? `<p class="material-desc">${escapeHtml(material.description)}</p>` : ''}
            </div>
        `).join('');

        document.querySelectorAll('.material-item').forEach(item => {
            item.addEventListener('click', () => {
                selectedMaterial = {
                    id: item.dataset.id,
                    url: item.dataset.url,
                    weekNumber: item.dataset.week !== '' ? Number(item.dataset.week) : null,
                    semester: item.dataset.semester || '',
                };

                // Mark the active material and keep it visible in the list.
                document.querySelectorAll('.material-item.active').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                item.scrollIntoView({ block: 'nearest' });

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

                // Selecting any non-PDF material must tear down the PDF renderer
                // state; otherwise stale keyboard shortcuts, highlight observers
                // and the page registry keep acting on the detached document.
                if (!isPdf) clearPdfHighlightState();

                // Session-panel hint teaches the highlighting flow where it applies.
                if (isPdf) {
                    setSessionHint('Tip — select any passage to highlight it.');
                } else {
                    setSessionHint('Highlighting is available on PDF materials.');
                }

                // Video files: native <video> player. Starts paused (browsers
                // block unmuted autoplay and WCAG 1.4.2 forbids it) with a
                // 16:9 shell and an inline download fallback.
                if (isVideo) {
                    const srcTag = contentType
                        ? `<source src="${proxyUrl}" type="${contentType}">`
                        : `<source src="${proxyUrl}">`;
                    target.innerHTML = `
                        <div class="video-shell">
                            <video controls preload="metadata" playsinline class="media-embed">
                                ${srcTag}
                                Your browser cannot play this video. <a href="${fileUrl}" download>Download it instead</a>.
                            </video>
                        </div>`;
                    setupVideoTracking(target.querySelector('video'));
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
                                <h3>${escapeHtml(fileName)}</h3>
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
                } else if (deepLinkMaterialId) {
                    // Deep link from elsewhere (e.g. the Performance page): auto-open
                    // the requested material once the list has rendered.
                    const target = materialList.querySelector(`.material-item[data-id="${deepLinkMaterialId}"]`);
                    if (target) target.click();
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

        syncCurrentPageFromScroll();
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

    // Final refresh on tab/window close (hard close path that never calls
    // resetMetrics). keepalive ensures the request is delivered.
    window.addEventListener('pagehide', () => finalRefresh());

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

        if (!isIdle && selectedMaterial) {
            activeSeconds = metrics.timeSpent;
            activeSinceClassify += 5;
        }

        if (selectedMaterial) {
            materialOpenSeconds += 5;
        }

        // Two-Tower classification: re-fires every 5 minutes of ACTIVE study so
        // the prediction stays fresh against recent quiz/attendance changes.
        // The first classification unlocks earlier - 60 active seconds OR a few
        // minutes of the material being open - so long-but-passive reading (or
        // a mostly-idle tab) still gets labelled instead of never classifying.
        if (selectedMaterial && !isIdle && activeSinceClassify >= 300) {
            classifyEngagement();
        } else if (selectedMaterial && !classificationSent && (activeSeconds >= 60 || materialOpenSeconds >= 300)) {
            classifyEngagement();
        }
    }, 5000);

    // ── Video watch analytics ─────────────────────────────────────────────────
    // Follows the xAPI Video Profile's core idea: what counts is UNIQUE
    // coverage of the footage, not how far the playhead got. `timeupdate`
    // samples are merged into watched intervals; skipping ahead never earns
    // credit for footage that was never actually played.
    let activeVideoEl = null;
    let watchedIntervals = [];   // merged [startSec, endSec] pairs
    let lastSampleT = -1;

    function mergeIntervals(list) {
        const sorted = [...list].sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const iv of sorted) {
            const last = out[out.length - 1];
            if (last && iv[0] <= last[1] + 0.5) {
                last[1] = Math.max(last[1], iv[1]);
            } else {
                out.push([...iv]);
            }
        }
        return out;
    }

    function computeVideoCoverage() {
        if (!activeVideoEl || !activeVideoEl.duration || !isFinite(activeVideoEl.duration)) return 0;
        const watched = watchedIntervals.reduce((s, iv) => s + (iv[1] - iv[0]), 0);
        return Math.min(100, Math.round((watched / activeVideoEl.duration) * 100));
    }

    function setupVideoTracking(video) {
        activeVideoEl = video;
        watchedIntervals = [];
        lastSampleT = -1;

        // Fires ~4x/second while playing only — deltas between consecutive
        // samples are real viewing seconds; a jump >1.5s means a seek, so the
        // skipped stretch is deliberately not counted as watched.
        video.addEventListener('timeupdate', () => {
            const t = video.currentTime;
            if (lastSampleT >= 0 && t > lastSampleT && t - lastSampleT < 1.5) {
                metrics.videoWatchSeconds += t - lastSampleT;
                watchedIntervals.push([lastSampleT, t]);
                watchedIntervals = mergeIntervals(watchedIntervals);
                metrics.videoCoveragePct = computeVideoCoverage();
            }
            lastSampleT = t;
        });

        // Watching a lecture clip IS studying: playback events keep the
        // session status Active just like scrolling a PDF does.
        video.addEventListener('play', markActivity);
        video.addEventListener('play', () => { lastSampleT = video.currentTime; });
        video.addEventListener('pause', () => {
            markActivity();
            metrics.videoCoveragePct = computeVideoCoverage();
        });
        video.addEventListener('seeked', () => {
            metrics.videoSeeks++;
            lastSampleT = video.currentTime;   // don't bridge across the jump
        });
        video.addEventListener('ended', () => {
            metrics.videoCoveragePct = computeVideoCoverage();
        });
    }

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
                    video_watch_seconds: +(metrics.videoWatchSeconds || 0).toFixed(1),
                    video_coverage_pct: metrics.videoCoveragePct || 0,
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

    // ── Two-Tower classification ─────────────────────────────────────────────
    // Fires once 60s of active engagement accrues, then periodically every
    // 5 minutes of active study (and on session close) so the prediction stays
    // fresh against recent quiz/attendance changes. The chip updates live and
    // each row is deduped to the latest per student on the dashboards.
    let classifyInFlight = false;
    async function classifyEngagement() {
        if (classifyInFlight || !courseId) return;
        classifyInFlight = true;
        activeSinceClassify = 0;
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
        } finally {
            classifyInFlight = false;
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
                <button class="option-btn" data-index="${i}">${escapeHtml(opt)}</button>
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
                row.innerHTML = `<strong>Q${r.question_index + 1}:</strong> ${escapeHtml(q.question)}<br>
                    <span class="${r.correct ? 'mq-correct' : 'mq-incorrect'}">${r.correct ? 'Correct' : `Incorrect (Answer: ${escapeHtml(q.options[r.correct_option])})`}</span>`;
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
    //
    // Rendering is LAZY: the layout pass only creates aspect-ratio placeholder
    // boxes (cheap even for 300-page decks), and an IntersectionObserver
    // rasterizes canvas + text layer for pages as they approach the viewport.
    // Zoom multiplies every page's width (horizontal overflow past fit-width)
    // and re-rasterizes what is visible; a ResizeObserver keeps pages crisp
    // when the pane itself resizes.
    let pdfjsPromise = null;
    let pdfDoc = null;               // loaded PDFDocumentProxy
    let pdfPageRegistry = {};        // page number -> { wrap, hlLayer, textLayerDiv, rendered }
    let activeHighlightGroups = [];  // [{ id, pageNumber, rects, els }]
    let savedHighlights = [];        // rows fetched from the API
    let pdfRenderToken = 0;          // bumped on every selection so a slow render
                                     // of an old material can't clobber the new one
    let pdfZoom = 1;                 // 1 = fit width
    let pdfNumPages = 0;
    let currentPdfPage = 1;
    let pdfPageQueue = [];           // page numbers waiting to rasterize
    let pdfRenderingBusy = false;
    let pdfObserver = null;          // IntersectionObserver driving lazy renders
    let pdfResizeTimer = null;

    const HL_COLORS = ['amber', 'green', 'blue'];
    const PDF_ZOOM_STEP = 0.25;
    const PDF_ZOOM_MIN = 0.5;
    const PDF_ZOOM_MAX = 3;
    const PDF_LAZY_MARGIN = '700px 0px';   // start rasterizing just off-screen
    const PDF_TOOLBAR_OFFSET = 56;         // sticky toolbar height + breathing room

    function clearPdfHighlightState() {
        if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
        pdfDoc = null;
        pdfPageRegistry = {};
        pdfPageQueue = [];
        pdfRenderingBusy = false;
        pdfZoom = 1;
        pdfNumPages = 0;
        currentPdfPage = 1;
        activeHighlightGroups = [];
        savedHighlights = [];
        updateHlCount();
        renderHlPanel();
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

    // Layout pass: placeholders for every page + toolbar + lazy observer.
    // Cheap per page (~one div), so even huge lecture decks mount instantly.
    async function renderPdf(url, container, token) {
        try {
            const lib = await loadPdfJs();
            const doc = await lib.getDocument({ url }).promise;
            if (token !== pdfRenderToken) return; // another material was selected
            container.classList.remove('is-zoomed');
            container.innerHTML = '';
            clearPdfHighlightState();

            const firstPage = await doc.getPage(1);
            if (token !== pdfRenderToken) return;
            const baseViewport = firstPage.getViewport({ scale: 1 });

            // State reset done — adopt this document for the lazy renderer.
            pdfDoc = doc;
            pdfNumPages = doc.numPages;

            buildPdfToolbar(container);

            for (let i = 1; i <= pdfNumPages; i++) {
                if (token !== pdfRenderToken) return;

                const wrap = document.createElement('div');
                wrap.className = 'pdf-page-wrap is-placeholder';
                wrap.dataset.page = i;
                wrap.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;

                // Highlight boxes sit under the text layer: selections always
                // land on text spans, never on the highlight itself.
                const hlLayer = document.createElement('div');
                hlLayer.className = 'pdf-highlight-layer';
                wrap.appendChild(hlLayer);

                container.appendChild(wrap);
                pdfPageRegistry[i] = { wrap, hlLayer, textLayerDiv: null, rendered: false };
            }

            setupLazyRendering(container);
            currentPdfPage = 1;
            updatePageIndicator();
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

    function setupLazyRendering(container) {
        pdfObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const n = Number(entry.target.dataset.page);
                if (!pdfPageQueue.includes(n)) pdfPageQueue.push(n);
            }
            pumpPdfQueue();
        }, { root: container, rootMargin: PDF_LAZY_MARGIN });

        for (const info of Object.values(pdfPageRegistry)) {
            pdfObserver.observe(info.wrap);
        }
    }

    // Serial rasterizer so approaching pages paint in order without jank.
    async function pumpPdfQueue() {
        if (pdfRenderingBusy || !pdfDoc) return;
        pdfRenderingBusy = true;
        try {
            while (pdfPageQueue.length) {
                pdfPageQueue.sort((a, b) => a - b);
                const pageNumber = pdfPageQueue.shift();
                const info = pdfPageRegistry[pageNumber];
                if (!info || info.rendered) continue;
                await renderPageContent(pageNumber);
            }
        } finally {
            pdfRenderingBusy = false;
        }
    }

    // Rasterize one page at the current zoom × device pixel ratio and rebuild
    // its selectable text layer. Safe to call again later (idempotent).
    async function renderPageContent(pageNumber) {
        const info = pdfPageRegistry[pageNumber];
        if (!info || !pdfDoc) return;
        const token = pdfRenderToken;
        try {
            const lib = await loadPdfJs();
            const page = await pdfDoc.getPage(pageNumber);
            if (token !== pdfRenderToken) return;

            const baseViewport = page.getViewport({ scale: 1 });
            const cssScale = (contentViewer.clientWidth / baseViewport.width) * pdfZoom;
            const dpr = window.devicePixelRatio || 1;
            const viewport = page.getViewport({ scale: Math.min(4, cssScale * dpr) });

            let canvas = info.wrap.querySelector('canvas');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                info.wrap.prepend(canvas);
            }
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);

            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (token !== pdfRenderToken) return;

            // Text layer uses CSS-pixel scale (no DPR) so its spans line up
            // with the displayed canvas, not its internal resolution.
            const cssViewport = page.getViewport({ scale: cssScale });
            const textContent = await page.getTextContent();
            if (token !== pdfRenderToken) return;

            let tl = info.textLayerDiv;
            if (!tl) {
                tl = document.createElement('div');
                tl.className = 'pdf-text-layer';
                info.wrap.appendChild(tl);
                info.textLayerDiv = tl;
            }
            tl.innerHTML = '';
            // PDF.js v3 sizes its text spans from this variable; without it,
            // selection strips render misaligned with the printed page.
            tl.style.setProperty('--scale-factor', String(cssScale));
            await lib.renderTextLayer({
                textContentSource: textContent,
                container: tl,
                viewport: cssViewport,
            }).promise;
            if (token !== pdfRenderToken) return;

            // Correct the aspect ratio now that the real page size is known
            // (placeholder used page 1's proportions).
            info.wrap.classList.remove('is-placeholder');
            info.wrap.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;
            info.rendered = true;

            paintHighlightsForPage(pageNumber);
        } catch (err) {
            console.error(`PDF page ${pageNumber} failed to render:`, err);
        }
    }

    // Re-rasterize after zoom or container resize. Page wraps keep their
    // aspect ratio, so scroll position survives proportionally.
    function refreshVisiblePdfPages() {
        if (!pdfDoc) return;
        for (const info of Object.values(pdfPageRegistry)) {
            info.rendered = false;
        }
        const visible = visiblePdfPages(PDF_TOOLBAR_OFFSET * 4);
        for (const n of visible) {
            if (!pdfPageQueue.includes(n)) pdfPageQueue.push(n);
        }
        pumpPdfQueue();
    }

    function setPdfZoom(zoom) {
        if (!pdfDoc) return;
        const prevHeight = contentViewer.scrollHeight;
        const prevTop = contentViewer.scrollTop;

        pdfZoom = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom));
        contentViewer.classList.toggle('is-zoomed', pdfZoom > 1.001);
        for (const info of Object.values(pdfPageRegistry)) {
            info.wrap.style.width = `${100 * pdfZoom}%`;
        }
        refreshVisiblePdfPages();
        updateZoomLabel();

        requestAnimationFrame(() => {
            const ratio = prevHeight ? contentViewer.scrollHeight / prevHeight : 1;
            contentViewer.scrollTop = prevTop * ratio;
        });
    }

    // Pages whose boxes intersect [top - margin, bottom + margin] of the pane.
    function visiblePdfPages(marginPx) {
        const viewTop = contentViewer.scrollTop - marginPx;
        const viewBottom = contentViewer.scrollTop + contentViewer.clientHeight + marginPx;
        const hits = [];
        for (const [n, info] of Object.entries(pdfPageRegistry)) {
            const top = info.wrap.offsetTop;
            if (top + info.wrap.offsetHeight >= viewTop && top <= viewBottom) {
                hits.push(Number(n));
            }
        }
        return hits.sort((a, b) => a - b);
    }

    function gotoPdfPage(pageNumber) {
        if (!pdfDoc) return;
        const target = Math.min(pdfNumPages, Math.max(1, pageNumber));
        const info = pdfPageRegistry[target];
        if (!info) return;
        contentViewer.scrollTo({
            top: info.wrap.offsetTop - PDF_TOOLBAR_OFFSET,
            behavior: 'smooth',
        });
    }

    function stepPdfPage(delta) {
        gotoPdfPage(currentPdfPage + delta);
    }

    function updatePageIndicator() {
        const el = document.getElementById('pdf-page-indicator');
        if (!el || !pdfNumPages) return;
        el.textContent = `Page ${currentPdfPage} / ${pdfNumPages}`;
    }

    function syncCurrentPageFromScroll() {
        if (!pdfDoc || !pdfNumPages) return;
        const probe = contentViewer.scrollTop + PDF_TOOLBAR_OFFSET + 24;
        let page = 1;
        for (const [n, info] of Object.entries(pdfPageRegistry)) {
            if (info.wrap.offsetTop <= probe) page = Number(n);
            else break;
        }
        if (page !== currentPdfPage) {
            currentPdfPage = page;
            updatePageIndicator();
        }
    }

    function updateZoomLabel() {
        const btn = document.getElementById('pdf-fit-btn');
        if (btn) btn.textContent = pdfZoom === 1 ? 'Fit' : `${Math.round(pdfZoom * 100)}%`;
    }

    function buildPdfToolbar(container) {
        const bar = document.createElement('div');
        bar.className = 'pdf-toolbar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'PDF reader controls');
        bar.innerHTML = `
            <button type="button" class="pdf-tbtn" data-act="prev" aria-label="Previous page"><i class="bi bi-chevron-up"></i></button>
            <span class="pdf-page-indicator" id="pdf-page-indicator" role="status">Page 1 / ${pdfNumPages}</span>
            <button type="button" class="pdf-tbtn" data-act="next" aria-label="Next page"><i class="bi bi-chevron-down"></i></button>
            <span class="pdf-tsep" aria-hidden="true"></span>
            <button type="button" class="pdf-tbtn" data-act="zoomout" aria-label="Zoom out"><i class="bi bi-zoom-out"></i></button>
            <button type="button" class="pdf-tbtn pdf-tbtn-wide" id="pdf-fit-btn" data-act="fitwidth">Fit</button>
            <button type="button" class="pdf-tbtn" data-act="zoomin" aria-label="Zoom in"><i class="bi bi-zoom-in"></i></button>`;
        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            markActivity();
            switch (btn.dataset.act) {
                case 'prev': stepPdfPage(-1); break;
                case 'next': stepPdfPage(1); break;
                case 'zoomout': setPdfZoom(pdfZoom - PDF_ZOOM_STEP); break;
                case 'zoomin': setPdfZoom(pdfZoom + PDF_ZOOM_STEP); break;
                case 'fitwidth': setPdfZoom(1); break;
            }
        });
        container.appendChild(bar);
    }

    // Keyboard shortcuts (+ / − / f / arrow page jumps) while a PDF is open.
    document.addEventListener('keydown', (e) => {
        if (!pdfDoc || modal.style.display === 'flex') return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        switch (e.key) {
            case '+': case '=': setPdfZoom(pdfZoom + PDF_ZOOM_STEP); break;
            case '-': case '_': setPdfZoom(pdfZoom - PDF_ZOOM_STEP); break;
            case 'f': case '0': setPdfZoom(1); break;
            case 'ArrowLeft': stepPdfPage(-1); break;
            case 'ArrowRight': stepPdfPage(1); break;
            default: return;
        }
        e.preventDefault();
    });

    // Keep pages crisp when the reading pane itself changes size.
    if ('ResizeObserver' in window) {
        new ResizeObserver(() => {
            if (!pdfDoc) return;
            clearTimeout(pdfResizeTimer);
            pdfResizeTimer = setTimeout(() => {
                const prevHeight = contentViewer.scrollHeight;
                const prevTop = contentViewer.scrollTop;
                refreshVisiblePdfPages();
                requestAnimationFrame(() => {
                    const ratio = prevHeight ? contentViewer.scrollHeight / prevHeight : 1;
                    contentViewer.scrollTop = prevTop * ratio;
                });
            }, 250);
        }).observe(contentViewer);
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
        // Only pages that are already rasterized can host boxes; each page
        // paints its own highlights the moment rendering finishes.
        for (const h of savedHighlights) {
            const pageInfo = pdfPageRegistry[h.page_number];
            if (!pageInfo || !pageInfo.rendered) continue;
            if (activeHighlightGroups.some(g => g.id === h.id)) continue;
            const rects = (h.rects || []).map(r => ({ l: r.l, t: r.t, w: r.w, h: r.h }));
            const els = paintHighlightGroup(pageInfo.hlLayer, rects, h.id, h.color);
            registerHighlightGroup(h.id, h.page_number, rects, els);
        }
    }

    function paintHighlightsForPage(pageNumber) {
        for (const h of savedHighlights) {
            if (h.page_number !== pageNumber) continue;
            const pageInfo = pdfPageRegistry[h.page_number];
            if (!pageInfo || !pageInfo.rendered) continue;
            if (activeHighlightGroups.some(g => g.id === h.id)) continue;
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
        renderHlPanel();
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

    // One deletion path shared by the hover × badge, the touch action
    // bubble, and the sidebar highlights panel.
    async function removeHighlightGroup(group) {
        if (!group || !group.id) return false;
        try {
            const res = await authFetch(`${API_BASE}/api/highlights/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            group.els.forEach(el => el.remove());
            activeHighlightGroups = activeHighlightGroups.filter(g => g !== group);
            savedHighlights = savedHighlights.filter(h => h.id !== group.id);
            updateHlCount();
            hideHighlightDelete();
            return true;
        } catch (err) {
            console.error('Highlight delete failed:', err);
            if (typeof showToast === 'function') showToast('Could not remove that highlight.', 'error');
            return false;
        }
    }

    hlDelBtn.addEventListener('click', () => { removeHighlightGroup(hlDelTarget); });

    // ── Touch: tap a highlight → small action bubble ──────────────────────────
    // Hover-dependent × badges don't exist on touch screens; tapping the mark
    // raises a Delete bubble instead (WCAG: every pointer path has an
    // equivalent non-hover path).
    const hlTapPop = document.createElement('div');
    hlTapPop.className = 'hl-tap-pop';
    hlTapPop.innerHTML = `
        <span class="hl-tap-label">Highlight</span>
        <button type="button" class="hl-tap-del"><i class="bi bi-trash3"></i> Remove</button>`;
    document.body.appendChild(hlTapPop);

    function hideHlTapPop() {
        hlTapPop.classList.remove('is-visible');
    }

    contentViewer.addEventListener('click', (e) => {
        const isCoarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        if (!isCoarse) return; // desktop uses the hover × badge

        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return;

        if (hlTapPop.contains(e.target)) return; // its own button handles it

        const wrap = e.target.closest ? e.target.closest('.pdf-page-wrap') : null;
        if (!wrap) { hideHlTapPop(); return; }

        const rect = wrap.getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        const group = findHighlightGroupAt(wrap, xPct, yPct);

        if (!group) { hideHlTapPop(); return; }
        hlTapPop.dataset.hid = group.id;
        hlTapPop.classList.add('is-visible');
        const popRect = hlTapPop.getBoundingClientRect();
        hlTapPop.style.left = `${Math.min(Math.max(8, e.clientX - popRect.width / 2), window.innerWidth - popRect.width - 8)}px`;
        hlTapPop.style.top = `${Math.max(8, e.clientY - popRect.height - 12)}px`;
    });

    hlTapPop.querySelector('.hl-tap-del').addEventListener('click', async () => {
        const id = hlTapPop.dataset.hid;
        const group = activeHighlightGroups.find(g => String(g.id) === String(id));
        hideHlTapPop();
        await removeHighlightGroup(group);
    });
    document.addEventListener('scroll', hideHlTapPop, { passive: true, capture: true });
    window.addEventListener('resize', hideHlTapPop);

    // ── Sidebar "Your highlights" panel ───────────────────────────────────────
    // Keyboard- and screen-reader-accessible surface for every saved mark:
    // snippet + color dot + page tag; click jumps to it, per-row button deletes.
    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function renderHlPanel() {
        const list = document.getElementById('hl-list');
        if (!list) return;
        list.innerHTML = savedHighlights.map(h => {
            const snippet = (h.text || '').trim().slice(0, 90) || 'Highlighted passage';
            return `
                <div class="hl-row" data-id="${escapeHtml(h.id)}" data-color="${escapeHtml(h.color || 'amber')}">
                    <button type="button" class="hl-row-main" aria-label="Go to highlight on page ${Number(h.page_number) || 1}">
                        <span class="hl-dot" aria-hidden="true"></span>
                        <span class="hl-snippet">${escapeHtml(snippet)}</span>
                        <span class="hl-row-page">p${Number(h.page_number) || 1}</span>
                    </button>
                    <button type="button" class="hl-row-del" aria-label="Remove this highlight"><i class="bi bi-x-lg"></i></button>
                </div>`;
        }).join('');
        list.style.display = savedHighlights.length ? '' : 'none';
    }

    document.getElementById('hl-list').addEventListener('click', async (e) => {
        const row = e.target.closest('.hl-row');
        if (!row) return;
        const id = row.dataset.id;
        const group = activeHighlightGroups.find(g => String(g.id) === String(id));

        if (e.target.closest('.hl-row-del')) {
            await removeHighlightGroup(group);
            return;
        }

        // Jump to the highlight and flash it so the eye lands on the mark.
        if (group && pdfDoc) {
            const info = pdfPageRegistry[group.pageNumber];
            if (info) {
                contentViewer.scrollTo({
                    top: info.wrap.offsetTop - PDF_TOOLBAR_OFFSET,
                    behavior: 'smooth',
                });
                group.els.forEach(el => el.classList.add('hl-flash'));
                setTimeout(() => group.els.forEach(el => el.classList.remove('hl-flash')), 1600);
            }
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
        setButtonBusy(hlConfirmBtn, true);
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
            setButtonBusy(hlConfirmBtn, false);
        }
    });

    await fetchMaterials();
});

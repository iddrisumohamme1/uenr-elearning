/* 
   RECOMMENDATIONS MODULE LOGIC
   frontend/recommendations/recommendations.js
   Search-engine style: query in, ranked result rows out.
*/

function escapeHTML(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
        return url || '';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();

    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = user.full_name || 'User';
    const avatarEl = document.querySelector('.user-profile .avatar');
    if (avatarEl) avatarEl.textContent = (user.full_name || 'U').charAt(0).toUpperCase();

    const loadingEl = document.getElementById('loading-state');
    const errorEl = document.getElementById('error-state');
    const errorMsgEl = document.getElementById('error-message');
    const listEl = document.getElementById('recommendations-list');
    const resultsInfoEl = document.getElementById('results-info');
    const relatedSearchesEl = document.getElementById('related-searches');
    const relatedChipsEl = document.getElementById('related-chips');
    const conceptsInput = document.getElementById('weak-concepts');
    const searchForm = document.getElementById('search-form');
    const clearBtn = document.getElementById('clear-search');
    const pendingEl = document.getElementById('pending-recs');
    const pendingListEl = document.getElementById('pending-recs-list');

    const sourceLabels = {
        material: 'Course Material',
        youtube: 'YouTube',
        article: 'Article',
    };

    const sourceIcons = {
        material: 'bi bi-journal-text',
        youtube: 'bi bi-youtube',
        article: 'bi bi-globe2',
    };

    function showLoading() {
        loadingEl.style.display = 'block';
        errorEl.style.display = 'none';
        listEl.innerHTML = '';
        resultsInfoEl.style.display = 'none';
    }

    function showError(msg) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorMsgEl.textContent = msg;
    }

    function showResultsInfo(count, elapsedMs) {
        if (!count) return;
        resultsInfoEl.style.display = 'block';
        resultsInfoEl.textContent =
            `About ${count} ${count === 1 ? 'result' : 'results'} (${(elapsedMs / 1000).toFixed(2)} seconds)`;
    }

    function resourceHref(rec) {
        if (rec.url) return { href: rec.url, external: true };
        if (rec.source === 'material' && rec.course_id) {
            return {
                href: `../materials/materials.html?id=${encodeURIComponent(rec.course_id)}`,
                external: false,
            };
        }
        return { href: '', external: false };
    }

    function renderResultRow(rec) {
        const score = Math.max(0, Math.min(100, Number(rec.similarity_percent) || 0));
        const source = sourceLabels[rec.source] || rec.source || 'Resource';
        const icon = sourceIcons[rec.source] || 'bi bi-file-earmark';
        const link = resourceHref(rec);

        let domain = source;
        let path = '';
        if (rec.source === 'youtube' && rec.url) {
            domain = 'YouTube';
            path = extractDomain(rec.url);
        } else if (rec.source === 'article' && rec.url) {
            domain = extractDomain(rec.url);
        } else if (rec.source === 'material' && rec.course_name) {
            domain = 'Course Materials';
            path = rec.course_name;
        } else if (rec.source === 'material') {
            domain = 'Course Materials';
        }

        const title = link.href
            ? `<a class="result-title" href="${escapeHTML(link.href)}"${link.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHTML(rec.title)}</a>`
            : `<h3 class="result-title">${escapeHTML(rec.title)}</h3>`;

        const snippet = rec.description && rec.description !== rec.title
            ? `<p class="result-snippet">${escapeHTML(rec.description)}</p>`
            : '';

        const reason = rec.reason
            ? `<p class="result-reason">${escapeHTML(rec.reason)}</p>`
            : '';

        const matchBar = score > 0 ? `
            <span class="result-match">
                <span class="match-label">Match</span>
                <span class="match-bar"><span class="match-fill" style="width:${score}%"></span></span>
                <span class="match-value">${score.toFixed(0)}%</span>
            </span>` : '';

        return `
            <div class="search-result">
                <div class="result-domain-row">
                    <span class="result-domain"><i class="${icon}" aria-hidden="true"></i>${escapeHTML(domain)}</span>
                    ${path ? `<span class="result-path">${escapeHTML(path)}</span>` : ''}
                </div>
                ${title}
                ${reason}
                ${snippet}
                ${matchBar ? `<div class="result-meta">${matchBar}</div>` : ''}
            </div>
        `;
    }

    function renderResults(recs) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'none';
        if (!recs.length) {
            resultsInfoEl.style.display = 'none';
            listEl.innerHTML = `
                <p class="text-muted">No results found for "<strong>${escapeHTML(conceptsInput.value.trim())}</strong>".</p>
                <p class="text-muted" style="margin-top:0.5rem">Try a different topic, or click one of the related searches above.</p>`;
            return;
        }
        listEl.innerHTML = recs.map(renderResultRow).join('');
    }

    async function runSearch() {
        const concepts = conceptsInput.value.trim();
        if (!concepts) {
            showError('Type a topic you need help with, or pick a related search below.');
            return;
        }

        showLoading();
        const startedAt = performance.now();
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ student_id: user.id, weak_concepts: concepts, top_n: 5 })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.detail || 'Failed to get recommendations');
            }
            const data = await res.json();
            const recs = data.recommendations || [];
            renderResults(recs);
            showResultsInfo(recs.length, performance.now() - startedAt);
        } catch (err) {
            console.error('Error loading recommendations:', err);
            showError(err.message || 'Unable to load recommendations.');
        }
    }

    function renderRelatedChips(topics) {
        if (!topics || !topics.length) {
            relatedSearchesEl.style.display = 'none';
            return;
        }
        relatedSearchesEl.style.display = 'flex';
        relatedChipsEl.innerHTML = topics.map(t => `
            <button type="button" class="related-chip" data-topic="${escapeHTML(t.topic)}"
                    title="Average score: ${escapeHTML(String(t.avg_score))}%">
                ${escapeHTML(t.label)}<span class="related-chip-score">${escapeHTML(String(t.avg_score))}%</span>
            </button>
        `).join('');
        relatedChipsEl.querySelectorAll('.related-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                conceptsInput.value = chip.dataset.topic;
                runSearch();
            });
        });
    }

    async function loadAutoDetection() {
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/auto`);
            if (!res.ok) return;
            const data = await res.json();
            renderRelatedChips(data.weak_topics || []);
        } catch (err) {
            console.error('Auto-detection failed:', err);
        }
    }

    async function loadPendingRecommendations() {
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/notifications`);
            if (!res.ok) return;
            const data = await res.json();
            const items = data.items || [];
            if (items.length) {
                pendingEl.style.display = 'block';
                pendingListEl.innerHTML = items.map(n => {
                    const rec = {
                        url: n.resource_url || '',
                        source: n.resource_source,
                        course_id: n.course_id,
                        course_name: n.course_name || '',
                        title: n.resource_title,
                        description: n.resource_description,
                        reason: n.reason,
                    };
                    return renderResultRow(rec);
                }).join('');
            }
            // Once surfaced to the student, clear the unread badge.
            await authFetch(`${API_BASE}/api/recommendations/notifications/read`, { method: 'POST' });
        } catch (err) {
            console.error('Failed to load pending recommendations:', err);
        }
    }

    /* ------------------------- AI TUTOR (Q&A) ------------------------- */

    const tutorThread = document.getElementById('tutor-thread');
    const tutorForm = document.getElementById('tutor-form');
    const tutorInput = document.getElementById('tutor-input');
    const tutorSend = document.getElementById('tutor-send');
    const tutorCourse = document.getElementById('tutor-course');
    const tutorError = document.getElementById('tutor-error');
    const tutorFab = document.getElementById('tutor-fab');
    const tutorPopup = document.getElementById('tutor-popup');
    const tutorClose = document.getElementById('tutor-close');

    function openTutor() {
        tutorPopup.classList.add('open');
        tutorPopup.setAttribute('aria-hidden', 'false');
        tutorInput.focus();
    }

    function closeTutor() {
        tutorPopup.classList.remove('open');
        tutorPopup.setAttribute('aria-hidden', 'true');
    }

    tutorFab.addEventListener('click', openTutor);
    tutorClose.addEventListener('click', closeTutor);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeTutor();
    });

    async function loadTutorCourses() {
        try {
            const res = await authFetch(`${API_BASE}/api/students/${user.id}/courses`);
            if (!res.ok) return;
            const courses = await res.json();
            if (!courses || !courses.length) return;
            tutorCourse.innerHTML = '<option value="">General (any topic)</option>' +
                courses.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.title)}</option>`).join('');
        } catch (err) {
            console.error('Failed to load tutor course list:', err);
        }
    }

    function appendTutorBubble(text, isUser) {
        const bubble = document.createElement('div');
        bubble.className = `tutor-bubble ${isUser ? 'tutor-bubble-user' : 'tutor-bubble-ai'}`;
        bubble.innerHTML = escapeHTML(text).replace(/\n/g, '<br>');
        tutorThread.appendChild(bubble);
        tutorThread.scrollTop = tutorThread.scrollHeight;
        return bubble;
    }

    function showTutorError(msg) {
        tutorError.textContent = msg;
        tutorError.style.display = 'block';
    }

    function hideTutorError() {
        tutorError.style.display = 'none';
    }

    async function sendTutorQuestion() {
        const question = tutorInput.value.trim();
        if (!question || tutorSend.disabled) return;

        hideTutorError();
        appendTutorBubble(question, true);
        tutorInput.value = '';

        const loading = document.createElement('div');
        loading.className = 'tutor-bubble tutor-bubble-ai tutor-loading';
        loading.innerHTML = '<span class="spinner"></span><span>Thinking...</span>';
        tutorThread.appendChild(loading);
        tutorThread.scrollTop = tutorThread.scrollHeight;

        tutorSend.disabled = true;
        tutorSend.querySelector('i').className = 'bi bi-hourglass-split';
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question,
                    course_id: tutorCourse.value || null,
                })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.detail || 'The AI tutor could not answer right now.');
            }
            const data = await res.json();
            loading.remove();
            appendTutorBubble(data.answer || 'No answer received.', false);
        } catch (err) {
            loading.remove();
            showTutorError(err.message || 'Unable to reach the AI tutor.');
            tutorInput.value = question;
        } finally {
            tutorSend.disabled = false;
            tutorSend.querySelector('i').className = 'bi bi-send';
            tutorInput.focus();
        }
    }

    tutorForm.addEventListener('submit', e => {
        e.preventDefault();
        sendTutorQuestion();
    });

    searchForm.addEventListener('submit', e => {
        e.preventDefault();
        runSearch();
    });

    conceptsInput.addEventListener('input', () => {
        clearBtn.style.display = conceptsInput.value ? 'flex' : 'none';
    });
    clearBtn.style.display = 'none';
    clearBtn.addEventListener('click', () => {
        conceptsInput.value = '';
        clearBtn.style.display = 'none';
        conceptsInput.focus();
    });

    loadPendingRecommendations();
    loadAutoDetection();
    loadTutorCourses();
});

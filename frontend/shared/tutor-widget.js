/*
 * ==============================================================================
 * SHARED AI TUTOR WIDGET
 * ==============================================================================
 * File: frontend/shared/tutor-widget.js
 * Purpose: Reusable floating "Ask the AI Tutor" chat. Injects its own markup
 *          and stylesheet, so any student page only needs:
 *
 *              <script src="../shared/session.js"></script>   (must come first)
 *              <script src="../shared/tutor-widget.js"></script>
 *
 *          Optional course grounding from a page that knows its course:
 *              window.aiTutor.setCourse('<course-id>');
 *          The tutor opens pre-grounded in that course; students can still
 *          switch the "Grounded in" dropdown to any of their courses.
 *
 * Requires: session.js (requireSession / authFetch / API_BASE globals).
 * Backend:  POST /api/recommendations/ask { question, course_id }.
 * ==============================================================================
 */

(function () {
    'use strict';

    /* Inject stylesheet once */
    if (!document.querySelector('link[href*="tutor.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '../shared/tutor.css?v=2';
        document.head.appendChild(link);
    }

    let booted = false;
    let pendingCourseId = '';
    const els = {};

    function escapeHTML(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(str).replace(/[&<>"']/g, function (c) { return map[c]; });
    }

    const MARKUP = `
        <div id="tutor-popup" class="tutor-popup" aria-hidden="true" role="dialog" aria-label="Ask the AI tutor">
            <div class="tutor-popup-header">
                <h2 class="tutor-chat-title"><i class="bi bi-robot" aria-hidden="true"></i> Ask the AI Tutor</h2>
                <button type="button" id="tutor-close" class="tutor-close" aria-label="Close AI tutor">
                    <i class="bi bi-x-lg"></i>
                </button>
            </div>
            <div class="tutor-chat-controls">
                <label class="tutor-course-label" for="tutor-course">Grounded in</label>
                <select id="tutor-course" class="tutor-course-select" data-dropdown data-dropdown-size="sm" aria-label="Course context">
                    <option value="">General (any topic)</option>
                </select>
            </div>
            <div id="tutor-thread" class="tutor-thread" aria-live="polite">
                <div class="tutor-bubble tutor-bubble-ai">
                    Hi! I'm your AI tutor. Ask me anything about your courses — I'll explain it clearly.
                </div>
            </div>
            <div id="tutor-error" class="tutor-error" style="display:none"></div>
            <form id="tutor-form" class="tutor-form" role="search">
                <input id="tutor-input" type="text" placeholder="Type your question..." autocomplete="off" spellcheck="false" aria-label="Ask the AI tutor" />
                <button type="submit" id="tutor-send" class="tutor-send" aria-label="Send question">
                    <i class="bi bi-send"></i>
                </button>
            </form>
        </div>

        <button type="button" id="tutor-fab" class="tutor-fab" aria-label="Open AI tutor" title="Ask the AI Tutor">
            <i class="bi bi-robot" aria-hidden="true"></i>
        </button>`;

    /* ------------------------------ behaviour ------------------------------ */

    function openTutor() {
        els.popup.classList.add('open');
        els.popup.setAttribute('aria-hidden', 'false');
        els.input.focus();
    }

    function closeTutor() {
        els.popup.classList.remove('open');
        els.popup.setAttribute('aria-hidden', 'true');
    }

    function appendBubble(text, isUser) {
        const bubble = document.createElement('div');
        bubble.className = `tutor-bubble ${isUser ? 'tutor-bubble-user' : 'tutor-bubble-ai'}`;
        bubble.innerHTML = escapeHTML(text).replace(/\n/g, '<br>');
        els.thread.appendChild(bubble);
        els.thread.scrollTop = els.thread.scrollHeight;
        return bubble;
    }

    function showError(msg) {
        els.error.textContent = msg;
        els.error.style.display = 'block';
    }

    function hideError() {
        els.error.style.display = 'none';
    }

    /* Apply a page-requested course once the options list can hold it. */
    function applyCourseSelection() {
        if (!els.course) return;
        const has = Array.from(els.course.options).some(o => o.value === pendingCourseId);
        els.course.value = has ? pendingCourseId : '';
        if (window.Dropdowns && els.course._ddBuild) els.course._ddBuild();
    }

    async function loadCourses(user) {
        try {
            const res = await authFetch(`${API_BASE}/api/students/${user.id}/courses`);
            if (!res.ok) return;
            const courses = await res.json();
            if (!courses || !courses.length) return;
            els.course.innerHTML = '<option value="">General (any topic)</option>' +
                courses.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.title)}</option>`).join('');
            applyCourseSelection();
        } catch (err) {
            console.error('[ai-tutor] Failed to load course list:', err);
        }
    }

    async function sendQuestion() {
        const question = els.input.value.trim();
        if (!question || els.send.disabled) return;

        hideError();
        appendBubble(question, true);
        els.input.value = '';

        const loading = document.createElement('div');
        loading.className = 'tutor-bubble tutor-bubble-ai tutor-loading';
        loading.innerHTML = '<span class="spinner"></span><span>Thinking...</span>';
        els.thread.appendChild(loading);
        els.thread.scrollTop = els.thread.scrollHeight;

        els.send.disabled = true;
        els.send.querySelector('i').className = 'bi bi-hourglass-split';
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question,
                    course_id: els.course.value || null,
                })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.detail || 'The AI tutor could not answer right now.');
            }
            const data = await res.json();
            loading.remove();
            appendBubble(data.answer || 'No answer received.', false);
        } catch (err) {
            loading.remove();
            showError(err.message || 'Unable to reach the AI tutor.');
            els.input.value = question;
        } finally {
            els.send.disabled = false;
            els.send.querySelector('i').className = 'bi bi-send';
            els.input.focus();
        }
    }

    /* -------------------------------- boot --------------------------------- */

    function boot(user) {
        if (booted) return;
        booted = true;

        const holder = document.createElement('div');
        holder.innerHTML = MARKUP.trim();
        while (holder.firstChild) document.body.appendChild(holder.firstChild);

        els.popup = document.getElementById('tutor-popup');
        els.fab = document.getElementById('tutor-fab');
        els.closeBtn = document.getElementById('tutor-close');
        els.thread = document.getElementById('tutor-thread');
        els.form = document.getElementById('tutor-form');
        els.input = document.getElementById('tutor-input');
        els.send = document.getElementById('tutor-send');
        els.course = document.getElementById('tutor-course');
        els.error = document.getElementById('tutor-error');

        els.fab.addEventListener('click', openTutor);
        els.closeBtn.addEventListener('click', closeTutor);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeTutor();
        });
        els.form.addEventListener('submit', e => {
            e.preventDefault();
            sendQuestion();
        });

        loadCourses(user);
    }

    /* Public API: pages with course context pre-ground the tutor. */
    window.aiTutor = {
        setCourse(courseId) {
            pendingCourseId = courseId || '';
            if (booted) applyCourseSelection();
        }
    };

    function start() {
        // session.js provides these as global bindings — bail silently if absent.
        if (typeof requireSession !== 'function' ||
            typeof authFetch !== 'function' ||
            typeof API_BASE === 'undefined') {
            console.warn('[ai-tutor] session.js not loaded; tutor disabled.');
            return;
        }
        // Only students get the tutor; requireSession redirects anyone else.
        requireSession('student').then(boot).catch(() => { /* redirected */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();

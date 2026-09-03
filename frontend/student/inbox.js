/* 
   STUDENT INBOX PAGE LOGIC
   frontend/student/inbox.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.querySelector('.avatar').textContent = user.full_name.charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    const listEl = document.getElementById('message-list');
    let courseNames = {};

    function fmtTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        if (sameDay) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    // Render the AI assistant's plain-text output as structured, styled parts.
    function renderAiContent(content) {
        const headerRe = /^[📘📝📄🤖]/;
        const lines = String(content || '').split('\n');
        const out = [];
        let list = [];

        const flushList = () => {
            if (list.length) {
                out.push(`<ul class="ai-list">${list.map(li => `<li>${escapeHTML(li)}</li>`).join('')}</ul>`);
                list = [];
            }
        };

        lines.forEach((raw) => {
            const line = raw.replace(/\s+$/, '');
            const trimmed = line.trim();
            if (!trimmed) return;
            if (trimmed.startsWith('•')) {
                list.push(trimmed.replace(/^•\s*/, '').trim());
                return;
            }
            flushList();
            if (headerRe.test(trimmed)) {
                out.push(`<div class="ai-h"><i class="bi bi-sparkles" aria-hidden="true"></i>${escapeHTML(trimmed)}</div>`);
            } else if (trimmed.startsWith('Assessment standing:') || trimmed.startsWith('Your current learning profile:')) {
                out.push(`<div class="ai-note">${escapeHTML(trimmed)}</div>`);
            } else {
                out.push(`<p class="ai-p">${escapeHTML(trimmed)}</p>`);
            }
        });
        flushList();
        return out.join('');
    }

    async function loadCourseNames() {
        try {
            await swrGet('my-courses', `${API_BASE}/api/students/${user.id}/courses`, courses => {
                courses.forEach(c => { if (c.id) courseNames[c.id] = c.title; });
            });
        } catch (err) { /* optional enrichment */ }
    }

    async function markRead(id, itemEl) {
        try {
            await authFetch(`${API_BASE}/api/messages/read/${id}`, { method: 'POST' });
            // Keep the session cache consistent so a revisit doesn't flash
            // this message as unread again.
            const cached = cachedRead('inbox');
            if (cached && Array.isArray(cached.messages)) {
                const msg = cached.messages.find(m => String(m.id) === String(id));
                if (msg) msg.is_read = true;
                cachedWrite('inbox', cached);
            }
            invalidateApiCache('nav-unread');
            itemEl.classList.remove('unread');
            itemEl.querySelector('.message-dot').textContent = '';
            const btn = itemEl.querySelector('.message-mark-read');
            if (btn) btn.remove();
            const inboxLink = document.querySelector('.nav-link[href*="inbox.html"]');
            const badge = inboxLink && inboxLink.querySelector('.nav-badge');
            if (badge) {
                const next = parseInt(badge.textContent, 10) - 1;
                if (next > 0) badge.textContent = next > 9 ? '9+' : next;
                else badge.remove();
            }
        } catch (err) { /* non-blocking */ }
    }

    function renderMessages(messages) {
        if (!messages.length) {
            listEl.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>No messages yet. Lecturers will message you here with feedback and study advice.</p></div>';
            return;
        }

        listEl.innerHTML = messages.map((m, i) => {
                const sender = (m.users && m.users.full_name) || 'Your lecturer';
                const isAI = m.users && m.users.role === 'assistant';
                const initial = sender.charAt(0).toUpperCase();
                const courseLabel = m.course_id && courseNames[m.course_id] ? courseNames[m.course_id] : '';
                return `
                <div class="message-item ${m.is_read ? '' : 'unread'} ${isAI ? 'is-ai' : ''}" data-id="${m.id}" style="animation-delay: ${i * 50}ms">
                    <div class="message-avatar">${isAI ? '<i class="bi bi-robot"></i>' : initial}</div>
                    <div class="message-body">
                        <div class="message-head">
                            <div>
                                <span class="message-sender">${isAI ? 'AI Insight Assistant' : escapeHTML(sender)}${isAI ? '<span class="ai-tag">AI</span>' : ''}</span>
                                ${courseLabel ? `<span class="message-course">${escapeHTML(courseLabel)}</span>` : ''}
                            </div>
                            <span class="message-time">${fmtTime(m.created_at)}</span>
                        </div>
                        ${isAI ? `<div class="ai-content">${renderAiContent(m.content)}</div>` : `<p class="message-text">${escapeHTML(m.content)}</p>`}
                        ${isAI ? renderReplyBox(m) : ''}
                    </div>
                    ${m.is_read ? '' : `<button class="message-mark-read" data-id="${m.id}" title="Mark as read"><i class="bi bi-check2-all"></i> Mark read</button>`}
                    <span class="message-dot">${m.is_read ? '' : '●'}</span>
                </div>`;
            }).join('');

        listEl.querySelectorAll('.message-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                item.classList.toggle('open');
                if (item.classList.contains('unread')) markRead(id, item);
            });
        });

        listEl.querySelectorAll('.message-mark-read').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = listEl.querySelector(`.message-item[data-id="${btn.dataset.id}"]`);
                if (item) markRead(btn.dataset.id, item);
            });
        });

        bindAiReplies();
    }

    function renderReplyBox(m) {
        return `
            <div class="ai-reply" data-course="${m.course_id || ''}">
                <textarea class="ai-reply-input" rows="2" placeholder="Ask the AI assistant a question about this course..."></textarea>
                <button class="ai-reply-send" type="button"><span class="btn-label"><i class="bi bi-send"></i> Reply</span><span class="btn-spinner" hidden></span></button>
                <span class="ai-reply-status" style="display:none"></span>
            </div>`;
    }

    function bindAiReplies() {
        listEl.querySelectorAll('.message-item.is-ai .ai-reply').forEach(box => {
            const btn = box.querySelector('.ai-reply-send');
            const input = box.querySelector('.ai-reply-input');
            const status = box.querySelector('.ai-reply-status');
            const courseId = box.dataset.course;

            const send = async () => {
                const text = input.value.trim();
                if (!text) return;
                setButtonBusy(btn, true);
                status.style.display = 'none';
                try {
                    const res = await authFetch(`${API_BASE}/api/messages/ai/reply`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ course_id: courseId || null, message: text })
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || 'Reply failed');
                    }
                    // Insert the sent question + AI answer into the inbox and refresh.
                    const data = await res.json();
                    invalidateApiCache('inbox');
                    await loadMessages();
                    showToast('AI replied.', 'success');
                } catch (err) {
                    status.textContent = err.message || 'Could not send. Try again.';
                } finally {
                    setButtonBusy(btn, false);
                }
            };

            btn.addEventListener('click', (e) => { e.stopPropagation(); send(); });
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            });
        });
    }

    async function loadMessages() {
        // Instant paint from the session cache, then refresh from the server.
        const cached = cachedRead('inbox');
        if (cached) {
            courseNames = Object.assign({}, courseNames, cached.courseNames || {});
            renderMessages(cached.messages || []);
        }

        try {
            await loadCourseNames();
            const res = await authFetch(`${API_BASE}/api/messages/inbox`);
            if (!res.ok) {
                if (res.status === 401 && !cached) {
                    listEl.innerHTML = '<div class="empty-state"><i class="bi bi-shield-lock"></i><p>Your session has expired. Please log in again.</p></div>';
                    setTimeout(() => window.location.href = '../auth/login.html', 1500);
                    return;
                }
                throw new Error(`Inbox request failed (${res.status})`);
            }
            const messages = await res.json();
            cachedWrite('inbox', { messages, courseNames });
            renderMessages(messages);
            await runDailyInsight();
        } catch (err) {
            console.error('Error loading inbox:', err);
            if (!cached) {
                const detail = (err && err.message) || 'Unable to load your messages.';
                listEl.innerHTML = `<div class="empty-state"><p>${detail}</p></div>`;
                showToast('Unable to load your inbox.', 'error');
            }
        }
    }

    // Lazy daily AI generation: ask the server to auto-generate an AI insight
    // message for each enrolled course that hasn't received one in 24h. If any
    // new message was produced, refresh the inbox so it appears immediately.
    async function runDailyInsight() {
        try {
            const res = await authFetch(`${API_BASE}/api/messages/insight-on-open`, { method: 'POST' });
            if (!res.ok) return;
            const data = await res.json().catch(() => ({}));
            if (data && data.generated > 0) {
                invalidateApiCache('inbox');
                invalidateApiCache('nav-unread');
                const fresh = await authFetch(`${API_BASE}/api/messages/inbox`);
                if (fresh.ok) {
                    const messages = await fresh.json();
                    cachedWrite('inbox', { messages, courseNames });
                    renderMessages(messages);
                }
            }
        } catch (err) {
            // Non-blocking: a failed daily generation must never break the inbox.
            console.error('Daily insight generation failed:', err);
        }
    }

    loadMessages();
});

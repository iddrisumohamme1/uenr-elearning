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
                const initial = sender.charAt(0).toUpperCase();
                const courseLabel = m.course_id && courseNames[m.course_id] ? courseNames[m.course_id] : '';
                return `
                <div class="message-item ${m.is_read ? '' : 'unread'}" data-id="${m.id}" style="animation-delay: ${i * 50}ms">
                    <div class="message-avatar">${initial}</div>
                    <div class="message-body">
                        <div class="message-head">
                            <div>
                                <span class="message-sender">${sender}</span>
                                ${courseLabel ? `<span class="message-course">${courseLabel}</span>` : ''}
                            </div>
                            <span class="message-time">${fmtTime(m.created_at)}</span>
                        </div>
                        <p class="message-text">${m.content}</p>
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
        } catch (err) {
            console.error('Error loading inbox:', err);
            if (!cached) {
                const detail = (err && err.message) || 'Unable to load your messages.';
                listEl.innerHTML = `<div class="empty-state"><p>${detail}</p></div>`;
                showToast('Unable to load your inbox.', 'error');
            }
        }
    }

    loadMessages();
});

/* 
   STAFF INBOX PAGE LOGIC (shared by lecturer & HOD)
   frontend/lecturer/inbox.js

   Two-pane conversation inbox: a left list of conversations (organized by
   student) and a right thread rendered as left/right bubbles with a sticky
   composer.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('lecturer', 'hod').catch(() => null);
    if (!user) return;

    const avatarEl = document.getElementById('user-avatar') || document.querySelector('.avatar');
    if (avatarEl) avatarEl.textContent = user.full_name.charAt(0).toUpperCase();
    attachLogout('logout-btn');
    initProfilePopup();

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    const convosEl = document.getElementById('convos-list');
    const threadNameEl = document.getElementById('thread-name');
    const threadMetaEl = document.getElementById('thread-meta');
    const threadAvatarEl = document.getElementById('thread-avatar');
    const messagesEl = document.getElementById('thread-messages');
    const composerWrapEl = document.getElementById('composer-wrap');
    const composerInputEl = document.getElementById('composer-input');
    const composerSendEl = document.getElementById('composer-send');
    const composerStatusEl = document.getElementById('composer-status');
    const backBtnEl = document.getElementById('thread-back');

    let courseNames = {};
    let conversations = [];
    let activeId = null;

    // ── Time formatting ──────────────────────────────────────────
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

    function fmtDateDivider(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const yest = new Date(now);
        yest.setDate(now.getDate() - 1);
        if (d.toDateString() === now.toDateString()) return 'Today';
        if (d.toDateString() === yest.toDateString()) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }

    async function loadCourseNames() {
        try {
            await swrGet('courses', `${API_BASE}/api/courses/`, courses => {
                courses.forEach(c => { if (c.id) courseNames[c.id] = c.title; });
            });
        } catch (err) { /* optional enrichment */ }
    }

    // ── Conversation grouping ─────────────────────────────────────
    function buildConversations(messages) {
        const map = new Map();
        (messages || []).forEach(m => {
            const outgoing = !!m.outgoing;
            const partner = determinePartner(m, outgoing);
            if (!map.has(partner.id)) {
                map.set(partner.id, {
                    id: partner.id,
                    recipientId: partner.recipientId,
                    name: partner.name,
                    role: partner.role,
                    isAI: partner.isAI,
                    courseId: partner.courseId,
                    courseLabel: partner.courseLabel,
                    messages: []
                });
            }
            map.get(partner.id).messages.push(m);
        });

        const convos = Array.from(map.values());
        convos.forEach(c => {
            c.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            c.unread = c.messages.filter(m => !m.outgoing && !m.is_read).length;
            const last = c.messages[c.messages.length - 1];
            c.lastMessage = last ? last.content : '';
            c.lastTime = last ? last.created_at : '';
            c.lastOutgoing = last ? !!last.outgoing : false;
        });

        convos.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
        return convos;
    }

    function determinePartner(m, outgoing) {
        const senderName = (m.users && m.users.full_name) || 'Student';
        const isAssistant = m.users && m.users.role === 'assistant';
        const role = (m.users && m.users.role) || '';

        if (outgoing) {
            // Staff sent this → conversation partner is the recipient (student).
            const partnerId = m.recipient_id || 'student';
            return {
                id: `out-${partnerId}`,
                recipientId: partnerId,
                name: (m.recipient && m.recipient.full_name) || 'Student',
                role: (m.recipient && m.recipient.role) || 'student',
                isAI: false,
                courseId: m.course_id,
                courseLabel: m.course_id && courseNames[m.course_id] ? courseNames[m.course_id] : ''
            };
        }

        return {
            id: isAssistant ? 'ai' : `in-${m.sender_id || 'student'}`,
            recipientId: m.sender_id,
            name: isAssistant ? 'AI Insight Assistant' : senderName,
            role: role,
            isAI: isAssistant,
            courseId: m.course_id,
            courseLabel: m.course_id && courseNames[m.course_id] ? courseNames[m.course_id] : ''
        };
    }

    function getInitial(name) {
        return name ? name.charAt(0).toUpperCase() : '?';
    }

    // ── Mark as read ──────────────────────────────────────────────
    async function markRead(id) {
        try {
            await authFetch(`${API_BASE}/api/messages/read/${id}`, { method: 'POST' });
            const convo = conversations.find(c =>
                c.messages.some(m => String(m.id) === String(id)));
            if (convo) {
                const msg = convo.messages.find(m => String(m.id) === String(id));
                if (msg) msg.is_read = true;
                convo.unread = convo.messages.filter(m => !m.outgoing && !m.is_read).length;
            }
            invalidateApiCache('nav-unread');
            updateBadge();
            renderConvos();
            if (activeId === (convo && convo.id)) renderThread(convo);
        } catch (err) { /* non-blocking */ }
    }

    function updateBadge() {
        const inboxLink = document.querySelector('.nav-link[href*="inbox.html"]');
        const badge = inboxLink && inboxLink.querySelector('.nav-badge');
        const total = conversations.reduce((n, c) => n + c.unread, 0);
        if (badge) {
            if (total > 0) badge.textContent = total > 9 ? '9+' : total;
            else badge.remove();
        }
    }

    // ── Render conversation list (left pane) ─────────────────────
    function renderConvos() {
        if (!conversations.length) {
            convosEl.innerHTML = '<div class="inbox-empty"><i class="bi bi-inbox"></i><p>No conversations yet. Reply to student messages here, or send a new one from your dashboard.</p></div>';
            return;
        }

        convosEl.innerHTML = conversations.map((c, i) => {
            const name = c.isAI ? 'AI Insight Assistant' : c.name;
            const av = c.isAI ? '<i class="bi bi-robot"></i>' : getInitial(name);
            const badge = c.unread > 0 ? `<span class="inbox-convo-badge">${c.unread > 9 ? '9+' : c.unread}</span>` : '';
            const time = fmtTime(c.lastTime);
            const preview = c.lastOutgoing ? `You: ${truncate(c.lastMessage)}` : truncate(c.lastMessage);
            const aiTag = c.isAI ? '<span class="ai-tag">AI</span>' : '';
            return `
                <button class="inbox-convo ${c.unread > 0 ? 'unread' : ''} ${c.id === activeId ? 'active' : ''}" data-id="${c.id}" style="animation-delay: ${i * 40}ms">
                    <span class="inbox-convo-avatar">${av}</span>
                    <span class="inbox-convo-main">
                        <span class="inbox-convo-top">
                            <span class="inbox-convo-name">${escapeHTML(name)}${aiTag}</span>
                            <span class="inbox-convo-time">${time}</span>
                        </span>
                        <span class="inbox-convo-preview">
                            <span class="inbox-convo-preview-text">${escapeHTML(preview)}</span>
                            ${badge}
                        </span>
                    </span>
                </button>`;
        }).join('');

        convosEl.querySelectorAll('.inbox-convo').forEach(btn => {
            btn.addEventListener('click', () => {
                activeId = btn.dataset.id;
                renderConvos();
                renderThread(conversations.find(c => c.id === activeId));
                const convo = conversations.find(c => c.id === activeId);
                if (convo) {
                    convo.messages.filter(m => !m.outgoing && !m.is_read).forEach(m => markRead(m.id));
                }
                if (window.innerWidth <= 760) {
                    document.getElementById('inbox').classList.add('show-thread');
                }
            });
        });
    }

    function truncate(text, n = 60) {
        const s = String(text || '');
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    // ── Render the open thread (right pane) ──────────────────────
    function renderThread(convo) {
        if (!convo) {
            threadNameEl.innerHTML = '';
            threadMetaEl.textContent = '';
            threadAvatarEl.innerHTML = '';
            messagesEl.innerHTML = '';
            composerWrapEl.style.display = 'none';
            return;
        }

        const name = convo.isAI ? 'AI Insight Assistant' : convo.name;
        threadAvatarEl.innerHTML = convo.isAI ? '<i class="bi bi-robot"></i>' : getInitial(name);
        threadNameEl.innerHTML = `${escapeHTML(name)}${convo.isAI ? '<span class="ai-tag">AI</span>' : ''}`;
        threadMetaEl.textContent = convo.courseLabel
            ? (convo.isAI ? 'Course insights' : convo.courseLabel)
            : (convo.isAI ? 'Study assistant' : 'Student');

        let lastDate = '';
        const rows = convo.messages.map(m => {
            const div = fmtDateDivider(m.created_at);
            let divider = '';
            if (div && div !== lastDate) {
                divider = `<div class="inbox-date">${div}</div>`;
                lastDate = div;
            }
            const isOutgoing = !!m.outgoing;
            let body = escapeHTML(m.content);
            const meta = isOutgoing ? `You · ${fmtTime(m.created_at)}` : `${fmtTime(m.created_at)}`;
            const readMark = isOutgoing && m.is_read ? '<i class="bi bi-check2-all"></i> ' : (isOutgoing ? '<i class="bi bi-check2"></i> ' : '');
            return `${divider}
                <div class="inbox-bubble-row ${isOutgoing ? 'inbox-out' : 'inbox-in'}">
                    <div class="inbox-bubble ${isOutgoing ? 'inbox-out' : 'inbox-in'}">
                        ${body}
                        <span class="inbox-bubble-meta">${readMark}${meta}</span>
                    </div>
                </div>`;
        }).join('');

        messagesEl.innerHTML = rows;

        composerWrapEl.style.display = 'flex';
        composerStatusEl.style.display = 'none';
        composerInputEl.value = '';
        composerInputEl.dataset.convoid = convo.id;
        composerInputEl.dataset.recipientid = convo.recipientId || '';
        composerInputEl.dataset.course = convo.courseId || '';
        composerInputEl.placeholder = convo.isAI
            ? 'Message the AI assistant…'
            : `Reply to ${convo.name}…`;

        scrollThreadToBottom();
    }

    function scrollThreadToBottom() {
        requestAnimationFrame(() => {
            if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ── Composer send (staff uses /send, not /reply) ──────────────
    async function sendComposer() {
        const input = composerInputEl;
        const text = input.value.trim();
        if (!text) return;
        const recipientId = input.dataset.recipientid;
        const courseId = input.dataset.course;
        const isAI = input.dataset.convoid === 'ai';

        setButtonBusy(composerSendEl, true);
        composerStatusEl.style.display = 'none';
        try {
            const res = await authFetch(`${API_BASE}/api/messages/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient_id: recipientId, course_id: courseId || null, content: text })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Send failed');
            }
            invalidateApiCache('inbox');
            invalidateApiCache('nav-unread');
            await loadMessages(true);
            showToast('Message sent.', 'success');
        } catch (err) {
            composerStatusEl.textContent = err.message || 'Could not send. Try again.';
            composerStatusEl.style.display = 'block';
        } finally {
            setButtonBusy(composerSendEl, false);
        }
    }

    function renderEverything() {
        const countEl = document.getElementById('convos-count');
        if (countEl) countEl.textContent = conversations.length || '';
        renderConvos();
        const active = conversations.find(c => c.id === activeId);
        if (active) {
            renderThread(active);
        } else if (conversations.length) {
            activeId = conversations[0].id;
            renderConvos();
            renderThread(conversations[0]);
            updateBadge();
        } else {
            renderThread(null);
            updateBadge();
        }
    }

    async function loadMessages(keepConversation = false) {
        const cached = cachedRead('inbox');
        if (cached) {
            courseNames = Object.assign({}, courseNames, cached.courseNames || {});
            conversations = buildConversations(cached.messages || []);
            renderEverything();
        }

        try {
            if (!cached) await loadCourseNames();
            else {
                try { await loadCourseNames(); } catch (e) { /* optional */ }
            }
            const res = await authFetch(`${API_BASE}/api/messages/inbox`);
            if (!res.ok) {
                if (res.status === 401 && !cached) {
                    convosEl.innerHTML = '<div class="inbox-empty"><i class="bi bi-shield-lock"></i><p>Your session has expired. Please log in again.</p></div>';
                    setTimeout(() => window.location.href = '../auth/login.html', 1500);
                    return;
                }
                throw new Error(`Inbox request failed (${res.status})`);
            }
            const messages = await res.json();
            cachedWrite('inbox', { messages, courseNames });
            conversations = buildConversations(messages);
            if (!keepConversation && !cached) {
                renderConvos();
                if (conversations.length) {
                    activeId = conversations[0].id;
                }
            }
            renderEverything();
        } catch (err) {
            console.error('Error loading inbox:', err);
            if (!cached) {
                convosEl.innerHTML = `<div class="inbox-empty"><p>Unable to load your messages.</p></div>`;
                showToast('Unable to load your inbox.', 'error');
            }
        }
    }

    // ── Bind composer events ──────────────────────────────────────
    composerSendEl.addEventListener('click', (e) => {
        e.preventDefault();
        sendComposer();
    });
    composerInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendComposer();
        }
    });
    composerInputEl.addEventListener('input', () => {
        composerInputEl.style.height = 'auto';
        composerInputEl.style.height = Math.min(composerInputEl.scrollHeight, 120) + 'px';
        composerSendEl.disabled = composerInputEl.value.trim().length === 0;
    });

    if (backBtnEl) {
        backBtnEl.addEventListener('click', () => {
            const inbox = document.getElementById('inbox');
            inbox.classList.remove('show-thread');
        });
    }

    loadMessages();
});

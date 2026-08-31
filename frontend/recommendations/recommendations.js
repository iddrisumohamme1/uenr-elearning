/* 
   RECOMMENDATIONS MODULE LOGIC
   frontend/recommendations/recommendations.js
   TikTok-style "For You" feed: a personalized, ranked, endlessly scrollable
   stack of study items. Each card names *why* it was picked (weak spot,
   trending, fresh). Save keeps an item for later; "Not for me" tunes the feed.
   Search still works like a search engine: query up top, ranked results below.
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

function youtubeId(url) {
    const m = String(url || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/|youtube\.com\/watch\?v=)([\w-]{6,15})/);
    return m ? m[1] : null;
}

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();

    const avatarEl = document.querySelector('.user-profile .avatar');
    if (avatarEl) avatarEl.textContent = (user.full_name || 'U').charAt(0).toUpperCase();

    // ── Element references ───────────────────────────────────────────────
    const feedList = document.getElementById('feed-list');
    const skeletonsEl = document.getElementById('feed-skeletons');
    const sentinelEl = document.getElementById('feed-sentinel');
    const endEl = document.getElementById('feed-end');
    const feedErrorEl = document.getElementById('feed-error');
    const feedErrorMsgEl = document.getElementById('feed-error-msg');
    const feedRetryBtn = document.getElementById('feed-retry');
    const feedEmptyEl = document.getElementById('feed-empty');
    const feedHeadlineEl = document.getElementById('feed-headline');
    const tabForYou = document.getElementById('tab-for-you');
    const tabSaved = document.getElementById('tab-saved');
    const panelForYou = document.getElementById('feed-panel-for-you');
    const panelSaved = document.getElementById('feed-panel-saved');
    const savedList = document.getElementById('saved-list');
    const savedEmptyEl = document.getElementById('saved-empty');
    const savedCountEl = document.getElementById('saved-count');
    const searchZone = document.getElementById('search-zone');

    const conceptsInput = document.getElementById('weak-concepts');
    const searchForm = document.getElementById('search-form');
    const clearBtn = document.getElementById('clear-search');
    const loadingEl = document.getElementById('loading-state');
    const errorEl = document.getElementById('error-state');
    const errorMsgEl = document.getElementById('error-message');
    const listEl = document.getElementById('recommendations-list');
    const resultsInfoEl = document.getElementById('results-info');
    const pendingEl = document.getElementById('pending-recs');
    const pendingListEl = document.getElementById('pending-recs-list');
    const relatedChipsEl = document.getElementById('related-chips');

    const PAGE_SIZE = 10;
    const state = {
        activeTab: 'for-you',
        feedReady: false,
        nextCursor: null,
        loading: false,
        idSet: new Set(),
        savedKeys: new Set(),
    };

    const SOURCE_META = {
        material: { label: 'Course Material', icon: 'bi-journal-text', spine: 'material' },
        study_resource: { label: 'Study Resource', icon: 'bi-lightbulb', spine: 'study' },
        youtube: { label: 'YouTube', icon: 'bi-youtube', spine: 'youtube' },
        article: { label: 'Article', icon: 'bi-globe2', spine: 'article' },
    };

    // ── Tracking (fire-and-forget; a failed signal must never block the UI)─
    function track(item, action) {
        const body = { item_type: item.item_type, item_key: item.item_key, action };
        // Persist a snapshot on save so web items survive on the Saved tab
        // even after they leave the feed pool.
        if (action === 'save') {
            const meta = SOURCE_META[item.source] || SOURCE_META[item.item_type] || {};
            body.payload = {
                title: item.title,
                description: item.description || '',
                url: item.url || '',
                source: item.source || 'external',
                source_label: item.source_label || meta.label || 'Resource',
                course_id: item.course_id || '',
                course_name: item.course_name || '',
                topic: item.topic || '',
                channel: item.channel || '',
                match_percent: Number(item.match_percent) || 0,
                thumbnails: item.thumbnails || {},
                reasons: item.reasons || [],
            };
        }
        authFetch(`${API_BASE}/api/recommendations/feed/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).catch(() => {});
    }

    function itemHref(item) {
        if (item.url) return { href: item.url, external: true };
        if (item.item_type === 'material' && item.course_id) {
            return { href: `../materials/materials.html?id=${encodeURIComponent(item.course_id)}`, external: false };
        }
        if (item.item_type === 'study_resource') {
            return { href: '../student/study_resources.html', external: false };
        }
        return { href: '', external: false };
    }

    // ── In-app viewer: opens results inside the system instead of a new tab ──
    const viewerOverlay = document.getElementById('viewer-overlay');
    const viewerTitle = document.getElementById('viewer-title');
    const viewerBadge = document.getElementById('viewer-badge');
    const viewerMeta = document.getElementById('viewer-meta');
    const viewerBody = document.getElementById('viewer-body');
    const viewerExternal = document.getElementById('viewer-external');
    const viewerNote = document.getElementById('viewer-note');

    function openItem(item) {
        track(item, 'open');
        const link = itemHref(item);
        const vid = itemSourceYouTube(item) ? youtubeId(item.url) : null;

        // Everything with a URL opens in the in-app viewer (embedded player /
        // iframe). In-system pages (materials, study resources) just navigate.
        if (item.url) {
            showViewer(item, vid);
            return;
        }
        if (link.href) {
            window.location.href = link.href;
        }
    }

    function showViewer(item, vid) {
        const meta = SOURCE_META[item.source] || SOURCE_META[item.item_type] || { label: 'Resource', icon: 'bi-file-earmark' };
        viewerTitle.textContent = item.title || 'Resource';
        viewerBadge.textContent = meta.label;
        viewerBadge.innerHTML = `<i class="bi ${meta.icon}" aria-hidden="true"></i>${escapeHTML(meta.label)}`;
        const domain = item.url ? extractDomain(item.url) : '';
        viewerMeta.textContent = domain || (item.channel || '').replace(/^www\./, '');
        viewerExternal.setAttribute('href', item.url || '#');
        viewerExternal.hidden = !item.url;

        // Videos get the YouTube player (no related-video spoilers); everything
        // else with a URL is embedded as a page. Certain sites refuse framing —
        // the footer link gives a graceful escape that still stays optional.
        if (vid) {
            viewerBody.innerHTML = `
                <iframe class="viewer-frame viewer-frame--video"
                    src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?rel=0&modestbranding=1"
                    title="${escapeHTML(item.title)}"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
            viewerNote.hidden = true;
        } else {
            viewerBody.innerHTML = `
                <iframe class="viewer-frame viewer-frame--page"
                    src="${escapeHTML(item.url)}"
                    title="${escapeHTML(item.title)}"
                    referrerpolicy="strict-origin-when-cross-origin"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                    loading="lazy"></iframe>`;
            viewerNote.hidden = false;
        }

        viewerOverlay.classList.add('is-open');
        viewerOverlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('has-viewer');
    }

    function closeViewer() {
        viewerOverlay.classList.remove('is-open');
        viewerOverlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('has-viewer');
        viewerBody.innerHTML = '';  // stop audio when closed
    }

    document.getElementById('viewer-close').addEventListener('click', closeViewer);
    viewerOverlay.addEventListener('click', (e) => {
        if (e.target === viewerOverlay) closeViewer();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && viewerOverlay.classList.contains('is-open')) closeViewer();
    });

    // ── Feed card ─────────────────────────────────────────────────────────
    function renderFeedCard(item, listEl, onSavedChange) {
        const meta = SOURCE_META[item.source] || SOURCE_META[item.item_type] || { label: 'Resource', icon: 'bi-file-earmark', spine: 'material' };
        const vid = itemSourceYouTube(item) ? youtubeId(item.url) : null;
        const match = Math.max(0, Math.min(100, Number(item.match_percent) || 0));
        const reasonChips = (item.reasons || []).map(r => `
            <span class="feed-reason"><i class="bi bi-stars" aria-hidden="true"></i>${escapeHTML(r)}</span>
        `).join('');
        const course = item.course_name ? `<span class="feed-course">${escapeHTML(item.course_name)}</span>` : '';
        const byline = item.channel
            ? `<p class="feed-byline"><i class="bi bi-youtube" aria-hidden="true"></i><span>${escapeHTML(item.channel)}</span></p>`
            : '';

        const thumbUrl = firstThumbUrl(item);
        const media = vid
            ? `<div class="feed-media">
                   <img class="feed-media-img" src="https://img.youtube.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg"
                        alt="" loading="lazy" onerror="this.parentElement.classList.add('is-empty')" />
                   <span class="feed-media-play"><i class="bi bi-play-fill" aria-hidden="true"></i></span>
               </div>`
            : thumbUrl
                ? `<div class="feed-media">
                       <img class="feed-media-img" src="${escapeHTML(thumbUrl)}"
                            alt="" loading="lazy" onerror="this.parentElement.classList.add('is-empty')" />
                   </div>`
                : '';

        const card = document.createElement('article');
        card.className = 'feed-card';
        card.dataset.key = item.key;
        card.dataset.type = item.item_type;
        card.innerHTML = `
            <span class="feed-spine spine--${escapeHTML(meta.spine)}" aria-hidden="true"></span>
            <div class="feed-card-main">
                <div class="feed-card-top">
                    <span class="feed-badge"><i class="bi ${escapeHTML(meta.icon)}" aria-hidden="true"></i>${escapeHTML(meta.label)}</span>
                    ${course}
                    ${match ? `<span class="feed-match">${match}% match</span>` : ''}
                </div>
                ${media}
                <h3 class="feed-card-title">${escapeHTML(item.title)}</h3>
                ${byline}
                ${item.description ? `<p class="feed-card-desc">${escapeHTML(item.description)}</p>` : ''}
                ${reasonChips ? `<div class="feed-reasons">${reasonChips}</div>` : ''}
                <div class="feed-actions">
                    <button type="button" class="btn-feed-open" data-action="open">
                        Open <i class="bi bi-arrow-up-right-square" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="feed-icon-btn" data-action="save" aria-label="${item.saved ? 'Remove from saved' : 'Save for later'}" title="${item.saved ? 'Saved' : 'Save for later'}">
                        <i class="bi ${item.saved ? 'bi-bookmark-fill' : 'bi-bookmark'}" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="feed-icon-btn feed-icon-btn--x" data-action="dismiss" aria-label="Not for me" title="Not for me">
                        <i class="bi bi-x-lg" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
        `;

        const openBtn = card.querySelector('.btn-feed-open');
        openBtn.addEventListener('click', () => openItem(item));

        // Clicking anywhere on the card body opens the item in the in-app
        // viewer; action buttons (save/dismiss) keep their own behaviour.
        card.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('.feed-actions button');
            if (actionBtn) return;
            if (e.target.closest('a')) return;
            openItem(item);
        });

        const saveBtn = card.querySelector('[data-action="save"]');
        saveBtn.addEventListener('click', () => {
            const nowSaved = !item.saved;
            item.saved = nowSaved;
            const icon = saveBtn.querySelector('i');
            icon.className = `bi ${nowSaved ? 'bi-bookmark-fill' : 'bi-bookmark'}`;
            saveBtn.setAttribute('aria-label', nowSaved ? 'Remove from saved' : 'Save for later');
            saveBtn.title = nowSaved ? 'Saved' : 'Save for later';
            if (nowSaved) {
                state.savedKeys.add(item.key);
                track(item, 'save');
                showToast('Saved to your list.', 'success');
            } else {
                state.savedKeys.delete(item.key);
                track(item, 'unsave');
                showToast('Removed from saved.', 'error');
                onSavedChange && onSavedChange(item);
            }
            updateSavedCount();
        });

        card.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
            if (item.saved) {
                track(item, 'unsave');
                state.savedKeys.delete(item.key);
                item.saved = false;
            }
            track(item, 'dismiss');
            card.style.setProperty('--collapse-h', card.offsetHeight + 'px');
            card.classList.add('is-collapsing');
            setTimeout(() => {
                card.remove();
                if (state.activeTab === 'saved' && !savedList.childElementCount) {
                    savedEmptyEl.style.display = 'block';
                }
                updateSavedCount();
            }, 250);
            showToast('Hidden from your feed — we\'ll learn from that.', 'info');
        });

        listEl.appendChild(card);
        state.idSet.add(item.key);
    }

    function itemSourceYouTube(item) {
        return item.source === 'youtube' || (item.source === 'external' && /youtube/i.test(item.title + ' ' + (item.url || '')));
    }

    function firstThumbUrl(item) {
        const t = item.thumbnails || {};
        const candidates = [
            t.high && t.high.url,
            t.medium && t.medium.url,
            t.default && t.default.url,
            typeof t === 'string' ? t : null,
            t.url,
        ];
        return candidates.find(Boolean) || '';
    }

    // ── For You feed (infinite scroll) ────────────────────────────────────
    function renderWeakTopicChips(weakTopics) {
        const relatedSearchesEl = document.getElementById('related-searches');
        const chipsEl = document.getElementById('related-chips');
        if (!relatedSearchesEl || !chipsEl) return;
        if (!weakTopics || !weakTopics.length) {
            relatedSearchesEl.style.display = 'none';
            return;
        }
        relatedSearchesEl.style.display = 'flex';
        chipsEl.innerHTML = weakTopics.map(t => `
            <button type="button" class="related-chip" data-topic="${escapeHTML(t.label)}"
                    title="Average score: ${escapeHTML(String(t.avg_score))}%">
                ${escapeHTML(t.label)}<span class="related-chip-score">${escapeHTML(String(t.avg_score))}%</span>
            </button>
        `).join('');
        chipsEl.querySelectorAll('.related-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                conceptsInput.value = chip.dataset.topic;
                runSearch();
            });
        });
    }

    function showSkeletons(show) {
        skeletonsEl.style.display = show ? 'block' : 'none';
    }

    async function loadFeedPage() {
        if (state.loading || state.activeTab !== 'for-you' || !state.feedReady || !state.nextCursor) return;
        state.loading = true;
        showSkeletons(true);
        const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
        if (state.nextCursor) params.set('cursor', state.nextCursor);
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/feed?${params}`);
            if (!res.ok) throw new Error('feed request failed');
            const data = await res.json();
            appendFeedPage(data.items || []);
            state.nextCursor = data.next_cursor || '';
            renderWeakTopicChips(data.weak_topics || []);
            if (!state.nextCursor) endEl.style.display = 'block';
        } catch (err) {
            console.error('Feed load failed:', err);
            if (!feedList.childElementCount) {
                feedErrorMsgEl.textContent = 'We couldn\'t build your feed right now. Check your connection and try again.';
                feedErrorEl.style.display = 'block';
            }
        } finally {
            state.loading = false;
            showSkeletons(false);
        }
    }

    function appendFeedPage(items) {
        const fresh = items.filter(it => !state.idSet.has(it.key));
        feedEmptyEl.style.display = 'none';
        fresh.forEach(it => {
            state.savedKeys.has(it.key) && (it.saved = true);
            renderFeedCard(it, feedList);
        });
        if (!state.nextCursor && !fresh.length) endEl.style.display = 'block';
    }

    async function loadInitialFeed() {
        state.nextCursor = '';
        state.feedReady = false;
        state.loading = false;
        feedErrorEl.style.display = 'none';
        endEl.style.display = 'none';
        showSkeletons(true);
        const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/feed?${params}`);
            if (!res.ok) throw new Error('feed request failed');
            const data = await res.json();
            renderWeakTopicChips(data.weak_topics || []);
            feedList.innerHTML = '';
            state.idSet.clear();
            state.nextCursor = data.next_cursor || '';
            appendFeedPage(data.items || []);
            state.feedReady = true;
            if (!state.nextCursor) endEl.style.display = 'block';
            else if (!feedList.childElementCount) feedEmptyEl.style.display = 'block';
        } catch (err) {
            console.error('Feed load failed:', err);
            feedErrorMsgEl.textContent = 'We couldn\'t build your feed right now. Check your connection and try again.';
            feedErrorEl.style.display = 'block';
        } finally {
            showSkeletons(false);
        }
    }

    function resetFeedInspector() {
        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && state.activeTab === 'for-you') {
                loadFeedPage();
            }
        }, { rootMargin: '600px 0px' });
        return observer;
    }

    // ── Saved tab ─────────────────────────────────────────────────────────
    function updateSavedCount() {
        const n = state.savedKeys.size;
        savedCountEl.hidden = n === 0;
        savedCountEl.textContent = String(n);
    }

    async function loadSaved() {
        savedEmptyEl.style.display = 'none';
        savedList.innerHTML = '<div class="feed-skeleton"></div><div class="feed-skeleton"></div>';
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/feed/saved`);
            if (!res.ok) throw new Error('saved request failed');
            const data = await res.json();
            state.savedKeys = new Set((data.items || []).map(i => i.key));
            savedList.innerHTML = '';
            (data.items || []).forEach(it => {
                it.saved = true;
                renderFeedCard(it, savedList, () => loadSaved());
            });
            if (!(data.items || []).length) savedEmptyEl.style.display = 'block';
            updateSavedCount();
        } catch (err) {
            console.error('Saved load failed:', err);
            savedList.innerHTML = '';
            savedEmptyEl.innerHTML = `
                <i class="bi bi-cloud-lightning-rain feed-state-icon"></i>
                <h3>Couldn't load your saved items</h3>
                <p class="text-muted">Check your connection and open the Saved tab again.</p>`;
            savedEmptyEl.style.display = 'block';
        }
    }

    // ── Tabs ──────────────────────────────────────────────────────────────
    function setTab(tab) {
        state.activeTab = tab;
        const isForYou = tab === 'for-you';
        tabForYou.classList.toggle('is-active', isForYou);
        tabSaved.classList.toggle('is-active', !isForYou);
        tabForYou.setAttribute('aria-selected', String(isForYou));
        tabSaved.setAttribute('aria-selected', String(!isForYou));
        panelForYou.style.display = isForYou ? 'block' : 'none';
        panelSaved.style.display = isForYou ? 'none' : 'block';
        searchZone.style.display = 'none';
        feedHeadlineEl.textContent = isForYou ? 'From the web, for you' : 'Your saved items';
    }

    tabForYou.addEventListener('click', () => setTab('for-you'));
    tabSaved.addEventListener('click', () => {
        setTab('saved');
        loadSaved();
    });

    // ── Search (kept from the search-engine flow) ─────────────────────────
    function showLoading() {
        panelForYou.style.display = 'none';
        panelSaved.style.display = 'none';
        searchZone.style.display = 'block';
        loadingEl.style.display = 'flex';
        errorEl.style.display = 'none';
        listEl.innerHTML = '';
        resultsInfoEl.style.display = 'none';
    }

    function showSearchError(msg) {
        searchZone.style.display = 'block';
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

    const sourceLabels = { material: 'Course Material', study_resource: 'Study Resource', youtube: 'YouTube', article: 'Article' };
    const sourceIcons = { material: 'bi-journal-text', study_resource: 'bi-lightbulb', youtube: 'bi-youtube', article: 'bi-globe2' };

    function searchResultHref(rec) {
        if (rec.url) return { href: rec.url, external: true };
        if (rec.source === 'material' && rec.course_id) {
            return { href: `../materials/materials.html?id=${encodeURIComponent(rec.course_id)}`, external: false };
        }
        if (rec.source === 'study_resource') {
            return { href: '../student/study_resources.html', external: false };
        }
        return { href: '', external: false };
    }

    // Map a search result to a trackable feed shape so students can save it.
    // Returns null when the result has no stable key (unreachable item).
    function searchTrackShape(rec) {
        const id = rec.id || '';
        if (id.startsWith('ext:')) {
            return { item_type: 'external', item_key: id.slice(4), key: id };
        }
        if (rec.source === 'youtube' || rec.source === 'article' || rec.source === 'study_resource') {
            const keyBase = id || rec.url;
            if (!keyBase) return null;
            return { item_type: 'external', item_key: keyBase, key: `external:${keyBase}` };
        }
        if (!id) return null;
        return { item_type: 'material', item_key: id, key: `material:${id}` };
    }

    function recToItem(rec) {
        const shape = searchTrackShape(rec) || {};
        return {
            item_type: shape.item_type || 'external',
            item_key: shape.item_key || rec.url || rec.title,
            key: shape.key || `external:${rec.url || rec.title}`,
            title: rec.title,
            description: rec.description,
            url: rec.url,
            source: rec.source || 'external',
            course_id: rec.course_id,
            topic: rec.topic,
            match_percent: Number(rec.similarity_percent) || 0,
        };
    }

    function renderSearchRow(rec, index) {
        const score = Math.max(0, Math.min(100, Number(rec.similarity_percent) || 0));
        const source = sourceLabels[rec.source] || rec.source || 'Resource';
        const icon = sourceIcons[rec.source] || 'bi-file-earmark';
        const link = searchResultHref(rec);

        let path = '';
        if (rec.source === 'youtube' && rec.url) path = extractDomain(rec.url);
        else if (rec.source === 'article' && rec.url) path = extractDomain(rec.url);
        else if (rec.source === 'material' && rec.course_name) path = rec.course_name;

        // External results open inside the system's viewer; in-system pages
        // (materials, study resources) keep their internal navigation.
        const title = link.external
            ? `<button type="button" class="result-title result-title--open" data-open-rec="${index}">${escapeHTML(rec.title)}</button>`
            : (link.href
                ? `<a class="result-title" href="${escapeHTML(link.href)}">${escapeHTML(rec.title)}</a>`
                : `<h3 class="result-title">${escapeHTML(rec.title)}</h3>`);

        const snippet = rec.description && rec.description !== rec.title
            ? `<p class="result-snippet">${escapeHTML(rec.description)}</p>` : '';
        const reason = rec.reason ? `<p class="result-reason">${escapeHTML(rec.reason)}</p>` : '';
        const matchBar = score > 0 ? `
            <span class="result-match">
                <span class="match-label">Match</span>
                <span class="match-bar"><span class="match-fill" style="width:${score}%"></span></span>
                <span class="match-value">${score.toFixed(0)}%</span>
            </span>` : '';

        const shape = searchTrackShape(rec);
        const saved = shape ? state.savedKeys.has(shape.key) : false;
        const saveBtn = shape ? `
            <button type="button" class="result-save" data-result-save="${escapeHTML(shape.key)}" aria-label="${saved ? 'Remove from saved' : 'Save for later'}" title="${saved ? 'Saved' : 'Save for later'}">
                <i class="bi ${saved ? 'bi-bookmark-fill' : 'bi-bookmark'}" aria-hidden="true"></i>
            </button>` : '';

        return `
            <div class="search-result">
                <div class="result-domain-row">
                    <span class="result-domain"><i class="${icon}" aria-hidden="true"></i>${escapeHTML(source)}</span>
                    ${path ? `<span class="result-path">${escapeHTML(path)}</span>` : ''}
                    ${saveBtn}
                </div>
                ${title}${reason}${snippet}
                ${matchBar ? `<div class="result-meta">${matchBar}</div>` : ''}
            </div>`;
    }

    function renderSearchResults(recs) {
        searchZone.style.display = 'block';
        loadingEl.style.display = 'none';
        errorEl.style.display = 'none';
        if (!recs.length) {
            resultsInfoEl.style.display = 'none';
            listEl.innerHTML = `
                <p class="text-muted">No results found for "<strong>${escapeHTML(conceptsInput.value.trim())}</strong>".</p>
                <p class="text-muted" style="margin-top:0.5rem">Try a different topic, or pick one of the chips above.</p>`;
            return;
        }
        listEl.innerHTML = recs.map(renderSearchRow).join('');
        // Open external results in the in-app viewer.
        listEl.querySelectorAll('[data-open-rec]').forEach(btn => {
            const idx = Number(btn.dataset.openRec);
            btn.addEventListener('click', () => openItem(recToItem(recs[idx])));
        });
        // Wire the save-later buttons on each result row.
        listEl.querySelectorAll('.result-save').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.resultSave;
                const rec = recs.find(r => searchTrackShape(r).key === key);
                if (!rec) return;
                const shape = searchTrackShape(rec);
                const nowSaved = !state.savedKeys.has(key);
                const icon = btn.querySelector('i');
                icon.className = `bi ${nowSaved ? 'bi-bookmark-fill' : 'bi-bookmark'}`;
                btn.setAttribute('aria-label', nowSaved ? 'Remove from saved' : 'Save for later');
                btn.title = nowSaved ? 'Saved' : 'Save for later';
                const item = {
                    item_type: shape.item_type,
                    item_key: shape.item_key,
                    key,
                    title: rec.title,
                    description: rec.description,
                    url: rec.url,
                    source: rec.source || 'external',
                    course_id: rec.course_id,
                    topic: rec.topic,
                    match_percent: Number(rec.similarity_percent) || 0,
                };
                if (nowSaved) {
                    state.savedKeys.add(key);
                    track(item, 'save');
                    showToast('Saved to your list.', 'success');
                } else {
                    state.savedKeys.delete(key);
                    track(item, 'unsave');
                    showToast('Removed from saved.', 'error');
                }
                updateSavedCount();
            });
        });
    }

    async function runSearch() {
        const concepts = conceptsInput.value.trim();
        if (!concepts) {
            showSearchError('Describe a topic you need help with, or pick one of the chips above.');
            return;
        }
        setTab('for-you');  // hide the feed while searching
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
            renderSearchResults(data.recommendations || []);
            showResultsInfo((data.recommendations || []).length, performance.now() - startedAt);
        } catch (err) {
            console.error('Error loading recommendations:', err);
            showSearchError(err.message || 'Unable to load recommendations.');
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
                const mapped = items.map(n => ({
                    url: n.resource_url || '',
                    source: n.resource_source,
                    course_id: n.course_id,
                    course_name: n.course_name || '',
                    title: n.resource_title,
                    description: n.resource_description,
                    reason: n.reason,
                }));
                pendingListEl.innerHTML = mapped.map(renderSearchRow).join('');
                pendingListEl.querySelectorAll('[data-open-rec]').forEach(btn => {
                    const idx = Number(btn.dataset.openRec);
                    btn.addEventListener('click', () => openItem(recToItem(mapped[idx])));
                });
            }
            await authFetch(`${API_BASE}/api/recommendations/notifications/read`, { method: 'POST' });
        } catch (err) {
            console.error('Failed to load pending recommendations:', err);
        }
    }

    // ── Wire-up ───────────────────────────────────────────────────────────
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

    feedRetryBtn.addEventListener('click', loadInitialFeed);

    const feedObserver = resetFeedInspector();
    feedObserver.observe(sentinelEl);

    await loadInitialFeed();
    loadPendingRecommendations();
    loadSaved();
});
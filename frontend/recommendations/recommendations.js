/* 
   RECOMMENDATIONS MODULE LOGIC
   frontend/recommendations/recommendations.js
*/

function escapeHTML(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const EXAMPLE_CONCEPTS = [
    'Database normalization and SQL joins',
    'Pointers and memory allocation in C++',
    'Neural network backpropagation',
    'Design patterns in software engineering',
    'HTTP and REST APIs',
    'Recursion and data structures',
];

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
    const listEl = document.getElementById('recommendations-list');
    const weakBannerEl = document.getElementById('weak-topics-banner');
    const weakChipsEl = document.getElementById('weak-topic-chips');
    const conceptsInput = document.getElementById('weak-concepts');
    const getRecsBtn = document.getElementById('get-recs-btn');

    const sourceLabels = {
        material: 'Course Material',
        youtube: 'YouTube',
        article: 'Article',
    };

    function showLoading() {
        loadingEl.style.display = 'block';
        errorEl.style.display = 'none';
        listEl.innerHTML = '';
    }

    function showError(msg) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        document.getElementById('error-message').textContent = msg;
    }

    function buildResourceLink(rec) {
        if (rec.url) {
            return `<a href="${escapeHTML(rec.url)}" target="_blank" rel="noopener noreferrer" class="btn-go">Open Resource</a>`;
        }
        if (rec.source === 'material' && rec.course_id) {
            const viewerUrl = `../materials/materials.html?id=${encodeURIComponent(rec.course_id)}`;
            return `<a href="${viewerUrl}" class="btn-go">View Course Materials</a>`;
        }
        return '';
    }

    function renderCards(recs) {
        if (!recs.length) {
            listEl.innerHTML = '<p class="text-muted">No recommendations found. Try different keywords.</p>';
            return;
        }
        listEl.innerHTML = recs.map(rec => {
            const score = Math.max(0, Math.min(100, Number(rec.similarity_percent) || 0));
            const source = escapeHTML(sourceLabels[rec.source] || rec.source || '');
            const type = escapeHTML(rec.type || 'Resource');
            const thumb = rec.source === 'youtube' && rec.thumbnails
                ? (rec.thumbnails.medium || rec.thumbnails.default || {}).url
                : '';
            const channel = rec.source === 'youtube' && rec.channel
                ? `<p class="rec-channel">${escapeHTML(rec.channel)}</p>`
                : '';
            return `
                <div class="rec-card">
                    ${thumb ? `<a class="rec-thumb" href="${escapeHTML(rec.url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHTML(thumb)}" alt="${escapeHTML(rec.title)}" loading="lazy"></a>` : ''}
                    <div class="rec-card-top">
                        <span class="rec-type">${type}</span>
                        ${source ? `<span class="rec-source">${source}</span>` : ''}
                    </div>
                    <h3 class="rec-title">${escapeHTML(rec.title)}</h3>
                    ${channel}
                    ${rec.reason ? `<p class="rec-reason">${escapeHTML(rec.reason)}</p>` : ''}
                    ${rec.description && rec.description !== rec.title ? `<p class="rec-desc">${escapeHTML(rec.description)}</p>` : ''}
                    <div class="rec-score">
                        <span class="rec-score-label">Match strength</span>
                        <div class="rec-score-bar"><span class="rec-score-fill" style="width:${score}%"></span></div>
                        <span class="rec-score-value">${score.toFixed(0)}%</span>
                    </div>
                    ${buildResourceLink(rec)}
                </div>
            `;
        }).join('');
    }

    function renderWeakTopics(weakTopics) {
        if (!weakTopics || !weakTopics.length) {
            weakBannerEl.style.display = 'none';
            return;
        }
        weakBannerEl.style.display = 'block';
        weakChipsEl.innerHTML = weakTopics.map(t => `
            <button type="button" class="topic-chip" data-topic="${escapeHTML(t.topic)}"
                    title="Average score: ${escapeHTML(String(t.avg_score))}%">
                ${escapeHTML(t.label)} <span class="chip-score">${escapeHTML(String(t.avg_score))}%</span>
            </button>
        `).join('');

        weakChipsEl.querySelectorAll('.topic-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                conceptsInput.value = chip.dataset.topic;
                getRecommendations();
            });
        });

        const labels = weakTopics.map(t => t.label).join(', ');
        conceptsInput.placeholder = `Detected: ${labels}`;
    }

    function renderExampleChips() {
        const container = document.getElementById('example-chips');
        container.innerHTML = EXAMPLE_CONCEPTS.map(concept => `
            <button type="button" class="topic-chip example-chip" data-concept="${escapeHTML(concept)}">
                ${escapeHTML(concept)}
            </button>
        `).join('');
        container.querySelectorAll('.example-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                conceptsInput.value = chip.dataset.concept;
                getRecommendations();
            });
        });
    }

    async function getRecommendations() {
        const concepts = conceptsInput.value.trim();
        if (!concepts) {
            showError('Please describe what topics you\'re struggling with, or pick an example below.');
            return;
        }

        showLoading();
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ student_id: user.id, weak_concepts: concepts, top_n: 5 })
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.detail || 'Failed to get recommendations');
            }
            const data = await res.json();
            renderCards(data.recommendations || []);
        } catch (err) {
            console.error('Error loading recommendations:', err);
            showError(err.message || 'Unable to load recommendations.');
        }
    }

    async function loadAutoDetection() {
        try {
            const res = await authFetch(`${API_BASE}/api/recommendations/auto`);
            if (!res.ok) return;
            const data = await res.json();
            renderWeakTopics(data.weak_topics || []);
            if ((data.recommendations || []).length) {
                renderCards(data.recommendations);
            }
        } catch (err) {
            console.error('Auto-detection failed:', err);
        }
    }

    renderExampleChips();
    loadAutoDetection();
    getRecsBtn.addEventListener('click', getRecommendations);
});

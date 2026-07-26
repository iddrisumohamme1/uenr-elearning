/* 
   RECOMMENDATIONS MODULE LOGIC
   frontend/recommendations/recommendations.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();

    const loadingEl = document.getElementById('loading-state');
    const errorEl = document.getElementById('error-state');
    const listEl = document.getElementById('recommendations-list');
    const conceptsInput = document.getElementById('weak-concepts');
    const getRecsBtn = document.getElementById('get-recs-btn');

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

    function showResults(recs) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'none';
        if (!recs.length) {
            listEl.innerHTML = '<p class="text-muted">No recommendations found. Try different keywords.</p>';
            return;
        }
        listEl.innerHTML = recs.map(rec => `
            <div class="rec-card">
                <span class="rec-type">${rec.type || 'Resource'}</span>
                <h3 class="rec-title">${rec.title}</h3>
                <p class="rec-reason">${rec.description || rec.reason || ''}</p>
                ${rec.url ? `<a href="${rec.url}" target="_blank" class="btn-go">Access Resource</a>` : ''}
            </div>
        `).join('');
    }

    async function getRecommendations() {
        const concepts = conceptsInput.value.trim();
        if (!concepts) { showError('Please describe what topics you\'re struggling with.'); return; }

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
            showResults(data.recommendations || []);
        } catch (err) {
            console.error('Error loading recommendations:', err);
            showError(err.message || 'Unable to load recommendations.');
        }
    }

    getRecsBtn.addEventListener('click', getRecommendations);
});

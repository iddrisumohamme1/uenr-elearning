/* 
   ANALYTICS MODULE LOGIC
   frontend/analytics/analytics.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    attachLogout('logout-btn');
    initProfilePopup();

    const loadingEl = document.getElementById('loading-state');
    const errorEl = document.getElementById('error-state');
    const bodyEl = document.getElementById('analytics-body');

    function showError(msg) {
        loadingEl.style.display = 'none';
        bodyEl.style.display = 'none';
        errorEl.style.display = 'block';
        document.getElementById('error-message').textContent = msg;
    }

    function showBody() {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'none';
        bodyEl.style.display = 'block';
    }

    try {
        const res = await authFetch(`${API_BASE}/api/engagement/student/${user.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const logs = data.logs || [];

        if (logs.length === 0) {
            showError('No engagement data yet. Start learning to see your analytics!');
            return;
        }

        const totalLogs = logs.length;
        const avgScore = Math.round(logs.reduce((sum, l) => sum + (l.engagement_score || 0), 0) / totalLogs);
        const totalTime = logs.reduce((sum, l) => sum + (l.time_spent || 0), 0);
        const materialsViewed = new Set(logs.map(l => l.material_id).filter(Boolean)).size;

        document.getElementById('avg-engagement').textContent = `${avgScore}%`;
        document.getElementById('materials-count').textContent = materialsViewed;
        document.getElementById('time-spent').textContent = totalTime > 3600
            ? `${Math.round(totalTime / 3600)}h` : `${Math.round(totalTime / 60)}m`;

        const high = logs.filter(l => (l.engagement_score || 0) >= 75).length;
        const med = logs.filter(l => { const s = l.engagement_score || 0; return s >= 40 && s < 75; }).length;
        const low = logs.filter(l => (l.engagement_score || 0) < 40).length;

        document.getElementById('bar-high').style.width = `${(high / totalLogs) * 100}%`;
        document.getElementById('bar-med').style.width = `${(med / totalLogs) * 100}%`;
        document.getElementById('bar-low').style.width = `${(low / totalLogs) * 100}%`;
        document.getElementById('pct-high').textContent = `${Math.round((high / totalLogs) * 100)}%`;
        document.getElementById('pct-med').textContent = `${Math.round((med / totalLogs) * 100)}%`;
        document.getElementById('pct-low').textContent = `${Math.round((low / totalLogs) * 100)}%`;

        const activityList = document.getElementById('activity-list');
        activityList.innerHTML = logs.slice(0, 5).map(l => `
            <div class="activity-item">
                <span>${l.engagement_level || 'N/A'}</span>
                <span class="text-muted">${l.logged_at ? new Date(l.logged_at).toLocaleDateString() : 'Recent'}</span>
            </div>
        `).join('');

        const insightEl = document.getElementById('insight-text');
        if (avgScore >= 75) {
            insightEl.textContent = 'Great job! You\'re maintaining high engagement.';
        } else if (avgScore >= 40) {
            insightEl.textContent = 'Your engagement is moderate. Try setting dedicated study times.';
        } else {
            insightEl.textContent = 'Your engagement is low. Consider breaking study sessions into smaller chunks.';
        }

        // ── Fetch Two-Tower ML classification ────────────────────────────────
        try {
            const clsRes = await authFetch(`${API_BASE}/api/engagement/student/${user.id}/classification`);
            if (clsRes.ok) {
                const clsData = await clsRes.json();
                const latest = clsData.latest;
                if (latest) {
                    document.getElementById('classification-card').style.display = 'block';
                    document.getElementById('ml-engagement').textContent = latest.engagement_label || 'N/A';
                    document.getElementById('ml-comprehension').textContent = latest.comprehension_label || 'N/A';
                    document.getElementById('ml-model-type').textContent = latest.fallback ? 'Rule-Based Heuristic' : 'Two-Tower NN';

                    const dateEl = document.getElementById('ml-last-analyzed');
                    if (latest.created_at) {
                        const d = new Date(latest.created_at);
                        dateEl.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
                    } else {
                        dateEl.textContent = 'Unknown';
                    }

                    // Color-code the engagement value
                    const engEl = document.getElementById('ml-engagement');
                    if (latest.engagement_class === 0) engEl.classList.add('class-at-risk');
                    else if (latest.engagement_class === 1) engEl.classList.add('class-moderate');
                    else engEl.classList.add('class-high');

                    const compEl = document.getElementById('ml-comprehension');
                    if (latest.comprehension_class === 0) compEl.classList.add('class-at-risk');
                    else if (latest.comprehension_class === 1) compEl.classList.add('class-moderate');
                    else compEl.classList.add('class-high');
                }
            }
        } catch (e) {
            // ML classification is optional - don't break the page
            console.log('ML classification not available:', e.message);
        }

        showBody();
    } catch (err) {
        console.error('Error loading analytics:', err);
        showError('Unable to load analytics. Please try again later.');
    }
});

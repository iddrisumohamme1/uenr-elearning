/* 
   ANALYTICS MODULE LOGIC
   frontend/analytics/analytics.js
   Loads engagement analytics + AI quiz results (incl. theory) for a student.
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

    const engagementRes = await authFetch(`${API_BASE}/api/engagement/student/${user.id}`).catch(() => null);
    const quizRes = await authFetch(`${API_BASE}/api/quiz/student/${user.id}`).catch(() => null);

    if (!engagementRes && !quizRes) {
        showError('Unable to load analytics. Please try again later.');
        return;
    }

    // ── Engagement analytics ────────────────────────────────────────────────
    if (engagementRes && engagementRes.ok) {
        const data = await engagementRes.json();
        const logs = data.logs || [];

        if (logs.length > 0) {
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

            // ── Two-Tower ML classification ──────────────────────────────
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
                        dateEl.textContent = latest.created_at
                            ? `${new Date(latest.created_at).toLocaleDateString()} ${new Date(latest.created_at).toLocaleTimeString()}`
                            : 'Unknown';

                        const engEl = document.getElementById('ml-engagement');
                        engEl.classList.add(latest.engagement_class === 0 ? 'class-at-risk' : latest.engagement_class === 1 ? 'class-moderate' : 'class-high');

                        const compEl = document.getElementById('ml-comprehension');
                        compEl.classList.add(latest.comprehension_class === 0 ? 'class-at-risk' : latest.comprehension_class === 1 ? 'class-moderate' : 'class-high');
                    }
                }
            } catch (e) {
                // ML classification is optional - don't break the page
                console.log('ML classification not available:', e.message);
            }
        } else {
            document.getElementById('activity-list').innerHTML = '<p class="text-muted">No engagement recorded yet. Start learning to build your analytics!</p>';
            document.getElementById('insight-text').textContent = 'No engagement data yet.';
        }
    }

    // ── Quiz performance ────────────────────────────────────────────────────
    if (quizRes && quizRes.ok) {
        const qdata = await quizRes.json();
        const results = qdata.results || [];
        const summary = qdata.summary || {};

        if (summary.count) {
            document.getElementById('quiz-avg').textContent = `${summary.average}%`;
            document.getElementById('quiz-count').textContent = summary.count;
            document.getElementById('quiz-best').textContent = `${summary.best}%`;
        }

        const historyEl = document.getElementById('quiz-history');
        if (!results.length) {
            historyEl.innerHTML = '<p class="text-muted">No quizzes taken yet. Take an AI comprehension quiz from a material to see your results here.</p>';
        } else {
            historyEl.innerHTML = results.map(r => {
                const pct = Math.round(r.score);
                const levelClass = (r.comprehension_level || '').toLowerCase();
                const levelBadge = r.comprehension_level || 'N/A';
                const course = r.course_title || 'Course';
                const material = r.material_title || '';
                const date = r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '';

                const obj = r.review.objective || [];
                const objCorrect = obj.filter(o => o.correct).length;
                const objTotal = obj.length;

                const theory = r.review.theory || [];
                const theoryScored = theory.filter(t => t.score != null).length;

                const objHtml = obj.map(o => {
                    const correctIdx = o.correct_index;
                    const chosenIdx = o.chosen_index;
                    return `
                        <div class="review-item">
                            <div class="review-q">${o.question}</div>
                            ${o.options.map((opt, i) => {
                                const isCorrect = i === correctIdx;
                                const isChosen = i === chosenIdx;
                                let cls = '';
                                let mark = '';
                                if (isCorrect) { cls = 'correct'; mark = '✓'; }
                                else if (isChosen) { cls = 'wrong'; mark = '✗'; }
                                else cls = '';
                                return `<div class="opt-row ${cls}"><span class="opt-mark">${mark}</span>${opt}</div>`;
                            }).join('')}
                            <div class="review-meta">${chosenIdx == null ? 'Not answered' : (o.correct ? 'Correct' : `Your answer: ${o.options[chosenIdx] || '(invalid)'}`)}</div>
                        </div>`;
                }).join('');

                const theoryHtml = theory.map(t => {
                    const sc = t.score == null ? null : Math.round(t.score * 100);
                    return `
                        <div class="review-item">
                            <div class="review-q">${t.question}</div>
                            <div class="review-meta"><strong>Your answer:</strong> ${t.answer || '(no answer)'}</div>
                            ${sc == null ? '' : `<div class="review-meta"><strong>Theory score:</strong> ${sc}%</div>`}
                            ${t.feedback ? `<div class="review-feedback">${t.feedback}</div>` : ''}
                        </div>`;
                }).join('');

                return `
                    <div class="quiz-attempt" data-id="${r.id}">
                        <button type="button" class="quiz-attempt-head">
                            <span class="qa-title">${course}${material ? `<small>${material}</small>` : ''}</span>
                            <span class="qa-badge ${levelClass}">${levelBadge}</span>
                            <span class="qa-score">${pct}%</span>
                            <span class="qa-date">${date}</span>
                            <i class="bi bi-chevron-down qa-chevron"></i>
                        </button>
                        <div class="qa-body">
                            ${objTotal ? `<div><h4>Objective Questions — ${objCorrect}/${objTotal}</h4>${objHtml}</div>` : ''}
                            ${theory.length ? `<div><h4>Theory Questions</h4>${theoryHtml}</div>` : ''}
                            ${theoryScored ? `<div class="review-meta">Theory contributes ${theory.length} question${theory.length === 1 ? '' : 's'} to your combined score.</div>` : ''}
                        </div>
                    </div>`;
            }).join('');

            historyEl.querySelectorAll('.quiz-attempt').forEach(el => {
                const head = el.querySelector('.quiz-attempt-head');
                head.addEventListener('click', () => el.classList.toggle('open'));
            });
        }
    }

    showBody();
});

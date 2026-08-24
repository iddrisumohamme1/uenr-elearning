/* 
   ANALYTICS MODULE LOGIC
   frontend/analytics/analytics.js
   Loads engagement analytics + AI quiz results (incl. theory) for a student.
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    document.getElementById('user-avatar').textContent = (user.full_name || 'U').charAt(0).toUpperCase();
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

    // ── Engagement analytics ─────────────────────────────────────────────
    // Primary source: /summary aggregates the FULL history server-side.
    // The plain /student/{id} endpoint only returns the 10 most recent
    // telemetry ticks (~5 minutes), which made every page-level average
    // misleading - it stays wired in purely as a graceful fallback.
    const engagementData = (engagementRes && engagementRes.ok)
        ? await engagementRes.json().catch(() => null)
        : null;
    const logs = engagementData?.logs || [];

    function escapeHtml(v) {
        return String(v ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function fmtMinutes(total) {
        const m = Math.max(0, Math.round(total || 0));
        if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
        return `${m}m`;
    }

    function relDay(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const today = new Date();
        const yesterday = new Date(Date.now() - 864e5);
        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString();
    }

    function setDistBars(highPct, medPct, lowPct) {
        document.getElementById('bar-high').style.width = `${highPct}%`;
        document.getElementById('bar-med').style.width = `${medPct}%`;
        document.getElementById('bar-low').style.width = `${lowPct}%`;
        document.getElementById('pct-high').textContent = `${Math.round(highPct)}%`;
        document.getElementById('pct-med').textContent = `${Math.round(medPct)}%`;
        document.getElementById('pct-low').textContent = `${Math.round(lowPct)}%`;
    }

    function buildActivityChart(daily) {
        const chartEl = document.getElementById('act-chart');
        if (!chartEl || !Array.isArray(daily)) return;
        const maxMin = Math.max(...daily.map(d => d.minutes || 0), 1);
        const activeDays = daily.filter(d => (d.minutes || 0) > 0).length;
        const cap = document.getElementById('chart-caption');
        if (cap) cap.textContent = activeDays
            ? `${activeDays} active day${activeDays === 1 ? '' : 's'} · focus a bar for detail`
            : 'No study time recorded yet';
        const todayKey = new Date().toISOString().slice(0, 10);
        chartEl.innerHTML = daily.map(d => {
            const mins = d.minutes || 0;
            const h = mins > 0 ? Math.max(8, Math.round((mins / maxMin) * 100)) : 3;
            const dt = new Date(`${d.date}T00:00:00`);
            const label = isNaN(dt) ? d.date : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const scoreTxt = d.score ? `, engagement score ${d.score}` : '';
            const dayLetter = isNaN(dt) ? '' : dt.toLocaleDateString(undefined, { weekday: 'narrow' });
            return `
                <div class="act-col${mins === 0 ? ' zero' : ''}${d.date === todayKey ? ' is-today' : ''}"
                     tabindex="0"
                     aria-label="${label}: ${mins} minute${mins === 1 ? '' : 's'} studied${scoreTxt}">
                    <div class="act-track">
                        <div class="act-bar" style="height:${h}%">
                            ${mins ? `<span class="act-val">${mins}</span>` : ''}
                        </div>
                    </div>
                    <span class="act-day">${dayLetter}</span>
                </div>`;
        }).join('');
    }

    function renderRecentSessions(rows) {
        const list = document.getElementById('activity-list');
        if (!rows.length) {
            list.innerHTML = '<p class="text-muted">Open a material and study for a few minutes - your sessions will appear here.</p>';
            return;
        }
        list.innerHTML = rows.map(r => `
            <div class="sess-item">
                <span class="lvl-badge lvl-${escapeHtml((r.level || 'Low')).toLowerCase()}">${escapeHtml(r.level || 'Low')}</span>
                <span class="sess-main">
                    <strong>${escapeHtml(r.material_title)}</strong>
                    ${r.course_title ? `<small>${escapeHtml(r.course_title)}</small>` : ''}
                    <small>${fmtMinutes(r.minutes)} · ${relDay(r.when)}${r.highlights ? ` · ${r.highlights} highlight${r.highlights === 1 ? '' : 's'}` : ''}</small>
                </span>
            </div>`).join('');
    }

    function renderInsights(s) {
        const list = document.getElementById('insight-list');
        const t = s.trend || {};
        const tips = [];

        if ((t.this_week_avg || 0) >= 75) {
            tips.push("Strong week - you're consistently engaged. Carry the momentum into next week.");
        } else if ((t.delta || 0) > 0) {
            tips.push(`Your engagement improved by ${t.delta} point${t.delta === 1 ? '' : 's'} versus last week. Whatever you changed, keep doing it.`);
        } else if ((t.last_week_avg || 0) > 0 && (t.delta || 0) < 0) {
            tips.push(`Engagement dipped ${Math.abs(t.delta)} point${Math.abs(t.delta) === 1 ? '' : 's'} this week. One short focused session today resets the rhythm.`);
        }

        if ((t.active_days || 0) >= 5) {
            tips.push(`${t.active_days} study days this week - excellent consistency.`);
        } else if ((t.active_days || 0) > 0) {
            tips.push(`You studied on ${t.active_days} day${t.active_days === 1 ? '' : 's'} this week. One more short session turns effort into habit.`);
        } else {
            tips.push('No study time yet this week - even ten focused minutes gets things moving again.');
        }

        if ((s.totals.highlights || 0) === 0) {
            tips.push('Try highlighting key passages while reading PDFs - actively marking text boosts recall.');
        } else {
            tips.push(`${s.totals.highlights} highlight${s.totals.highlights === 1 ? '' : 's'} saved - great active-reading work.`);
        }

        if ((s.totals.video_minutes || 0) >= 1) {
            tips.push(`${s.totals.video_minutes} minute${s.totals.video_minutes === 1 ? '' : 's'} of lecture video watched - pairing it with the matching notes strengthens understanding.`);
        }

        list.innerHTML = tips.slice(0, 3).map(tip => `<li>${tip}</li>`).join('');
    }

    function renderLegacyRows() {
        if (!logs.length) {
            document.getElementById('activity-list').innerHTML =
                '<p class="text-muted">Open a course material to start building your analytics.</p>';
            document.getElementById('insight-list').innerHTML = '<li>No engagement data yet.</li>';
            return;
        }
        const totalLogs = logs.length;
        const avgScore = Math.round(logs.reduce((sum, l) => sum + (l.engagement_score || 0), 0) / totalLogs);
        const totalTime = logs.reduce((sum, l) => sum + (l.time_spent || 0), 0);
        const materialsViewed = new Set(logs.map(l => l.material_id).filter(Boolean)).size;

        document.getElementById('wk-engagement').textContent = avgScore;
        document.getElementById('materials-count').textContent = materialsViewed;
        document.getElementById('time-spent').textContent = totalTime > 3600
            ? `${Math.round(totalTime / 3600)}h` : `${Math.round(totalTime / 60)}m`;

        const high = logs.filter(l => (l.engagement_score || 0) >= 75).length;
        const med = logs.filter(l => { const sc = l.engagement_score || 0; return sc >= 40 && sc < 75; }).length;
        const low = totalLogs - high - med;
        setDistBars((high / totalLogs) * 100, (med / totalLogs) * 100, (low / totalLogs) * 100);
        document.getElementById('dist-subtext').textContent =
            'Based on recent check-ins (limited history available).';

        document.getElementById('activity-list').innerHTML = logs.slice(0, 5).map(l => `
            <div class="activity-item">
                <span>${escapeHtml(l.engagement_level || 'N/A')}</span>
                <span class="text-muted">${l.logged_at ? new Date(l.logged_at).toLocaleDateString() : 'Recent'}</span>
            </div>`).join('');

        const tip = avgScore >= 75
            ? "Great job! You're maintaining high engagement."
            : avgScore >= 40
                ? 'Your engagement is moderate. Try setting dedicated study times.'
                : 'Your engagement is low. Consider breaking study sessions into smaller chunks.';
        document.getElementById('insight-list').innerHTML = `<li>${tip}</li>`;
    }

    function renderDailyFallback(rows) {
        // Client-side 14-day buckets from whatever log rows we have.
        const buckets = new Map();
        for (let i = 13; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            buckets.set(d.toISOString().slice(0, 10), { minutes: 0, scoreW: 0, secsW: 0 });
        }
        rows.forEach(l => {
            if (!l.logged_at) return;
            const key = l.logged_at.slice(0, 10);
            const b = buckets.get(key);
            if (!b) return;
            const secs = l.time_spent || 0;
            const score = l.engagement_score || 0;
            b.minutes += Math.round(secs / 60);
            b.scoreW += score * secs;
            b.secsW += secs;
        });
        const daily = [...buckets.entries()].map(([date, b]) => ({
            date,
            minutes: b.minutes,
            score: b.secsW > 0 ? Math.round(b.scoreW / b.secsW) : 0,
        }));
        buildActivityChart(daily);
        const totalMin = daily.reduce((s, d) => s + d.minutes, 0);
        setRhythmTotal(totalMin);
        document.getElementById('chart-caption').textContent =
            totalMin > 0
                ? 'Recent check-ins only - full history unavailable right now'
                : 'No study time yet - open a material to start your first session';
    }

    function setRhythmTotal(totalMinutes) {
        document.getElementById('rhythm-total').textContent = fmtMinutes(totalMinutes);
    }

    // Learning profile: friendly wording lives here - the backend's
    // dataset-trained labels never reach the student.
    const PROFILE_LEVELS = [
        { word: 'Needs attention', tone: 'low' },
        { word: 'Steady', tone: 'medium' },
        { word: 'Excellent', tone: 'high' },
    ];
    const PROFILE_COMPREHENSION = [
        { word: 'Building up', tone: 'low' },
        { word: 'Fair', tone: 'medium' },
        { word: 'Strong', tone: 'high' },
    ];

    async function loadClassification() {
        try {
            const clsRes = await authFetch(`${API_BASE}/api/engagement/student/${user.id}/classification`);
            if (!clsRes.ok) return;
            const clsData = await clsRes.json();
            const latest = clsData.latest;
            if (!latest) return;

            const eng = PROFILE_LEVELS[latest.engagement_class] || PROFILE_LEVELS[1];
            const comp = PROFILE_COMPREHENSION[latest.comprehension_class] || PROFILE_COMPREHENSION[1];

            document.getElementById('profile-card').style.display = 'block';
            const engEl = document.getElementById('profile-engagement');
            engEl.textContent = eng.word;
            engEl.className = `lvl-badge lvl-${eng.tone}`;
            const compEl = document.getElementById('profile-comprehension');
            compEl.textContent = comp.word;
            compEl.className = `lvl-badge lvl-${comp.tone}`;

            if (latest.created_at) {
                const d = new Date(latest.created_at);
                document.getElementById('profile-updated').textContent =
                    `Updated ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            }
        } catch (e) {
            console.log('Learning profile unavailable:', e.message);
        }
    }

    if (engagementData) {
        let rendered = false;
        try {
            const summaryRes = await authFetch(`${API_BASE}/api/engagement/student/${user.id}/summary`).catch(() => null);
            const summary = (summaryRes && summaryRes.ok)
                ? await summaryRes.json().catch(() => null)
                : null;

            if (summary && (summary.session_count || 0) > 0) {
                renderSummary(summary);
                rendered = true;
            } else if (summary) {
                // Summary responded but no sessions yet - draw what raw rows show
                renderDailyFallback(logs);
                renderLegacyRows();
                rendered = true;
            }
        } catch (err) {
            console.error('Study history failed to load:', err);
            renderDailyFallback(logs);
            renderLegacyRows();
            rendered = true;
        }

        if (!rendered) {
            renderDailyFallback([]);
            renderLegacyRows();
        }

        loadClassification();
    }

    // ── Quiz performance ─────────────────────────────────────────────────
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

    // ── Assignment performance ───────────────────────────────────────────
    try {
        const studyRes = await authFetch(`${API_BASE}/api/study/summary/${user.id}`);
        if (studyRes.ok) {
            const sdata = await studyRes.json();
            const rows = (sdata.courses || []).filter(c => (c.assignments_total || 0) > 0);
            const total = rows.reduce((s, c) => s + c.assignments_total, 0);
            const submitted = rows.reduce((s, c) => s + c.assignments_submitted, 0);
            const onTime = rows.reduce((s, c) => s + c.assignments_on_time, 0);
            const graded = rows.filter(c => c.assignments_grade_avg != null);
            const avg = graded.length
                ? Math.round(graded.reduce((s, c) => s + c.assignments_grade_avg, 0) / graded.length)
                : null;

            document.getElementById('assign-avg').textContent = avg != null ? `${avg}%` : '--';
            document.getElementById('assign-submitted').textContent = `${submitted}/${total}`;
            document.getElementById('assign-ontime').textContent = total ? `${onTime}/${total}` : '--';

            const historyEl = document.getElementById('assignment-history');
            if (!rows.length) {
                historyEl.innerHTML = '<p class="text-muted">No assignments yet. Download a course material to generate an AI assignment.</p>';
            } else {
                historyEl.innerHTML = rows.map(c => {
                    const g = c.assignments_grade_avg;
                    const avgText = g != null ? `${g}%` : 'n/a';
                    const cls = g == null ? '' : g >= 70 ? 'good' : g >= 50 ? 'moderate' : 'low';
                    return `
                        <div class="assign-row">
                            <span class="qa-title">${c.course_title}<small>${c.course_code || ''}</small></span>
                            <span class="qa-badge ${cls}">${avgText}</span>
                            <span class="qa-score">${c.assignments_submitted}/${c.assignments_total}</span>
                        </div>`;
                }).join('');
            }
        }
    } catch (err) {
        console.error('Assignment performance failed:', err);
    }

    function renderSummary(s) {
        const t = s.trend || {};
        const wkEl = document.getElementById('wk-engagement');
        wkEl.textContent = t.this_week_avg ?? '--';

        const chip = document.getElementById('trend-chip');
        const delta = t.delta ?? 0;
        if (!t.this_week_avg && !t.last_week_avg) {
            chip.style.display = 'none';
        } else {
            chip.style.display = 'inline-flex';
            if (delta > 0) { chip.className = 'trend-chip up'; chip.textContent = `▲ +${delta} vs last week`; }
            else if (delta < 0) { chip.className = 'trend-chip down'; chip.textContent = `▼ ${delta} vs last week`; }
            else { chip.className = 'trend-chip flat'; chip.textContent = 'steady vs last week'; }
        }

        document.getElementById('materials-count').textContent = s.totals?.materials_viewed ?? 0;
        document.getElementById('time-spent').textContent = fmtMinutes(s.totals?.minutes || 0);

        const daily = s.daily || [];
        buildActivityChart(daily);
        setRhythmTotal(daily.reduce((sum, d) => sum + (d.minutes || 0), 0));

        const nSess = s.session_count || 0;
        const dist = s.distribution || {};
        document.getElementById('dist-subtext').textContent = nSess
            ? `Ranked across your ${nSess} study session${nSess === 1 ? '' : 's'} so far.`
            : 'No study sessions recorded yet.';
        setDistBars(dist.High || 0, dist.Medium || 0, dist.Low || 0);

        renderRecentSessions(s.recent_sessions || []);
        renderInsights(s);
    }

    showBody();
});

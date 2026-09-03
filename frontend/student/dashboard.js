/* 
   STUDENT DASHBOARD LOGIC
   frontend/student/dashboard.js
*/

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireSession('student').catch(() => null);
    if (!user) return;

    // Update Profile Info
    document.getElementById('welcome-text').textContent = `Welcome, ${user.full_name.split(' ')[0]}`;
    document.querySelector('.avatar').textContent = user.full_name.charAt(0).toUpperCase();

    attachLogout('logout-btn');
    initProfilePopup();

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function setEngagementValue(score) {
        document.getElementById('engagement-value').textContent =
            (score === null || score === undefined) ? '--%' : `${score}%`;
    }

    async function loadStats() {
        let fallbackScore = null;
        try {
            await swrGet('stats', `${API_BASE}/api/students/${user.id}/stats`, stats => {
                // Last-20-tick average - only used if the weekly summary
                // endpoint is unavailable, so the card never goes blank.
                fallbackScore = stats.engagement_score;
                document.getElementById('courses-count').textContent = stats.enrolled_courses;
                document.getElementById('completed-count').textContent = stats.completed_topics;

                // The Grade card opens the progress page, which is empty until the
                // student enrols in a course — hide it for brand-new users.
                const gradeCard = document.getElementById('predicted-grade')?.closest('.stat-card');
                if (!gradeCard) return;
                gradeCard.style.display = stats.enrolled_courses ? '' : 'none';
            });
        } catch (err) {
            console.error('Error loading stats:', err);
        }

        // Same source as the Performance page's "This Week's Engagement",
        // so both pages always agree. forceRefresh bypasses the SWR cache -
        // a stale weekly score is worse than no cache at all here.
        try {
            await swrGet('eng-summary', `${API_BASE}/api/engagement/student/${user.id}/summary`, data => {
                const wk = data?.trend?.this_week_avg;
                setEngagementValue(wk ?? fallbackScore);
            }, { forceRefresh: true });
        } catch (err) {
            console.error('Engagement summary failed, using recent-average fallback:', err);
            setEngagementValue(fallbackScore);
        }
    }

    async function loadStudyInsights() {
        try {
            await swrGet('study-summary', `${API_BASE}/api/study/summary/${user.id}`, data => {
                const overall = data.overall || {};
                document.getElementById('predicted-grade').textContent = overall.predicted_grade || '–';

                const warning = document.getElementById('study-warning');
                if (overall.active_warnings) {
                    warning.hidden = false;
                    document.getElementById('study-warning-text').textContent =
                        `${overall.active_warnings} of your courses need more study time this week. Click through to see how to improve your predicted grade.`;
                } else {
                    warning.hidden = true;
                }
            });
        } catch (err) {
            console.error('Error loading study insights:', err);
        }
    }

    async function loadCourses() {
        const grid = document.getElementById('course-grid');
        try {
            await swrGet('my-courses', `${API_BASE}/api/students/${user.id}/courses`, courses => {
                if (!courses.length) {
                    grid.innerHTML = '<p class="text-muted">No courses enrolled yet. <a href="../courses/courses.html">Browse courses</a></p>';
                    return;
                }

                // Per-course accent derived from the course code, keeping the
                // emerald brand alive while giving each card a distinct tile.
                function accentFor(code, progress) {
                    if (progress >= 100) return { grad: 'linear-gradient(135deg,#22c55e,#16a34a)', glow: 'rgba(34,197,94,0.4)', ink: 'var(--clr-success)' };
                    let seed = 0;
                    const key = String(code || 'UENR');
                    for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
                    const hue = 150 + (seed % 90);
                    return {
                        grad: `linear-gradient(135deg,hsl(${hue},70%,52%),hsl(${hue},72%,40%))`,
                        glow: `hsla(${hue},70%,52%,0.45)`,
                        ink: `hsl(${hue},70%,58%)`,
                    };
                }
                function monogramFor(title) {
                    const words = String(title || '?').trim().split(/\s+/);
                    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
                    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
                }

                const CLAMP = 6;
                grid.innerHTML = courses.map(course => {
                    const progress = Math.min(100, Math.max(0, course.progress || 0));
                    const accent = accentFor(course.code, progress);
                    const done = progress >= 100;
                    return `
                        <a class="course-card tappable" href="../materials/materials.html?id=${course.id}"
                           style="--card-accent:${accent.grad};--card-accent-glow:${accent.glow};--card-accent-ink:${accent.ink};">
                            <div class="course-card-head">
                                <span class="course-card-tile" style="background:${accent.grad};box-shadow:0 6px 16px -6px ${accent.glow};">${monogramFor(course.title)}</span>
                                <span class="course-card-meta">
                                    <span class="course-card-code">${escapeHTML(course.code || 'UENR')}</span>
                                    <span class="course-card-lecturer">${escapeHTML(course.lecturer_name || 'Unknown Lecturer')}</span>
                                </span>
                            </div>
                            <h4 class="course-card-title">${escapeHTML(course.title)}</h4>
                            <span class="course-card-status ${done ? 'is-done' : progress > 0 ? 'is-active' : 'is-fresh'}">
                                <i class="bi ${done ? 'bi-check-circle-fill' : progress > 0 ? 'bi-arrow-repeat' : 'bi-hourglass-split'}" aria-hidden="true"></i>
                                ${done ? 'Completed' : progress > 0 ? 'In progress' : 'Not started'}
                            </span>
                            <div class="course-card-foot">
                                <div class="course-card-gauge">
                                    <div class="course-card-progress-track">
                                        <div class="course-card-progress-fill" style="width:${progress}%;background:${accent.grad};"></div>
                                    </div>
                                    <span class="course-card-pct" style="color:${accent.ink};">${progress}%</span>
                                </div>
                                <span class="course-card-go">${done ? 'Review' : 'Continue'}<i class="bi bi-arrow-right" aria-hidden="true"></i></span>
                            </div>
                        </a>
                    `;
                }).join('');

                if (courses.length <= CLAMP) return;

                grid.classList.add('clamped');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'show-all-btn';
                btn.textContent = `Show all ${courses.length} courses`;
                btn.setAttribute('aria-expanded', 'false');
                btn.addEventListener('click', () => {
                    const expanded = grid.classList.toggle('clamped');
                    btn.textContent = expanded
                        ? `Show all ${courses.length} courses`
                        : 'Show fewer';
                    btn.setAttribute('aria-expanded', String(!expanded));
                });
                grid.appendChild(btn);
            });
        } catch (err) {
            console.error('Error loading courses:', err);
            grid.innerHTML = '<p style="color:var(--text-muted); padding:var(--s6);">Unable to load courses.</p>';
            showToast('Unable to load courses.', 'error');
        }
    }

    async function loadUnreadMessages() {
        try {
            const res = await authFetch(`${API_BASE}/api/messages/unread-count`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.unread_count > 0) {
                showToast(
                    `You have ${data.unread_count} unread message${data.unread_count > 1 ? 's' : ''} from your lecturer. Open the Inbox.`,
                    'info',
                    { title: 'New Message', duration: 8000 }
                );
            }
        } catch (err) {
            console.error('Error checking unread messages:', err);
        }
    }

    loadStats();
    loadStudyInsights();
    loadCourses();
    loadUnreadMessages();
});

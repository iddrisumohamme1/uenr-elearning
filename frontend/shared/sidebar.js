/*
   SHARED SIDEBAR RENDERER
   frontend/shared/sidebar.js

   Single source of truth for the sidebar across all role pages. Reads the
   logged-in user from localStorage, picks the nav set for their role, and
   injects the sidebar markup into <aside class="sidebar" id="app-sidebar">.

   Links are built relative to the current page's folder so the sidebar
   never loses items when a user navigates across role folders (e.g. a HOD
   opening a lecturer page still sees the full HOD nav).

   Load this BEFORE session.js (and before the page's own scripts) so the
   logout button exists when attachLogout() runs and so student nav badges
   attach to the rendered links.
*/

(function () {
    const NAV_SETS = {
        hod: [
            { folder: 'hod', file: 'dashboard.html', icon: 'bi-house-door', label: 'Overview' },
            { folder: 'hod', file: 'department_courses.html', icon: 'bi-journal-text', label: 'Courses' },
            { folder: 'hod', file: 'create_course.html', icon: 'bi-plus-circle', label: 'Add Course' },
            { folder: 'hod', file: 'upload.html', icon: 'bi-cloud-arrow-up', label: 'Upload Material' },
        ],
        lecturer: [
            { folder: 'lecturer', file: 'dashboard.html', icon: 'bi-house-door', label: 'Dashboard' },
            { folder: 'lecturer', file: 'upload.html', icon: 'bi-cloud-arrow-up', label: 'Upload Content' },
            { folder: 'lecturer', file: 'my_courses.html', icon: 'bi-journal-bookmark', label: 'My Courses' },
        ],
        student: [
            { folder: 'student', file: 'dashboard.html', icon: 'bi-house-door', label: 'Dashboard' },
            { folder: 'courses', file: 'courses.html', icon: 'bi-book', label: 'My Courses' },
            { folder: 'student', file: 'study_resources.html', icon: 'bi-lightbulb', label: 'Study Aids' },
            { folder: 'student', file: 'progress.html', icon: 'bi-speedometer2', label: 'My Progress' },
            { folder: 'student', file: 'assignments.html', icon: 'bi-journal-check', label: 'Assignments' },
            { folder: 'student', file: 'inbox.html', icon: 'bi-inbox', label: 'Inbox' },
            { folder: 'recommendations', file: 'recommendations.html', icon: 'bi-stars', label: 'Recommendations' },
            { folder: 'analytics', file: 'analytics.html', icon: 'bi-graph-up-arrow', label: 'Performance' },
        ],
    };

    function escapeHTML(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(str).replace(/[&<>"']/g, c => map[c]);
    }

    function currentPage() {
        const parts = (window.location.pathname || '').split('/').filter(Boolean);
        const file = parts[parts.length - 1] || '';
        const folder = parts.length > 1 ? parts[parts.length - 2] : '';
        return { folder, file };
    }

    function buildHref(item, currentFolder) {
        if (item.folder === currentFolder) return item.file;
        return `../${item.folder}/${item.file}`;
    }

    function render() {
        const host = document.getElementById('app-sidebar') || document.querySelector('.sidebar');
        if (!host) return;

        let user = null;
        try {
            user = JSON.parse(localStorage.getItem('user')) || null;
        } catch (err) {
            user = null;
        }

        const navItems = (user && NAV_SETS[user.role]) ? NAV_SETS[user.role] : [];
        const { folder: currentFolder, file: currentFile } = currentPage();

        const links = navItems.map(item => {
            const active = item.file === currentFile ? ' active' : '';
            return `
                <a href="${escapeHTML(buildHref(item, currentFolder))}" class="nav-link${active}">
                    <span class="nav-icon"><i class="bi ${item.icon}"></i></span>
                    <span class="nav-label"> ${escapeHTML(item.label)}</span>
                </a>
            `;
        }).join('');

        host.innerHTML = `
            <div class="sidebar-header"><img class="logo" src="../image/UENR-LOGO.png" alt="UENR Learn logo" /><span class="logo-text"> UENR Learn</span></div>
            <nav class="sidebar-nav">
                ${links}
            </nav>
            <div class="sidebar-footer">
                <button id="logout-btn"><span class="nav-icon"><i class="bi bi-box-arrow-right"></i></span><span class="nav-label"> Logout</span></button>
            </div>
        `;
    }

    /* Mobile drawer: inject a hamburger toggle into the page header's left
       corner and a scrim behind the drawer. Visible only at <= 560px (see
       responsive.css). Most pages use a .top-bar (with an optional nested
       .title-row for the title/profile row); quiz pages use .quiz-header.
       The toggle is dropped at the far left of whichever header exists. */
    function initMobileNav() {
        if (document.querySelector('.sidebar-toggle')) return;
        const topBar = document.querySelector('.top-bar')
            || document.querySelector('.page-header')
            || document.querySelector('.quiz-header');
        if (!topBar) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-toggle';
        btn.setAttribute('aria-label', 'Open menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<i class="bi bi-list"></i>';
        (topBar.querySelector('.title-row') || topBar).prepend(btn);
        const backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop';
        document.body.appendChild(backdrop);

        const icon = btn.querySelector('i');
        const host = document.getElementById('app-sidebar') || document.querySelector('.sidebar');

        function setOpen(open) {
            document.body.classList.toggle('sidebar-open', open);
            btn.setAttribute('aria-expanded', String(open));
            btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
            if (icon) icon.className = open ? 'bi bi-x-lg' : 'bi bi-list';
        }

        btn.addEventListener('click', () => setOpen(!document.body.classList.contains('sidebar-open')));
        backdrop.addEventListener('click', () => setOpen(false));
        // Any button/link tapped inside the drawer closes it.
        if (host) {
            host.addEventListener('click', (e) => {
                if (e.target.closest('button, a')) setOpen(false);
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) setOpen(false);
        });
    }

    function mount() {
        render();
        initMobileNav();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();

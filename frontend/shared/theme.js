/*
   THEME MANAGER
   frontend/shared/theme.js
   Handles dark/light mode toggle. Reads/writes preference to localStorage.
   Include <script src="../shared/theme.js"></script> in every page.
*/

(function() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
})();

function getTheme() {
    return localStorage.getItem('theme') || 'light';
}

function setTheme(theme) {
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    const current = getTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    return next;
}

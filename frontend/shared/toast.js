/*
 * ==============================================================================
 * SHARED TOAST NOTIFICATIONS
 * ==============================================================================
 * File: frontend/shared/toast.js
 * Purpose: Provides showToast() globally. Auto-injects container + CSS.
 * Usage: showToast('Something went wrong', 'error')
 *        showToast('Saved successfully', 'success')
 *        showToast('Check your input', 'warning')
 *        showToast('FYI', 'info')
 * ==============================================================================
 */

(function () {
    /* Inject toast.css once if not already loaded */
    if (!document.querySelector('link[href*="toast.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '../shared/toast.css';
        document.head.appendChild(link);
    }

    /* Ensure container exists */
    function ensureContainer() {
        let c = document.getElementById('toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'toast-container';
            c.className = 'toast-container';
            document.body.appendChild(c);
        }
        return c;
    }

    const ICONS = {
        error:   '<i class="bi bi-x-circle-fill"></i>',
        success: '<i class="bi bi-check-circle-fill"></i>',
        warning: '<i class="bi bi-exclamation-triangle-fill"></i>',
        info:    '<i class="bi bi-info-circle-fill"></i>'
    };

    const TITLES = {
        error:   'Error',
        success: 'Success',
        warning: 'Warning',
        info:    'Info'
    };

    function escapeHTML(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(str).replace(/[&<>"']/g, function (c) { return map[c]; });
    }

    /**
     * Show a styled toast notification.
     * @param {string} message  - The message body.
     * @param {string} type     - 'error' | 'success' | 'warning' | 'info' (default 'error')
     * @param {object} [opts]   - { title, duration, closable }
     */
    window.showToast = function (message, type, opts) {
        type  = type  || 'error';
        opts  = opts  || {};
        const duration = opts.duration !== undefined ? opts.duration : 5000;
        const title    = opts.title    || TITLES[type] || TITLES.error;
        const closable = opts.closable !== undefined ? opts.closable : true;

        const container = ensureContainer();

        const toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.innerHTML =
            '<span class="toast-icon">' + (ICONS[type] || ICONS.error) + '</span>' +
            '<div class="toast-body">' +
                '<div class="toast-title">' + escapeHTML(title) + '</div>' +
                '<div class="toast-message">' + escapeHTML(message) + '</div>' +
            '</div>' +
            (closable ? '<button class="toast-close" aria-label="Close">&times;</button>' : '');

        if (closable) {
            // Clicking anywhere on the toast dismisses it; the close button
            // is covered by bubbling, and dismiss() ignores repeat calls.
            toast.style.cursor = 'pointer';
            toast.addEventListener('click', function () {
                dismiss(toast);
            });
        }

        container.appendChild(toast);

        if (duration > 0) {
            setTimeout(function () { dismiss(toast); }, duration);
        }

        return toast;
    };

    function dismiss(toast) {
        if (!toast || toast.classList.contains('toast-exit')) return;
        toast.classList.add('toast-exit');
        toast.addEventListener('animationend', function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        });
    }
})();

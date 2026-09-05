/*
 * ==============================================================================
 * SHARED CUSTOM DROPDOWN
 * ==============================================================================
 * File: frontend/shared/dropdown.js
 * Purpose: Progressive enhancement that upgrades every <select data-dropdown>
 *          into a theme-aware, responsive custom dropdown (see dropdown.css).
 *
 * The native <select> stays in the DOM (visually hidden) and its .value is kept
 * in sync, and a native 'change' event is dispatched on selection — so every
 * existing form, filter, and script keeps working unchanged.
 *
 * Features: ARIA combobox/listbox, full keyboard navigation, viewport-aware
 * placement (flips above when no room below), mobile bottom-sheet via CSS,
 * and a MutationObserver that rebuilds the list when options are populated
 * dynamically (lecturer lists, semester filters, course pickers, etc.).
 * ==============================================================================
 */

(function () {
    'use strict';

    let initialized = false;
    let openPanel = null;

    const SHEET_QUERY = '(max-width: 560px) and (pointer: coarse)';
    const isSheet = () => window.matchMedia(SHEET_QUERY).matches;

    function enhance(select) {
        if (!select || select.dataset.ddEnhanced) return;
        select.dataset.ddEnhanced = 'true';

        const panelId = 'dd-panel-' + (select.id || 'dd' + Math.random().toString(36).slice(2, 8));
        const layoutClasses = ['filter-select', 'semester-filter', 'tutor-course-select', 'form-input'];

        const wrapper = document.createElement('span');
        wrapper.className = 'dd';
        if (select.classList.contains('form-input')) wrapper.classList.add('dd--block');

        const isSm = select.dataset.dropdownSize === 'sm' ||
                     select.classList.contains('filter-select') ||
                     select.classList.contains('semester-filter') ||
                     select.classList.contains('tutor-course-select');
        if (isSm) wrapper.classList.add('dd--sm');

        layoutClasses.forEach(c => {
            if (c !== 'form-input' && select.classList.contains(c)) wrapper.classList.add(c);
        });

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'dd__trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', panelId);
        trigger.innerHTML =
            '<span class="dd__value"></span>' +
            '<span class="dd__chevron" aria-hidden="true"><i class="bi bi-chevron-down"></i></span>';

        const panel = document.createElement('div');
        panel.className = 'dd__panel';
        panel.setAttribute('role', 'listbox');
        panel.setAttribute('id', panelId);
        panel.hidden = true;

        const searchable = select.hasAttribute('data-dropdown-search');
        const forcedDown = select.dataset.dropdownDir === 'down';
        let searchBox = null;
        let listEl = null;
        let emptyEl = null;

        if (searchable) {
            panel.classList.add('dd__panel--search');

            const searchWrap = document.createElement('div');
            searchWrap.className = 'dd__search-wrap';
            searchBox = document.createElement('input');
            searchBox.type = 'search';
            searchBox.className = 'dd__search';
            searchBox.setAttribute('aria-label', 'Search options');
            searchBox.placeholder = 'Search…';
            searchWrap.appendChild(searchBox);

            listEl = document.createElement('div');
            listEl.className = 'dd__list';
            emptyEl = document.createElement('div');
            emptyEl.className = 'dd__empty';
            emptyEl.hidden = true;
            emptyEl.textContent = 'No matching options';

            panel.appendChild(searchWrap);
            panel.appendChild(listEl);
            panel.appendChild(emptyEl);

            searchBox.addEventListener('input', function () {
                query = searchBox.value.trim().toLowerCase();
                applyFilter();
            });
            searchBox.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const first = optionButtons.find(function (b) {
                        return !b.disabled && !b.classList.contains('dd__option--gone');
                    });
                    if (first) first.focus();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const last = optionButtons.slice().reverse().find(function (b) {
                        return !b.disabled && !b.classList.contains('dd__option--gone');
                    });
                    if (last) last.focus();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                    trigger.focus();
                }
            });
        }

        select.classList.add('dd__native');
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(trigger);
        wrapper.appendChild(panel);
        wrapper.appendChild(select);

        if (select.getAttribute('aria-label')) {
            trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
        } else if (select.id) {
            const label = document.querySelector('label[for="' + select.id + '"]');
            if (label) trigger.setAttribute('aria-labelledby', label.id || null);
        }
        if (select.disabled) trigger.disabled = true;

        let optionButtons = [];
        let query = '';

        function makeOption(opt) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dd__option';
            btn.setAttribute('role', 'option');
            btn.dataset.value = opt.value;
            btn.innerHTML =
                '<span class="dd__option-text"></span>' +
                '<span class="dd__check" aria-hidden="true"><i class="bi bi-check-lg"></i></span>';
            btn.querySelector('.dd__option-text').textContent = opt.textContent;
            if (opt.disabled) {
                btn.setAttribute('aria-disabled', 'true');
                btn.disabled = true;
            }
            btn.addEventListener('click', function () { selectOption(opt.value); });
            optionButtons.push(btn);
            return btn;
        }

        function applyFilter() {
            if (!searchable) return;
            const q = query;
            let visible = 0;
            optionButtons.forEach(function (btn) {
                const text = btn.querySelector('.dd__option-text').textContent.toLowerCase();
                const match = !q || text.indexOf(q) !== -1;
                btn.classList.toggle('dd__option--gone', !match);
                if (match) visible++;
            });
            emptyEl.hidden = visible > 0;
        }

        function buildOptions() {
            const options = Array.prototype.slice.call(select.options);
            optionButtons = [];

            if (options.length === 0) {
                if (searchable) {
                    listEl.innerHTML = '';
                    emptyEl.hidden = false;
                    emptyEl.textContent = 'No options';
                } else {
                    panel.innerHTML = '<div class="dd__empty">No options</div>';
                }
                return;
            }

            if (searchable) {
                listEl.innerHTML = '';
                options.forEach(function (opt) { listEl.appendChild(makeOption(opt)); });
                applyFilter();
            } else {
                panel.innerHTML = '';
                options.forEach(function (opt) { panel.appendChild(makeOption(opt)); });
            }
            syncSelected();
        }

        function currentOption() {
            return select.options[select.selectedIndex] || null;
        }

        function syncSelected() {
            const opt = currentOption();
            const value = opt ? opt.value : '';
            optionButtons.forEach(function (btn) {
                const sel = btn.dataset.value === value;
                btn.setAttribute('aria-selected', sel ? 'true' : 'false');
            });
            const valueEl = trigger.querySelector('.dd__value');
            valueEl.textContent = opt ? opt.textContent : '';
            if (value === '') {
                trigger.classList.add('dd__trigger--placeholder');
            } else {
                trigger.classList.remove('dd__trigger--placeholder');
            }
        }

        function selectOption(value) {
            select.value = value;
            syncSelected();
            select.dispatchEvent(new Event('change', { bubbles: true }));
            close();
            trigger.focus();
        }

        function positionPanel() {
            panel.classList.remove('dd__panel--up');
            if (forcedDown) return;
            const rect = panel.getBoundingClientRect();
            if (rect.bottom > window.innerHeight) {
                panel.classList.add('dd__panel--up');
            }
        }

        function open() {
            if (openPanel && openPanel !== panel) closeOpenPanel();
            syncSelected();
            panel.hidden = false;
            if (!isSheet()) positionPanel();
            openPanel = panel;
            trigger.setAttribute('aria-expanded', 'true');

            if (searchable && !isSheet()) {
                searchBox.focus();
                return;
            }
            const selected = optionButtons.find(function (b) { return !b.disabled && b.dataset.value === select.value; });
            const focusTarget = selected || optionButtons.find(function (b) { return !b.disabled; });
            if (focusTarget) focusTarget.focus();
        }

        function close() {
            panel.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (openPanel === panel) openPanel = null;
        }

        function toggle() {
            if (panel.hidden) open(); else close();
        }

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            toggle();
        });

        trigger.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                open();
            } else if (e.key === 'Escape') {
                close();
            }
        });

        panel.addEventListener('keydown', function (e) {
            const enabled = optionButtons.filter(function (b) { return !b.disabled && !b.classList.contains('dd__option--gone'); });
            if (enabled.length === 0) return;

            let idx = enabled.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                idx = Math.min(idx + 1, enabled.length - 1);
                enabled[idx].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                idx = Math.max(idx - 1, 0);
                enabled[idx].focus();
            } else if (e.key === 'Home') {
                e.preventDefault();
                enabled[0].focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                enabled[enabled.length - 1].focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                const active = document.activeElement;
                if (active && active.classList.contains('dd__option') && !active.disabled) {
                    e.preventDefault();
                    selectOption(active.dataset.value);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
                trigger.focus();
            } else if (e.key === 'Tab') {
                close();
            }
        });

        document.addEventListener('pointerdown', function (e) {
            if (!wrapper.contains(e.target) && !panel.hidden) close();
        });

        const observer = new MutationObserver(buildOptions);
        observer.observe(select, { childList: true, subtree: true });

        select._ddBuild = buildOptions;
        buildOptions();
    }

    function closeOpenPanel() {
        const panels = document.querySelectorAll('.dd__panel:not([hidden])');
        panels.forEach(function (p) {
            p.hidden = true;
            const w = p.closest('.dd');
            if (w) {
                const t = w.querySelector('.dd__trigger');
                if (t) t.setAttribute('aria-expanded', 'false');
            }
        });
        openPanel = null;
    }

    function init(root) {
        (root || document).querySelectorAll('select[data-dropdown]').forEach(enhance);
    }

    function ensureInit() {
        if (!initialized) {
            initialized = true;
            init(document);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureInit);
    } else {
        ensureInit();
    }

    window.Dropdowns = {
        init: init,
        refresh: function (sel) {
            if (sel && sel._ddBuild) sel._ddBuild();
            else if (sel) enhance(sel);
        }
    };
})();

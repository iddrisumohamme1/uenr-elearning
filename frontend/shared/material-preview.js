/*
   MATERIAL PREVIEW MODAL
   frontend/shared/material-preview.js
   Staff-facing read-only preview of a course material: PDFs render with the
   vendored PDF.js, videos/images play inline, and office documents use their
   server-generated PDF twin (falling back to an inline iframe + Download).
   All files are served by the access-checked /api/materials/view/{id}
   endpoint, so no storage URL is exposed.
*/

(function () {
    'use strict';

    let overlay = null;

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function viewUrl(material, variant) {
        return `${API_BASE}/api/materials/view/${encodeURIComponent(material.id)}${variant ? `?variant=${variant}` : ''}`;
    }

    // Native media elements (<img>/<video>/<iframe>, PDF.js) cannot send the
    // Authorization header, so they authenticate with a short-lived,
    // material-scoped token fetched via authFetch and appended as ?vt=.
    const tokenCache = {}; // materialId -> { token, expiresAt }

    async function fetchViewToken(materialId) {
        const res = await authFetch(`${API_BASE}/api/materials/view-token/${encodeURIComponent(materialId)}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to authorize material');
        }
        return res.json();
    }

    async function signedViewUrl(material, variant) {
        let entry = tokenCache[material.id];
        const now = Date.now();
        if (!entry || now >= entry.expiresAt - 30000) {
            const data = await fetchViewToken(material.id);
            entry = { token: data.token, expiresAt: (data.expires_at || 0) * 1000 };
            tokenCache[material.id] = entry;
        }
        let url = viewUrl(material, variant);
        url += (url.includes('?') ? '&' : '?') + `vt=${encodeURIComponent(entry.token)}`;
        return url;
    }

    function kindOf(material) {
        const type = (material.content_type || '').toLowerCase();
        const url = (material.content_url || '').toLowerCase();
        if (type.startsWith('video/') || /\.(mp4|webm|ogg)$/.test(url)) return 'video';
        if (type.startsWith('image/') || /\.(jpg|jpeg|png|gif|svg|webp)$/.test(url)) return 'image';
        const hasPdfTwin = !!(material.render_url || '');
        if (hasPdfTwin || type === 'application/pdf' || url.endsWith('.pdf')) return 'pdf';
        return 'iframe';
    }

    function buildModal() {
        overlay = document.createElement('div');
        overlay.className = 'mp-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="mp-card" role="dialog" aria-modal="true" aria-label="Material preview">
                <header class="mp-head">
                    <div class="mp-heading">
                        <span class="mp-eyebrow">Material preview</span>
                        <h3 class="mp-title"></h3>
                    </div>
                    <button type="button" class="mp-close" aria-label="Close preview">&times;</button>
                </header>
                <div class="mp-body"></div>
                <footer class="mp-foot">
                    <span class="mp-kind"></span>
                    <div class="mp-actions">
                        <button type="button" class="mp-btn mp-btn-open" title="Open the file in a new tab"><i class="bi bi-box-arrow-up-right"></i> Open full view</button>
                        <button type="button" class="mp-btn mp-btn-dl"><i class="bi bi-download"></i> Download</button>
                    </div>
                </footer>
            </div>`;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        overlay.querySelector('.mp-close').addEventListener('click', close);

        overlay.querySelector('.mp-btn-open').addEventListener('click', async () => {
            const m = state.material;
            if (!m) return;
            const win = window.open('about:blank', '_blank');
            if (!win) return;
            try {
                win.location.href = await signedViewUrl(m, state.variant);
            } catch (err) {
                win.close();
                console.error('Failed to open full view:', err);
            }
        });
        overlay.querySelector('.mp-btn-dl').addEventListener('click', () => {
            const m = state.material;
            if (m) downloadMaterial(m);
        });
    }

    const state = { material: null, variant: 'content' };

    function close() {
        if (!overlay) return;
        overlay.hidden = true;
        const body = overlay.querySelector('.mp-body');
        body.innerHTML = '';
        state.material = null;
        document.body.style.overflow = '';
    }

    function openMaterialPreview(material) {
        if (!overlay) buildModal();
        const body = overlay.querySelector('.mp-body');
        state.material = material;

        const kind = kindOf(material);
        const hasPdfTwin = !!(material.render_url || '');
        // PDF twin is the rendering surface for office uploads.
        state.variant = kind === 'pdf' && (hasPdfTwin || (material.content_type || '').toLowerCase() !== 'application/pdf' && !(material.content_url || '').toLowerCase().endsWith('.pdf'))
            ? 'render'
            : 'content';

        overlay.querySelector('.mp-title').textContent = material.title || 'Material preview';
        overlay.querySelector('.mp-kind').textContent = kind.toUpperCase();

        body.innerHTML = '<div class="mp-loading"><div class="spinner"></div><p>Loading material…</p></div>';
        overlay.hidden = false;
        document.body.style.overflow = 'hidden';

        render(kind).catch(err => {
            console.error('Preview error:', err);
            body.innerHTML = '<div class="mp-error"><p>This material could not be loaded.</p></div>';
        });
    }

    async function signedSrc(material, variant) {
        try {
            return await signedViewUrl(material, variant);
        } catch (err) {
            console.error('Failed to authorize material:', err);
            return null;
        }
    }

    async function render(kind) {
        const body = overlay.querySelector('.mp-body');
        const material = state.material;

        if (kind === 'video') {
            const src = await signedSrc(material, 'content');
            if (!src) throw new Error('Could not authorize video');
            const type = material.content_type ? ` type="${escapeHTML(material.content_type)}"` : '';
            body.innerHTML = `
                <div class="mp-video-shell">
                    <video controls preload="metadata" playsinline class="mp-media">
                        <source src="${src}"${type}>
                        Your browser cannot play this video. <a href="${src}" target="_blank" rel="noopener">Open it instead</a>.
                    </video>
                </div>`;
            return;
        }

        if (kind === 'image') {
            const src = await signedSrc(material, 'content');
            if (!src) throw new Error('Could not authorize image');
            body.innerHTML = `<img src="${src}" class="mp-image" alt="${escapeHTML(material.title || 'Material')}">`;
            return;
        }

        if (kind === 'pdf') {
            const src = await signedSrc(material, state.variant || 'content');
            if (!src) throw new Error('Could not authorize PDF');
            renderPdf(src, body).catch(() => {
                body.innerHTML = '<div class="mp-error"><p>This PDF could not be rendered in the browser.</p></div>';
            });
            return;
        }

        // Unknown/office-without-twin: try an inline iframe.
        const iframe = document.createElement('iframe');
        iframe.className = 'mp-iframe';
        iframe.addEventListener('load', () => { iframe.style.display = 'block'; });
        body.innerHTML = '';
        body.appendChild(iframe);
        const src = await signedSrc(material, 'content');
        if (!src) throw new Error('Could not authorize file');
        iframe.src = src;
    }

    // ── PDF rendering (vendored PDF.js, no annotations needed) ────────────
    let pdfjsPromise = null;

    function loadPdfJs() {
        if (!pdfjsPromise) {
            pdfjsPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = '../shared/vendor/pdfjs/pdf.min.js';
                script.onload = () => {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../shared/vendor/pdfjs/pdf.worker.min.js';
                    resolve(window.pdfjsLib);
                };
                script.onerror = () => {
                    pdfjsPromise = null;
                    reject(new Error('Failed to load PDF viewer'));
                };
                document.head.appendChild(script);
            });
        }
        return pdfjsPromise;
    }

    async function renderPdf(url, container) {
        const lib = await loadPdfJs();
        const doc = await lib.getDocument({ url }).promise;

        container.innerHTML = '';
        const holder = document.createElement('div');
        holder.className = 'mp-pdf-pages';
        container.appendChild(holder);

        const first = await doc.getPage(1);
        const baseViewport = first.getViewport({ scale: 1 });
        const wraps = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const wrap = document.createElement('div');
            wrap.className = 'mp-pdf-page';
            wrap.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;
            holder.appendChild(wrap);
            wraps.push(wrap);
        }

        const width = Math.max(container.clientWidth || 640, 320);
        for (let i = 0; i < wraps.length; i++) {
            const page = await doc.getPage(i + 1);
            const vp = page.getViewport({ scale: 1 });
            const cssScale = width / vp.width;
            const viewport = page.getViewport({ scale: Math.min(4, cssScale * (window.devicePixelRatio || 1)) });
            const canvas = document.createElement('canvas');
            canvas.className = 'mp-pdf-canvas';
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            wraps[i].prepend(canvas);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            wraps[i].style.aspectRatio = `${vp.width} / ${vp.height}`;
            wraps[i].classList.add('is-rendered');
        }
        try { doc.destroy(); } catch (e) { /* non-fatal */ }
    }

    // ── Download (authFetch → blob → save) ────────────────────────────────
    async function downloadMaterial(material) {
        const btn = overlay && overlay.querySelector('.mp-btn-dl');
        if (btn) btn.disabled = true;
        try {
            const res = await authFetch(`${API_BASE}/api/materials/download?id=${encodeURIComponent(material.id)}`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Download failed');
            }
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const filename = (disposition.match(/filename="?([^";]+)"?/) || [])[1] || 'material';
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);
            if (typeof showToast === 'function') {
                showToast('Material downloaded.', 'success');
            }
        } catch (err) {
            console.error('Download error:', err);
            if (typeof showToast === 'function') {
                showToast(err.message || 'Download failed.', 'error');
            }
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay && !overlay.hidden) close();
    });

    window.MaterialPreview = { open: openMaterialPreview, close: close, download: downloadMaterial };
})();
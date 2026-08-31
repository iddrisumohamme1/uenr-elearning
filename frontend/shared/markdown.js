/*
   Lightweight markdown-to-HTML renderer for AI-generated study aids.
   frontend/shared/markdown.js
   Exposes window.renderMarkdown(md). The input is escaped first so no raw
   HTML from the AI/material can inject markup; then the safe subset of
   markdown that the resource generator emits is converted:
     #..###### headings, **bold**, *italic*, `inline code`, --- rules,
     bullet lists (- / * / •) and numbered lists (1. 2. …), paragraphs.
*/

(function () {
    function escapeHTML(s) {
        return String(s ?? '').replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function inline(text) {
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    function renderMarkdown(md) {
        const src = escapeHTML(md).replace(/\r\n?/g, '\n');
        const lines = src.split('\n');
        const out = [];
        let listType = null; // 'ul' | 'ol'

        const closeList = function () {
            if (listType) { out.push('</' + listType + '>'); listType = null; }
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (!line) { closeList(); continue; }

            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) {
                closeList();
                const lvl = Math.min(heading[1].length, 6);
                out.push('<h' + lvl + '>' + inline(heading[2]) + '</h' + lvl + '>');
                continue;
            }

            if (/^(---|\*\*\*|___)\s*$/.test(line)) {
                closeList();
                out.push('<hr>');
                continue;
            }

            const blockquote = /^>\s?(.*)$/.exec(line);
            if (blockquote) {
                closeList();
                out.push('<blockquote>' + inline(blockquote[1]) + '</blockquote>');
                continue;
            }

            const ul = /^[-*•]\s+(.*)$/.exec(line);
            const ol = /^\d+[.)]\s+(.*)$/.exec(line);
            if (ul) {
                if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
                out.push('<li>' + inline(ul[1]) + '</li>');
                continue;
            }
            if (ol) {
                if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
                out.push('<li>' + inline(ol[1]) + '</li>');
                continue;
            }

            closeList();
            out.push('<p>' + inline(line) + '</p>');
        }

        closeList();
        out.push(''); // guard ghost-node whitespace
        return out.join('\n');
    }

    window.renderMarkdown = renderMarkdown;
})();
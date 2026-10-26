export async function sendRichHtml(EliteProTech, chat, { id, title, html }) {
    if (typeof html !== 'string' || !html.trim()) throw new Error('No HTML content supplied.')
    if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw new Error('HTML content exceeds 2 MB.')
    const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    // Standard documents work without impersonating a Meta AI bot. WhatsApp
    // does not execute HTML: download and open this file in a modern browser.
    const viewport = '<meta name="viewport" content="width=device-width,initial-scale=1">'
    const document = /<html\b/i.test(html)
        ? (/<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, tag => tag + viewport) : html.replace(/<html\b[^>]*>/i, tag => tag + '<head>' + viewport + '</head>'))
        : `<!doctype html><html lang="en"><head><meta charset="utf-8">${viewport}<title>${escape(title)}</title></head><body>${html}</body></html>`
    const filename = String(id || 'game').replace(/[^a-z0-9_-]/gi, '-').slice(0, 80)
    return EliteProTech.sendMessage(chat, {
        document: Buffer.from(document, 'utf8'), mimetype: 'text/html', fileName: `${filename}.html`,
        caption: `${title || 'Game'}\nDownload the HTML file and open it in a browser to play. WhatsApp cannot run games inside the chat.`
    }, { fontPlain: true })
}
/* Hard count caps for every long-lived memory structure.
   The host kills the process when RSS grows past its plan limit (long uptimes
   and redeploy-startup spikes died this way), so nothing the bot keeps in
   memory is allowed to grow without a bound. Bounding is silent — no console
   output, no clearing of live state — and only counts entries, never timing. */
'use strict';

const CHAT_ARCHIVE_MAX_CHATS = Number(process.env.CHAT_ARCHIVE_MAX_CHATS) || 150;
const LEARN_MAX_PEOPLE = Number(process.env.LEARN_MAX_PEOPLE) || 1500;
const CHAT_SET_MAX_CHATS = 300;

// Object key order is insertion order, so the oldest entries sit first and are
// the ones dropped.
function boundObjectKeys(obj, max) {
    if (!obj || typeof obj !== 'object') return 0;
    const keys = Object.keys(obj);
    const overflow = keys.length - max;
    if (overflow <= 0) return 0;
    for (const key of keys.slice(0, overflow)) delete obj[key];
    return overflow;
}

// Chat archive: every chat is already capped at 400 lines; this caps how many
// chats are kept at all.
function boundChatArchive(archive, maxChats = CHAT_ARCHIVE_MAX_CHATS) {
    return boundObjectKeys(archive, maxChats);
}

// Style + facts learned per person.
function boundLearning(style, facts, maxPeople = LEARN_MAX_PEOPLE) {
    return boundObjectKeys(style || {}, maxPeople) + boundObjectKeys(facts || {}, maxPeople);
}

// The full chat list WhatsApp sends at connect.
function boundChatSet(chats, max = CHAT_SET_MAX_CHATS) {
    if (!chats || typeof chats !== 'object') return chats || {};
    const keys = Object.keys(chats);
    if (keys.length <= max) return chats;
    const bounded = {};
    for (const key of keys.slice(keys.length - max)) bounded[key] = chats[key];
    return bounded;
}

// Anti-delete recovery retention: 24 hours in private chats, 1 hour in groups.
const ANTIDELETE_TTL_PRIVATE = 24 * 60 * 60 * 1000;
const ANTIDELETE_TTL_GROUP = 1 * 60 * 60 * 1000;
function antideleteTtl(jid) {
    return String(jid || '').endsWith('@g.us') ? ANTIDELETE_TTL_GROUP : ANTIDELETE_TTL_PRIVATE;
}

// Log only numerical resource data, never environment values or provider errors.
function resourceSummary({ usage = process.memoryUsage(), heapLimit = require('v8').getHeapStatistics().heap_size_limit,
    read = file => require('fs').readFileSync(file, 'utf8') } = {}) {
    const mb = bytes => Math.round(bytes / 1024 / 1024);
    let containerLimit = null;
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try {
            const value = Number(String(read(file)).trim());
            if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) {
                containerLimit = value;
                break;
            }
        } catch {}
    }
    return `rss=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}/${mb(heapLimit)}MB buffers=${mb(usage.arrayBuffers || 0)}MB container=${containerLimit === null ? 'unknown' : mb(containerLimit) + 'MB'}`;
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const STORAGE_TARGET_BYTES = 300 * 1000 * 1000;
const TEMP_RETENTION_MS = 30 * 60 * 1000;

// Never follow links into credentials or saved data; PDF image collections are
// user-created inputs, not disposable conversion scratch files.
function expireTempFiles(root = path.join(__dirname, '..'), now = Date.now(), systemTemp = os.tmpdir()) {
    let removedBytes = 0;
    function visit(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isSymbolicLink() || entry.name === 'pdf') continue;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) { visit(file); continue; }
            if (!entry.isFile() || !/\.(ogg|opus|mp3|mp4|wav|webp|jpg|jpeg|png|pcm|tmp|webm|m4a|gif|bin|part|media|docx)$/i.test(entry.name)) continue;
            try {
                const stat = fs.lstatSync(file);
                if (stat.isSymbolicLink() || now - stat.mtimeMs <= TEMP_RETENTION_MS) continue;
                fs.unlinkSync(file);
                removedBytes += stat.size;
            } catch {}
        }
    }
    for (const relative of ['database/temp', 'lib/database/temp', 'v2/lib/database/temp', 'v2/tmp', 'tmp']) visit(path.join(root, relative));
    // Visit only our named converter directories, never arbitrary OS temp files.
    try {
        for (const entry of fs.readdirSync(systemTemp, { withFileTypes: true })) {
            if (entry.isDirectory() && /^(elite-direct-youtube-|elite-youtube-|elitepro-convert$)/.test(entry.name)) visit(path.join(systemTemp, entry.name));
        }
    } catch {}
    return removedBytes;
}

// Remove only non-runtime install artifacts. Keep licenses, executables, assets,
// declarations and all package code; saved data is outside these directories.
function compactInstall(root = path.join(__dirname, '..')) {
    let removedBytes = 0;
    const disposable = new Set(['test', 'tests', '__tests__', 'coverage', '.nyc_output', 'docs', 'doc', 'examples', '.github']);
    function size(file) {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) return 0;
        return stat.isDirectory() ? fs.readdirSync(file).reduce((n, name) => n + size(path.join(file, name)), 0) : stat.size;
    }
    function prune(dir, artifactFolders = false) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const file = path.join(dir, entry.name);
            try {
                if ((artifactFolders && entry.isDirectory() && disposable.has(entry.name)) || (entry.isFile() && entry.name.endsWith('.map'))) {
                    removedBytes += size(file);
                    fs.rmSync(file, { recursive: true, force: true });
                } else if (entry.isDirectory()) prune(file, false);
            } catch {}
        }
    }
    for (const base of [path.join(root, 'node_modules'), path.join(root, 'v2/node_modules')]) {
        // Documentation folder removal is explicitly limited to these packages.
        for (const pkg of ['fluent-ffmpeg', 'gifwrap', 'docx', 'pdfjs-dist']) prune(path.join(base, pkg), true);
        prune(base);
    }
    return removedBytes;
}

module.exports = {
    CHAT_ARCHIVE_MAX_CHATS,
    LEARN_MAX_PEOPLE,
    CHAT_SET_MAX_CHATS,
    ANTIDELETE_TTL_PRIVATE,
    ANTIDELETE_TTL_GROUP,
    boundObjectKeys,
    boundChatArchive,
    boundLearning,
    boundChatSet,
    antideleteTtl,
    resourceSummary,
    STORAGE_TARGET_BYTES,
    TEMP_RETENTION_MS,
    expireTempFiles,
    compactInstall
};

if (require.main === module && process.argv.includes('--compact-install')) {
    const freed = compactInstall();
    console.log(`[STORAGE] Removed ${Math.round(freed / 1000000)} MB of disposable installation artifacts; target=${STORAGE_TARGET_BYTES / 1000000} MB`);
}

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

/* ===== DISK GUARD =====
   A full disk (ENOSPC) stops reconnects and corrupts the login file, so stale
   temporary output and package caches are removed on a schedule. Login keys
   (session/), installed packages and saved settings are never touched. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const TEMP_MAX_AGE = 30 * 60 * 1000;
const EMERGENCY_MAX_AGE = 2 * 60 * 1000;

function sizeOf(full) {
    try {
        const st = fs.lstatSync(full);
        if (!st.isDirectory()) return st.size;
        let total = 0;
        for (const name of fs.readdirSync(full)) total += sizeOf(path.join(full, name));
        return total;
    } catch { return 0; }
}

function removePath(full, stats) {
    const bytes = sizeOf(full);
    try {
        fs.rmSync(full, { recursive: true, force: true });
        stats.removed++;
        stats.freedBytes += bytes;
    } catch {}
}

// Removes files older than maxAge anywhere under dir, then empty folders.
function pruneOld(dir, maxAge, now, stats, keep = () => false) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
        const full = path.join(dir, name);
        if (keep(name)) continue;
        let st;
        try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isDirectory()) {
            pruneOld(full, maxAge, now, stats, keep);
            try { if (!fs.readdirSync(full).length && now - st.mtimeMs > maxAge) fs.rmdirSync(full); } catch {}
        } else if (now - st.mtimeMs > maxAge) {
            removePath(full, stats);
        }
    }
}

function freeDiskSpace({ root, home = os.homedir(), tmp = os.tmpdir(), now = Date.now(), emergency = false } = {}) {
    const stats = { removed: 0, freedBytes: 0 };
    if (!root) return stats;
    const maxAge = emergency ? EMERGENCY_MAX_AGE : TEMP_MAX_AGE;
    const keepNotes = name => /^(README(\.txt|\.md)?|TempFiles|File)$/i.test(name);

    // Bot temporary output (downloads, conversions, stickers, PDF work).
    for (const dir of [
        path.join(root, 'database', 'temp'),
        path.join(root, 'lib', 'database', 'temp'),
        path.join(root, 'v2', 'lib', 'database', 'temp'),
        path.join(root, 'tmp'),
        path.join(root, 'temp'),
        path.join(root, 'v2', 'tmp')
    ]) pruneOld(dir, maxAge, now, stats, keepNotes);

    // Leftover PDF conversion folders and our own system-temp work folders.
    for (const [dir, pattern] of [[root, /^pdf2docx_out_/], [tmp, /^(elite-|elitepro-|lo-profile-bot$)/]]) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch {}
        for (const name of names) {
            if (!pattern.test(name)) continue;
            const full = path.join(dir, name);
            try { if (now - fs.lstatSync(full).mtimeMs > maxAge) removePath(full, stats); } catch {}
        }
    }

    // Old anti-delete folder (no longer written): apply the same retention.
    const legacy = path.join(root, 'anti_delete');
    let legacyNames = [];
    try { legacyNames = fs.readdirSync(legacy); } catch {}
    for (const name of legacyNames) {
        const full = path.join(legacy, name);
        try { if (now - fs.lstatSync(full).mtimeMs > antideleteTtl(name.includes('@g.us') ? '@g.us' : '')) removePath(full, stats); } catch {}
    }

    // Package-manager and downloader caches: rebuilt automatically when needed.
    if (home) {
        for (const rel of [['.npm', '_cacache'], ['.npm', '_logs'], ['.npm', '_npx'], ['.bun', 'install', 'cache'],
            ['.cache', 'yt-dlp'], ['.cache', 'node-gyp'], ['.yarn', 'cache'], ['.cache', 'yarn']]) {
            const full = path.join(home, ...rel);
            if (fs.existsSync(full)) removePath(full, stats);
        }
    }
    return stats;
}

function diskSummary(dir, statfs = fs.statfsSync) {
    try {
        const s = statfs(dir);
        const mb = n => Math.round(n / 1024 / 1024);
        return `disk free=${mb(s.bavail * s.bsize)}MB total=${mb(s.blocks * s.bsize)}MB`;
    } catch { return 'disk free=unknown'; }
}

const isNoSpace = err => !!err && (err.code === 'ENOSPC' || /ENOSPC|no space left/i.test(String(err.message || err)));

/* Login file safety: a write that fails on a full disk leaves creds.json empty,
   which makes WhatsApp ask for pairing again. A copy of the last good login is
   kept beside it and restored only when creds.json is missing or unreadable. */
function readCreds(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && data.noiseKey && data.signedIdentityKey ? data : null;
    } catch { return null; }
}

function backupCreds(sessionDir) {
    const main = path.join(sessionDir, 'creds.json');
    const data = readCreds(main);
    if (!data || !data.registered) return false;
    const backup = path.join(sessionDir, 'creds.backup.json');
    const temp = backup + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify(data));
        fs.renameSync(temp, backup);
        return true;
    } catch {
        try { fs.unlinkSync(temp); } catch {}
        return false;
    }
}

function restoreCreds(sessionDir) {
    const main = path.join(sessionDir, 'creds.json');
    if (readCreds(main)) return false;
    const backup = path.join(sessionDir, 'creds.backup.json');
    const data = readCreds(backup);
    if (!data) return false;
    try {
        fs.writeFileSync(main, JSON.stringify(data));
        return true;
    } catch { return false; }
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
    freeDiskSpace,
    diskSummary,
    isNoSpace,
    backupCreds,
    restoreCreds
};

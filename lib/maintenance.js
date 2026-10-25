/* Hard count caps for every long-lived memory structure.
   The host kills the process when RSS grows past its plan limit (long uptimes
   and redeploy-startup spikes died this way), so nothing the bot keeps in
   memory is allowed to grow without a bound. Bounding is silent — no console
   output, no clearing of live state — and only counts entries, never timing. */
'use strict';

const STORAGE_BUDGET_BYTES = 300 * 1000 * 1000;

// Remove debug maps and known test fixtures only inside installed packages.
// Never traverse credentials, user data, or another package manager's store.
function pruneDependencyMaps(root) {
    const fs = require('fs');
    const path = require('path');
    let removedBytes = 0;
    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== '.bun') walk(file);
            else if (entry.isFile() && entry.name.endsWith('.map')) {
                const size = fs.statSync(file).size;
                fs.unlinkSync(file);
                removedBytes += size;
            }
        }
    }
    for (const base of ['node_modules', 'v2/node_modules']) {
        const modules = path.join(root, base);
        walk(modules);
        for (const relative of ['fluent-ffmpeg/coverage', 'gifwrap/test']) {
            const target = path.join(modules, relative);
            if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
                removedBytes += diskBytes(target);
                fs.rmSync(target, { recursive: true, force: true });
            }
        }
        // npm installs both libc variants on Linux. Keep the actual host's
        // variant; do not omit optional dependencies (FFmpeg requires them).
        if (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)) {
            const glibc = Boolean(process.report?.getReport().header.glibcVersionRuntime);
            const names = [
                `@napi-rs/canvas-linux-${process.arch}-${glibc ? 'musl' : 'gnu'}`,
                `@img/sharp-libvips-${glibc ? 'linuxmusl' : 'linux'}-${process.arch}`,
                `@img/sharp-${glibc ? 'linuxmusl' : 'linux'}-${process.arch}`
            ];
            for (const name of names) {
                const target = path.join(modules, name);
                if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
                    removedBytes += diskBytes(target);
                    fs.rmSync(target, { recursive: true, force: true });
                }
            }
        }
    }
    return removedBytes;
}

function diskBytes(root) {
    const fs = require('fs');
    const path = require('path');
    let total = 0;
    const inodes = new Set();
    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) {
                const stat = fs.statSync(file);
                const key = `${stat.dev}:${stat.ino}`;
                if (inodes.has(key)) continue;
                inodes.add(key);
                total += stat.blocks == null ? stat.size : stat.blocks * 512;
            }
        }
    }
    walk(root);
    return total;
}

function storageStatus(bytes) {
    return { bytes, budgetBytes: STORAGE_BUDGET_BYTES, overBudget: bytes > STORAGE_BUDGET_BYTES };
}

if (require.main === module && process.argv.includes('--storage')) {
    const root = require('path').join(__dirname, '..');
    const removed = pruneDependencyMaps(root);
    const status = storageStatus(diskBytes(root));
    console.log(`[STORAGE] project=${(status.bytes / 1000000).toFixed(1)}MB budget=300MB removed-install-extras=${(removed / 1000000).toFixed(1)}MB`);
    if (status.overBudget) console.warn('[STORAGE] Above budget; inspect host caches/backups and saved data. Credentials and user data were not removed.');
}

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

module.exports = {
    STORAGE_BUDGET_BYTES,
    pruneDependencyMaps,
    diskBytes,
    storageStatus,
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
    resourceSummary
};

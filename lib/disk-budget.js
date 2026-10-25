/* Disk budget for the hosting panel (target: whole bot folder <= 300 MB).
   Only disposable data is removed: duplicate installs, package docs/tests/types,
   npm/yt-dlp caches, old temporary media and the oldest anti-delete copies when
   that store grows too large. WhatsApp credentials (session/), settings and
   user data in database/*.json are never touched. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DISK_LIMIT_MB = Number(process.env.DISK_LIMIT_MB) || 300;
const ANTIDELETE_MAX_MB = Number(process.env.ANTIDELETE_MAX_MB) || 40;
const TEMP_MAX_AGE_MS = 30 * 60 * 1000;

function sizeOf(target) {
    let total = 0;
    let stat;
    try { stat = fs.lstatSync(target); } catch { return 0; }
    if (!stat.isDirectory()) return stat.size;
    let entries = [];
    try { entries = fs.readdirSync(target); } catch {}
    for (const name of entries) total += sizeOf(path.join(target, name));
    return total;
}

function remove(target) {
    const bytes = sizeOf(target);
    if (!bytes && !fs.existsSync(target)) return 0;
    try { fs.rmSync(target, { recursive: true, force: true }); return bytes; } catch { return 0; }
}

// Files inside node_modules the bot never loads at runtime.
const JUNK_DIRS = new Set(['coverage', 'doc', 'docs', 'example', 'examples', 'test', 'tests', '__tests__', '.github', 'benchmark', 'benchmarks']);
const JUNK_FILE = /(\.d\.ts|\.d\.cts|\.d\.mts|\.map|\.md|\.markdown|\.iife\.js|\.umd\.cjs|\.umd\.js|\.flow|\.tsbuildinfo)$/i;
const KEEP_FILE = /^(license|licence|notice)/i;

function pruneTree(dir, depth = 0) {
    let freed = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            // Never strip anything a package exposes as a direct folder name at
            // the top level of node_modules (e.g. a package called "test").
            if (depth > 0 && JUNK_DIRS.has(entry.name.toLowerCase())) freed += remove(full);
            else freed += pruneTree(full, depth + 1);
        } else if (entry.isFile() && depth > 0 && JUNK_FILE.test(entry.name) && !KEEP_FILE.test(entry.name)) {
            freed += remove(full);
        }
    }
    return freed;
}

// One-off after every install: drop the duplicate V2 install (V2 resolves the
// shared root packages) and package files that are never executed.
function pruneInstall(root = ROOT) {
    let freed = remove(path.join(root, 'v2', 'node_modules'));
    freed += pruneTree(path.join(root, 'node_modules'));
    freed += clearCaches(root);
    return freed;
}

// Caches that panels store inside the server folder when HOME points there.
function clearCaches(root = ROOT) {
    let freed = 0;
    for (const rel of ['.npm', '.cache', '.yarn', '.bun/install/cache', '.node-gyp', 'node_modules/.cache']) {
        freed += remove(path.join(root, rel));
    }
    return freed;
}

function cleanOldFiles(dir, now, maxAge, depth = 0) {
    let freed = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
            const stat = fs.lstatSync(full);
            if (now - stat.mtimeMs <= maxAge) continue;
            if (entry.isDirectory()) {
                if (depth < 3) freed += cleanOldFiles(full, now, maxAge, depth + 1);
                try { fs.rmdirSync(full); } catch {}
            } else if (entry.isFile() && !/^(README|TempFiles|File)(\.\w+)?$/i.test(entry.name)) {
                freed += stat.size;
                fs.unlinkSync(full);
            }
        } catch {}
    }
    return freed;
}

function cleanTemp(root = ROOT, now = Date.now(), maxAge = TEMP_MAX_AGE_MS) {
    let freed = 0;
    for (const rel of ['database/temp', 'lib/database/temp', 'v2/lib/database/temp', 'tmp', 'temp', 'v2/tmp']) {
        freed += cleanOldFiles(path.join(root, rel), now, maxAge);
    }
    // Bot-owned folders in the system temp directory (yt-dlp, converters).
    try {
        for (const name of fs.readdirSync(os.tmpdir())) {
            if (!/^(elite|elitepro|shzm-)/i.test(name)) continue;
            const full = path.join(os.tmpdir(), name);
            try {
                if (now - fs.statSync(full).mtimeMs > maxAge) freed += remove(full);
            } catch {}
        }
    } catch {}
    return freed;
}

// Keeps the anti-delete store under its byte cap by dropping the oldest copies.
function boundDirBytes(dir, maxBytes) {
    let files = [];
    try {
        files = fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(name => {
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            return { full, size: stat.size, mtime: stat.mtimeMs };
        });
    } catch { return 0; }
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= maxBytes) return 0;
    files.sort((a, b) => a.mtime - b.mtime);
    let freed = 0;
    for (const file of files) {
        if (total <= maxBytes) break;
        try { fs.unlinkSync(file.full); total -= file.size; freed += file.size; } catch {}
    }
    return freed;
}

function enforceDiskBudget(root = ROOT, { limitMb = DISK_LIMIT_MB, antideleteMb = ANTIDELETE_MAX_MB } = {}) {
    let freed = cleanTemp(root) + clearCaches(root);
    // A panel reinstall can bring the duplicate V2 install back.
    freed += remove(path.join(root, 'v2', 'node_modules'));
    freed += boundDirBytes(path.join(root, 'database', 'antidelete_store'), antideleteMb * 1024 * 1024);
    let used = sizeOf(root);
    if (used > limitMb * 1024 * 1024) {
        // Still above budget: clear every temporary file regardless of age and
        // halve the anti-delete store.
        freed += cleanTemp(root, Date.now(), -1);
        freed += boundDirBytes(path.join(root, 'database', 'antidelete_store'), (antideleteMb / 2) * 1024 * 1024);
        used = sizeOf(root);
    }
    return { usedMb: Math.round(used / 1024 / 1024), freedMb: Math.round(freed / 1024 / 1024), limitMb };
}

module.exports = { DISK_LIMIT_MB, sizeOf, pruneInstall, pruneTree, clearCaches, cleanTemp, boundDirBytes, enforceDiskBudget };

if (require.main === module && process.argv.includes('--prune')) {
    const freed = pruneInstall();
    const { usedMb } = enforceDiskBudget();
    console.log(`[DISK] install pruned ${Math.round(freed / 1024 / 1024)}MB; bot folder ${usedMb}MB of ${DISK_LIMIT_MB}MB`);
}

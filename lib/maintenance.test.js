'use strict';

const test = require('node:test');
const assert = require('node:assert');
const maintenance = require('./maintenance');

test('bundled V1 starts in the current process without spawning a second bot', () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'v1/source.js'), 'utf8');
    const reachedConfig = new Error('configuration reached');
    let spawned = 0;
    assert.throws(() => vm.runInNewContext(`(function(){${source}\n})()`, {
        process: { argv: ['node', 'index.js'] },
        require(name) {
            if (name === 'child_process') return { spawn() { spawned++; throw new Error('duplicate startup'); } };
            if (name === './config') throw reachedConfig;
            return require(name);
        }
    }), error => error === reachedConfig);
    assert.equal(spawned, 0);
});

test('host diagnostics report actual memory and cgroup v2 limit', () => {
    const mb = 1024 * 1024;
    assert.equal(maintenance.resourceSummary({ usage: { rss: 200 * mb, heapUsed: 100 * mb, arrayBuffers: 20 * mb },
        heapLimit: 320 * mb, read: () => String(512 * mb) }),
        'rss=200MB heap=100/320MB buffers=20MB container=512MB');
});

test('host diagnostics handle cgroup v1 and unavailable limits', () => {
    const usage = { rss: 0, heapUsed: 0 };
    const mb = 1024 * 1024;
    assert.equal(maintenance.resourceSummary({ usage, heapLimit: 320 * mb,
        read: file => file.endsWith('memory.max') ? 'max' : String(1024 * mb) }),
        'rss=0MB heap=0/320MB buffers=0MB container=1024MB');
    assert.equal(maintenance.resourceSummary({ usage, heapLimit: 320 * mb,
        read: () => { throw new Error('unavailable'); } }),
        'rss=0MB heap=0/320MB buffers=0MB container=unknown');
});

test('chat archive drops the oldest chats past the cap and keeps the newest', () => {
    const archive = {};
    for (let i = 0; i < 5; i++) archive[`chat${i}@s.whatsapp.net`] = ['x'];
    const removed = maintenance.boundChatArchive(archive, 3);
    assert.equal(removed, 2);
    assert.deepEqual(Object.keys(archive), ['chat2@s.whatsapp.net', 'chat3@s.whatsapp.net', 'chat4@s.whatsapp.net']);
});

test('chat archive does nothing while under the cap', () => {
    const archive = { 'a@s.whatsapp.net': ['x'] };
    assert.equal(maintenance.boundChatArchive(archive, 150), 0);
    assert.deepEqual(Object.keys(archive), ['a@s.whatsapp.net']);
});

test('learned style and facts are capped per person count', () => {
    const style = {}, facts = {};
    for (let i = 0; i < 4; i++) {
        style[`s${i}`] = { msgs: i };
        facts[`f${i}`] = ['my name is test'];
    }
    const removed = maintenance.boundLearning(style, facts, 2);
    assert.equal(removed, 4);
    assert.deepEqual(Object.keys(style), ['s2', 's3']);
    assert.deepEqual(Object.keys(facts), ['f2', 'f3']);
});

test('antidelete retention is 24 hours private and 1 hour for groups', () => {
    assert.equal(maintenance.antideleteTtl('234900@s.whatsapp.net'), 24 * 60 * 60 * 1000);
    assert.equal(maintenance.antideleteTtl('12345-67890@g.us'), 1 * 60 * 60 * 1000);
    assert.equal(maintenance.antideleteTtl(''), 24 * 60 * 60 * 1000);
});

test('the connect chat list is bounded to the newest 300 chats', () => {
    const chats = {};
    for (let i = 0; i < 350; i++) chats[`c${i}@s.whatsapp.net`] = { id: `c${i}@s.whatsapp.net` };
    const bounded = maintenance.boundChatSet(chats);
    const keys = Object.keys(bounded);
    assert.equal(keys.length, 300);
    assert.equal(keys[0], 'c50@s.whatsapp.net');
    assert.equal(keys[299], 'c349@s.whatsapp.net');
});

test('hosting storage target is 300 MB, not 300 MiB', () => {
    assert.equal(maintenance.STORAGE_TARGET_BYTES, 300000000);
});

test('temp expiry preserves credentials, saved voices, recent files and PDF image collections', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'storage-test-'));
    const now = Date.now();
    const files = ['session/creds.json', 'database/voices/test/reference.wav', 'database/temp/voicechanger/old.wav',
        'database/temp/recent.mp3', 'database/temp/pdf/user/1.jpg', 'system/unrelated.mp3', 'system/elite-youtube-test/input.bin'];
    try {
        for (const relative of files) {
            const file = path.join(root, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'keep');
            const date = new Date(relative.includes('recent') ? now : now - 31 * 60 * 1000);
            fs.utimesSync(file, date, date);
        }
        fs.symlinkSync(path.join(root, 'database/voices'), path.join(root, 'database/temp/link'));
        assert.equal(maintenance.expireTempFiles(root, now, path.join(root, 'system')), 8);
        for (const relative of files.filter(f => !f.includes('old.wav') && !f.includes('input.bin'))) assert.ok(fs.existsSync(path.join(root, relative)), relative);
        assert.equal(fs.existsSync(path.join(root, 'database/temp/voicechanger/old.wav')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('install compaction keeps runtime modules, licenses and user data', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compact-test-'));
    const discarded = ['node_modules/fluent-ffmpeg/coverage/result.json', 'node_modules/docx/dist/index.cjs.map'];
    const kept = ['node_modules/docx/dist/index.cjs', 'node_modules/docx/LICENSE', 'node_modules/other/test/runtime.js', 'session/creds.json'];
    try {
        for (const relative of [...discarded, ...kept]) {
            const file = path.join(root, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'data');
        }
        assert.equal(maintenance.compactInstall(root), 8);
        for (const relative of discarded) assert.equal(fs.existsSync(path.join(root, relative)), false);
        for (const relative of kept) assert.ok(fs.existsSync(path.join(root, relative)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const maintenance = require('./maintenance');

test('deployment storage target is 300 MB', () => {
    assert.equal(maintenance.STORAGE_TARGET_BYTES, 300 * 1024 * 1024);
});

test('scratch cleanup removes expired nested files without deleting user data or active work', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bot-storage-check-'));
    const now = Date.now();
    const files = ['database/temp/voicechanger/old.wav', 'database/temp/recent.mp3',
        'database/temp/pdf/person/book.png', 'session/creds.json', 'database/voices/sample.wav',
        'database/chatbot.json', 'os-temp/unrelated.wav', 'os-temp/elite-youtube-abandoned/input',
        'database/temp/TempFiles'];
    try {
        for (const name of files) {
            const file = path.join(root, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'saved');
            const age = name.includes('recent') ? 0 : maintenance.TEMP_TTL_MS + 1000;
            fs.utimesSync(file, new Date(now - age), new Date(now - age));
        }
        fs.symlinkSync(path.join(root, 'session'), path.join(root, 'database/temp/linked'));
        assert.equal(await maintenance.cleanDisposableFiles({ root, tmp: path.join(root, 'os-temp'), now }), 10);
        for (const name of files) assert.equal(fs.existsSync(path.join(root, name)), !['database/temp/voicechanger/old.wav', 'os-temp/elite-youtube-abandoned/input'].includes(name), name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

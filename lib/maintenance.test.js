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

test('disk cleanup removes stale temp output and caches but never login keys', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-root-'));
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'systmp');
    const old = Date.now() / 1000 - 3600;
    const make = (rel, content = 'x'.repeat(1024)) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return full;
    };
    const aged = full => { fs.utimesSync(full, old, old); return full; };
    const staleTemp = aged(make('database/temp/pdf/user/a.pdf'));
    const freshTemp = make('database/temp/b.mp4');
    const note = aged(make('database/temp/TempFiles', ''));
    const creds = aged(make('session/creds.json', '{}'));
    const key = aged(make('session/pre-key-1.json', '{}'));
    const cache = make('home/.npm/_cacache/index/x');
    const ytdlp = aged(make('systmp/elite-youtube-1/v.mp4'));
    const other = aged(make('systmp/someone-else/file'));
    const stats = maintenance.freeDiskSpace({ root, home, tmp });
    assert.equal(fs.existsSync(staleTemp), false);
    assert.equal(fs.existsSync(freshTemp), true);
    assert.equal(fs.existsSync(note), true);
    assert.equal(fs.existsSync(creds), true);
    assert.equal(fs.existsSync(key), true);
    assert.equal(fs.existsSync(cache), false);
    assert.equal(fs.existsSync(ytdlp), false);
    assert.equal(fs.existsSync(other), true);
    assert.ok(stats.freedBytes >= 2048);
    fs.rmSync(root, { recursive: true, force: true });
});

test('a login file emptied by a full disk is restored from the last good copy', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
    const good = { noiseKey: { a: 1 }, signedIdentityKey: { b: 2 }, registered: true };
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(good));
    assert.equal(maintenance.backupCreds(dir), true);
    assert.equal(maintenance.restoreCreds(dir), false);
    fs.writeFileSync(path.join(dir, 'creds.json'), '');
    assert.equal(maintenance.restoreCreds(dir), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')), good);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('unregistered logins are never backed up and ENOSPC is recognised', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ noiseKey: {}, signedIdentityKey: {}, registered: false }));
    assert.equal(maintenance.backupCreds(dir), false);
    assert.equal(maintenance.isNoSpace(new Error("ENOSPC: no space left on device, mkdir '/home/container/anti_delete'")), true);
    assert.equal(maintenance.isNoSpace(new Error('timeout')), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

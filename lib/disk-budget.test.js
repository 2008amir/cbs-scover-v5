'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const disk = require('./disk-budget');

function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-budget-'));
    const write = (rel, bytes = 10) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), Buffer.alloc(bytes));
    };
    return { root, write };
}

test('default disk budget is 300 MB', () => {
    assert.equal(disk.DISK_LIMIT_MB, 300);
});

test('install prune removes the duplicate V2 install and keeps credentials and data', () => {
    const { root, write } = tree();
    write('v2/node_modules/sharp/index.js');
    write('node_modules/pkg/package.json');
    write('node_modules/pkg/index.js');
    write('node_modules/pkg/index.d.ts');
    write('node_modules/pkg/coverage/report.html');
    write('.npm/_cacache/blob');
    write('session/creds.json');
    write('database/antidelete.json');
    disk.pruneInstall(root);
    assert.equal(fs.existsSync(path.join(root, 'v2/node_modules')), false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/pkg/index.d.ts')), false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/pkg/coverage')), false);
    assert.equal(fs.existsSync(path.join(root, '.npm')), false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/pkg/index.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'session/creds.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'database/antidelete.json')), true);
});

test('install prune keeps files the package manifest points to', () => {
    const { root, write } = tree();
    fs.mkdirSync(path.join(root, 'node_modules/umdpkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/umdpkg/package.json'), '{"main":"lib.umd.js"}');
    write('node_modules/umdpkg/lib.umd.js');
    disk.pruneInstall(root);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/umdpkg/lib.umd.js')), true);
});

test('temporary media older than 30 minutes is removed, fresh files stay', () => {
    const { root, write } = tree();
    write('database/temp/old.mp4');
    write('database/temp/new.mp4');
    const old = (Date.now() - 31 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(root, 'database/temp/old.mp4'), old, old);
    disk.cleanTemp(root);
    assert.equal(fs.existsSync(path.join(root, 'database/temp/old.mp4')), false);
    assert.equal(fs.existsSync(path.join(root, 'database/temp/new.mp4')), true);
});

test('anti-delete store is capped by size, dropping the oldest copies first', () => {
    const { root, write } = tree();
    const dir = path.join(root, 'database/antidelete_store');
    for (let i = 0; i < 4; i++) {
        write(`database/antidelete_store/m${i}.json`, 100);
        const t = (Date.now() - (10 - i) * 1000) / 1000;
        fs.utimesSync(path.join(dir, `m${i}.json`), t, t);
    }
    disk.boundDirBytes(dir, 250);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['m2.json', 'm3.json']);
});

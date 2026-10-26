const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('hosting lockfile uses only public npm registry tarballs, retaining pinned integrity', () => {
    const root = path.join(__dirname, '..');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const packages = Object.entries(lock.packages).filter(([, pkg]) => pkg.resolved);
    assert.ok(packages.length > 0);
    for (const [name, pkg] of packages) {
        assert.equal(new URL(pkg.resolved).origin, 'https://registry.npmjs.org', name);
        assert.match(pkg.integrity, /^sha(?:512|1)-/, name);
    }
    const pdf = lock.packages['node_modules/pdfjs-dist'];
    assert.equal(pdf.resolved, 'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz');
    assert.ok(fs.readFileSync(path.join(root, '.npmrc'), 'utf8').includes('registry=https://registry.npmjs.org/'));
});
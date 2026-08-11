const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const runtimeFiles = [
    'auth.js', 'cache.js', 'capture.js', 'geometry.js', 'history.js', 'layer-tree.js', 'main.js',
    'place.js', 'png.js', 'presets.js', 'usage.js',
    'providers/google.js', 'providers/http.js', 'providers/index.js', 'providers/openai.js',
];

test('manifest v5 має однакові дозволи для macOS і Windows', () => {
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.manifestVersion, 5);
    assert.equal(manifest.requiredPermissions?.localFileSystem, 'request');
    assert.deepEqual(manifest.requiredPermissions?.launchProcess?.schemes, ['https']);
    assert.ok(manifest.requiredPermissions?.network?.domains?.includes('https://api.openai.com'));
    assert.ok(manifest.requiredPermissions?.network?.domains?.includes('https://generativelanguage.googleapis.com'));
});

test('runtime не містить абсолютних шляхів конкретної ОС', () => {
    for (const file of runtimeFiles) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, /\/Applications\//, `${file}: macOS absolute path`);
        assert.doesNotMatch(source, /[A-Za-z]:\\\\(?:Program Files|Users|Windows)\\\\/, `${file}: Windows absolute path`);
        assert.doesNotMatch(source, /\.nativePath\b/, `${file}: nativePath bypasses UXP tokens`);
    }
});

test('локальні require мають файли з точним регістром', () => {
    for (const file of runtimeFiles) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
            const requested = path.resolve(path.dirname(path.join(ROOT, file)), match[1]);
            const dir = path.dirname(requested);
            const base = path.basename(requested);
            assert.ok(fs.readdirSync(dir).includes(base), `${file}: неправильний регістр або відсутній ${match[1]}`);
        }
    }
});

test('обидва deploy-скрипти включають однакові runtime-модулі', () => {
    const ps = fs.readFileSync(path.join(ROOT, 'deploy.ps1'), 'utf8');
    const sh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    for (const file of ['main.js', 'usage.js', 'layer-tree.js', 'manifest.json', 'index.html', 'style.css']) {
        assert.match(ps, new RegExp(file.replace('.', '\\.')));
    }
    for (const nonRuntime of ['deploy.ps1', 'Install AI Image.cmd', 'README.md', 'package.json']) {
        assert.match(sh, new RegExp(`--exclude '${nonRuntime.replace('.', '\\.')}'`));
    }
});

test('Windows one-click installer піднімає права і запускає deploy.ps1', () => {
    const cmd = fs.readFileSync(path.join(ROOT, 'Install AI Image.cmd'), 'utf8');
    assert.match(cmd, /Start-Process[^\r\n]+-Verb RunAs/i);
    assert.match(cmd, /deploy\.ps1/i);
    assert.match(cmd, /%~dp0/);
});

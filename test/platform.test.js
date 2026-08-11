const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appInfo = require('../app-info.js');

const runtimeFiles = [
    'app-info.js', 'auth.js', 'cache.js', 'capture.js', 'geometry.js', 'history.js',
    'i18n.js', 'layer-tree.js', 'main.js', 'place.js', 'png.js', 'presets.js',
    'public-ui.js', 'usage.js',
    'providers/google.js', 'providers/http.js', 'providers/index.js', 'providers/openai.js',
];

test('public metadata and manifest stay aligned', () => {
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.version, appInfo.version);
    assert.equal(manifest.name, 'ExactFill');
    assert.equal(appInfo.name, 'ExactFill');
    assert.equal(manifest.id, appInfo.id, 'plugin id must stay stable so private-build settings survive');
    assert.match(appInfo.repository, /zgmrclick\/exactfill-photoshop$/);
    assert.equal(manifest.manifestVersion, 5);
    assert.equal(manifest.host?.minVersion, '25.0.0');
    assert.equal(manifest.entrypoints?.[0]?.label?.default, 'ExactFill');
    assert.equal(manifest.icons?.[0]?.path, 'icons/exactfill.svg');
});

test('manifest v5 has the same permissions on macOS and Windows', () => {
    assert.equal(manifest.requiredPermissions?.localFileSystem, 'request');
    assert.deepEqual(manifest.requiredPermissions?.launchProcess?.schemes, ['https']);
    assert.ok(manifest.requiredPermissions?.network?.domains?.includes('https://api.openai.com'));
    assert.ok(manifest.requiredPermissions?.network?.domains?.includes('https://generativelanguage.googleapis.com'));
});

test('runtime contains no absolute platform-specific paths', () => {
    for (const file of runtimeFiles) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, /\/Applications\//, `${file}: macOS absolute path`);
        assert.doesNotMatch(source, /[A-Za-z]:\\\\(?:Program Files|Users|Windows)\\\\/, `${file}: Windows absolute path`);
        assert.doesNotMatch(source, /\.nativePath\b/, `${file}: nativePath bypasses UXP tokens`);
    }
});

test('local requires resolve with exact filename case', () => {
    for (const file of runtimeFiles) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
            const requested = path.resolve(path.dirname(path.join(ROOT, file)), match[1]);
            const dir = path.dirname(requested);
            const base = path.basename(requested);
            assert.ok(fs.readdirSync(dir).includes(base), `${file}: missing or wrong case: ${match[1]}`);
        }
    }
});

test('HTML scripts do not redeclare top-level UXP globals', () => {
    const owners = new Map();
    for (const file of ['i18n.js', 'public-ui.js', 'auth.js', 'main.js']) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const names = [];
        for (const match of source.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
            names.push(match[1]);
        }
        for (const match of source.matchAll(/^(?:const|let)\s+\{([^}]+)\}\s*=/gm)) {
            names.push(...match[1].split(',').map(part => part.trim().split(/[:=]/)[0].trim()).filter(Boolean));
        }
        for (const name of names) {
            assert.equal(owners.has(name), false,
                `${name} is declared by both ${owners.get(name)} and ${file}; UXP runs HTML scripts in one scope`);
            owners.set(name, file);
        }
    }
});

test('macOS development deploy excludes non-runtime content', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    for (const nonRuntime of ['INSTALL.txt', 'README.md', 'README.uk.md', 'package.json',
                              'LICENSE', 'PRIVACY.md', '.github', 'scripts', 'dist']) {
        assert.match(sh, new RegExp(`--exclude '${nonRuntime.replace('.', '\\.')}'`));
    }
    assert.match(sh, /Plugins → ExactFill/);
    assert.match(sh, /--include 'icons\/exactfill\.svg'/);
    assert.match(sh, /--exclude 'icons\/\*'/);
    assert.match(sh, /--exclude 'verify-assumptions\.psjs'/);
});

test('one universal guide documents manual installation on both platforms', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'INSTALL.txt'), 'utf8');
    assert.match(guide, /WINDOWS/);
    assert.match(guide, /macOS/);
    assert.match(guide, /ExactFill/);
    assert.match(guide, /Plug-ins/);
    assert.match(guide, /manifest\.json/);
    assert.match(guide, /api\.openai\.com/);
    assert.match(guide, /generativelanguage\.googleapis\.com/);
    assert.match(guide, /explicit Block rule/);
    assert.equal(fs.existsSync(path.join(ROOT, 'deploy.ps1')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'Install AI Image.cmd')), false);
});

test('release builder whitelists every runtime module', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/build-release.sh'), 'utf8');
    for (const file of [...runtimeFiles, 'index.html', 'style.css', 'manifest.json', 'icons/exactfill.svg']) {
        assert.match(script, new RegExp(file.replace(/[./-]/g, '\\$&')), `build omits ${file}`);
    }
});

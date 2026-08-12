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
    assert.deepEqual(manifest.entrypoints?.[0]?.minimumSize, { width: 230, height: 260 });
    assert.deepEqual(manifest.entrypoints?.[0]?.preferredDockedSize, { width: 300, height: 600 });
    assert.deepEqual(manifest.entrypoints?.[0]?.preferredFloatingSize, { width: 320, height: 680 });
    assert.equal(manifest.icons?.[0]?.path, 'icons/exactfill.svg');
    assert.deepEqual(manifest.entrypoints?.[0]?.icons?.map(icon => icon.path),
        ['icons/panel-dark.png', 'icons/panel-light.png']);
    assert.deepEqual(manifest.entrypoints?.[0]?.icons?.map(icon => icon.scale), [[1, 2], [1, 2]]);
    for (const [file, size] of [['panel-dark@1x.png', 23], ['panel-dark@2x.png', 46],
                                ['panel-light@1x.png', 23], ['panel-light@2x.png', 46]]) {
        const png = fs.readFileSync(path.join(ROOT, 'icons', file));
        assert.equal(png.subarray(1, 4).toString(), 'PNG', `${file} must be a PNG`);
        assert.equal(png.readUInt32BE(16), size, `${file} width`);
        assert.equal(png.readUInt32BE(20), size, `${file} height`);
        assert.equal(png[25], 6, `${file} must use RGBA truecolor, like Photoshop's native panel icons`);
    }
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

test('panel has an owned vertical scroll region and accessible disclosures', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(html, /id="main" class="panel-scroll hidden"/);
    assert.match(css, /\.panel-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(css, /body\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(html, /role="button" tabindex="0" aria-controls="opts-body"/);
    assert.match(main, /setAttribute\('aria-expanded'/);
    assert.match(main, /e\.key === 'Enter' \|\| e\.key === ' '/);
});

test('critical panel controls use deterministic UXP-safe markup', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(html, /id="generate-btn" type="button" class="action-btn primary-btn/);
    assert.match(html, /id="plan-card" class="plan-card dim"/);
    assert.match(html, /class="advanced-stack"/);
    assert.match(html, /<svg class="chevron"/);
    assert.doesNotMatch(html, /prompt\.shortcut|⌘\/Ctrl/);
    assert.doesNotMatch(css, /\.shortcut\s*\{/);
    assert.doesNotMatch(main, /metaKey|ctrlKey/);
    assert.match(css, /\.control-grid\s*\{[^}]*display:\s*flex/s);
    assert.doesNotMatch(css, /\.control-grid\s*\{[^}]*display:\s*grid/s);
    assert.doesNotMatch(css, /\.chevron\s*\{[^}]*border-(?:right|bottom):/s);
});

test('macOS development deploy excludes non-runtime content', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    for (const nonRuntime of ['INSTALL.txt', 'README.md', 'README.uk.md', 'package.json',
                              'LICENSE', 'PRIVACY.md', '.github', 'scripts', 'dist']) {
        assert.match(sh, new RegExp(`--exclude '${nonRuntime.replace('.', '\\.')}'`));
    }
    assert.match(sh, /Plugins → ExactFill/);
    assert.match(sh, /--include 'icons\/exactfill\.svg'/);
    assert.match(sh, /--include 'icons\/panel-\*\.png'/);
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
    for (const file of ['panel-dark@1x.png', 'panel-dark@2x.png', 'panel-light@1x.png', 'panel-light@2x.png']) {
        assert.match(script, new RegExp(file.replace(/[.@-]/g, '\\$&')), `build omits icons/${file}`);
    }
});

test('public demo ships a lightweight accessible comparison and real video', () => {
    const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const video = path.join(ROOT, 'docs/assets/exactfill-demo.mp4');
    for (const file of ['demo-before.jpg', 'demo-generating.jpg', 'demo-after.jpg']) {
        assert.ok(fs.statSync(path.join(ROOT, 'docs/assets', file)).size > 0, `${file} is empty`);
    }
    assert.match(html, /type="range"[^>]*aria-label="Reveal before or after image"/);
    assert.match(html, /<video controls playsinline/);
    assert.match(html, /assets\/exactfill-demo\.mp4/);
    assert.ok(fs.statSync(video).size < 5 * 1024 * 1024, 'demo video should remain GitHub-friendly');
    assert.match(readme, /zgmrclick\.github\.io\/exactfill-photoshop/);
});

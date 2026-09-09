const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appInfo = require('../app-info.js');

/* ⚠️ СПИСОК ВИВОДИТЬСЯ З ФАЙЛОВОЇ СИСТЕМИ, А НЕ ПИШЕТЬСЯ РУКАМИ.
   Раніше це був літерал — і новий модуль просто не існував для жодної з
   перевірок нижче: ні для «нема абсолютних шляхів», ні для «місток лише в
   одному модулі», ні (найгірше) для «білд не забув жодного файлу». Тобто
   можна було додати модуль, зібрати реліз без нього й отримати зелені тести
   при непрацездатному ZIP. Тепер новий файл автоматично потрапляє під усі
   гейти, а білд доводиться оновити — бо інакше тест впаде. */
const runtimeFiles = [
    ...fs.readdirSync(ROOT).filter(f => f.endsWith('.js')),
    ...fs.readdirSync(path.join(ROOT, 'providers'))
        .filter(f => f.endsWith('.js')).map(f => `providers/${f}`),
].sort();

// Єдиний файл, якому нативні шляхи потрібні по суті задачі: щоб зібрати команду
// для системної оболонки. Файли створює сам UXP у своїй тимчасовій папці, тому
// читання й прибирання йдуть через ті самі Entry. Вставка в документ як раніше —
// через session token, і цей виняток на неї не поширюється.
const NATIVE_PATH_ALLOWED = new Set(['providers/curl-transport.js']);

test('public metadata and manifest stay aligned', () => {
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.version, appInfo.version);
    assert.equal(manifest.name, 'ExactFill');
    assert.equal(appInfo.name, 'ExactFill');
    assert.equal(appInfo.supportUrl, 'https://ko-fi.com/havryil89140');
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
        if (!NATIVE_PATH_ALLOWED.has(file)) {
            assert.doesNotMatch(source, /\.nativePath\b/, `${file}: nativePath bypasses UXP tokens`);
        }
    }
});

test('the curl transport keeps its dangerous parts contained', () => {
    const source = fs.readFileSync(path.join(ROOT, 'providers/curl-transport.js'), 'utf8');
    // ключ живе лише у файлі --config: аргументи процесу видно в ps(1)
    assert.match(source, /data-binary = /);
    assert.doesNotMatch(source, /Authorization[^\n]*\+/, 'no key concatenated into a command');
    // шлях до curl мусить обчислюватись у згенерованому скрипті, не бути вбитим тут
    assert.match(source, /getenv\("SystemRoot"\)/);
    assert.doesNotMatch(source, /\/usr\/local\/bin\/curl/);
    // тільки транспорт має право говорити з ExtendScript-містком
    for (const file of runtimeFiles.filter(f => f !== 'providers/curl-transport.js')) {
        assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'),
            /AdobeScriptAutomation Scripts/, `${file}: bridge use must stay in one module`);
    }
    // place.js досі вставляє через токен, а не через шлях
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'place.js'), 'utf8'), /\.nativePath\b/);
});

test('a request mask is never paired with a non-PNG input', () => {
    // OpenAI: «the source image and the mask must share the same format and
    // dimensions». Сервер розбіжність не відхиляє — він тихо ігнорує маску, і
    // модель перемальовує весь кадр. Симптом: «модель не бачить виділення».
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const capture = fs.readFileSync(path.join(ROOT, 'capture.js'), 'utf8');
    const png = fs.readFileSync(path.join(ROOT, 'png.js'), 'utf8');

    // рішення про маску мусить ухвалюватись ДО захоплення й керувати форматом
    assert.match(main, /captureRegion\(ctx, s\.layerOnly, s\.lossless, wantMask\)/);
    /* ⚠️ І воно мусить лишатись в ОДНОМУ місці. Доки формула жила двічі —
       окремо в картці плану, окремо в capturePayload — вони розійшлись, і
       картка обіцяла JPEG там, де летів PNG (виміряно в хості 2026-09-09).
       Гейт саме на кількість збігів: другий рядок із цією формулою і є рецидив. */
    assert.equal((main.match(/provider\.supportsMask && s\.padPercent > 0/g) || []).length, 1,
        'формула wantMask мусить існувати рівно один раз — у inputPlan');
    assert.match(main, /function inputPlan\(s, provider, ctx\)/);
    assert.match(main, /const \{ wantMask \} = inputPlan\(s, provider, ctx\);/,
        'capturePayload бере рішення з inputPlan');
    assert.match(main, /const io = inputPlan\(s, provider, ctx\);/,
        'картка плану бере рішення з того самого inputPlan');
    // Останній рубіж переїхав у capture.maskForRequest — там він перевіряється
    // поведінкою (test/mask-blend.test.js), а не текстом. Тут лишається гейт на
    // те, що main.js не будує маску повз цю функцію.
    assert.match(capture, /input\.type !== 'image\/png'[\s\S]{0,200}reason:/);
    assert.match(main, /capture\.maskForRequest\(/);
    assert.doesNotMatch(main, /buildRectMaskPng\(/,
        'маску будує лише capture.maskForRequest — інакше інваріант обходиться');
    // Поріг швидкості не має права деградувати ФОРМАТ — лише перемикати
    // виконавця. `lossless` тому const: жоден рядок нижче не може тихо
    // переписати його на JPEG ні коли PNG обов'язковий через маску, ні коли
    // користувач просто поставив галку «вхід без втрат».
    assert.match(capture, /const lossless = wantLossless \|\| requirePng;/);
    assert.doesNotMatch(capture, /\blossless = false\b/,
        'поріг не має права скасовувати вибір формату');
    assert.match(capture, /const viaDuplicateOnly = lossless && w \* h > LOSSLESS_MAX_PX;/);
    // маска — RGBA (тип 6), як у прикладі документації
    assert.match(png, /encodePng\(px, width, height, 4\)/);
});

test('кожне поле вводу оголошує maxlength — інакше UXP мовчки глушить його на ~256 символах', () => {
    // Виміряно в хості, не виведено з документації: поле UXP без ЯВНОГО
    // maxlength приблизно на 256 символах просто перестає приймати введення.
    // Ні помилки, ні обрізаного хвоста, ні події — промпт мовчки виявлявся
    // коротшим за написаний. Adobe цього ніде не документує, тож єдиний захист
    // від повернення бага — цей гейт.
    for (const file of ['index.html', 'test/ui-harness.html']) {
        const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const tags = html.match(/<(?:textarea|sp-textfield)\b[^>]*>/g) || [];
        assert.ok(tags.length, `${file}: полів вводу не знайдено — тест утратив предмет`);
        for (const tag of tags) {
            assert.match(tag, /\smaxlength="\d+"/,
                `${file}: поле без maxlength → ${tag.slice(0, 70)}`);
        }
        // rows= в UXP не діє взагалі (офіційний перелік відомих проблем):
        // висоту задає лише CSS, а атрибут у розмітці вводив би в оману
        assert.doesNotMatch(html, /<textarea[^>]*\srows=/, `${file}: rows у UXP нічого не робить`);
    }
    // нову межу видно користувачеві, а не лише коду
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(main, /function updateCharCount\(/);
    assert.match(main, /updateCharCount\('prompt-input', 'prompt-count'\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8'), /\.char-count\s*\{/);
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
    // docs/ — це сайт проєкту з демо-відео на ~1 МБ. Photoshop сканує Plug-ins
    // при кожному старті, тому все, що не є рантаймом, туди не їде.
    for (const nonRuntime of ['INSTALL.txt', 'README.md', 'README.uk.md', 'package.json',
                              'LICENSE', 'PRIVACY.md', '.github', 'scripts', 'dist', 'docs']) {
        assert.match(sh, new RegExp(`--exclude '${nonRuntime.replace('.', '\\.')}'`));
    }
    assert.match(sh, /Plugins → ExactFill/);
    assert.match(sh, /--include 'icons\/exactfill\.svg'/);
    assert.match(sh, /--include 'icons\/panel-\*\.png'/);
    assert.match(sh, /--exclude 'icons\/\*'/);
    assert.match(sh, /--exclude 'verify-assumptions\.psjs'/);
});

test('deploy target matches the installed plugin folder', () => {
    // Скрипт довго вказував на AiImagePS — назву з часів до перейменування.
    // Photoshop від цього не падає, і саме тому баг жив: замість оновити робочу
    // папку деплой мовчки створював поруч ДРУГУ копію з тим самим manifest id.
    const sh = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    const dest = sh.match(/^DEST="([^"]+)"/m);
    assert.ok(dest, 'deploy.sh має оголошувати DEST');
    assert.equal(dest[1].split('/').pop(), manifest.name,
        'папка призначення мусить збігатися з manifest.name');
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
    assert.match(html, /https:\/\/ko-fi\.com\/havryil89140/);
    assert.match(readme, /https:\/\/ko-fi\.com\/havryil89140/);
});

test('GitHub Sponsor button points to the ExactFill Ko-fi page', () => {
    const funding = fs.readFileSync(path.join(ROOT, '.github', 'FUNDING.yml'), 'utf8');
    assert.equal(funding.trim(), 'ko_fi: havryil89140');
});

test('сегментний перемикач якості кладе шість рівнів у два ряди по три', () => {
    /* ⚠️ ВИМІРЯНО В ХОСТІ, НЕ В БРАУЗЕРІ. У браузерному стенді flex-basis
       33.333 % давав рівно три кнопки в ряду. У Photoshop 27.5.0 ті самі три
       переповнювали рядок на кілька пікселів і лягали ПО ДВІ — три ряди замість
       двох. Причина: у .seg-btn немає box-sizing: border-box (глобального
       правила у файлі теж немає), тому border-right: 1px додається до базису.

       Гейт на обидві половини причини: box-sizing і базис із запасом. */
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const segBtn = css.slice(css.indexOf('.seg-btn {'), css.indexOf('.seg-btn:last-child'));
    assert.match(segBtn, /box-sizing:\s*border-box/,
        'border-right інакше додається до flex-basis');

    const basis = css.match(/\.seg-wrap \.seg-btn \{[^}]*flex:\s*1\s+1\s+([\d.]+)%/);
    assert.ok(basis, 'flex-basis рядів мусить лишатись у відсотках, щоб не залежати від ширини');
    const pct = Number(basis[1]);
    assert.ok(pct * 3 <= 100 && pct * 4 > 100,
        `базис ${pct}%: три кнопки мусять влазити (${pct * 3}% ≤ 100), а четверта — ні (${pct * 4}% > 100)`);
});

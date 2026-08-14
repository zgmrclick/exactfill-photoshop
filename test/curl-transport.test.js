const assert = require('node:assert/strict');
const test = require('node:test');

const t = require('../providers/curl-transport.js');

test('the API key never reaches the command line, only the config file', () => {
    const config = t.buildCurlConfig({
        url: 'https://api.openai.com/v1/images/edits',
        method: 'POST',
        headers: { Authorization: 'Bearer sk-secret-value', 'Content-Type': 'application/json' },
        bodyFile: '/tmp/x.body', outFile: '/tmp/x.out', headerFile: '/tmp/x.hdr',
    });
    assert.match(config, /header = "Authorization: Bearer sk-secret-value"/);
    assert.match(config, /data-binary = "@\/tmp\/x\.body"/);
    // ps(1) показує аргументи будь-якого процесу — у команді секретів бути не може
    const cmd = t.buildCommand({
        plat: 'darwin', curlPath: '/usr/bin/curl',
        configFile: '/tmp/x.cfg', codeFile: '/tmp/x.code',
    });
    assert.doesNotMatch(cmd, /sk-secret-value/);
    assert.doesNotMatch(cmd, /Authorization/);
});

test('status and curl exit code travel through write-out, not through the shell', () => {
    const config = t.buildCurlConfig({
        url: 'https://api.openai.com/v1/models', outFile: '/o', headerFile: '/h',
    });
    // на Windows після `start /b` коду виходу не існує, тому він мусить бути у -w
    assert.match(config, /write-out = "%\{http_code\} %\{exitcode\}"/);
    assert.deepEqual(t.parseWriteOut('401 0'), { status: 401, curlExit: 0, note: '' });
    assert.deepEqual(t.parseWriteOut('000 28'), { status: 0, curlExit: 28, note: '' });
    assert.equal(t.parseWriteOut('curl: (6) Could not resolve host\n000 6').curlExit, 6);
    assert.match(t.parseWriteOut('curl: (6) Could not resolve host\n000 6').note, /resolve host/);
    assert.equal(t.parseWriteOut(''), null, 'empty file means curl has not finished yet');
});

test('each platform gets its own async launch and quoting', () => {
    const posix = t.buildCommand({ plat: 'darwin', curlPath: '/usr/bin/curl',
        configFile: "/tmp/it's.cfg", codeFile: '/tmp/a.code' });
    assert.match(posix, / &$/, 'POSIX backgrounds with &');
    assert.match(posix, /'\/tmp\/it'\\''s\.cfg'/, "single quote inside a path must be escaped");

    const win = t.buildCommand({ plat: 'win32', curlPath: 'C:/W/curl.exe',
        configFile: 'C:/Temp/a.cfg', codeFile: 'C:/Temp/a.code' });
    assert.match(win, /^start "" \/b /, 'cmd needs start /b; & there is sequential, not background');
    assert.match(win, /"C:\/Temp\/a\.cfg"/, 'cmd has no single quotes');
    assert.doesNotMatch(win, /'/);
});

test('config values escape backslashes so Windows paths survive', () => {
    assert.equal(t.quoteConfigValue('C:\\Temp\\a.cfg'), '"C:\\\\Temp\\\\a.cfg"');
    assert.equal(t.quoteConfigValue('say "hi"'), '"say \\"hi\\""');
});

test('non-ASCII work paths are rejected before curl mangles them', () => {
    // cmd на тестовій машині працює в кодовій сторінці 866: профіль з кирилицею
    // доїхав би до curl зіпсованим, тому такий шлях краще відхилити заздалегідь
    assert.equal(t.isAsciiPath('/Users/zg/Library/Caches/ExactFill'), true);
    assert.equal(t.isAsciiPath('C:\\Users\\Оксана\\AppData\\Local\\Temp'), false);
    assert.equal(t.isAsciiPath('/Users/Мар/tmp'), false);
    assert.equal(t.isAsciiPath(''), false);
});

test('generated ExtendScript stays ASCII and ES3', () => {
    const jsx = t.buildJobJsx({ configFile: '/tmp/a.cfg', codeFile: '/tmp/a.code' });
    assert.doesNotMatch(jsx, /[^\x00-\x7F]/, 'do javascript encoding is not guaranteed');
    assert.doesNotMatch(jsx, /\b(?:let|const)\s/, 'ExtendScript is ES3');
    assert.doesNotMatch(jsx, /=>/);
    assert.doesNotMatch(jsx, /\bJSON\b/, 'ExtendScript has no JSON object');
    assert.match(jsx, /app\.system\(/);
    assert.match(jsx, /getenv\("SystemRoot"\)/, 'curl path must be derived, not hardcoded');
    assert.doesNotMatch(jsx, /C:\\\\Windows/);
    assert.throws(() => t.buildJobJsx({ configFile: '/tmp/файл.cfg', codeFile: '/x' }),
        /ASCII/, 'a non-Latin path must fail loudly, not silently');
});

test('curl exit codes turn into explanations, not bare numbers', () => {
    for (const code of [6, 7, 28, 35, 60]) {
        assert.match(t.describeCurlExit(code), /\S/);
        assert.doesNotMatch(t.describeCurlExit(code), /^\d+$/);
    }
    assert.match(t.describeCurlExit(99), /99/, 'unknown codes still report the number');
});

test('response headers are parsed so Retry-After keeps working', () => {
    const headers = t.parseHeaderDump('HTTP/2 429\r\nRetry-After: 12\r\nContent-Type: application/json\r\n');
    assert.equal(headers.get('retry-after'), '12');
    assert.equal(headers.get('Retry-After'), '12', 'header lookup is case-insensitive');
    assert.equal(headers.get('x-missing'), null);
});

test('mode gates the route and auto only switches after a real failure', () => {
    t.setMode('direct');
    t.resetDirectFailure();
    assert.equal(t.active(), false);
    t.noteDirectFailure();
    assert.equal(t.active(), false, 'direct stays direct even after a failure');

    assert.equal(t.setMode('curl'), 'curl');
    assert.equal(t.active(), true);

    t.setMode('auto');
    t.resetDirectFailure();
    assert.equal(t.active(), false, 'auto must not pay for curl until the direct route fails');
    t.noteDirectFailure();
    // Тут немає ні UXP, ні містка — і це рівно той випадок, коли маршрут непридатний.
    // 'auto' зобов'язане лишитися прямим, інакше кожен наступний запит ішов би
    // в транспорт, який не може працювати.
    assert.equal(t.active(), false, 'auto needs a working bridge, not just a failure');

    assert.equal(t.setMode('nonsense'), 'auto', 'unknown modes fall back to auto');
    t.resetDirectFailure();
});

test('preflight decides the route in seconds instead of waiting out the request timeout', async () => {
    t.setMode('auto');
    t.resetDirectFailure();
    assert.equal(t.isRouteDecided(), false);

    // прямий шлях відповідає — навіть 403 доводить, що мережа є
    let calls = 0;
    const answering = async () => { calls++; return { ok: false, status: 403 }; };
    assert.equal(await t.decideRoute('https://api.openai.com', { fetchImpl: answering }), false);
    assert.equal(t.isRouteDecided(), true);
    assert.equal(t.active(), false);
    await t.decideRoute('https://api.openai.com', { fetchImpl: answering });
    assert.equal(calls, 1, 'the verdict is cached for the session');

    // заблокований шлях саме висить, а не падає — на це і розрахований дедлайн
    t.setMode('auto');
    assert.equal(t.isRouteDecided(), false, 'changing mode must clear the verdict');
    const hanging = (url, init) => new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const started = Date.now();
    // містка тут немає, тому curl лишається недоступним і маршрут не змінюється,
    // але головне — рішення приходить за мілісекунди, а не за 300 с
    assert.equal(await t.decideRoute('https://api.openai.com', { fetchImpl: hanging, timeoutMs: 120 }), false);
    assert.ok(Date.now() - started < 3000, 'a hanging route must not be waited out');
    assert.ok(t.PREFLIGHT_MS <= 10000, 'the real deadline stays in seconds');
});

test('an unavailable bridge is reported, not silently swallowed', async () => {
    const cap = await t.probe();
    assert.equal(cap.ok, false, 'there is no Photoshop in the test runner');
    assert.match(cap.reason, /\S/, 'the reason must be sayable in the panel');
    await assert.rejects(() => t.fetchLike('https://api.openai.com/v1/models'), /\S/);
});

test('streaming asks curl not to buffer, otherwise there is no live preview', () => {
    const streamed = t.buildCurlConfig({ url: 'https://x/y', outFile: '/o', headerFile: '/h', stream: true });
    assert.match(streamed, /^no-buffer$/m);
    const plain = t.buildCurlConfig({ url: 'https://x/y', outFile: '/o', headerFile: '/h' });
    assert.doesNotMatch(plain, /no-buffer/);
});

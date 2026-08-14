/* ============================================================================
 *  providers/curl-transport.js — мережа ПОЗА процесом Photoshop.
 *
 *  Задача: якщо фаєрвол блокує вихідні з'єднання Photoshop (правило по процесу),
 *  плагін усе одно працює. Запит робить окремий бінарник `curl`, який є штатно
 *  і в macOS, і у Windows 10+ — жодних встановлень і жодного sidecar.
 *
 *  Ланцюг (кожна ланка виміряна в PS 27.5.0, деталі — у пам'яті проєкту):
 *    UXP → session token → batchPlay 'AdobeScriptAutomation Scripts'
 *        → згенерований ES3-скрипт → app.system("curl … &")
 *        → пулінг файлів відповіді → Response-подібний об'єкт
 *
 *  ⚠️ ЧОМУ СКРИПТ ГЕНЕРУЄТЬСЯ, А НЕ ЛЕЖИТЬ ГОТОВИЙ: подія
 *  'AdobeScriptAutomation Scripts' не має каналу для аргументів. Єдиний спосіб
 *  передати команду — вбудувати її в текст скрипта. Ключ API у цей текст НЕ
 *  потрапляє: він живе лише у файлі `--config`, тому й у `ps` його не видно.
 *
 *  ⚠️ ЧОМУ nativePath: щоб зібрати команду для shell, потрібні справжні шляхи.
 *  Файли створює сам UXP у власній тимчасовій папці, тому читання й прибирання
 *  йдуть через ті ж Entry (`entry.delete()`), а не через здогадки про шляхи.
 *  Вставка результату в документ як раніше — через session token, не через шлях.
 * ========================================================================== */

const curlI18n = require('../i18n.js');

/** Стан транспорту: 'auto' | 'direct' | 'curl'. Рішення — у active(). */
let mode = 'auto';
/** Кеш результату перевірки можливостей: null | { ok, reason } */
let capability = null;
/** Синхронна копія capability.ok — active() не може бути async. */
let capabilityOk = false;
/** Чи впав прямий fetch через мережу — підстава для 'auto' піти в curl. */
let directFailed = false;
/** Результат preflight: чи вирішено маршрут і який саме. */
let routeDecided = false;
let routeUseCurl = false;
let seq = 0;

/**
 * Скільки чекати першого контакту, перш ніж визнати прямий шлях непрохідним.
 *
 * ⚠️ ЧОМУ ЦЕ ОКРЕМО ВІД timeoutMs ЗАПИТУ: заблокований фаєрволом потік не
 * відмовляється, а ВИСИТЬ (виміряно: 20–30 с у стані «правила ще нема»). Якщо
 * чекати таймаут генерації, користувач дивиться на «Generating…» до 300 с і
 * лише потім отримує перемикання. Preflight на дешевий keyless-запит вирішує
 * маршрут за секунди й лише раз на сесію.
 */
const PREFLIGHT_MS = 6000;

function platform() {
    try { return require('os').platform(); } catch (e) { return 'unknown'; }
}

const isWindows = () => platform() === 'win32';

/* ── Чисті функції (тестуються під Node, без Photoshop) ────────────────────── */

/**
 * ASCII-перевірка шляху.
 *
 * ⚠️ Windows cmd працює в OEM-кодуванні (на нашій тестовій машині `chcp` = 866).
 * Шлях із кирилицею — а профіль користувача цілком може бути «C:\Users\Оксана» —
 * дійде до curl зіпсованим. Тому непридатний шлях краще виявити заздалегідь і
 * лишити прямий fetch, ніж дати незрозумілу помилку.
 */
function isAsciiPath(p) {
    return typeof p === 'string' && p.length > 0 && !/[^\x20-\x7E]/.test(p);
}

/** Значення для файлу `--config`: подвійні лапки, escape зворотних слешів. */
function quoteConfigValue(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Файл `--config` для curl. Тут живуть URL, метод, заголовки (разом із
 * Authorization) і шляхи — тобто все чутливе лишається у файлі з правами
 * користувача, а не в аргументах процесу.
 */
function buildCurlConfig({ url, method = 'GET', headers = {}, bodyFile, outFile,
                           headerFile, timeoutSec = 300, stream = false }) {
    const lines = [
        'url = ' + quoteConfigValue(url),
        'request = ' + quoteConfigValue(method),
        'silent',
        'show-error',
        'max-time = ' + String(Math.max(1, Math.round(timeoutSec))),
        'output = ' + quoteConfigValue(outFile),
        'dump-header = ' + quoteConfigValue(headerFile),
        // статус і код виходу забираємо з stdout, а не з коду app.system:
        // на Windows після `start /b` коду виходу немає взагалі
        'write-out = ' + quoteConfigValue('%{http_code} %{exitcode}'),
    ];
    if (stream) lines.push('no-buffer');
    for (const [name, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue;
        lines.push('header = ' + quoteConfigValue(`${name}: ${value}`));
    }
    if (bodyFile) lines.push('data-binary = ' + quoteConfigValue('@' + bodyFile));
    return lines.join('\n') + '\n';
}

/** Лапки для shell цільової платформи. */
function shellQuote(plat, value) {
    const s = String(value);
    if (plat === 'win32') return '"' + s.replace(/"/g, '""') + '"';
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Команда запуску. Асинхронна на обох платформах: у POSIX — `&`, у cmd —
 * `start "" /b` (там `&` означає послідовне виконання, а не фон).
 */
function buildCommand({ plat, curlPath, configFile, codeFile }) {
    const q = v => shellQuote(plat, v);
    const core = `${q(curlPath)} --config ${q(configFile)} > ${q(codeFile)} 2>&1`;
    return plat === 'win32' ? `start "" /b ${core}` : `${core} &`;
}

/**
 * Текст одноразового ES3-скрипта.
 *
 * ⚠️ ExtendScript тут — ES3: ні let, ні стрілок, ні JSON. І лише ASCII: кодування
 * `do javascript` / події не гарантоване, будь-яка кирилиця дає мойбейк.
 * Шлях до curl обчислюється всередині скрипта ($.getenv), щоб у runtime-коді
 * плагіна не з'явилось жодного абсолютного системного шляху.
 */
function buildJobJsx({ configFile, codeFile }) {
    const jsx = [
        '// generated by ExactFill; disposable',
        'var win = $.os.indexOf("Windows") >= 0;',
        'var curl = win ? ($.getenv("SystemRoot") + "\\\\System32\\\\curl.exe") : "/usr/bin/curl";',
        'var cfg = ' + JSON.stringify(configFile) + ';',
        'var code = ' + JSON.stringify(codeFile) + ';',
        'function q(v) { return win ? ("\\"" + v + "\\"") : ("\'" + v + "\'"); }',
        'var cmd = q(curl) + " --config " + q(cfg) + " > " + q(code) + " 2>&1";',
        'cmd = win ? ("start \\"\\" /b " + cmd) : (cmd + " &");',
        'var rc = -1;',
        'try { rc = app.system(cmd); } catch (e) { rc = "threw:" + e; }',
        '"spawned rc=" + rc;',
    ].join('\n');
    if (/[^\x00-\x7F]/.test(jsx)) throw new Error('generated jsx must stay ASCII');
    return jsx;
}

/** `-w` віддає «<http_code> <exitcode>»; помилка curl може дописати текст. */
function parseWriteOut(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const m = raw.match(/(\d{3})\s+(\d+)\s*$/);
    if (!m) return { status: 0, curlExit: -1, note: raw.slice(0, 300) };
    const note = raw.slice(0, m.index).trim();
    return { status: Number(m[1]), curlExit: Number(m[2]), note: note.slice(0, 300) };
}

/** Заголовки з `dump-header` → мінімальний headers.get(). */
function parseHeaderDump(text) {
    const map = new Map();
    for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    return { get: name => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) };
}

/** Людське пояснення кодів виходу curl, які трапляються насправді. */
function describeCurlExit(code) {
    if (code === 6) return curlI18n.t('transport.curlDns');
    if (code === 7) return curlI18n.t('transport.curlRefused');
    if (code === 28) return curlI18n.t('transport.curlTimeout');
    if (code === 35 || code === 60) return curlI18n.t('transport.curlTls');
    return curlI18n.t('transport.curlFailed', { code: String(code) });
}

/* ── Рантайм ───────────────────────────────────────────────────────────────── */

function setMode(next) {
    mode = ['auto', 'direct', 'curl'].includes(next) ? next : 'auto';
    routeDecided = false;               // ручний вибір скасовує попередній вердикт
    routeUseCurl = false;
    return mode;
}
const getMode = () => mode;
const noteDirectFailure = () => { directFailed = true; };
const resetDirectFailure = () => { directFailed = false; };
const isRouteDecided = () => routeDecided;

/**
 * Preflight: один дешевий keyless-запит, щоб дізнатися, чи взагалі виходить
 * прямий шлях. Будь-яка HTTP-відповідь (навіть 401/403/404) означає «мережа
 * працює» — нас цікавить факт відповіді, не її код.
 */
async function decideRoute(origin, { fetchImpl, timeoutMs = PREFLIGHT_MS } = {}) {
    if (routeDecided) return routeUseCurl;
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    routeDecided = true;
    routeUseCurl = false;
    if (!doFetch) return routeUseCurl;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
        await doFetch(origin + '/', { method: 'GET', signal: ctrl ? ctrl.signal : undefined });
        console.log('[curl] preflight: прямий шлях працює');
    } catch (e) {
        const cap = await probe();
        routeUseCurl = cap.ok;
        console.log(routeUseCurl
            ? `[curl] preflight: прямий шлях не відповів (${e && e.message}) — беру curl`
            : `[curl] preflight: прямий шлях не відповів, curl теж недоступний (${cap.reason})`);
    } finally {
        if (timer) clearTimeout(timer);
    }
    return routeUseCurl;
}

/**
 * Чи маємо зараз іти через curl.
 *
 * ⚠️ В 'auto' недостатньо факту відмови прямого шляху: якщо перевірка можливостей
 * не пройшла (немає містка, шлях із кирилицею), маршрут непридатний, і вертати тут
 * true означало б гнати кожен наступний запит у транспорт, який не працює.
 */
function active() {
    if (mode === 'direct') return false;
    if (mode === 'curl') return true;
    return routeUseCurl || (directFailed && capabilityOk);
}

async function tempFolder() {
    const lfs = require('uxp').storage.localFileSystem;
    return lfs.getTemporaryFolder();
}

/** Створює (перезаписує) файл у тимчасовій папці плагіна. */
async function makeFile(folder, name) {
    const { storage } = require('uxp');
    return folder.createFile(name, { overwrite: true });
}

async function writeText(entry, text) {
    const { formats } = require('uxp').storage;
    await entry.write(text, { format: formats.utf8 });
}

async function writeBinary(entry, data) {
    const { formats } = require('uxp').storage;
    await entry.write(data, { format: formats.binary });
}

async function readTextSafe(entry) {
    const { formats } = require('uxp').storage;
    try { return await entry.read({ format: formats.utf8 }); } catch (e) { return ''; }
}

async function removeQuietly(entries) {
    for (const entry of entries) {
        if (!entry) continue;
        try { await entry.delete(); } catch (e) { /* лишиться в temp, не критично */ }
    }
}

/**
 * Одноразова перевірка можливостей: тимчасова папка з ASCII-шляхом і робочий
 * місток до ExtendScript. Результат кешується — це не безкоштовно.
 */
async function probe() {
    if (capability) return capability;
    try {
        const folder = await tempFolder();
        if (!isAsciiPath(folder.nativePath)) {
            // шлях у лог свідомо: без нього неможливо зрозуміти, чому транспорт
            // відмовився на чужій машині (найімовірніша причина — імʼя користувача
            // не латиницею, а профіль Windows складається саме з нього)
            console.log(`[curl] робоча папка не ASCII, лишаю прямий шлях: ${folder.nativePath}`);
            capability = { ok: false, reason: curlI18n.t('transport.nonAsciiPath') };
            capabilityOk = false;
            return capability;
        }
        const probeJsx = await makeFile(folder, 'exactfill-probe.jsx');
        await writeText(probeJsx, '"exactfill-bridge-ok";');
        const answer = await runJsx(probeJsx);
        await removeQuietly([probeJsx]);
        capability = answer === 'exactfill-bridge-ok'
            ? { ok: true, reason: '' }
            : { ok: false, reason: curlI18n.t('transport.bridgeUnavailable') };
    } catch (e) {
        capability = { ok: false, reason: e && e.message ? e.message : String(e) };
    }
    capabilityOk = capability.ok === true;
    return capability;
}

/**
 * Виконує ExtendScript-файл і повертає його результат.
 *
 * ⚠️ Нативний шлях подія НЕ приймає: `{_path:'/abs'}` дає «invalid file token
 * used». Працює лише session token, і лише всередині executeAsModal.
 * Значення, яке віддав скрипт, приходить у `javaScriptMessage` — це і є
 * зворотний канал, тому дрібні відповіді через файли гонити не треба.
 */
async function runJsx(entry) {
    const { action, core } = require('photoshop');
    const lfs = require('uxp').storage.localFileSystem;
    const token = lfs.createSessionToken(entry);
    const result = await core.executeAsModal(
        () => action.batchPlay([{
            _obj: 'AdobeScriptAutomation Scripts',
            javaScript: { _path: token, _kind: 'local' },
            _options: { dialogOptions: 'dontDisplay' },
        }], { synchronousExecution: false }),
        { commandName: 'ExactFill network request' });
    const first = result && result[0];
    if (first && first._obj === 'error') throw new Error(curlI18n.t('transport.bridgeRefused'));
    return first ? first.javaScriptMessage : undefined;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Response-подібний об'єкт над файлами curl: рівно те, що використовує http.js
 * (`ok`, `status`, `headers.get`, `text()`, `body.getReader()`), і нічого більше.
 * Завдяки цьому провайдери й розбір SSE лишаються без змін.
 */
async function curlFetch(url, { method = 'GET', headers = {}, body,
                                timeoutMs = 300000, signal, stream = false } = {}) {
    const cap = await probe();
    if (!cap.ok) throw new Error(cap.reason);

    const folder = await tempFolder();
    const id = `exactfill-${Date.now().toString(36)}-${++seq}`;
    const files = {};
    const created = [];
    for (const [key, suffix] of [['cfg', '.cfg'], ['out', '.out'], ['hdr', '.hdr'],
                                 ['code', '.code'], ['jsx', '.jsx']]) {
        files[key] = await makeFile(folder, id + suffix);
        created.push(files[key]);
    }
    let bodyEntry = null;
    if (body !== undefined && body !== null) {
        bodyEntry = await makeFile(folder, id + '.body');
        created.push(bodyEntry);
        if (typeof body === 'string') await writeText(bodyEntry, body);
        else await writeBinary(bodyEntry, body instanceof Uint8Array ? body.buffer : body);
    }

    for (const entry of created) {
        if (!isAsciiPath(entry.nativePath)) {
            await removeQuietly(created);
            throw new Error(curlI18n.t('transport.nonAsciiPath'));
        }
    }

    await writeText(files.cfg, buildCurlConfig({
        url, method, headers,
        bodyFile: bodyEntry ? bodyEntry.nativePath : null,
        outFile: files.out.nativePath,
        headerFile: files.hdr.nativePath,
        timeoutSec: Math.ceil(timeoutMs / 1000),
        stream,
    }));
    await writeText(files.jsx, buildJobJsx({
        configFile: files.cfg.nativePath,
        codeFile: files.code.nativePath,
    }));

    const spawned = await runJsx(files.jsx);
    console.log(`[curl] ${method} ${new URL(url).host} — ${spawned}`);

    /** Пулінг: чекаємо, поки curl допише файл статусу. */
    async function waitForCompletion(onPartial) {
        const started = Date.now();
        let seen = 0;
        for (;;) {
            if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            const code = parseWriteOut(await readTextSafe(files.code));
            if (onPartial) {
                const text = await readTextSafe(files.out);
                if (text.length > seen) { onPartial(text.slice(seen)); seen = text.length; }
            }
            if (code) return code;
            if (Date.now() - started > timeoutMs + 5000) {
                throw Object.assign(new Error('timeout'), { name: 'AbortError' });
            }
            await sleep(stream ? 250 : 400);
        }
    }

    return { files, created, waitForCompletion, removeQuietly, readTextSafe };
}

/**
 * Обгортка з інтерфейсом Response для неструмового запиту.
 * Помилки лишаються тими самими типами, що й у прямому шляху: розбір тіла,
 * retry-after і тексти повідомлень робить http.js.
 */
async function fetchLike(url, init = {}) {
    const run = await curlFetch(url, init);
    const started = Date.now();
    try {
        const code = await run.waitForCompletion(null);
        console.log(`[curl] ← ${code.status} (curl exit ${code.curlExit}) за ${Date.now() - started} мс`);
        if (code.curlExit !== 0 || code.status === 0) {
            const detail = describeCurlExit(code.curlExit);
            throw new Error(code.note ? `${detail} (${code.note})` : detail);
        }
        const text = await run.readTextSafe(run.files.out);
        const headers = parseHeaderDump(await run.readTextSafe(run.files.hdr));
        return {
            ok: code.status >= 200 && code.status < 300,
            status: code.status,
            headers,
            text: async () => text,
            body: null,
        };
    } finally {
        await run.removeQuietly(run.created);
    }
}

/**
 * Струмовий варіант: reader над зростаючим файлом. Проміжні кадри реальні —
 * файл curl росте під час запиту (виміряно: 50 КБ/с рівно посекундно).
 */
async function fetchLikeStream(url, init = {}) {
    const run = await curlFetch(url, { ...init, stream: true });
    const chunks = [];
    let done = false;
    let failure = null;

    const pump = run.waitForCompletion(part => chunks.push(part))
        .then(code => {
            console.log(`[curl] ← stream ${code.status} (curl exit ${code.curlExit})`);
            if (code.curlExit !== 0 || code.status === 0) {
                failure = new Error(code.note
                    ? `${describeCurlExit(code.curlExit)} (${code.note})`
                    : describeCurlExit(code.curlExit));
            }
            return code;
        })
        .catch(e => { failure = e; return null; })
        .then(async code => { done = true; return code; });

    // статус відомий лише після завершення curl, тому для SSE віддаємо 200
    // оптимістично, а справжню помилку кидаємо в reader — саме там її ловить http.js
    return {
        ok: true,
        status: 200,
        headers: parseHeaderDump(''),
        text: async () => { await pump; return (await run.readTextSafe(run.files.out)); },
        body: {
            getReader() {
                return {
                    async read() {
                        for (;;) {
                            if (chunks.length) return { done: false, value: chunks.shift() };
                            if (done) {
                                await run.removeQuietly(run.created);
                                if (failure) throw failure;
                                return { done: true, value: undefined };
                            }
                            await sleep(200);
                        }
                    },
                };
            },
        },
    };
}

module.exports = {
    // чисте, для тестів
    isAsciiPath, quoteConfigValue, buildCurlConfig, shellQuote, buildCommand,
    buildJobJsx, parseWriteOut, parseHeaderDump, describeCurlExit,
    // стан і рантайм
    setMode, getMode, active, noteDirectFailure, resetDirectFailure,
    isRouteDecided, decideRoute, PREFLIGHT_MS,
    probe, fetchLike, fetchLikeStream,
};

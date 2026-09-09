/* ============================================================================
 *  providers/http.js — спільна транспортна частина для всіх провайдерів.
 *
 *  Виправляє три дефекти старих SDK:
 *   1. Таймаут через Promise.race не СКАСОВУВАВ запит — fetch продовжував
 *      висіти, і панель могла мовчати до 15 хвилин. Тут AbortController.
 *   2. retryWithBackoff відкидав усе 4xx, тобто НЕ ретраїв 429 (rate limit),
 *      хоч саме він і потребує ретраю. Тут 429/408/5xx ретраяться з повагою
 *      до Retry-After, а 400/401/403/404 — ні.
 *   3. Помилки провайдера падали як TypeError на розборі відповіді. Тут завжди
 *      читабельний текст українською.
 * ========================================================================== */

const httpI18n = require('../i18n.js');
const transport = require('./curl-transport.js');

/**
 * Єдина точка виходу в мережу.
 *
 * ⚠️ ЧОМУ НЕ ПРОСТО fetch: UXP-дозвіл `network.domains` не обходить системний
 * фаєрвол — запит іде з процесу Photoshop, і правило «Block Photoshop» його
 * ріже (виміряно: Socket із процесу PS падає, дочірній curl тими ж секундами
 * отримує 401/403). Тому в режимі 'auto' перша мережева відмова перемикає
 * подальші запити на curl-транспорт, а 'curl'/'direct' задають шлях жорстко.
 */
async function netFetch(url, init, streaming) {
    const viaCurl = () => (streaming ? transport.fetchLikeStream(url, init)
                                     : transport.fetchLike(url, init));
    // ⚠️ Перший запит сесії в 'auto' вирішуємо preflight'ом, а НЕ таймаутом самого
    // запиту: заблокований потік висить, і з timeoutMs 300 с користувач дивився б
    // на «Generating…» п'ять хвилин, перш ніж транспорт узагалі спробував би curl.
    if (transport.getMode() === 'auto' && !transport.isRouteDecided()) {
        try { await transport.decideRoute(new URL(url).origin); } catch (e) {}
    }
    if (transport.active()) return viaCurl();
    try {
        return await fetch(url, init);
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || String(e.message).includes('abort'));
        if (aborted || transport.getMode() !== 'auto') throw e;
        transport.noteDirectFailure();
        const cap = await transport.probe();
        if (!cap.ok) {
            // маршруту немає — не лишаємо 'auto' у стані «перемкнено на curl»,
            // інакше кожен наступний запит ішов би в неробочий транспорт
            transport.resetDirectFailure();
            console.log(`[http] curl-транспорт недоступний: ${cap.reason}`);
            throw e;
        }
        console.log('[http] прямий fetch не дійшов — переходжу на curl-транспорт');
        return viaCurl();
    }
}

/** UTF-8 без TextEncoder — в UXP його немає. */
function strToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
        } else if (code >= 0xD800 && code <= 0xDBFF) {
            const lo = str.charCodeAt(++i);
            const cp = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
            bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                       0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else {
            bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
    }
    return new Uint8Array(bytes);
}

/** Blob → base64 без FileReader (в UXP він неповний). */
async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(binary);
}

/**
 * multipart/form-data вручну: FormData + Blob зависає в UXP, тому збираємо
 * тіло байтами самі. Це не самодурство старого коду, це необхідність.
 */
async function buildMultipart(fields) {
    const boundary = 'AiImageBoundary' + Date.now().toString(36) +
                     Math.floor(Math.random() * 1e6).toString(36);
    const chunks = [];
    for (const f of fields) {
        let disposition = `Content-Disposition: form-data; name="${f.name}"`;
        if (f.filename) disposition += `; filename="${f.filename}"`;
        chunks.push(strToBytes(`--${boundary}\r\n${disposition}\r\n`));
        if (f.contentType) chunks.push(strToBytes(`Content-Type: ${f.contentType}\r\n`));
        chunks.push(strToBytes('\r\n'));
        if (f.data instanceof Blob) {
            chunks.push(new Uint8Array(await f.data.arrayBuffer()));
        } else if (f.data instanceof Uint8Array) {
            chunks.push(f.data);
        } else {
            chunks.push(strToBytes(String(f.data)));
        }
        chunks.push(strToBytes('\r\n'));
    }
    chunks.push(strToBytes(`--${boundary}--\r\n`));

    let total = 0;
    for (const c of chunks) total += c.length;
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { body.set(c, off); off += c.length; }
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

class HttpError extends Error {
    constructor(status, message, retryAfter) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

/** Статуси, які варто повторити. 429 — ОБОВ'ЯЗКОВО (саме він і був пропущений). */
const RETRYABLE = s => s === 429 || s === 408 || s === 409 || (s >= 500 && s < 600);

/** Скасування користувачем — окремий тип, щоб withRetry його НЕ повторював. */
class Cancelled extends Error {
    constructor() { super(httpI18n.t('provider.cancelled')); this.name = 'Cancelled'; this.cancelled = true; }
}

/**
 * Зводить зовнішній сигнал скасування й внутрішній таймаут в один контролер.
 * Повертає { signal, done() } — done() обов'язково викликати у finally, інакше
 * слухач на зовнішньому сигналі протече між генераціями.
 */
function linkAbort(external, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (!ctrl) return { signal: undefined, done() {}, wasCancelled: () => false };
    let cancelled = false;
    const onExternal = () => { cancelled = true; ctrl.abort(); };
    if (external) {
        if (external.aborted) onExternal();
        else external.addEventListener('abort', onExternal);
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return {
        signal: ctrl.signal,
        wasCancelled: () => cancelled,
        done() {
            clearTimeout(timer);
            if (external) { try { external.removeEventListener('abort', onExternal); } catch (e) {} }
        },
    };
}

/**
 * fetch із реальним скасуванням і читабельними помилками.
 * timeoutMs великий свідомо: генерація зображення на high може йти хвилини.
 * signal — зовнішній AbortSignal кнопки «Скасувати».
 */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 300000, signal } = {}) {
    const link = linkAbort(signal, timeoutMs);
    try {
        let res;
        try {
            res = await netFetch(url, { method, headers, body, signal: link.signal, timeoutMs }, false);
        } catch (e) {
            if (e && (e.name === 'AbortError' || String(e.message).includes('abort'))) {
                if (link.wasCancelled()) throw new Cancelled();
                throw new HttpError(0, httpI18n.t('provider.timeout', {
                    seconds: Math.round(timeoutMs / 1000),
                }));
            }
            throw new HttpError(0, httpI18n.t('provider.noConnection', {
                host: new URL(url).host, error: e.message,
            }));
        }

        const text = await res.text();
        if (!res.ok) throw errorFromBody(res, text);

        try {
            return JSON.parse(text);
        } catch (e) {
            throw new HttpError(res.status, httpI18n.t('provider.invalidJson'));
        }
    } finally {
        link.done();
    }
}

function errorFromBody(res, text) {
    let msg = `HTTP ${res.status}`;
    let code = null;
    try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.error?.status || j?.message || msg;
        // ⚠️ Сам код помилки, а не лише текст: статус 404 однаково стоїть і на
        // «немає такої моделі», і на «немає такого ендпоінта», а розрізняти їх
        // за англійським реченням — крихко. Провайдери реагують саме на code.
        code = j?.error?.code || j?.error?.type || null;
    } catch (e) {
        if (text) msg += `: ${text.slice(0, 300)}`;
    }
    const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    const err = new HttpError(res.status, msg, parseRetryAfter(ra));
    err.code = code;
    return err;
}

/** Retry-After буває секундами або HTTP-датою; обидві форми стандартні. */
function parseRetryAfter(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const at = Date.parse(String(value));
    return Number.isFinite(at) ? Math.max(0, (at - now) / 1000) : null;
}

/**
 * SSE-запит для провайдерів, що вміють віддавати проміжні кадри.
 *
 * ⚠️ ЧЕСНО ПРО ОБМЕЖЕННЯ: чи підтримує fetch в UXP потокове ЧИТАННЯ тіла
 * (`res.body.getReader`) — не задокументовано, і перевірити це з ExtendScript
 * неможливо (там немає fetch). Тому робимо перевірку можливості в рантаймі:
 * якщо reader є — читаємо подіями, якщо ні — дочитуємо весь текст і віддаємо
 * ті самі події одним пакетом. Прев'ю тоді просто не буде проміжним, але
 * генерація не зламається. Який шлях спрацював — видно в консолі.
 *
 * @param {(ev:object)=>void} onEvent — виклик на кожну розібрану SSE-подію
 * @returns {Promise<object|null>} остання подія (…completed), якщо була
 */
async function requestStream(url, { method = 'POST', headers = {}, body, timeoutMs = 300000, signal } = {}, onEvent) {
    const link = linkAbort(signal, timeoutMs);
    try {
        let res;
        try {
            res = await netFetch(url, { method, headers, body, signal: link.signal, timeoutMs }, true);
        } catch (e) {
            if (e && (e.name === 'AbortError' || String(e.message).includes('abort'))) {
                if (link.wasCancelled()) throw new Cancelled();
                throw new HttpError(0, httpI18n.t('provider.streamTimeout', {
                    seconds: Math.round(timeoutMs / 1000),
                }));
            }
            throw new HttpError(0, httpI18n.t('provider.noConnection', {
                host: new URL(url).host, error: e.message,
            }));
        }
        if (!res.ok) throw errorFromBody(res, await res.text());

        let last = null;
        const feed = chunk => { for (const ev of parseSse(chunk)) { last = ev; if (onEvent) onEvent(ev); } };

        const canStream = res.body && typeof res.body.getReader === 'function';
        if (canStream) {
            const reader = res.body.getReader();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                // SSE дозволяє і LF, і CRLF. Нормалізуємо одразу, інакше
                // `\r\n\r\n` не знаходиться як `\n\n`, а кадри накопичуються
                // до завершення запиту й перестають бути живим preview.
                buf += bytesToStr(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                // подія завершується порожнім рядком; тримаємо хвіст у буфері
                const cut = buf.lastIndexOf('\n\n');
                if (cut >= 0) { feed(buf.slice(0, cut + 2)); buf = buf.slice(cut + 2); }
            }
            if (buf.trim()) feed(buf);
        } else {
            console.log('[http] потокове читання недоступне — розбираю SSE одним пакетом');
            feed(await res.text());
        }
        return last;
    } finally {
        link.done();
    }
}

/** UTF-8 з байтів без TextDecoder (в UXP його теж може не бути). */
function bytesToStr(bytes) {
    if (!bytes) return '';
    if (typeof bytes === 'string') return bytes;
    let s = '';
    const CHUNK = 8192;
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + CHUNK, arr.length)));
    }
    // base64 у SSE — ASCII, тому декодування UTF-8 тут не потрібне
    return s;
}

/** Розбирає блок SSE у масив об'єктів із рядків `data:`. */
function parseSse(chunk) {
    const out = [];
    const normalized = String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const block of normalized.split(/\n\n/)) {
        const dataLines = [];
        for (const line of block.split(/\n/)) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join('');
        if (payload === '[DONE]') continue;
        try { out.push(JSON.parse(payload)); } catch (e) { /* неповний кадр — пропускаємо */ }
    }
    return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Очікування ретраю, яке переривається кнопкою «Скасувати» одразу. */
function sleepWithSignal(ms, signal) {
    if (!signal) return sleep(ms);
    if (signal.aborted) return Promise.reject(new Cancelled());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            try { signal.removeEventListener('abort', onAbort); } catch (e) {}
            reject(new Cancelled());
        };
        const timer = setTimeout(() => {
            try { signal.removeEventListener('abort', onAbort); } catch (e) {}
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort);
    });
}

/** Ретрай лише того, що варто ретраїти, з повагою до Retry-After. */
async function withRetry(fn, { tries = 4, baseDelay = 1200, signal } = {}) {
    let last;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            // Скасування користувачем — не помилка мережі, повторювати НЕ можна:
            // інакше кнопка «Скасувати» лише подовжувала б очікування вчетверо.
            if (e && e.cancelled) throw e;
            const status = e && e.status;
            if (!RETRYABLE(status) || attempt === tries - 1) throw e;
            const wait = (Number.isFinite(e.retryAfter) ? e.retryAfter * 1000 : baseDelay * Math.pow(2, attempt))
                       + Math.floor(Math.random() * 300);
            console.log(`[http] ${status} — повтор ${attempt + 1}/${tries - 1} через ${wait} мс`);
            await sleepWithSignal(wait, signal);
        }
    }
    throw last;
}

module.exports = {
    strToBytes, blobToBase64, buildMultipart,
    request, requestStream, withRetry, HttpError, Cancelled, RETRYABLE, sleep,
    sleepWithSignal, parseRetryAfter, parseSse,
    transport,
};

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

/**
 * fetch із реальним скасуванням і читабельними помилками.
 * timeoutMs великий свідомо: генерація зображення на high може йти хвилини.
 */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 300000 } = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    try {
        if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(url, { method, headers, body, signal: ctrl ? ctrl.signal : undefined });
        } catch (e) {
            if (e && (e.name === 'AbortError' || String(e.message).includes('abort'))) {
                throw new HttpError(0, `Запит перевищив ${Math.round(timeoutMs / 1000)} с і був скасований`);
            }
            throw new HttpError(0, `Немає з'єднання з ${new URL(url).host}: ${e.message}`);
        }

        const text = await res.text();
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
                const j = JSON.parse(text);
                msg = j?.error?.message || j?.error?.status || j?.message || msg;
            } catch (e) {
                if (text) msg += `: ${text.slice(0, 300)}`;
            }
            const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
            throw new HttpError(res.status, msg, ra ? Number(ra) : null);
        }

        try {
            return JSON.parse(text);
        } catch (e) {
            throw new HttpError(res.status, 'Провайдер повернув не JSON — можливо, змінився формат API');
        }
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Ретрай лише того, що варто ретраїти, з повагою до Retry-After. */
async function withRetry(fn, { tries = 4, baseDelay = 1200 } = {}) {
    let last;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            const status = e && e.status;
            if (!RETRYABLE(status) || attempt === tries - 1) throw e;
            const wait = (e.retryAfter ? e.retryAfter * 1000 : baseDelay * Math.pow(2, attempt))
                       + Math.floor(Math.random() * 300);
            console.log(`[http] ${status} — повтор ${attempt + 1}/${tries - 1} через ${wait} мс`);
            await sleep(wait);
        }
    }
    throw last;
}

module.exports = {
    strToBytes, blobToBase64, buildMultipart,
    request, withRetry, HttpError, RETRYABLE, sleep,
};

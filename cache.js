/* ============================================================================
 *  cache.js — кеш згенерованих зображень для повторної вставки БЕЗ нового запиту.
 *
 *  ЧОМУ ЦЕ ОБМЕЖЕНО ЖОРСТКО. Старий плагін мав saveDebugBlob, який писав два
 *  файли на кожну генерацію і не видаляв нічого: намило 2.97 ГБ у 484 файлах,
 *  і Photoshop сканував цю папку при кожному старті. Тут навпаки:
 *    • MAX записів, ротація найстаріших при кожному save();
 *    • індекс у localStorage, самі байти — у папці даних плагіна;
 *    • bytes() віддає фактичний розмір, щоб його можна було ПОКАЗАТИ в панелі;
 *    • clear() є в UI, а не лише в коді.
 *
 *  Сенс не в дебазі, а в грошах: повторна вставка того самого результату —
 *  нуль запитів до провайдера.
 * ========================================================================== */

const uxpStorage = require('uxp').storage;

const MAX_ENTRIES = 8;
const INDEX_KEY = require('./storage-keys.js').LS.cache;
const SUBFOLDER = 'results';

/** base64 з байтів без FileReader — в UXP він неповний. */
function bytesToB64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < arr.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + CHUNK, arr.length)));
    }
    return btoa(binary);
}
function b64ToBytes(b64) {
    const bin = atob(String(b64).replace(/^data:[^,]+,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function readIndex() {
    try {
        const raw = localStorage.getItem(INDEX_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter(e => e && typeof e.id === 'string' &&
            typeof e.name === 'string' && /^[A-Za-z0-9._-]+$/.test(e.name)) : [];
    } catch (e) {
        console.warn('[cache] індекс побитий, починаю з чистого:', e.message);
        return [];
    }
}
function writeIndex(arr) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(arr)); }
    catch (e) { console.error('[cache] індекс не збережено:', e.message); }
}

/** Папка даних плагіна. Не temp: temp чистить система, і кеш зникав би довільно. */
async function folder() {
    const data = await uxpStorage.localFileSystem.getDataFolder();
    try {
        return await data.getEntry(SUBFOLDER);
    } catch (e) {
        return await data.createFolder(SUBFOLDER);
    }
}

async function removeFile(name) {
    try {
        const f = await folder();
        const entry = await f.getEntry(name);
        await entry.delete();
        return true;
    } catch (e) { return false; }
}

/**
 * Кладе PNG у кеш і повертає id. Ротація тут же, синхронно з записом —
 * не в окремому «прибиральнику», якого легко забути викликати.
 * @param {string} b64
 * @param {object} meta — prompt, provider, model, ctx, target, quality тощо
 */
async function save(b64, meta = {}) {
    const bytes = b64ToBytes(b64);
    const id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const name = `${id}.png`;
    try {
        const f = await folder();
        const file = await f.createFile(name, { overwrite: true });
        await file.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                         { format: uxpStorage.formats.binary });
    } catch (e) {
        console.error('[cache] не записалось:', e.message);
        return null;
    }

    const index = readIndex();
    index.push({ id, name, size: bytes.length, at: Date.now(), meta });
    // ротація: лишаємо MAX_ENTRIES найновіших, решту видаляємо з диска
    while (index.length > MAX_ENTRIES) {
        const old = index.shift();
        await removeFile(old.name);
    }
    writeIndex(index);
    return id;
}

/** Найновіші першими — так само, як історія. */
function list() {
    return readIndex().slice().reverse();
}

function bytes() {
    return readIndex().reduce((s, e) => s + (e.size || 0), 0);
}

function human() {
    const b = bytes();
    if (b < 1024) return `${b} Б`;
    if (b < 1048576) return `${(b / 1024).toFixed(0)} КБ`;
    return `${(b / 1048576).toFixed(1)} МБ`;
}

async function get(id) {
    const entry = readIndex().find(e => e.id === id);
    if (!entry) return null;
    try {
        const f = await folder();
        const file = await f.getEntry(entry.name);
        const buf = await file.read({ format: uxpStorage.formats.binary });
        return bytesToB64(buf);
    } catch (e) {
        console.warn('[cache] файл зник, чищу запис:', e.message);
        writeIndex(readIndex().filter(e2 => e2.id !== id));
        return null;
    }
}

async function remove(id) {
    const entry = readIndex().find(e => e.id === id);
    if (entry) await removeFile(entry.name);
    writeIndex(readIndex().filter(e => e.id !== id));
}

async function clear() {
    for (const e of readIndex()) await removeFile(e.name);
    writeIndex([]);
}

module.exports = { save, get, list, remove, clear, bytes, human, MAX_ENTRIES };

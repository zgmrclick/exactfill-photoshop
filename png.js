/* ============================================================================
 *  png.js — мінімальний PNG-кодер із СПРАВЖНІМ deflate.
 *
 *  Чому не взяти старий encodeMaskPNG: він писав deflate STORED-блоками, тобто
 *  без стиснення. Маска 1024×1024 RGBA виходила 4 195 659 B ≈ 4.00 MiB, а ліміт
 *  OpenAI на маску — «less than 4MB». Тобто робоче вікно було ≈655 360…1 040 000
 *  пікселів і все; для 2048×1536 маска важила ~12 МБ і запит гарантовано падав.
 *
 *  Тут fixed-Huffman deflate з RLE-матчами. Для маски (величезні однорідні
 *  області) дає стиснення в сотні разів. Жодних залежностей.
 *
 *  Чистий модуль: без require('photoshop'), тестується в node через
 *  zlib.inflateSync.
 * ========================================================================== */

/* ── CRC32 / біти ──────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function adler32(buf) {
    let s1 = 1, s2 = 0;
    for (let i = 0; i < buf.length; i++) {
        s1 = (s1 + buf[i]) % 65521;
        s2 = (s2 + s1) % 65521;
    }
    return ((s2 << 16) | s1) >>> 0;
}

function w32(a, o, v) {
    a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255;
    a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255;
}

/**
 * Бітовий письменник для deflate.
 * Тонкість, на якій легко зламатися: у deflate службові біти пишуться
 * LSB-first, а Huffman-коди — MSB-first («packed starting with the most
 * significant bit of the code»). Тому два різні методи.
 */
class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
    /** Службові поля: молодшим бітом уперед. */
    bits(value, count) {
        for (let i = 0; i < count; i++) {
            this.cur |= ((value >>> i) & 1) << this.n;
            if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
        }
    }
    /** Huffman-код: старшим бітом уперед. */
    code(value, count) {
        for (let i = count - 1; i >= 0; i--) {
            this.cur |= ((value >>> i) & 1) << this.n;
            if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
        }
    }
    align() { if (this.n) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } }
    out() { this.align(); return Uint8Array.from(this.bytes); }
}

/* ── Таблиці fixed Huffman (RFC 1951, §3.2.5-3.2.6) ────────────────────────── */

// Довжини 3..258 → код 257..285 + додаткові біти
const LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEN_EXTRA = [0,0,0,0,0,0,0,0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,  4,  5,  5,  5,  5,  0];
// Дистанції 1..32768 → код 0..29 + додаткові біти
const DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2, 2, 3, 3, 4, 4, 5, 5,  6,  6,  7,  7,  8,  8,   9,   9,  10,  10,  11,  11,  12,   12,   13,   13];

/** Літерал у fixed Huffman. */
function putLiteral(bw, b) {
    if (b <= 143) bw.code(0x30 + b, 8);           // 00110000..10111111
    else          bw.code(0x190 + (b - 144), 9);  // 110010000..111111111
}

/** Довжина match'у. */
function putLength(bw, len) {
    let i = LEN_BASE.length - 1;
    while (LEN_BASE[i] > len) i--;
    const sym = 257 + i;
    if (sym <= 279) bw.code(sym - 256, 7);        // 0000001..0010111
    else            bw.code(0xC0 + (sym - 280), 8);
    if (LEN_EXTRA[i]) bw.bits(len - LEN_BASE[i], LEN_EXTRA[i]);
}

/** Дистанція match'у — у fixed Huffman коди дистанцій рівно 5 біт. */
function putDistance(bw, dist) {
    let i = DIST_BASE.length - 1;
    while (DIST_BASE[i] > dist) i--;
    bw.code(i, 5);
    if (DIST_EXTRA[i]) bw.bits(dist - DIST_BASE[i], DIST_EXTRA[i]);
}

/**
 * deflate у fixed-Huffman режимі з RLE-матчами.
 *
 * Свідоме обмеження: шукаємо повтори лише з distance = 1 (той самий байт) і
 * distance = rowStride (той самий байт у попередньому рядку). Для маски й
 * будь-якого зображення з однорідними рядками цього достатньо, а повний LZ77
 * із хеш-таблицею тут — зайвий ризик помилки. Дані завжди коректні: у
 * найгіршому разі виродиться в літерали, тобто в розмір stored + службові біти.
 *
 * @param {Uint8Array} data
 * @param {number} rowStride — довжина рядка в байтах разом із байтом фільтра
 */
function deflateRle(data, rowStride) {
    const bw = new BitWriter();
    bw.bits(1, 1);   // BFINAL = 1
    bw.bits(1, 2);   // BTYPE = 01 (fixed Huffman)

    const n = data.length;
    let i = 0;
    while (i < n) {
        let bestLen = 0, bestDist = 0;

        // повтор того самого байта
        if (i + 3 <= n && data[i] === data[i - 1] && i > 0) {
            let l = 0;
            while (l < 258 && i + l < n && data[i + l] === data[i - 1]) l++;
            if (l >= 3) { bestLen = l; bestDist = 1; }
        }
        // повтор рядка вище — саме він дає основне стиснення на масках
        if (rowStride > 0 && i >= rowStride) {
            let l = 0;
            while (l < 258 && i + l < n && data[i + l] === data[i + l - rowStride]) l++;
            if (l >= 3 && l > bestLen) { bestLen = l; bestDist = rowStride; }
        }

        if (bestLen >= 3) {
            putLength(bw, bestLen);
            putDistance(bw, bestDist);
            i += bestLen;
        } else {
            putLiteral(bw, data[i]);
            i++;
        }
    }
    bw.code(0, 7);   // символ 256 = кінець блоку

    const body = bw.out();
    const out = new Uint8Array(2 + body.length + 4);
    out[0] = 0x78; out[1] = 0x01;            // zlib header (CMF/FLG, ділиться на 31)
    out.set(body, 2);
    w32(out, 2 + body.length, adler32(data));
    return out;
}

/* ── PNG ───────────────────────────────────────────────────────────────────── */

function makeChunk(type, data) {
    const n = data.length;
    const out = new Uint8Array(12 + n);
    w32(out, 0, n);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    if (n) out.set(data, 8);
    const crcBuf = new Uint8Array(4 + n);
    for (let k = 0; k < 4; k++) crcBuf[k] = type.charCodeAt(k);
    if (n) crcBuf.set(data, 4);
    w32(out, 8 + n, crc32(crcBuf));
    return out;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * Кодує PNG із сирих компонент.
 * @param {Uint8Array} pixels — chunky, components байтів на піксель
 * @param {number} components 1=Grey, 2=Grey+A, 3=RGB, 4=RGBA
 */
function encodePng(pixels, width, height, components) {
    const COLOR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 };
    const colorType = COLOR_TYPE[components];
    if (colorType === undefined) throw new Error(`Непідтримувана кількість компонент: ${components}`);

    const rowBytes = width * components;
    const stride   = rowBytes + 1;
    const raw = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        raw[y * stride] = 0;                    // фільтр None: RLE нижче й так ловить рядки
        raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * stride + 1);
    }

    const ihdr = new Uint8Array(13);
    w32(ihdr, 0, width); w32(ihdr, 4, height);
    ihdr[8] = 8; ihdr[9] = colorType;           // bit depth 8

    return concat([
        Uint8Array.from(PNG_SIG),
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', deflateRle(raw, stride)),
        makeChunk('IEND', new Uint8Array(0)),
    ]);
}

/** Розміри з IHDR. Єдине джерело істини про пікселі відповіді провайдера. */
function readPngSize(png) {
    if (png.length < 24) throw new Error('Відповідь провайдера надто коротка для PNG');
    for (let i = 0; i < 8; i++) {
        if (png[i] !== PNG_SIG[i]) throw new Error('Відповідь провайдера — не PNG');
    }
    const rd = o => ((png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3]) >>> 0;
    return { w: rd(16), h: rd(20) };
}

/**
 * Вписує роздільність у чанк pHYs.
 *
 * Навіщо: Place Embedded масштабує вміст на docPPI/filePPI — це задокументована
 * поведінка «by design». PNG від провайдера чанка pHYs не має, тому Photoshop
 * вважає його 72 ppi і в 300-ppi документі роздуває до 416.7 %. Рівна
 * роздільність робить коефіцієнт 1, і корекція геометрії стає косметичною.
 *
 * pHYs за спекою — один раз і ДО першого IDAT, тому існуючий перезаписуємо.
 */
function setPngResolution(png, ppi) {
    const ppm = Math.max(1, Math.round(ppi * 39.3700787));   // 300 ppi → 11811 px/m
    const data = new Uint8Array(9);
    w32(data, 0, ppm); w32(data, 4, ppm); data[8] = 1;       // unit = 1 (метр)

    const rd = o => ((png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3]) >>> 0;
    let off = 8, insertAt = -1;
    while (off + 8 <= png.length) {
        const len  = rd(off);
        const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
        if (type === 'pHYs') {
            if (len !== 9) return png;                        // побитий чанк — не гіршаємо
            const out = png.slice();
            out.set(data, off + 8);
            w32(out, off + 8 + len, crc32(out.subarray(off + 4, off + 8 + len)));
            return out;
        }
        if (type === 'IHDR') insertAt = off + 12 + len;
        if (type === 'IDAT' || type === 'IEND') break;
        off += 12 + len;
    }
    if (insertAt < 0) return png;
    const chunk = makeChunk('pHYs', data);
    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(png.subarray(insertAt), insertAt + chunk.length);
    return out;
}

/**
 * Маска inpainting для прямокутної області.
 * Домовленість OpenAI: alpha = 0 (прозорий) — «змінити тут»;
 * alpha = 255 (непрозорий) — «зберегти як контекст».
 *
 * Grey+Alpha (2 байти/піксель) замість RGBA — удвічі менше даних до deflate,
 * а сірий канал провайдером усе одно не читається.
 *
 * @param {{left,top,right,bottom}} rect — у координатах маски, не документа
 */
function buildRectMaskPng(width, height, rect) {
    const L = Math.max(0, Math.round(rect.left));
    const T = Math.max(0, Math.round(rect.top));
    const R = Math.min(width, Math.round(rect.right));
    const B = Math.min(height, Math.round(rect.bottom));
    if (R <= L || B <= T) throw new Error('Порожній прямокутник маски');

    const px = new Uint8Array(width * height * 2);
    for (let y = 0; y < height; y++) {
        const inRow = y >= T && y < B;
        let o = y * width * 2;
        for (let x = 0; x < width; x++, o += 2) {
            const inside = inRow && x >= L && x < R;
            px[o]     = inside ? 0 : 255;      // сірий: косметика, провайдер його не читає
            px[o + 1] = inside ? 0 : 255;      // alpha: 0 = змінити, 255 = зберегти
        }
    }
    return encodePng(px, width, height, 2);
}

module.exports = {
    crc32, adler32, w32, makeChunk, deflateRle,
    encodePng, readPngSize, setPngResolution, buildRectMaskPng,
};

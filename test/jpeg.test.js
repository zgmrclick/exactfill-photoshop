/* ============================================================================
 *  JPEG-відповіді: розмір і роздільність для place.js.
 *
 *  Gemini `generateContent` віддає лише JPEG (виміряно 2026-10-08: enum
 *  responseFormat.image.mimeType знає тільки IMAGE_JPEG). До цього place.js
 *  приймав лише PNG і падав на `png.invalid` — тобто кожна генерація Gemini,
 *  що повертала JPEG, гинула вже після оплати.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const P = require('../png.js');

const seg = (marker, body) => Uint8Array.from([0xFF, marker, (body.length + 2) >> 8, (body.length + 2) & 0xFF, ...body]);
const jfif = dpi => seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 1, dpi >> 8, dpi & 0xFF, dpi >> 8, dpi & 0xFF, 0, 0]);
const sof0 = (w, h) => seg(0xC0, [8, h >> 8, h & 0xFF, w >> 8, w & 0xFF, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const join = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};
const SOI = Uint8Array.from([0xFF, 0xD8]);
const EOI = Uint8Array.from([0xFF, 0xD9]);

/* Та сама послідовність сегментів, що в справжній відповіді 2.1 (8:1, 1K):
   APP0 JFIF 300 dpi → APP11 (C2PA/JUMBF) → DQT → SOF0 2928×352 → DHT → SOS. */
const geminiLike = () => join(SOI, jfif(300), seg(0xEB, new Array(40).fill(7)),
    seg(0xDB, new Array(65).fill(1)), sof0(2928, 352), seg(0xC4, new Array(29).fill(0)), EOI);

test('розмір JPEG читається з SOF, а не з першого-ліпшого сегмента', () => {
    assert.deepEqual(P.readJpegSize(geminiLike()), { w: 2928, h: 352 });
});

test('роздільність документа переписує JFIF-щільність на місці', () => {
    const src = geminiLike();
    const out = P.setJpegResolution(src, 72);
    assert.equal(out.length, src.length, 'існуючий APP0 правимо, не дублюємо');
    assert.equal(out[13], 1, 'одиниці — dpi');
    assert.equal((out[14] << 8) | out[15], 72);
    assert.equal((out[16] << 8) | out[17], 72);
    assert.equal((src[14] << 8) | src[15], 300, 'вхід не мутуємо — він ще лежить у кеші');
    assert.deepEqual(P.readJpegSize(out), { w: 2928, h: 352 });
});

test('JPEG без APP0 отримує JFIF-сегмент одразу після SOI', () => {
    const src = join(SOI, sof0(1024, 768), EOI);
    const out = P.setJpegResolution(src, 300.4);
    assert.equal(out.length, src.length + 18);
    assert.equal(String.fromCharCode(...out.subarray(6, 11)), 'JFIF\0');
    assert.equal((out[14] << 8) | out[15], 300, 'JFIF тримає лише цілі dpi');
    assert.deepEqual(P.readJpegSize(out), { w: 1024, h: 768 });
});

test('prepareForPlace розрізняє формат за байтами й дає розширення файлу', () => {
    const jpg = P.prepareForPlace(geminiLike(), 300);
    assert.equal(jpg.ext, 'jpg');
    assert.deepEqual(jpg.size, { w: 2928, h: 352 });

    const png = P.prepareForPlace(P.encodePng(new Uint8Array(4 * 3 * 3), 4, 3, 3), 300);
    assert.equal(png.ext, 'png');
    assert.deepEqual(png.size, { w: 4, h: 3 });

    assert.throws(() => P.prepareForPlace(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 300));
});

test('прев’ю і «Уточнити» підписують JPEG як JPEG', () => {
    const b64 = Buffer.from(geminiLike()).toString('base64');
    assert.ok(b64.startsWith('/9j/'));
    assert.equal(P.mimeOfB64(b64), 'image/jpeg');
    const png = Buffer.from(P.encodePng(new Uint8Array(3), 1, 1, 3)).toString('base64');
    assert.equal(P.mimeOfB64(png), 'image/png');
});

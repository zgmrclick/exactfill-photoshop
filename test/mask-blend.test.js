const assert = require('node:assert/strict');
const test = require('node:test');

const { insetBlendRadius } = require('../geometry.js');

// capture.js робить require('photoshop') на верхньому рівні, тому потрібні заглушки
require('./stubs/dom.js').install();
const capture = require('../capture.js');

test('ширина переходу ділиться між contract і feather', () => {
    const bounds = { left: 100, top: 100, right: 1124, bottom: 1124 };
    assert.equal(insetBlendRadius(bounds, 16), 8);
    assert.equal(insetBlendRadius(bounds, 256), 128);
});

test('мале виділення зберігає повністю непрозоре ядро', () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 40 };
    assert.equal(insetBlendRadius(bounds, 256), 9);
});

test('нульове або некоректне значення не змінює selection', () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
    assert.equal(insetBlendRadius(bounds, 0), 0);
    assert.equal(insetBlendRadius(bounds, 'не число'), 0);
});


/* ── Інваріант «маска лише з PNG-входом» ───────────────────────────────────── */

const CTX = { left: 0, top: 0, w: 512, h: 512 };
const TARGET = { left: 128, top: 128, right: 384, bottom: 384 };

test('маска не їде разом із JPEG-входом', () => {
    /* ⚠️ OpenAI: «the source image and the mask must share the same format and
       dimensions». Розбіжність сервер НЕ відхиляє — він мовчки ігнорує маску, і
       модель перемальовує весь кадр. Симптом у користувача: «модель не бачить
       виділення», причому запит виглядає успішним і гроші списано.

       Раніше цей інваріант жив рядками всередині onGenerate, а гейтом був
       регекс по тексту main.js. Тепер це функція, і перевіряється поведінка. */
    const out = capture.maskForRequest({
        ctx: CTX, target: TARGET, feather: 16,
        input: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }),
    });
    assert.equal(out.blob, null, 'маски бути не повинно');
    assert.match(out.reason, /PNG/, 'причина мусить бути named, інакше в логах порожньо');
});

test('маска будується для PNG-входу і має розмір контексту', () => {
    const out = capture.maskForRequest({
        ctx: CTX, target: TARGET, feather: 16,
        input: new Blob([new Uint8Array(10)], { type: 'image/png' }),
    });
    assert.ok(out.blob, `маска мусить бути, а причина: ${out.reason}`);
    assert.equal(out.reason, '', 'успішний шлях не пояснює себе');
    assert.ok(out.bytes > 0 && out.bytes < 4 * 1024 * 1024, `розмір ${out.bytes} B поза лімітом OpenAI`);
});

test('відсутній вхід і зламана геометрія не кидають виняток, а пояснюють', () => {
    // ignorePixels: входу немає взагалі
    const noInput = capture.maskForRequest({ ctx: CTX, target: TARGET, input: null });
    assert.equal(noInput.blob, null);
    assert.match(noInput.reason, /\S/);

    // ціль поза контекстом — buildRectMaskPng кине, і це не має валити запуск
    const broken = capture.maskForRequest({
        ctx: CTX, target: { left: 900, top: 900, right: 800, bottom: 800 },
        input: new Blob([new Uint8Array(10)], { type: 'image/png' }),
    });
    assert.equal(broken.blob, null);
    assert.match(broken.reason, /\S/, 'причину мусимо побачити в логу, а не втратити');
});


/* ── Маска запиту за формою виділення, а не за його рамкою ─────────────────── */

const { buildShapeMaskPng, buildRectMaskPng } = require('../png.js');

/** Коло радіуса r у кадрі w×h: 255 = «змінити тут». */
function circle(w, h, r) {
    const sel = new Uint8Array(w * h);
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy < r * r) sel[y * w + x] = 255;
        }
    }
    return sel;
}

test('маска за формою менша за прямокутну — саме в цьому вся суть', () => {
    /* ⚠️ Це не про байти, а про площу дозволу. До 2026-09-09 в API летів
       bounding box: усе, що ділило його з ціллю, модель мала право стерти —
       у хості так зникла голова людини, що потрапила в кут рамки. Коло
       вписане в той самий квадрат займає π/4 ≈ 79% його площі; решта 21%
       мусить лишитись моделі як КОНТЕКСТ. */
    const w = 200, h = 200, r = 100;
    const shaped = buildShapeMaskPng(w, h, circle(w, h, r), 0);
    const rect = buildRectMaskPng(w, h, { left: 0, top: 0, right: w, bottom: h }, 0);
    assert.ok(shaped.length > rect.length,
        'суцільний прямокутник стискається краще за коло — якщо ні, форма не застосувалась');
});

test('порожня форма не проходить: маска без прозорих пікселів поверне вхід без змін', () => {
    assert.throws(() => buildShapeMaskPng(8, 8, new Uint8Array(64), 0));
    assert.throws(() => buildShapeMaskPng(8, 8, new Uint8Array(10), 0), /.*/,
        'невідповідний розмір буфера теж мусить падати, а не мовчки різати');
});

test('край не має права з’їсти серцевину форми', () => {
    // край 400 px на колі радіуса 40 — зажим мусить лишити повністю прозоре ядро
    const w = 120, h = 120;
    const png = buildShapeMaskPng(w, h, circle(w, h, 40), 400);
    assert.ok(png.length > 0);
    const same = buildShapeMaskPng(w, h, circle(w, h, 40), 64);
    assert.deepEqual(Array.from(png), Array.from(same),
        'вище зажиму збільшення краю не має нічого змінювати');
});

test('maskForRequest бере форму, коли вона є, і каже про це джерелом', () => {
    const png = { input: new Blob([new Uint8Array(10)], { type: 'image/png' }) };
    const withShape = capture.maskForRequest({
        ctx: CTX, target: TARGET, feather: 0, shape: circle(CTX.w, CTX.h, 100), ...png,
    });
    assert.equal(withShape.source, 'selection');
    assert.ok(withShape.blob, 'маска мусить побудуватись');

    const withoutShape = capture.maskForRequest({ ctx: CTX, target: TARGET, feather: 0, ...png });
    assert.equal(withoutShape.source, 'rectangle', 'без форми лишається стара поведінка');
});

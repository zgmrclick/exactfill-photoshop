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

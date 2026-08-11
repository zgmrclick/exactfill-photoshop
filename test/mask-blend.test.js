const assert = require('node:assert/strict');
const test = require('node:test');

const { insetBlendRadius } = require('../geometry.js');

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

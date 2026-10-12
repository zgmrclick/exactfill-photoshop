/* ============================================================================
 *  test/model-retired-boot.test.js — СТАРТ ПАНЕЛІ ПІСЛЯ ВИМКНЕННЯ МОДЕЛІ.
 *
 *  Окремий файл, бо потрібен інший годинник і інший localStorage ще ДО
 *  require('../main.js'): node --test запускає кожен файл в окремому процесі.
 *
 *  Сценарій: користувач працював на gpt-image-1-mini, оновив плагін, а відкрив
 *  панель уже після 2026-12-01. Мусить статися три речі, і кожну тест бачить
 *  у DOM, а не у функції, яку кликав би сам (див. «тест зелений на тому, чого
 *  в бою немає»): вибір перейшов на Flare, вимкнених пунктів у пікері немає,
 *  у статусі сказано, що сталося.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const stub = require('./stubs/dom.js');

const DEC_2 = Date.parse('2026-12-02T09:00:00Z');
Date.now = () => DEC_2;

const env = stub.install({ storage: { ai_provider: 'openai', ai_model: 'gpt-image-1-mini' } });
const { doc, store } = env;

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };

require('../main.js');

const booted = (async () => {
    doc.fire('DOMContentLoaded');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));
})();

test('збережена вимкнена модель переходить на свою заміну, а не на list[0]', async () => {
    await booted;
    assert.deepEqual(errors, []);
    assert.equal(store.get('ai_model'), 'gpt-image-2.5-flare',
        'mini — найдешевша лінійка; Sunburst (list[0]) мовчки підняв би рахунок');
});

test('вимкнених моделей у пікері немає', async () => {
    await booted;
    const items = doc.getElementById('model-select').querySelectorAll('sp-menu-item')
        .map(c => c.getAttribute('value'));
    assert.deepEqual(items, ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']);
});

test('панель каже, що модель замінено', async () => {
    await booted;
    const status = doc.getElementById('status-text').textContent;
    assert.match(status, /gpt-image-1-mini/);
    assert.match(status, /GPT Image 2\.5 Flare/);
});

test('підказка про вимкнення не лишається на моделі, якої вона не стосується', async () => {
    await booted;
    // Листопад: mini ще жива й має підказку з датою. Перемикач провайдера
    // перечитує перелік — так, як це робить панель.
    Date.now = () => Date.parse('2026-11-01T09:00:00Z');
    doc.getElementById('provider-select').fire('change', { target: { value: 'openai' } });
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
    const model = doc.getElementById('model-select');
    model.value = 'gpt-image-1-mini';
    model.fire('change', { target: { value: 'gpt-image-1-mini' } });
    assert.match(model.getAttribute('title') || '', /2026-12-01/, 'у mini мусить бути дата вимкнення');

    model.value = 'gpt-image-2';
    model.fire('change', { target: { value: 'gpt-image-2' } });
    assert.equal(model.getAttribute('title'), null, 'у gpt-image-2 підказки немає — стара мусить зникнути');
});

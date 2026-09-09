/* ============================================================================
 *  test/settings.test.js — panel-settings.js і єдине джерело ключів сховища.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const stub = require('./stubs/dom.js');
const env = stub.install();
const { doc, store } = env;

const settings = require('../panel-settings.js');
const { LS, LEGACY } = require('../storage-keys.js');
const ROOT = path.join(__dirname, '..');

test('ключі сховища оголошені рівно в одному файлі', () => {
    /* ⚠️ ЧОМУ ЦЕ ВАЖЛИВО: 'ai_provider' був написаний літералом у пʼяти файлах.
       Перейменування в одному місці НЕ ламало панель — вона просто читала інший
       ключ, — зате мовчки псувало діагностику у звіті про ваду («Provider:
       unknown»). Такі розбіжності в цьому плагіні вже коштували двох
       розслідувань, тому гейт стоїть саме на літералі. */
    const offenders = [];
    for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))) {
        if (file === 'storage-keys.js') continue;
        // коментарі не рахуємо: назвати ключ у поясненні — не те саме, що
        // оголосити його вдруге, а прибирати згадку з тексту було б безглуздо
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const m of src.matchAll(/'(ai_[a-z_0-9]+|googleAiPresets|nanobanana_[a-z_]+|exactfill_locale)'/g)) {
            offenders.push(`${file}: ${m[1]}`);
        }
    }
    assert.deepEqual(offenders, [],
        'ключ сховища оголошується лише в storage-keys.js, решта бере його звідти');
});

test('жоден ключ не оголошено двічі під різними іменами', () => {
    const values = [...Object.values(LS), ...Object.values(LEGACY)];
    assert.equal(new Set(values).size, values.length, `дублікат серед: ${values}`);
});

test('рівень якості зводиться під модель і НІКОЛИ не підвищується', () => {
    /* Матриця «збережене побажання × модель». Підвищення тут — не косметика:
       це чужі гроші, бо xhigh/max коштують дорожче за high. */
    const cases = [
        ['gpt-image-2.5-sunburst', 'max',    'max'],
        ['gpt-image-2.5-flare',    'xhigh',  'xhigh'],
        ['gpt-image-2',            'max',    'high'],
        ['gpt-image-2',            'xhigh',  'high'],
        ['gpt-image-1',            'max',    'high'],
        ['gpt-image-1-mini',       'xhigh',  'high'],
        ['gpt-image-1.5',          'medium', 'medium'],
        ['gpt-image-2.5-sunburst', 'low',    'low'],
        ['неіснуюча-модель',       'max',    'high'],
    ];
    store.set(LS.provider, 'openai');
    for (const [model, saved, want] of cases) {
        store.set(LS.model, model);
        store.set(LS.quality, saved);
        assert.equal(settings.currentQuality(), want, `${model} + ${saved}`);
        assert.ok(settings.allowedQualities().includes(settings.currentQuality()),
            `${model}: зведений рівень мусить бути серед дозволених`);
    }
    // побажання лишається недоторканим — щоб max повернувся сам
    assert.equal(store.get(LS.quality), 'max', 'зведення не має перезаписувати вибір користувача');
});

test('невідомий провайдер відкочується на першого, а не валить панель', () => {
    store.set(LS.provider, 'провайдер-якого-нема');
    assert.ok(settings.currentProvider().id, 'мусить бути якийсь провайдер');
    assert.doesNotThrow(() => settings.currentCaps());
    store.set(LS.provider, 'openai');
});

test('числові налаштування зажимаються в задокументовані межі', () => {
    const pad = doc.getElementById('context-pad');
    const feather = doc.getElementById('edge-feather');
    for (const [value, wantPad] of [['-40', 0], ['999', 50], ['15', 15], ['не число', 15], ['', 15]]) {
        pad.value = value;
        assert.equal(settings.readSettings().padPercent, wantPad, `context-pad="${value}"`);
    }
    for (const [value, wantFeather] of [['-1', 0], ['9999', 256], ['32', 32], ['', 16]]) {
        feather.value = value;
        assert.equal(settings.readSettings().feather, wantFeather, `edge-feather="${value}"`);
    }
});

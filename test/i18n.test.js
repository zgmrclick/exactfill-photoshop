const assert = require('node:assert/strict');
const test = require('node:test');

const i18n = require('../i18n.js');

test('English and Ukrainian dictionaries contain exactly the same keys', () => {
    assert.deepEqual(Object.keys(i18n.STRINGS.uk).sort(), Object.keys(i18n.STRINGS.en).sort());
});

test('every translation is non-empty and resolves placeholders', () => {
    for (const locale of ['en', 'uk']) {
        i18n.setLocale(locale);
        for (const [key, value] of Object.entries(i18n.STRINGS[locale])) {
            assert.ok(String(value).trim(), `${locale}:${key} is empty`);
            const rendered = i18n.t(key, {
                provider: 'Provider', error: 'Error', amount: '$1', count: 1,
                width: 10, height: 20, what: 'edit', input: '', context: '', refs: '',
                dx: 0, dy: 0, dw: 0, dh: 0, number: 1, seconds: 60,
                host: 'api.example.com', refusal: '', reason: 'reason', detail: '', text: 'text',
                code: 28,
            });
            assert.doesNotMatch(rendered, /\{\w+\}/, `${locale}:${key} has an unresolved placeholder`);
        }
    }
});

test('unknown keys remain visible for diagnostics', () => {
    assert.equal(i18n.t('missing.translation.key'), 'missing.translation.key');
});

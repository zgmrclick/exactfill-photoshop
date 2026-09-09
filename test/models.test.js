/* ============================================================================
 *  Реєстр моделей і рівні якості.
 *
 *  Ці тести існують через конкретний клас багів: знання про модель раніше жило
 *  рядковими винятками (`if (model !== 'gpt-image-2')`) і глобальними списками,
 *  тож нова модель ламала чотири файли по-різному й ЧАСТКОВО — тобто мовчки.
 *  Тут перевіряємо, що кожна модель декларує все, що від неї читають інші.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');

const openai = require('../providers/openai.js');
const google = require('../providers/google.js');
const geometry = require('../geometry.js');
const usage = require('../usage.js');

const EXTENDED = ['xhigh', 'max'];

test('кожна модель декларує повний набір можливостей', async () => {
    for (const provider of [openai, google]) {
        const list = await provider.models(null);
        assert.ok(list.length, `${provider.id}: перелік моделей порожній`);
        for (const m of list) {
            const caps = provider.capsFor(m.id);
            assert.ok(caps, `${m.id}: немає caps`);
            assert.ok(Array.isArray(caps.qualities) && caps.qualities.length,
                `${m.id}: без caps.qualities панель не знає, які кнопки малювати`);
            // геометрія читає рівно одну з трьох форм — інакше planRequest
            // мовчки поверне сам лише { quality } і розмір ніхто не задасть
            assert.ok(caps.arbitrary || caps.sizes || caps.aspects,
                `${m.id}: caps не описують жодного способу задати розмір`);
        }
    }
});

test('xhigh і max декларує лише gpt-image-2.5', async () => {
    for (const m of await openai.models(null)) {
        const has = EXTENDED.some(q => openai.capsFor(m.id).qualities.includes(q));
        assert.equal(has, m.id.startsWith('gpt-image-2.5-'),
            `${m.id}: розширені рівні є лише в 2.5 — решті це HTTP 400`);
    }
    for (const m of await google.models(null)) {
        for (const q of EXTENDED) {
            assert.ok(!google.capsFor(m.id).qualities.includes(q),
                `${m.id}: Gemini рівнів якості не приймає взагалі`);
        }
    }
});

test('невідома модель не отримує розширених можливостей', () => {
    const caps = openai.capsFor('gpt-image-9-does-not-exist');
    for (const q of EXTENDED) {
        assert.ok(!caps.qualities.includes(q), 'невідомій моделі — найобережніші припущення');
    }
    assert.equal(caps.inputFidelity, false);
});

test('input_fidelity просимо лише в моделей, які його знають', async () => {
    for (const m of await openai.models(null)) {
        const expected = !/^gpt-image-2/.test(m.id);   // 2 і 2.5 його не приймають
        assert.equal(openai.capsFor(m.id).inputFidelity, expected, m.id);
    }
});

test('зведення рівня якості ніколи не підвищує витрати', () => {
    const classic = ['low', 'medium', 'high', 'auto'];
    const extended = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

    // головний випадок: користувач обрав max на 2.5 і перемкнувся на стару модель
    assert.equal(geometry.coerceQuality('max', classic), 'high');
    assert.equal(geometry.coerceQuality('xhigh', classic), 'high');
    // доступне лишається як є, у ОБИДВА боки
    for (const q of extended) assert.equal(geometry.coerceQuality(q, extended), q);
    for (const q of classic) assert.equal(geometry.coerceQuality(q, classic), q);
    // повернення на 2.5 не «застрягає» на high — побажання зберігається окремо
    assert.equal(geometry.coerceQuality('max', extended), 'max');
    // сміття з localStorage не має підіймати рівень до найдорожчого
    assert.equal(geometry.coerceQuality('ultra', extended), 'auto');
    assert.equal(geometry.coerceQuality('', classic), 'auto');
});

test('розширені рівні не просять більше пікселів, ніж дозволяє модель', () => {
    const caps = openai.capsFor('gpt-image-2.5-sunburst');
    const target = { left: 0, top: 0, right: 1200, bottom: 900, w: 1200, h: 900 };
    const px = q => {
        const [w, h] = geometry.planRequest(caps, target, q).size.split('x').map(Number);
        return w * h;
    };
    for (const q of ['high', 'xhigh', 'max']) {
        assert.ok(px(q) <= caps.maxPx, `${q}: понад maxPx моделі`);
    }
    // xhigh/max купують зусилля рендера, а не площу — площа та сама, що в high
    assert.equal(px('xhigh'), px('high'));
    assert.equal(px('max'), px('high'));
    assert.ok(px('low') < px('high'), 'повзунок якості мусить лишатись не декоративним');
});

test('кожна модель у переліку має ціну — інакше витрати рахувались би як невідомі', async () => {
    for (const [provider, mod] of [['openai', openai], ['google', google]]) {
        for (const m of await mod.models(null)) {
            const est = usage.estimateCost(
                { provider, model: m.id, quality: 'medium',
                  plan: { size: '1024x1024', imageSize: '1K' }, imageCount: 1 },
                { input_tokens: 100, output_tokens: 1000 });
            assert.notEqual(est.method, 'unknown-model',
                `${m.id}: додано в перелік, але не в таблицю цін usage.js`);
            assert.ok(Number.isFinite(est.usd) && est.usd > 0, `${m.id}: ціна не порахувалась`);
        }
    }
});

/* ── Каталог /v1/models нічого не вирішує ─────────────────────────────────── */

/* ⚠️ ДВІ ПОМИЛКИ ЗА ОДИН ДЕНЬ, 2026-09-09 — обидві з однієї посилки.
   Спершу тут стояла ФІЛЬТРАЦІЯ за /v1/models: чого немає в каталозі, те
   зникало з пікера. Потім, помʼякшивши, — ПОЗНАЧКА `listed`, і панель
   попереджала «немає в каталозі вашого ключа».

   Обидві прибрані, бо посилка хибна, і це ВИМІРЯНО, а не додумано. Проба
   (verify/check-models.sh, крок 2) спитала сам ендпоінт генерації:
     gpt-image-2                  → ДОСТУПНА   (контроль)
     zzz-model-that-cannot-exist  → НЕМА       (контроль)
     gpt-image-2.5-sunburst       → ДОСТУПНА
     gpt-image-2.5-flare          → ДОСТУПНА
   Контролі відповіли по-різному, тож проба розрізняє. Висновок: моделі
   працюють, а /v1/models їх просто не перелічує. Фільтр сховав би дві робочі
   моделі; позначка попереджала б про неіснуючу проблему.

   Правило, що лишається: /v1/models відповідає на питання «що OpenAI
   перелічує», а не «що цьому ключу дозволено». Про доступ питати ЛИШЕ той
   ендпоінт, яким користуєшся. Тому models() тут не ходить у мережу зовсім. */

test('перелік моделей однаковий із ключем і без нього', async () => {
    const withKey = await openai.models('sk-whatever');
    const without = await openai.models(null);
    assert.deepEqual(withKey.map(m => m.id), without.map(m => m.id));
    assert.ok(withKey.length >= 6, `очікував увесь перелік, маю ${withKey.length}`);
    assert.ok(withKey.some(m => m.id === 'gpt-image-2.5-sunburst'));
    assert.ok(withKey.some(m => m.id === 'gpt-image-2.5-flare'));
    for (const m of withKey) assert.ok(m.caps && m.caps.qualities, `${m.id} без caps`);
});

test('models() не ходить у мережу — гейт проти повернення перевірки каталогу', () => {
    /* Статичний навмисно: поведінкова перевірка «не було запиту» вимагала б
       підміняти http.js, а зламатися це може саме тим, що хтось знову впише
       звернення до каталогу. Ловимо сам рядок. */
    const fs = require('node:fs');
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'providers', 'openai.js'), 'utf8');
    const body = src.slice(src.indexOf('async function models('), src.indexOf('function explainModelError'));
    assert.doesNotMatch(body, /fetchJson|\$\{BASE\}models|await /,
        'models() мусить лишатись без мережі: каталог не є джерелом правди про доступ');
});

/* ── Що бачить користувач, коли моделі для його ключа таки немає ──────────── */

test('404 model_not_found пояснюється словами, а не лишається «HTTP 404»', () => {
    /* ⚠️ Це ДРУГА половина рішення «не ховати, а пояснювати». Прибрати модель
       із пікера легко, але тоді причина зникає разом із нею. Лишаємо пункт —
       і зобовʼязані зробити відмову зрозумілою: користувач мусить дізнатись,
       що модель існує, ID правильний, а бракує саме доступу для цього ключа. */
    const raw = Object.assign(new Error(
        'The model `gpt-image-2.5-sunburst` does not exist or you do not have access to it.'),
        { name: 'HttpError', status: 404, code: 'model_not_found' });
    const out = openai.explainModelError(raw, 'gpt-image-2.5-sunburst');
    assert.notEqual(out, raw, 'помилку треба замінити на пояснення');
    assert.match(out.message, /gpt-image-2\.5-sunburst/, 'у тексті мусить бути сама модель');
    assert.equal(out.status, 404);

    // те саме, коли code не приїхав — форма відповіді OpenAI не гарантована
    const noCode = Object.assign(new Error(
        'The model `gpt-image-2.5-flare` does not exist or you do not have access to it.'),
        { name: 'HttpError', status: 404 });
    assert.notEqual(openai.explainModelError(noCode, 'gpt-image-2.5-flare'), noCode);
});

test('чужі помилки explainModelError не чіпає', () => {
    for (const e of [
        Object.assign(new Error('Rate limit reached'), { status: 429, code: 'rate_limit_exceeded' }),
        Object.assign(new Error('Invalid value: size'), { status: 400, code: 'invalid_value' }),
        Object.assign(new Error('Incorrect API key'), { status: 401, code: 'invalid_api_key' }),
        Object.assign(new Error('Not Found'), { status: 404, code: 'unknown_url' }),
    ]) {
        assert.equal(openai.explainModelError(e, 'gpt-image-2'), e, `${e.status}/${e.code} не мала змінитись`);
    }
});

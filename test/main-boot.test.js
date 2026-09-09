/* ============================================================================
 *  test/main-boot.test.js — ІНІЦІАЛІЗАЦІЯ ПАНЕЛІ, ЗАПУЩЕНА НАСПРАВДІ.
 *
 *  ⚠️ Досі main.js (1271 рядок) жоден тест не завантажував — його читали як
 *  текст. Помилку в шляху запуску міг показати лише Photoshop, відкритий
 *  руками. Цей файл проходить увесь initUI на заглушках і дивиться, що
 *  опинилось у DOM.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');
const stub = require('./stubs/dom.js');

const env = stub.install();
const { doc, store } = env;

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };

require('../main.js');

// DOMContentLoaded запускає initUI; він асинхронний, тому даємо циклу подій дійти
const booted = (async () => {
    doc.fire('DOMContentLoaded');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));
})();

test('ініціалізація проходить без жодного винятку, навіть коли ключа API ще нема', async () => {
    await booted;
    // initUI ловить кожен блок окремо і пише в console.error — тобто мовчазний
    // console.error тут і є «ініціалізація пройшла»
    assert.deepEqual(errors, [], 'жоден блок initUI не має падати на чистому старті');
});

test('перелік провайдерів і моделей справді доїжджає до DOM', async () => {
    await booted;
    const provider = doc.getElementById('provider-select');
    assert.ok(provider, 'picker провайдерів мусить існувати після підміни');
    assert.ok(provider.querySelectorAll('sp-menu-item').length > 0,
        'picker провайдерів не має лишатись порожнім');

    const model = doc.getElementById('model-select');
    const ids = model.querySelectorAll('sp-menu-item').map(c => c.getAttribute('value'));
    // ⚠️ Саме заради цього два await у refreshModels розділені: без ключа API
    // перелік мусить приїхати з вбудованого, а не лишити picker порожнім.
    assert.ok(ids.includes('gpt-image-2.5-sunburst'),
        `нова модель мусить бути в переліку, а там: ${ids.join(', ')}`);
    assert.ok(ids.includes(store.get('ai_model')), 'збережена модель мусить бути серед пунктів');
});

test('рівні якості йдуть за можливостями моделі, а не за назвою', async () => {
    await booted;
    const seg = doc.getElementById('quality-toggle');
    const levels = () => seg.querySelectorAll('.seg-btn').map(b => b.dataset.value);

    // gpt-image-2.5 вибрана першою: у неї є розширені рівні
    assert.deepEqual(levels(), ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
        'у 2.5 мусять бути xhigh і max');
    assert.ok(seg.classList.contains('seg-wrap'),
        'шість кнопок в один ряд у 230-піксельній панелі не влазять — має бути два ряди');

    // ⚠️ ГОЛОВНЕ: перемикання на стару модель мусить ПРИБРАТИ рівні, яких вона
    // не знає. Інакше запит із quality=max пішов би в gpt-image-1 і повернув 400.
    const model = doc.getElementById('model-select');
    seg.querySelectorAll('.seg-btn').find(b => b.dataset.value === 'max').fire('click');
    assert.equal(store.get('ai_quality'), 'max');

    model.value = 'gpt-image-1';
    model.fire('change', { target: { value: 'gpt-image-1' } });
    assert.deepEqual(levels(), ['low', 'medium', 'high', 'auto'],
        'у gpt-image-1 розширених рівнів немає — кнопки мусять зникнути');
    const active = seg.querySelectorAll('.seg-btn').filter(b => b.classList.contains('active'));
    assert.equal(active.length, 1, 'рівно один рівень активний');
    assert.equal(active[0].dataset.value, 'high',
        'збережений max мусить опуститись до high — і НІКОЛИ не піднятись угору, бо це чужі гроші');
});

test('вбудований пресет з\'являється на першому ж старті', async () => {
    await booted;
    const list = doc.getElementById('preset-list');
    assert.ok(list, 'секція пресетів мусить існувати');
    assert.ok(list.children.length > 0,
        'без presetManager.load() тут було порожньо — саме цей баг тест і стереже');
});

test('лічильник символів промпта зʼявляється лише коли текст справді довгий', async () => {
    await booted;
    const input = doc.getElementById('prompt-input');
    const counter = doc.getElementById('prompt-count');
    assert.ok(input && counter);
    const limit = Number(input.getAttribute('maxlength'));
    assert.ok(limit >= 1000, 'поле мусить оголошувати великий maxlength — інакше UXP глушить його на ~256');

    input.value = 'коротко';
    input.fire('input');
    assert.ok(counter.classList.contains('hidden'), 'на короткому тексті лічильник не потрібен');

    input.value = 'я'.repeat(Math.round(limit * 0.95));
    input.fire('input');
    assert.ok(!counter.classList.contains('hidden'), 'на довгому тексті лічильник мусить показатись');
    assert.ok(counter.classList.contains('near'), 'близько до межі — інший колір');
    assert.match(counter.textContent, new RegExp(`/ ${limit}$`));
});

test('зміна ключа перезапитує перелік моделей', async () => {
    await booted;
    /* ⚠️ Доступність моделей залежить від ключа (openai.models питає
       /v1/models). Без цієї проводки щойно введений ключ починав фільтрувати
       пікер лише після перевідкриття панелі: користувач бачив моделі, яких у
       нього нема, і діставав 404 замість пояснення. Гейт статичний, бо подію
       кидає auth.js, а слухає main.js — саме стик між ними й губився. */
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    assert.match(fs.readFileSync(path.join(root, 'auth.js'), 'utf8'),
        /dispatchEvent\(new Event\('exactfill:keychange'\)\)/,
        'auth.js мусить повідомляти про новий ключ');
    assert.match(fs.readFileSync(path.join(root, 'main.js'), 'utf8'),
        /addEventListener\('exactfill:keychange'[\s\S]{0,400}refreshModels\(\)/,
        'main.js мусить на цю подію перезапитати моделі');
    /* ⚠️ Для OpenAI перелік від ключа НЕ залежить (див. models.test.js — каталог
       не є джерелом правди про доступ). Проводка лишається заради Google, де
       ListModels справді віддає те, що дозволено саме цьому ключу. */
});

/* ── Картка плану: обіцянка мусить збігатись із запитом ────────────────────── */

/** Дає циклу подій добігти: обробники `change` не чекають refreshPlanLine. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 2)); };

/** Виділення 1011×423 на канві 1920×1280 — та сама область, що й у живому прогоні. */
function withSelection(pad, extra = {}) {
    env.photoshop.app.activeDocument = {
        width: 1920, height: 1280,
        selection: { bounds: { left: 169, top: 36, right: 1180, bottom: 459 }, solid: true },
        ...extra,
    };
    const el = doc.getElementById('context-pad');
    el.value = String(pad);
    el.fire('change');
    return settle();
}

const planLine = () => doc.getElementById('plan-line').textContent;

test('картка плану називає ТОЙ САМИЙ формат входу, який справді полетить', async () => {
    await booted;
    /* ⚠️ ЦЕ БУВ ЖИВИЙ БАГ, зловлений у Photoshop 2026-09-09. Рішення про формат
       жило двічі: capturePayload змушував PNG заради маски, а картка дивилась
       лише на галку «вхід без втрат». Користувач читав «вхід JPEG · 58 КБ», а
       летіло 1227 КБ PNG — двадцятикратна різниця саме там, де вона дорога. */
    doc.getElementById('lossless-input').checked = false;

    await withSelection(0);
    assert.match(planLine(), /вхід JPEG/, 'без контексту маски нема — JPEG');
    assert.doesNotMatch(planLine(), /з маскою/);

    await withSelection(15);
    assert.match(planLine(), /вхід PNG/,
        'контекст > 0 вмикає маску, а маска зобов\'язує PNG — картка мусить це сказати');
    assert.match(planLine(), /з маскою/,
        'маска змінює поведінку моделі з «редагуй» на «перемалюй» — це не дрібниця для картки');
});

test('картка плану не обіцяє вхідного зображення, коли пікселі ігноруються', async () => {
    await booted;
    doc.getElementById('lossless-input').checked = false;
    doc.getElementById('ignore-pixels').checked = true;
    await withSelection(15);
    assert.match(planLine(), /без вхідного зображення/);
    assert.doesNotMatch(planLine(), /з маскою/, 'без пікселів маску нема до чого чіпляти');
    doc.getElementById('ignore-pixels').checked = false;
});

test('«Перегенерувати» бере відступ контексту поточний, а не збережений', () => {
    /* ⚠️ Гейт статичний: гілка reuse спрацьовує лише після справжнього запиту,
       якого стенд не робить. Але сама помилка текстова — resolveRegion приймав
       padPercent і в цій гілці його не читав, повертаючи lastRun.ctx. Зміна
       повзунка перед «Перегенерувати» мовчки не діяла: той самий кадр і та сама
       ціна без жодного натяку в інтерфейсі. */
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const branch = src.slice(src.indexOf('async function resolveRegion'),
                             src.indexOf('/** Захоплення пікселів'));
    assert.match(branch, /return \{ target: lastRun\.target, ctx: expandForContext\(lastRun\.target, doc, padPercent\) \}/,
        'reuse мусить перерахувати контекст із поточного padPercent');
    assert.doesNotMatch(branch, /ctx: lastRun\.ctx/,
        'збережений ctx у гілці reuse — це і є той самий баг');
});

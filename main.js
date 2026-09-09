/* ============================================================================
 *  main.js — єдиний потік: виділення → промпт → провайдер → Smart Object.
 *
 *  Тут НЕМА геометрії (geometry.js), НЕМА роботи з пікселями (capture.js),
 *  НЕМА вставки (place.js) і НЕМА знання про провайдерів (providers/).
 *  Старий main.js мав 2797 рядків, з яких на цей сценарій працювало ~850.
 *
 *  Варіацій тут свідомо немає. Вони вставляли N шарів один поверх одного з
 *  однаковою маскою: заплатив за чотири, а порівнювати доводилось кліканням
 *  видимості в палітрі шарів. Замість них — «Перегенерувати» (та сама область,
 *  без нового виділення) і кеш результатів (повторна вставка безкоштовна).
 * ========================================================================== */

const { app, core, action } = require('photoshop');
const { batchPlay } = require('photoshop').action;
const uxpStorage = require('uxp').storage;

const providers = require('./providers/index.js');
const geometry   = require('./geometry.js');
const place      = require('./place.js');
const capture    = require('./capture.js');
const cache      = require('./cache.js');
const presetManager  = require('./presets.js');
const historyManager = require('./history.js');
const usageTracker   = require('./usage.js');
const ledger         = require('./ledger.js');
const dom            = require('./ui-dom.js');
const mainI18n       = require('./i18n.js');

/* Ключі сховища й читання налаштувань живуть окремо: перший — щоб не було
   пʼяти копій рядка 'ai_provider' по файлах, друге — щоб зведення якості до
   можливостей моделі можна було перевірити в node, а не лише в Photoshop. */
const { LEGACY } = require('./storage-keys.js');
const {
    LS, num, checked,
    currentProvider, currentCaps, allowedQualities, currentQuality, readSettings,
} = require('./panel-settings.js');

const $ = id => document.getElementById(id);
const TRANSPORTS = ['auto', 'direct', 'curl'];
const httpTransport = require('./providers/http.js').transport;

let busy = false;
let abortCtrl = null;
let references = [];        // [{ name, blob }]
let lastRun = null;         // { prompt, provider, model, ctx, target, ... }
let modelRefreshSeq = 0;    // захист від перегонів при швидкій зміні провайдера

/* ── Виділення ─────────────────────────────────────────────────────────────── */

/**
 * Межі виділення БЕЗ imaging.getSelection.
 * Причина: getSelection/getData() валить Photoshop у CMYK-документі, а нам
 * потрібні лише чотири числа. doc.selection.bounds їх і дає (PS 25.0+);
 * для старіших — той самий descriptor через batchPlay.
 */
async function readSelectionBounds(doc) {
    try {
        const sel = doc.selection;
        if (sel && sel.bounds) {
            return { bounds: sel.bounds, solid: sel.solid !== false };
        }
    } catch (e) { /* падаємо на batchPlay */ }

    const r = await batchPlay([{
        _obj: 'get',
        _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
    }], {});
    const s = r && r[0] && r[0].selection;
    if (!s) return null;
    const v = x => (x && typeof x === 'object' && '_value' in x) ? x._value : x;
    if (v(s.left) === undefined) return null;
    return {
        bounds: { left: v(s.left), top: v(s.top), right: v(s.right), bottom: v(s.bottom) },
        solid: true,   // через batchPlay форму не визначити — вважаємо прямокутником
    };
}

/** Розширює цільову область контекстом і зажимає канвою. */
function expandForContext(target, doc, padPercent) {
    if (!padPercent) return { ...target };
    /* ⚠️ Відсоток рахуємо ПО КОЖНІЙ ОСІ ОКРЕМО. Раніше тут був один відступ від
       довшої сторони — і на смузі 1011×423 «15%» означало +30% ширини, але
       +72% висоти, ще й асиметрично після зажиму об канву (виміряно 2026-09-09:
       ctx 1315×611 замість очікуваних 1315×549). Користувач бачив у картці
       вдвічі більший кадр, ніж просив, і платив за нього. */
    const padX = Math.round(target.w * (padPercent / 100));
    const padY = Math.round(target.h * (padPercent / 100));
    const left   = Math.max(0, target.left - padX);
    const top    = Math.max(0, target.top - padY);
    const right  = Math.min(doc.width, target.right + padX);
    const bottom = Math.min(doc.height, target.bottom + padY);
    return { left, top, right, bottom, w: right - left, h: bottom - top };
}

/* ── UI ────────────────────────────────────────────────────────────────────── */

function setStatus(text) {
    const el = $('status-text');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('has-content', Boolean(text));
    }
}

function setBusy(on) {
    busy = on;
    const btn = $('generate-btn');
    if (btn) {
        btn.disabled = on;                 // захист від подвійного кліку — у старому його не було
        btn.setAttribute('aria-busy', on ? 'true' : 'false');
    }
    const regen = $('regen-btn');
    if (regen) regen.disabled = on || !lastRun;
    const refine = $('refine-btn');
    // Уточнення потребує не лише минулого запуску, а й провайдера, який уміє
    // розмову: у Gemini такого маршруту немає, і кнопка мусить це показувати.
    if (refine) {
        refine.disabled = on || !canRefine();
        /* Хід розмови видно лише тут. Різниця між першим ходом (їдуть пікселі)
           і продовженням (їде id) — це різна ціна й різна поведінка моделі,
           тому вона мусить бути написана, а не вгадуватись. */
        const turn = !canRefine() ? ''
            : lastRun.responseId
                ? mainI18n.t('plan.refineTurn', { number: (lastRun.turn || 1) + 1 })
                : mainI18n.t('plan.refineFirst');
        refine.setAttribute('title', turn
            ? `${mainI18n.t('action.refineTitle')} — ${mainI18n.t('plan.refine', { turn })}`
            : mainI18n.t('action.refineTitle'));
    }
    const cancel = $('cancel-btn');
    if (cancel) cancel.classList.toggle('hidden', !on);
    const sp = $('spinner');
    if (sp) sp.classList.toggle('hidden', !on);
}

function showPreview(b64) {
    const wrap = $('preview-wrap'), img = $('preview-img');
    if (!wrap || !img) return;
    if (!b64) { wrap.classList.add('hidden'); img.removeAttribute('src'); return; }
    img.src = 'data:image/png;base64,' + b64;
    wrap.classList.remove('hidden');
}

/**
 * Бейдж-лічильник біля заголовка секції.
 * ⚠️ НЕ через CSS `.badge:empty` — UXP цей псевдоклас не підтримує, і порожній
 * бейдж малювався як синій кружечок біля кожної секції.
 */
function setBadge(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
}

/**
 * Лічильник символів промпта.
 *
 * ⚠️ НАВІЩО ВІН ВЗАГАЛІ: поле UXP без явного `maxlength` мовчки припиняє
 * приймати введення приблизно на 256 символах — ні помилки, ні обрізаного
 * хвоста. Ліміт у розмітці цю стелю знімає, а лічильник робить нову межу
 * видимою, щоб історія «текст просто перестав вводитись» не повторилась із
 * іншим числом. Порогом 60 % тримаємо панель чистою у звичайній роботі.
 */
function updateCharCount(inputId, counterId, showFrom = 0.6) {
    const el = $(inputId), out = $(counterId);
    if (!el || !out) return;
    const limit = Number(el.getAttribute('maxlength')) || 0;
    const used = String(el.value || '').length;
    if (!limit || used < limit * showFrom) {
        out.classList.add('hidden');
        return;
    }
    out.textContent = `${used} / ${limit}`;
    out.classList.remove('hidden');
    out.classList.toggle('near', used >= limit * 0.9 && used < limit);
    out.classList.toggle('full', used >= limit);
}

/**
 * Гарантує, що керування числом видно.
 *
 * ⚠️ ЧОМУ ЦЕ ПОТРІБНО: UXP не малює компоненти, яких немає в його переліку, і
 * робить це МОЛЧА — `sp-number-field` залишав у панелі самі підписи без полів.
 * `sp-slider` задокументований, але страхуємось так само, як із потоковим
 * fetch: якщо після рендеру висота нульова, підміняємо сегментним перемикачем
 * зі звичайних <button>, які в цій панелі демонстративно працюють (якість).
 *
 * Підміна зберігає той самий id і властивість .value, тому решта коду читає
 * значення однаково і про підміну не знає.
 */
function ensureNumericControl(id, lsKey, values, unit) {
    const el = $(id);
    if (!el) return;
    if (el.offsetHeight > 0) return;          // намалювався — нічого не робимо

    console.log(`[ui] ${id}: sp-slider не намалювався — ставлю сегментний перемикач`);
    const saved = Number(localStorage.getItem(lsKey));
    const initial = values.includes(saved) ? saved : values[Math.floor(values.length / 2)];

    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.className = 'field-title';
    label.textContent = el.querySelector('sp-label')?.textContent || id;
    const seg = document.createElement('div');
    seg.className = 'seg numeric-seg';
    seg.setAttribute('role', 'group');

    const holder = document.createElement('div');
    holder.id = id;                            // той самий id
    holder.value = String(initial);
    holder.style.display = 'none';

    for (const v of values) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn numeric-seg-btn' + (v === initial ? ' active' : '');
        btn.textContent = v + unit;
        btn.dataset.value = String(v);
        btn.setAttribute('aria-pressed', v === initial ? 'true' : 'false');
        btn.addEventListener('click', () => {
            holder.value = String(v);
            localStorage.setItem(lsKey, String(v));
            seg.querySelectorAll('.seg-btn').forEach(b => {
                const active = b.dataset.value === String(v);
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            refreshPlanLine();
        });
        seg.appendChild(btn);
    }

    field.append(label, seg, holder);
    el.replaceWith(field);
}

/**
 * sp-picker у Photoshop не перебудовує закритий trigger після асинхронної
 * заміни options. Тому збираємо весь control поза DOM і підміняємо його вже
 * готовим — разом із value, що збігається з одним із пунктів.
 */
function fillPicker(id, items, selectedValue) {
    const old = $(id);
    if (!old) return null;

    const picker = document.createElement('sp-picker');
    picker.id = id;
    for (const attr of ['size', 'class', 'title']) {
        const value = old.getAttribute(attr);
        if (value !== null) picker.setAttribute(attr, value);
    }
    if (old.disabled) picker.disabled = true;
    picker.setAttribute('value', selectedValue);
    const selected = items.find(it => it.value === selectedValue);
    if (selected) {
        // UXP іноді лишає trigger порожнім навіть за правильного value.
        // label/placeholder дають той самий видимий текст як безпечний fallback.
        picker.setAttribute('label', selected.label);
        picker.setAttribute('placeholder', selected.label);
        // «Sunburst» і «Flare» самі по собі нічого не пояснюють, а місця під
        // окремий підпис у 230-піксельній панелі немає — тому підказка живе в
        // title пікера. Пункти sp-menu-item власного title в UXP не мають.
        if (selected.title) picker.setAttribute('title', selected.title);
    }

    const menu = document.createElement('sp-menu');
    menu.setAttribute('slot', 'options');
    for (const it of items) {
        const item = document.createElement('sp-menu-item');
        item.setAttribute('value', it.value);
        item.textContent = it.label;
        if (it.value === selectedValue) {
            item.setAttribute('selected', '');
            item.selected = true;
        }
        menu.appendChild(item);
    }
    picker.appendChild(menu);
    old.replaceWith(picker);
    picker.value = selectedValue;
    return picker;
}

function bindModelPicker(picker, items) {
    if (!picker) return;
    picker.addEventListener('change', e => {
        localStorage.setItem(LS.model, e.target.value);
        // Набір рівнів якості належить МОДЕЛІ: у gpt-image-2.5 є xhigh і max,
        // у решти їх немає. Без цього рядка в панелі лишились би кнопки, які
        // нова модель відхилить чи стара не зрозуміє.
        initQuality();
        const picked = (items || []).find(it => it.value === e.target.value);
        if (picked && picked.title) picker.setAttribute('title', picked.title);
        refreshPlanLine();
    });
}

/**
 * Заповнює перелік моделей.
 *
 * ⚠️ Два await РОЗДІЛЕНІ свідомо. Раніше `getKey` і `p.models` стояли в одному
 * try — і коли getKey кидав (secureStorage.getItem на відсутньому ключі саме
 * кидає), ми не доходили до p.models, тобто вбудований резервний список навіть
 * не питали. Picker лишався БЕЗ ЖОДНОГО пункту, а причина — лише в консолі.
 */
async function refreshModels() {
    const p = currentProvider();
    const refreshSeq = ++modelRefreshSeq;

    let apiKey = null;
    try { apiKey = await window.aiAuth.getKey(p.keyName); }
    catch (e) { console.log('[ui] ключ ще не введено — беру перелік без нього'); }

    let list = [];
    try { list = (await p.models(apiKey)) || []; }
    catch (e) { console.warn('[ui] перелік моделей не отримано:', e.message); }

    // Остання лінія: у провайдерів є вбудований список, який не потребує мережі.
    if (!list.length) {
        try { list = (await p.models(null)) || []; }
        catch (e) { console.warn('[ui] і вбудований перелік не вдався:', e.message); }
    }
    if (!list.length) {
        setStatus(mainI18n.t('status.noModels', { provider: p.label }));
        return;
    }
    // без цього рядка неможливо відрізнити «мережа не дала переліку» від
    // «перелік прийшов, але pickerʼа не перемалювало»
    console.log(`[ui] моделі: ${p.id} → ${list.length} (${list.slice(0, 3).map(m => m.id).join(', ')})`);

    // Поки мережевий перелік завантажувався, користувач міг уже вибрати іншого
    // провайдера. Старий результат не має права перезаписати новий picker.
    if (refreshSeq !== modelRefreshSeq || currentProvider().id !== p.id) return;

    const saved = localStorage.getItem(LS.model);
    const pick = list.some(m => m.id === saved) ? saved : list[0].id;
    localStorage.setItem(LS.model, pick);
    const items = list.map(m => ({
        value: m.id,
        label: m.label,
        title: m.hintKey ? mainI18n.t(m.hintKey) : '',
    }));
    const picker = fillPicker('model-select', items, pick);
    bindModelPicker(picker, items);
    // Модель щойно могла змінитись (інший провайдер, інший перелік) — рівні
    // якості треба перемалювати під неї, поки користувач нічого не натиснув.
    initQuality();
}

/** Гасить елементи, яких провайдер не підтримує, замість тихого ігнорування. */
function applyProviderCapabilities() {
    const p = currentProvider();
    const dim = (id, ok, why) => {
        const el = $(id);
        if (!el) return;
        el.disabled = !ok;
        el.parentElement?.classList.toggle('unsupported', !ok);
        if (!ok) el.title = why;
    };
    dim('transparent-bg', p.supportsTransparent !== false,
        mainI18n.t('cap.noTransparent', { provider: p.label }));
    dim('live-preview', p.supportsStream !== false,
        mainI18n.t('cap.noPreview', { provider: p.label }));
    dim('add-ref-btn', p.supportsReferences !== false,
        mainI18n.t('cap.noReferences', { provider: p.label }));
}

/**
 * Перемальовує перемикач якості під МОДЕЛЬ, а не під сталий список.
 * Викликати після кожної зміни моделі — інакше в панелі лишаться кнопки, яких
 * поточна модель не приймає.
 */
function initQuality() {
    const group = $('quality-toggle');
    if (!group) return;
    const list = allowedQualities();
    const saved = currentQuality();
    group.setAttribute('aria-label', mainI18n.t('field.quality'));
    group.innerHTML = '';

    /* ⚠️ ГЕОМЕТРІЯ, А НЕ СМАК: у gpt-image-2.5 рівнів шість. В одному рядку
       панелі 230 px кожна кнопка отримала б ~31 px і перетворилась на «…».
       Тому від п'яти рівнів перемикач іде у два ряди по три.

       Ряди й межі розставляє JS, а не CSS: :nth-child і :nth-last-child у цій
       панелі не перевірені, а UXP уже одного разу мовчки проігнорував
       псевдоклас (:empty малював порожні бейджі як кружечки). Індекс кнопки ми
       знаємо точно — тож рахуємо тут. */
    const perRow = 3;
    const wrap = list.length > 4;
    group.classList.toggle('seg-wrap', wrap);

    list.forEach((q, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn' + (q === saved ? ' active' : '');
        if (wrap) {
            if ((i + 1) % perRow === 0) btn.classList.add('seg-row-end');
            if (i < list.length - (list.length % perRow || perRow)) btn.classList.add('seg-row-top');
        }
        btn.textContent = mainI18n.t(`quality.${q}`);
        btn.dataset.value = q;
        btn.setAttribute('aria-pressed', q === saved ? 'true' : 'false');
        btn.addEventListener('click', () => {
            localStorage.setItem(LS.quality, q);
            group.querySelectorAll('.seg-btn').forEach(b => {
                const active = b.dataset.value === q;
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            refreshPlanLine();
        });
        group.appendChild(btn);
    });
}

/**
 * Вибір мережевого маршруту.
 *
 * ⚠️ ЩО ЦЕ ВЗАГАЛІ ЛІКУЄ: дозвіл `network.domains` у manifest не має влади над
 * системним фаєрволом — запит іде з процесу Photoshop, і правило «блокувати
 * Photoshop» його ріже. Дочірній `curl` — окремий бінарник, тому під те правило
 * не потрапляє. «Авто» не платить за це нічим, поки прямий шлях працює: воно
 * перемикається лише після реальної мережевої відмови.
 */
function initTransport() {
    const group = $('transport-toggle');
    if (!group) return;
    const saved = TRANSPORTS.includes(localStorage.getItem(LS.transport))
        ? localStorage.getItem(LS.transport) : 'auto';
    httpTransport.setMode(saved);
    group.setAttribute('aria-label', mainI18n.t('field.transport'));
    group.innerHTML = '';
    for (const value of TRANSPORTS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn' + (value === saved ? ' active' : '');
        btn.textContent = mainI18n.t(`transport.${value}`);
        btn.dataset.value = value;
        btn.setAttribute('aria-pressed', value === saved ? 'true' : 'false');
        btn.addEventListener('click', () => {
            localStorage.setItem(LS.transport, value);
            httpTransport.setMode(value);
            // ручний вибір скидає пам'ять про відмову: інакше 'auto' лишалося б
            // назавжди в curl після однієї випадкової помилки мережі
            httpTransport.resetDirectFailure();
            group.querySelectorAll('.seg-btn').forEach(b => {
                const active = b.dataset.value === value;
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            refreshTransportBadge();
            if (value !== 'direct') setStatus(mainI18n.t('transport.firstApproval'));
        });
        group.appendChild(btn);
    }
    refreshTransportBadge();
}

/** Бейдж показує не вибір користувача, а фактичний маршрут просто зараз. */
function refreshTransportBadge() {
    setBadge('net-badge', httpTransport.active() ? mainI18n.t('transport.curl') : '');
}

/* ── Рядок «що саме буде запрошено» ────────────────────────────────────────── */

/**
 * Показує розмір запиту ДО натискання кнопки. Це і є відповідь на «побільше для
 * якості, поменше для економії»: рівень якості видно в мегапікселях, а не на
 * віру. Читання виділення тут поза executeAsModal — це лише `get`, документ не
 * змінюється.
 */
let planTimer = null;
function schedulePlanLine() {
    if (planTimer) clearTimeout(planTimer);
    planTimer = setTimeout(refreshPlanLine, 250);
}

function setPlanCard(titleKey, body, ready) {
    const card = $('plan-card');
    const title = $('plan-title');
    const line = $('plan-line');
    if (!card || !title || !line) return;
    title.textContent = mainI18n.t(titleKey);
    line.textContent = body || '';
    card.classList.toggle('dim', !ready);
}

/**
 * Рядок ціни для картки плану. Порожній, коли спостережень нема — вигадана
 * цифра тут гірша за її відсутність: за нею ухвалюють рішення натискати.
 */
function forecastNote({ provider, model, quality, plan }) {
    try {
        const f = usageTracker.forecastCost({
            provider: provider.id, model, quality, plan, history: ledger.load(),
        });
        if (f.usd === null) return '';
        const usd = usageTracker.formatUsd(f.usd);
        return f.low === f.high
            ? ` · ${mainI18n.t('plan.cost', { usd })}`
            : ` · ${mainI18n.t('plan.costRange', {
                usd,
                low: usageTracker.formatUsd(f.low),
                high: usageTracker.formatUsd(f.high),
            })}`;
    } catch (e) {
        console.warn('[ui] прогноз ціни не порахувався:', e.message);
        return '';
    }
}

async function refreshPlanLine() {
    const el = $('plan-line');
    if (!el) return;
    try {
        const doc = app.activeDocument;
        if (!doc) { setPlanCard('plan.notReadyTitle', mainI18n.t('plan.noDocument'), false); return; }

        const sel = await readSelectionBounds(doc).catch(() => null);
        if (!sel || !sel.bounds) {
            setPlanCard('plan.selectTitle', mainI18n.t('plan.selectArea'), false);
            return;
        }
        const target = geometry.integerTarget(sel.bounds);
        if (target.w < 1 || target.h < 1) {
            setPlanCard('plan.selectTitle', mainI18n.t('plan.emptySelection'), false);
            return;
        }
        const s = readSettings();
        const ctx = expandForContext(target, doc, s.padPercent);
        const provider = currentProvider();
        const model = localStorage.getItem(LS.model);
        const plan = geometry.planRequest(provider.capsFor(model), ctx, s.quality);

        let what;
        if (plan.size) {
            const [w, h] = String(plan.size).split('x').map(Number);
            what = `${w}×${h} · ${(w * h / 1e6).toFixed(2)} ${mainI18n.t('unit.megapixels')}`;
            // Найдорожчий і найменш передбачуваний режим має називатись до
            // натискання кнопки, а не з'ясовуватись за рахунком.
            const caps = provider.capsFor(model);
            if (caps.stablePx && w * h > caps.stablePx) {
                what += ` · ${mainI18n.t('plan.experimental')}`;
            }
        } else if (plan.aspectRatio) {
            what = `${plan.aspectRatio} · ${plan.imageSize}`;
        } else {
            what = mainI18n.t('plan.defaultSize');
        }
        const io = inputPlan(s, provider, ctx);
        const inputNote = !io.sendsPixels
            ? ` · ${mainI18n.t('plan.inputNone')}`
            : ` · ${mainI18n.t(io.viaDuplicate ? 'plan.inputPngLarge'
                             : io.lossless ? 'plan.inputPng' : 'plan.inputJpeg')}`
              /* Форма важить: за нею модель отримує сусідні пікселі як контекст,
                 а не як дозвіл малювати. Обіцяємо її лише там, де справді
                 зможемо прочитати — у CMYK getSelection не викликаємо взагалі. */
              + (io.wantMask ? ` · ${mainI18n.t(
                    !sel.solid && capture.isSafeMode(String(doc.mode))
                        ? 'plan.withShapeMask' : 'plan.withMask')}` : '')
              // Жорсткий край при масці — це видимий рубець на стику. Дефолт 16 px
              // ставився не з естетики: див. коментар до buildRectMaskPng.
              + (io.wantMask && !s.feather ? ` · ${mainI18n.t('plan.hardEdge')}` : '');
        setPlanCard('plan.readyTitle', mainI18n.t('plan.request', {
            what,
            cost: forecastNote({ provider, model, quality: s.quality, plan }),
            input: inputNote,
            width: target.w,
            height: target.h,
            context: s.padPercent ? mainI18n.t('plan.context', { width: ctx.w, height: ctx.h }) : '',
            refs: references.length ? mainI18n.t('plan.refs', { count: references.length }) : '',
        }), true);
    } catch (e) {
        setPlanCard('plan.notReadyTitle', '', false);
        console.warn('[ui] план не порахувався:', e.message);
    }
}

/* ── Постійний журнал витрат ───────────────────────────────────────────────── */

function recordUsage(meta, usage) {
    ledger.record(meta, usage);
    renderUsage();
}

function amountWithUnknown(summary) {
    const amount = `≈${usageTracker.formatUsd(summary.usd)}`;
    return summary.unknownCost
        ? mainI18n.t('usage.unknown', { amount, count: summary.unknownCost }) : amount;
}

/** Один рядок зведення: сьогодні / 7 днів / усього. */
function usageCard(label, data) {
    const card = dom.el('div', 'usage-card');
    card.append(
        dom.el('span', 'usage-card-label', label),
        dom.el('strong', '', amountWithUnknown(data)),
        dom.el('span', 'usage-card-meta',
            `${data.requests} ${mainI18n.t('usage.requestsShort')} · ` +
            `${usageTracker.formatTokens(data.inputTokens)} ${mainI18n.t('usage.inputShort')} / ` +
            `${usageTracker.formatTokens(data.outputTokens)} ${mainI18n.t('usage.outputShort')}`),
    );
    return card;
}

/** Один запит у переліку останніх. */
function usageRow(entry) {
    const when = new Date(entry.at);
    const date = when.toLocaleDateString(mainI18n.dateLocale(), { day: '2-digit', month: '2-digit' });
    const time = when.toLocaleTimeString(mainI18n.dateLocale(), { hour: '2-digit', minute: '2-digit' });
    const shape = [entry.quality, entry.size, entry.aspectRatio].filter(Boolean).join(' · ');

    const info = dom.el('div', 'usage-info');
    info.append(
        dom.el('div', 'usage-main', `${entry.providerLabel || entry.provider} · ${entry.model}`),
        dom.el('div', 'usage-meta',
            `${date} ${time}${shape ? ` · ${shape}` : ''} · ` +
            `${usageTracker.formatTokens(entry.inputTokens)} ${mainI18n.t('usage.inputShort')} / ` +
            `${usageTracker.formatTokens(entry.outputTokens)} ${mainI18n.t('usage.outputShort')}`),
    );
    const row = dom.el('div', 'usage-row');
    row.append(info, dom.el('div', 'usage-amount',
        Number.isFinite(entry.costUsd) ? `≈${usageTracker.formatUsd(entry.costUsd)}` : '—'));
    return row;
}

/** Компактний рядок під кнопкою — єдине, що видно без розгортання секції. */
function usageCompactLine(stats) {
    const lastAmount = Number.isFinite(stats.last.costUsd)
        ? `≈${usageTracker.formatUsd(stats.last.costUsd)}` : mainI18n.t('usage.costUnknown');
    return `${mainI18n.t('usage.last')}: ${lastAmount} · ` +
        `${mainI18n.t('usage.today').toLowerCase()}: ${amountWithUnknown(stats.today)} ` +
        `(${stats.today.requests}) · ${mainI18n.t('usage.sevenDays')}: ${amountWithUnknown(stats.sevenDays)} ` +
        `(${stats.sevenDays.requests})`;
}

function renderUsage() {
    const compact = $('cost-line');
    const summaryEl = $('usage-summary');
    const listEl = $('usage-list');
    const stats = ledger.summarize();

    if (!stats.last) {
        if (compact) { compact.textContent = ''; compact.classList.add('hidden'); }
        if (summaryEl) summaryEl.textContent = mainI18n.t('usage.empty');
        dom.clear(listEl);
        setBadge('usage-badge', '');
        return;
    }

    if (compact) {
        compact.textContent = usageCompactLine(stats);
        compact.classList.remove('hidden');
    }
    setBadge('usage-badge', `${usageTracker.formatUsd(stats.today.usd)} · ${stats.today.requests}`);

    dom.fill(summaryEl, [
        [mainI18n.t('usage.today'), stats.today],
        [mainI18n.t('usage.sevenDays'), stats.sevenDays],
        [mainI18n.t('usage.all'), stats.all],
    ].map(([label, data]) => usageCard(label, data)));

    dom.fill(listEl, stats.recent.map(usageRow));
}

/* ── Референси ─────────────────────────────────────────────────────────────── */

function renderRefs() {
    dom.fill($('ref-list'), references.map((r, i) => {
        const chip = dom.el('span', 'chip', r.name);
        chip.appendChild(dom.iconButton({
            title: mainI18n.t('common.delete'),
            className: 'chip-x',
            onClick: () => { references.splice(i, 1); renderRefs(); refreshPlanLine(); },
        }));
        return chip;
    }));
    setBadge('ref-count', references.length ? String(references.length) : '');
}

async function pickReferences() {
    try {
        const files = await uxpStorage.localFileSystem.getFileForOpening({
            allowMultiple: true,
            types: ['png', 'jpg', 'jpeg', 'webp'],
        });
        const arr = Array.isArray(files) ? files : (files ? [files] : []);
        for (const f of arr) {
            const buf = await f.read({ format: uxpStorage.formats.binary });
            const lower = String(f.name).toLowerCase();
            const type = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
                       : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
            references.push({ name: f.name, blob: new Blob([buf], { type }) });
        }
        renderRefs();
        refreshPlanLine();
    } catch (e) {
        if (e && /cancel/i.test(String(e.message))) return;
        console.error('[ui] референси не додались:', e.message);
        setStatus(mainI18n.t('refs.addError', { error: e.message }));
    }
}

/* ── Пресети, історія, кеш ─────────────────────────────────────────────────── */

function renderPresets() {
    dom.fill($('preset-list'), presetManager.getAll().map(p => {
        const cb = dom.el('sp-checkbox', '', p.name);
        if (p.active) cb.setAttribute('checked', '');
        cb.addEventListener('change', e => presetManager.toggleActive(p.id, e.target.checked));
        const row = dom.el('div', 'preset-row');
        row.append(cb, dom.iconButton({
            title: mainI18n.t('common.delete'),
            onClick: () => { presetManager.delete(p.id); renderPresets(); },
        }));
        return row;
    }));
    const active = presetManager.getAll().filter(p => p.active).length;
    setBadge('preset-count', active ? String(active) : '');
}

function renderHistory() {
    dom.fill($('history-list'), historyManager.getAll().map(h => {
        const txt = dom.el('span', 'history-prompt',
            (h.prompt || '').slice(0, 90) || mainI18n.t('common.noPrompt'));
        txt.title = mainI18n.t('history.restore');
        txt.addEventListener('click', () => {
            const input = $('prompt-input');
            if (input) {
                input.value = h.prompt || '';
                localStorage.setItem(LS.prompt, input.value);
                // ⚠️ Без цього рядка лічильник лишався від попереднього тексту:
                // відновлений із історії промпт міг бути будь-якої довжини, а
                // подія input при програмній зміні value не спрацьовує.
                updateCharCount('prompt-input', 'prompt-count');
            }
            if (h.ctx) { lastRun = { ...h, references: [] }; setBusy(false); }
            refreshPlanLine();
        });
        const row = dom.el('div', 'history-row');
        row.append(txt, dom.iconButton({
            title: mainI18n.t('common.delete'),
            onClick: () => { historyManager.delete(h.id); renderHistory(); },
        }));
        return row;
    }));
}

function renderCache() {
    const entries = cache.list();
    dom.fill($('cache-list'), entries.map(entry => {
        const meta = entry.meta || {};
        const when = new Date(entry.at).toLocaleTimeString();
        const txt = dom.el('span', 'cache-info',
            `${when} · ${(entry.size / 1024).toFixed(0)} KB · ` +
            `${(meta.prompt || '').slice(0, 40) || mainI18n.t('common.noPrompt')}`);

        const insert = dom.el('button', 'mini-btn', mainI18n.t('cache.insert'));
        insert.type = 'button';
        insert.title = mainI18n.t('cache.insertTitle');
        insert.addEventListener('click', () => reinsert(entry.id));

        const row = dom.el('div', 'cache-row');
        row.append(txt, insert, dom.iconButton({
            title: mainI18n.t('common.delete'),
            onClick: async () => { await cache.remove(entry.id); renderCache(); },
        }));
        return row;
    }));
    setBadge('cache-badge', entries.length ? `${entries.length} · ${cache.human()}` : '');
}

function buildPrompt() {
    let text = ($('prompt-input')?.value || '').trim();
    for (const p of presetManager.getAll()) {
        if (p.active && p.content) text += ' ' + p.content;
    }
    return text.trim();
}

/* ── Вставка ───────────────────────────────────────────────────────────────── */

/**
 * Один шлях вставки для НОВОЇ генерації і для повтору з кешу — щоб маска,
 * канал і залишок рахувались однаково і не розходились між двома копіями коду.
 */
async function insertImage(b64, ctx, target, feather) {
    await core.executeAsModal(async () => {
        const channelName = 'AiSel_' + Date.now();
        let haveChannel = false;
        try {
            // Під час довгої генерації користувач може змінити виділення. Не
            // застосовуємо чужу маску до старої області: канал зберігаємо лише
            // коли поточні bounds усе ще збігаються з цільовими.
            const current = await readSelectionBounds(app.activeDocument).catch(() => null);
            const currentTarget = current && current.bounds ? geometry.integerTarget(current.bounds) : null;
            const sameTarget = currentTarget && ['left', 'top', 'right', 'bottom']
                .every(k => currentTarget[k] === target[k]);
            if (!sameTarget) throw new Error('активне виділення змінилося — використовую цільовий прямокутник');
            // Офіційний DOM Selection API (PS 25+). Попередній batchPlay
            // помилково кодував selection як enum і тому не створював канал.
            await app.activeDocument.selection.save(channelName);
            haveChannel = true;
        } catch (e) {
            // Немає активного виділення (типовий випадок повтору з кешу) —
            // place.js побудує маску з прямокутника target.
            console.log('[main] виділення в канал не збережено:', e.message);
        }
        try {
            const report = await place.placeGeneratedSmartObject(
                b64, ctx, haveChannel ? channelName : null,
                { maskFeather: feather, maskBounds: target });
            const r = report.residual || {};
            const el = $('residual-text');
            if (el) {
                const zero = [r.dx, r.dy, r.dw, r.dh].every(v => Math.abs(Number(v) || 0) < 0.01);
                /* ⚠️ Відкат на прямокутну маску був ЛИШЕ в консолі. А це саме той
                   випадок, коли форма виділення переставала різати шар: усе, що
                   ділить з ціллю bounding box, лишалось перемальованим. Мовчати
                   про це не можна — користувач дивиться на результат, а не в лог. */
                const fallback = haveChannel ? '' : ` · ${mainI18n.t('residual.rectMask')}`;
                el.textContent = (zero
                    ? mainI18n.t('residual.exact')
                    : mainI18n.t('residual.value', r)) + fallback;
                el.className = 'residual' + (zero && haveChannel ? ' ok' : ' warn');
            }
            console.log('[main] residual', JSON.stringify(report.residual),
                report.warnings.length ? 'warnings: ' + report.warnings.join('; ') : '');
        } finally {
            if (haveChannel) {
                try {
                    await app.activeDocument.channels.getByName(channelName).remove();
                } catch (e) {}
            }
        }
    }, { commandName: mainI18n.t('command.insert') });
}

async function reinsert(cacheId) {
    if (busy) return;
    const entry = cache.list().find(e => e.id === cacheId);
    if (!entry) { setStatus(mainI18n.t('cache.missing')); renderCache(); return; }
    const doc = app.activeDocument;
    if (!doc) { await core.showAlert(mainI18n.t('alert.openDocument')); return; }

    setBusy(true);
    try {
        setStatus(mainI18n.t('cache.reading'));
        const b64 = await cache.get(cacheId);
        if (!b64) { setStatus(mainI18n.t('cache.fileMissing')); renderCache(); return; }
        const m = entry.meta || {};
        // Якщо є активне виділення — вставляємо в НЬОГО; інакше в збережену область.
        const sel = await readSelectionBounds(doc).catch(() => null);
        let ctx = m.ctx, target = m.target;
        if (sel && sel.bounds) {
            target = geometry.integerTarget(sel.bounds);
            ctx = expandForContext(target, doc, Number(m.padPercent) || 0);
            setStatus(mainI18n.t('cache.insertCurrent'));
        } else if (!ctx) {
            setStatus(mainI18n.t('cache.noCoordinates'));
            return;
        } else {
            setStatus(mainI18n.t('cache.insertSaved'));
        }
        showPreview(b64);
        await insertImage(b64, ctx, target, readSettings().feather);
        setStatus(mainI18n.t('cache.inserted'));
    } catch (e) {
        console.error('[main] повтор із кешу:', e);
        setStatus(mainI18n.t('error.failed', { error: e.message || e }));
    } finally {
        setBusy(false);
    }
}

/* ── Головний потік ────────────────────────────────────────────────────────── */

/**
 * Передумови запуску. Кожна відмова — showAlert і null; тримати їх в onGenerate
 * означало б двадцять рядків guard-ів перед першою корисною дією.
 */
async function collectRunInputs(mode) {
    const doc = app.activeDocument;
    if (!doc) { await core.showAlert(mainI18n.t('alert.openDocument')); return null; }

    const model = localStorage.getItem(LS.model);
    if (!model) { await core.showAlert(mainI18n.t('alert.chooseModel')); return null; }

    /* Лише «Перегенерувати» бере старий промпт. «Уточнити» — навпаки: увесь
       його сенс у НОВОМУ тексті, тому він читає поле, як і звичайний запуск. */
    const prompt = mode === 'again' && lastRun ? lastRun.prompt : buildPrompt();
    if (!prompt) { await core.showAlert(mainI18n.t('alert.writePrompt')); return null; }

    const provider = currentProvider();
    const apiKey = await window.aiAuth.getKey(provider.keyName);
    if (!apiKey) {
        await core.showAlert(mainI18n.t('alert.noKey', { provider: provider.label }));
        return null;
    }
    return { doc, provider, model, prompt, apiKey, s: readSettings() };
}

/**
 * Область: або з живого виділення, або та сама, що минулого разу.
 * null означає «працювати нема з чим», alert уже показано.
 */
async function resolveRegion(reuse, doc, padPercent) {
    if (reuse && lastRun && lastRun.target) {
        setStatus(mainI18n.t('status.sameArea'));
        /* Область та сама, а відступ контексту читаємо ЗАРАЗ. ⚠️ Раніше сюди
           поверталось збережене lastRun.ctx — і зміна повзунка «контекст» перед
           «Перегенерувати» мовчки не діяла: той самий кадр, та сама ціна,
           жодного натяку в інтерфейсі (виміряно 2026-09-09). */
        return { target: lastRun.target, ctx: expandForContext(lastRun.target, doc, padPercent) };
    }
    setStatus(mainI18n.t('status.readSelection'));
    const sel = await core.executeAsModal(() => readSelectionBounds(app.activeDocument),
        { commandName: mainI18n.t('command.readSelection') });
    if (!sel || !sel.bounds) { await core.showAlert(mainI18n.t('alert.selectArea')); return null; }

    const target = geometry.integerTarget(sel.bounds);
    if (target.w < 1 || target.h < 1) {
        await core.showAlert(mainI18n.t('alert.emptySelection'));
        return null;
    }
    if (!sel.solid) {
        // Не проблема: маска шару робиться з каналу справжнього виділення,
        // тому ласо й еліпс обрізаються правильно. Запит іде по bounding box.
        console.log('[main] виділення не прямокутне — запит по bounding box, ' +
                    'маска шару по фактичній формі');
    }
    return { target, ctx: expandForContext(target, doc, padPercent) };
}

/**
 * Що поїде в тілі запиту: чи буде маска і в якому форматі вхід.
 *
 * ⚠️ ОДНЕ МІСЦЕ НА ДВОХ СПОЖИВАЧІВ НАВМИСНО. Доки це рішення жило двічі — у
 * картці плану й у capturePayload — вони розійшлись: картка дивилась лише на
 * галку «вхід без втрат» і обіцяла «вхід JPEG», тоді як маска мовчки змушувала
 * PNG. Виміряно на живому хості 2026-09-09: картка казала 58 КБ JPEG, полетіло
 * 1227 КБ PNG. Формула формату — та сама, що в capture.captureRegion:
 * lossless = wantLossless || requirePng.
 */
function inputPlan(s, provider, ctx) {
    const wantMask = provider.supportsMask && s.padPercent > 0 && !s.ignorePixels;
    const lossless = s.lossless || wantMask;
    return {
        wantMask,
        lossless,
        sendsPixels: !s.ignorePixels,
        viaDuplicate: lossless && ctx.w * ctx.h > capture.LOSSLESS_MAX_PX,
    };
}

/** Захоплення пікселів плюс маска запиту — те, що піде в тіло запиту. */
async function capturePayload({ s, provider, ctx, target }) {
    /* Рішення про маску ухвалюємо ДО захоплення: OpenAI вимагає, щоб вхід і
       маска були одного формату, тому наявність маски визначає формат входу. */
    const { wantMask } = inputPlan(s, provider, ctx);

    let cap = { blob: null, lossless: false };
    if (!s.ignorePixels) {
        setStatus(mainI18n.t('status.capturing'));
        cap = await core.executeAsModal(
            () => capture.captureRegion(ctx, s.layerOnly, s.lossless, wantMask),
            { commandName: mainI18n.t('command.capture') });
        console.log(`[main] захоплено: ${cap.docMode} ${cap.bpc}біт` +
                    `${cap.viaDuplicate ? ' (через дублікат)' : ''}` +
                    `${cap.lossless ? ' PNG' : ' JPEG'}`);
    }

    /* Форму виділення читаємо ОКРЕМИМ модальним блоком, уже знаючи режим
       документа: у CMYK getSelection валить Photoshop, і туди ми не йдемо. */
    let shape = null;
    if (wantMask) {
        const got = await core.executeAsModal(() => capture.selectionShape(ctx, target, cap.docMode),
            { commandName: mainI18n.t('command.readSelection') });
        shape = got.data;
        if (got.reason) console.warn('[main] форма виділення недоступна, маска прямокутна:', got.reason);
    }

    const mask = wantMask
        ? capture.maskForRequest({ ctx, target, feather: s.feather, input: cap.blob, shape })
        : { blob: null, bytes: 0, reason: '' };
    if (mask.reason) console.warn('[main] маски не буде:', mask.reason);
    else if (mask.blob) console.log(`[main] маска ${ctx.w}×${ctx.h} (${mask.source}), ` +
                                    `край ${s.feather} px: ${(mask.bytes / 1024).toFixed(1)} КБ`);

    return { input: cap.blob, mask: mask.blob };
}

/** Пам'ять про запуск: кеш, історія і кнопки повтору. */
async function rememberRun(meta, image, s) {
    const cacheId = await cache.save(image, meta);
    renderCache();
    // cacheId у lastRun — щоб перший хід «Уточнити» мав звідки взяти пікселі,
    // не тримаючи мегабайти base64 у пам'яті панелі між запусками.
    lastRun = { ...meta, cacheId };
    historyManager.add({ ...meta, cacheId, settings: s });
    renderHistory();
}

/**
 * Чи є що уточнювати. Три умови, і кожна вміє відмовити окремо: був запуск,
 * від нього лишились пікселі або id розмови, і провайдер узагалі вміє маршрут.
 */
function canRefine() {
    if (!lastRun || !lastRun.ctx) return false;
    if (currentProvider().supportsRefine !== true) return false;
    return Boolean(lastRun.responseId || lastRun.cacheId);
}

/**
 * Уточнення: запит до провайдера плюс те, що треба знати вставці.
 *
 * ⚠️ ГЕОМЕТРІЯ БЕРЕТЬСЯ З ТОГО ЗАПУСКУ, ЯКИЙ УТОЧНЮЄМО, а не з поточних
 * налаштувань. Уточнюється вже намальована плитка; якби ми, як «Перегенерувати»,
 * перечитали повзунок контексту, картинка лягла б у кадр, якого не зображує.
 */
async function runRefine({ provider, model, prompt, apiKey, s }) {
    const previousImage = lastRun.responseId ? null : await cache.get(lastRun.cacheId);
    if (!lastRun.responseId && !previousImage) {
        await core.showAlert(mainI18n.t('cache.fileMissing'));
        return null;
    }
    setStatus(mainI18n.t('status.refining'));
    const plan = lastRun.plan || geometry.planRequest(provider.capsFor(model), lastRun.ctx, s.quality);
    console.log('[main] уточнення:', JSON.stringify(plan),
                'ctx', lastRun.ctx.w + '×' + lastRun.ctx.h,
                lastRun.responseId ? 'продовження розмови' : 'перший хід');

    const res = await provider.refine({
        apiKey, model, prompt, plan,
        previousResponseId: lastRun.responseId || null,
        previousImage,
        signal: abortCtrl ? abortCtrl.signal : undefined,
        onPartial: s.livePreview ? (b64, idx) => {
            showPreview(b64);
            setStatus(mainI18n.t('status.partial', { number: (idx ?? 0) + 1 }));
        } : null,
        onProgress: st => setStatus(st),
    });
    return { res, plan, ctx: lastRun.ctx, target: lastRun.target };
}

async function onGenerate(mode) {
    if (busy) return;
    const refining = mode === 'refine';
    if (refining && !canRefine()) {
        await core.showAlert(mainI18n.t('plan.refineNoRun'));
        return;
    }

    const run = await collectRunInputs(mode);
    if (!run) return;
    const { doc, provider, model, prompt, apiKey, s } = run;

    const docId = doc.id;
    abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setBusy(true);
    showPreview(null);
    const residual = $('residual-text');
    if (residual) residual.textContent = '';

    try {
        let res, plan, ctx, target, input = null, refBlobs = [];

        if (refining) {
            const done = await runRefine({ provider, model, prompt, apiKey, s });
            if (!done) return;
            ({ res, plan, ctx, target } = done);
        } else {
            /* 1. Область */
            const region = await resolveRegion(mode === 'again', doc, s.padPercent);
            if (!region) return;
            ({ target, ctx } = region);

            /* 2. Що просити в провайдера */
            plan = geometry.planRequest(provider.capsFor(model), ctx, s.quality);
            console.log('[main] план запиту:', JSON.stringify(plan), 'ctx', ctx.w + '×' + ctx.h);

            /* 3. Пікселі й маска — документ користувача не змінюється */
            const payload = await capturePayload({ s, provider, ctx, target });
            input = payload.input;

            /* 4. Генерація — поза модальним контекстом, щоб Photoshop не блокувався */
            setStatus(mainI18n.t('status.generating'));
            const wantPreview = s.livePreview && provider.supportsStream !== false;
            refBlobs = (provider.supportsReferences !== false)
                ? references.map(r => r.blob) : [];

            res = await provider.generate({
                apiKey, model, prompt,
                imageBlob: input, maskBlob: payload.mask,
                references: refBlobs,
                plan,
                background: s.transparent && provider.supportsTransparent !== false ? 'transparent' : null,
                ignorePixels: s.ignorePixels,
                signal: abortCtrl ? abortCtrl.signal : undefined,
                onPartial: wantPreview ? (b64, idx) => {
                    showPreview(b64);
                    setStatus(mainI18n.t('status.partial', { number: (idx ?? 0) + 1 }));
                } : null,
                onProgress: st => setStatus(st),
            });
        }

        const images = (res && res.images) || [];
        if (!images.length) { await core.showAlert(mainI18n.t('alert.noImages')); return; }
        showPreview(images[0]);

        // Записуємо одразу після успішної відповіді API: гроші вже витрачені,
        // навіть якщо користувач перемкне документ і вставку доведеться скасувати.
        /* ⚠️ route у записі — не прикраса. Прогноз ціни бере медіану ВЛАСНИХ
           запитів користувача; токени розмови й токени images/edits — різні
           величини, і змішані в одну медіану вони зіпсували б обидві оцінки. */
        recordUsage({
            provider: provider.id,
            providerLabel: provider.label,
            model,
            quality: s.quality,
            plan,
            route: refining ? 'responses' : 'edits',
            imageCount: images.length,
            hasImageInput: refining || !!input || refBlobs.length > 0,
        }, res.usage);

        /* 5. Вставка */
        if (!app.activeDocument || app.activeDocument.id !== docId) {
            await core.showAlert(mainI18n.t('alert.documentChanged'));
            return;
        }
        setStatus(mainI18n.t('status.inserting'));
        await insertImage(images[0], ctx, target, s.feather);

        /* 6. Пам'ять про запуск.
           Уточнення НЕ переписує prompt: «Перегенерувати» після нього має
           означати «той самий початковий задум наново», а не повтор репліки
           «зроби тінь м'якшою» по вихідних пікселях. Змінюються лише ланка
           розмови (responseId) і кадр, який тепер уточнюємо (cacheId у rememberRun). */
        await rememberRun({
            prompt: refining ? lastRun.prompt : prompt,
            provider: provider.id, model, ctx, target, plan,
            padPercent: refining ? lastRun.padPercent : s.padPercent,
            quality: s.quality,
            responseId: res.responseId || null,
            turn: refining ? (lastRun.turn || 1) + 1 : 1,
            refinedWith: refining ? prompt : undefined,
        }, images[0], s);
        setStatus(mainI18n.t('status.done'));

    } catch (e) {
        if (e && e.cancelled) {
            setStatus(mainI18n.t('status.cancelled'));
        } else {
            console.error('[main]', e);
            await core.showAlert(mainI18n.t('error.failed', { error: e && e.message ? e.message : e }));
            setStatus(mainI18n.t('status.error'));
        }
    } finally {
        abortCtrl = null;
        setBusy(false);
        // 'auto' могло перемкнутися на curl усередині цього запуску — бейдж має
        // показувати фактичний маршрут, а не той, що був на старті
        try { refreshTransportBadge(); } catch (e) {}
    }
}

/* ── Запуск ────────────────────────────────────────────────────────────────── */

/**
 * Ініціалізація UI. Кожен блок в окремому try: у старому плагіні
 * ReferenceError у initializeModels обривав ініціалізацію, і разом із ним
 * тихо вмирали refine-пікер та вкладка чату.
 */
async function initUI() {
    try {
        const list = providers.list();
        const stored = localStorage.getItem(LS.provider);
        const saved = list.some(p => p.id === stored) ? stored : list[0].id;
        localStorage.setItem(LS.provider, saved);
        fillPicker('provider-select', list.map(p => ({ value: p.id, label: p.label })), saved);
        const picker = $('provider-select');
        if (picker) picker.addEventListener('change', async e => {
            localStorage.setItem(LS.provider, e.target.value);
            localStorage.removeItem(LS.model);
            await window.aiAuth.refreshAuthUI();
            await refreshModels();
            applyProviderCapabilities();
            refreshPlanLine();
        });
    } catch (e) { console.error('[ui] провайдери:', e.message); }

    try { await refreshModels(); } catch (e) { console.error('[ui] моделі:', e.message); }

    try { initQuality(); } catch (e) { console.error('[ui] якість:', e.message); }
    try { initTransport(); } catch (e) { console.error('[ui] маршрут мережі:', e.message); }
    try { applyProviderCapabilities(); } catch (e) { console.error('[ui] можливості:', e.message); }

    try {
        const bind = (id, key, def, prop = 'value') => {
            const el = $(id);
            if (!el) return;
            const saved = localStorage.getItem(key);
            if (saved !== null) el[prop] = prop === 'checked' ? saved === 'true' : saved;
            else if (def !== undefined) el[prop] = def;
            el.addEventListener('change', () => {
                localStorage.setItem(key, String(prop === 'checked' ? el.checked : el.value));
                refreshPlanLine();
            });
        };
        bind('prompt-input', LS.prompt, '');
        bind('context-pad', LS.pad, '15');
        bind('edge-feather', LS.feather, '16');
        // sp-slider віддає значення подією input, а не лише change
        for (const id of ['context-pad', 'edge-feather']) {
            const el = $(id);
            if (el) el.addEventListener('input', () => {
                localStorage.setItem(id === 'context-pad' ? LS.pad : LS.feather, String(el.value));
                schedulePlanLine();
            });
        }
        bind('use-layer-only', LS.layerOnly, false, 'checked');
        bind('lossless-input', LS.lossless, true, 'checked');
        bind('transparent-bg', LS.transparent, false, 'checked');
        bind('ignore-pixels', LS.ignorePixels, false, 'checked');
        bind('live-preview', LS.preview, true, 'checked');
        const prompt = $('prompt-input');
        if (prompt) {
            prompt.addEventListener('input', () => {
                localStorage.setItem(LS.prompt, prompt.value);
                updateCharCount('prompt-input', 'prompt-count');
            });
            // відновлений із localStorage промпт теж може бути довгим
            updateCharCount('prompt-input', 'prompt-count');
        }
    } catch (e) { console.error('[ui] налаштування:', e.message); }

    // Перевірка рендеру — ПІСЛЯ біндингу, бо підміна забирає елемент із DOM.
    try {
        ensureNumericControl('context-pad', LS.pad, [0, 5, 10, 15, 25, 40], '%');
        ensureNumericControl('edge-feather', LS.feather, [0, 8, 16, 32, 64, 128, 256], '');
    } catch (e) { console.error('[ui] контроли чисел:', e.message); }

    // ⚠️ load() ОБОВ'ЯЗКОВИЙ. Без нього presetManager стартує з порожнім масивом,
    // і перший же add() зберігав порожній список плюс новий пункт — тобто тихо
    // знищував усі раніше збережені пресети, а вбудований «Upscale & Enhance»
    // не з'являвся жодного разу. Гейт — тест «кожен менеджер зі станом справді
    // завантажується під час ініціалізації».
    try { await presetManager.load(); renderPresets(); } catch (e) { console.error('[ui] пресети:', e.message); }
    try { await historyManager.load(); renderHistory(); } catch (e) { console.error('[ui] історія:', e.message); }
    try { renderCache(); } catch (e) { console.error('[ui] кеш:', e.message); }
    try { renderRefs(); renderUsage(); } catch (e) { console.error('[ui] статистика:', e.message); }
    try { await refreshPlanLine(); } catch (e) {}
}

/**
 * Слухач подій Photoshop, щоб рядок «що буде запрошено» жив сам.
 * Форма API мінялась (масив рядків → масив об'єктів), тому пробуємо обидві й
 * тихо обходимось без цього, якщо жодна не пройшла: рядок тоді оновлюється на
 * зміну налаштувань і при кліку на панель.
 */
function watchSelection() {
    const events = ['set', 'historyStateChanged', 'select'];
    const cb = () => schedulePlanLine();
    try {
        action.addNotificationListener(events.map(event => ({ event })), cb);
        return;
    } catch (e) { /* друга форма нижче */ }
    try {
        action.addNotificationListener(events, cb);
    } catch (e) {
        console.log('[ui] подій виділення не слухаю:', e.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initUI();
    watchSelection();

    const btn = $('generate-btn');
    if (btn) btn.addEventListener('click', () => onGenerate('new'));

    const regen = $('regen-btn');
    if (regen) regen.addEventListener('click', () => onGenerate('again'));

    const refineBtn = $('refine-btn');
    if (refineBtn) refineBtn.addEventListener('click', () => onGenerate('refine'));

    const cancel = $('cancel-btn');
    if (cancel) cancel.addEventListener('click', () => {
        if (abortCtrl) { abortCtrl.abort(); setStatus(mainI18n.t('status.cancelling')); }
    });

    // Esc — скасувати активний запит.
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && busy && abortCtrl) {
            e.preventDefault();
            abortCtrl.abort();
            setStatus(mainI18n.t('status.cancelling'));
        }
    });

    const addRef = $('add-ref-btn');
    if (addRef) addRef.addEventListener('click', pickReferences);
    const clearRef = $('clear-ref-btn');
    if (clearRef) clearRef.addEventListener('click', () => { references = []; renderRefs(); refreshPlanLine(); });

    const clearCache = $('clear-cache-btn');
    if (clearCache) clearCache.addEventListener('click', async () => {
        await cache.clear(); renderCache(); setStatus(mainI18n.t('status.cacheCleared'));
    });

    const clearUsage = $('clear-usage-btn');
    if (clearUsage) clearUsage.addEventListener('click', () => {
        localStorage.removeItem(LS.usage);
        // Старий безчасовий лічильник більше не читається; очищаємо його разом
        // із новим журналом, якщо він лишився від попередньої версії.
        localStorage.removeItem(LEGACY.sessionUsage);
        renderUsage();
        setStatus(mainI18n.t('status.usageCleared'));
    });

    const addPreset = $('add-preset-btn');
    if (addPreset) addPreset.addEventListener('click', () => {
        const name = $('new-preset-name')?.value?.trim();
        const content = $('new-preset-content')?.value?.trim();
        if (!name || !content) return;
        presetManager.add(name, content);
        $('new-preset-name').value = '';
        $('new-preset-content').value = '';
        renderPresets();
    });

    // Секції, що згортаються. Підтримуємо мишу й клавіатуру та синхронізуємо
    // aria-expanded — у вузькій панелі це ще й надійне джерело стану шеврона.
    for (const [head, body] of [['opts-header', 'opts-body'], ['usage-header', 'usage-body'],
                                ['net-header', 'net-body'],
                                ['ref-header', 'ref-body'], ['cache-header', 'cache-body'],
                                ['preset-header', 'preset-body'], ['history-header', 'history-body'],
                                ['report-header', 'report-body']]) {
        const h = $(head), b = $(body);
        if (!h || !b) continue;
        const sync = () => h.setAttribute('aria-expanded', b.classList.contains('hidden') ? 'false' : 'true');
        const toggle = () => { b.classList.toggle('hidden'); sync(); };
        sync();
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    }
});

/* Ключ змінився — перелік моделей міг змінитись разом із ним. */
document.addEventListener('exactfill:keychange', async () => {
    try { await refreshModels(); } catch (e) { console.error('[ui] моделі після ключа:', e.message); }
    try { applyProviderCapabilities(); refreshPlanLine(); } catch (e) {}
});

document.addEventListener('exactfill:localechange', () => {
    initQuality();
    initTransport();
    applyProviderCapabilities();
    renderPresets();
    renderHistory();
    renderCache();
    renderRefs();
    renderUsage();
    refreshPlanLine();
});

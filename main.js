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

const LS = {
    provider: 'ai_provider', model: 'ai_model', quality: 'ai_quality',
    prompt: 'ai_prompt', layerOnly: 'ai_layer_only', pad: 'ai_context_pad',
    feather: 'ai_edge_feather', lossless: 'ai_lossless', transparent: 'ai_transparent',
    ignorePixels: 'ai_ignore_pixels', preview: 'ai_live_preview',
    usage: 'ai_usage_ledger_v1',
};

const $ = id => document.getElementById(id);
const QUALITIES = ['low', 'medium', 'high', 'auto'];

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
    const pad = Math.round(Math.max(target.w, target.h) * (padPercent / 100));
    const left   = Math.max(0, target.left - pad);
    const top    = Math.max(0, target.top - pad);
    const right  = Math.min(doc.width, target.right + pad);
    const bottom = Math.min(doc.height, target.bottom + pad);
    return { left, top, right, bottom, w: right - left, h: bottom - top };
}

/* ── Читання налаштувань ───────────────────────────────────────────────────── */

const num = (id, def, lo, hi) => {
    const v = parseInt($(id)?.value ?? String(def), 10);
    return Math.max(lo, Math.min(hi, isNaN(v) ? def : v));
};
const checked = id => $(id)?.checked === true;

function currentProvider() {
    return providers.get(localStorage.getItem(LS.provider)) || providers.first();
}

function readSettings() {
    return {
        quality: localStorage.getItem(LS.quality) || 'medium',
        padPercent: num('context-pad', 15, 0, 50),
        feather: num('edge-feather', 16, 0, 256),
        layerOnly: checked('use-layer-only'),
        lossless: checked('lossless-input'),
        transparent: checked('transparent-bg'),
        ignorePixels: checked('ignore-pixels'),
        livePreview: checked('live-preview'),
    };
}

/* ── UI ────────────────────────────────────────────────────────────────────── */

function setStatus(text) {
    const el = $('status-text');
    if (el) el.textContent = text || '';
}

function setBusy(on) {
    busy = on;
    const btn = $('generate-btn');
    if (btn) btn.disabled = on;            // захист від подвійного кліку — у старому його не було
    const regen = $('regen-btn');
    if (regen) regen.disabled = on || !lastRun;
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
    label.className = 'lbl';
    label.textContent = el.querySelector('sp-label')?.textContent || id;
    const seg = document.createElement('div');
    seg.className = 'seg';

    const holder = document.createElement('div');
    holder.id = id;                            // той самий id
    holder.value = String(initial);
    holder.style.display = 'none';

    for (const v of values) {
        const btn = document.createElement('button');
        btn.className = 'seg-btn' + (v === initial ? ' active' : '');
        btn.textContent = v + unit;
        btn.dataset.value = String(v);
        btn.addEventListener('click', () => {
            holder.value = String(v);
            localStorage.setItem(lsKey, String(v));
            seg.querySelectorAll('.seg-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.value === String(v)));
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

function bindModelPicker(picker) {
    if (!picker) return;
    picker.addEventListener('change', e => {
        localStorage.setItem(LS.model, e.target.value);
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
        setStatus(`Немає жодної моделі для ${p.label} — перевірте ключ і зв'язок`);
        return;
    }

    // Поки мережевий перелік завантажувався, користувач міг уже вибрати іншого
    // провайдера. Старий результат не має права перезаписати новий picker.
    if (refreshSeq !== modelRefreshSeq || currentProvider().id !== p.id) return;

    const saved = localStorage.getItem(LS.model);
    const pick = list.some(m => m.id === saved) ? saved : list[0].id;
    localStorage.setItem(LS.model, pick);
    const picker = fillPicker(
        'model-select', list.map(m => ({ value: m.id, label: m.label })), pick
    );
    bindModelPicker(picker);
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
        `${p.label} не має параметра прозорого фону — попросіть це в промпті`);
    dim('live-preview', p.supportsStream !== false,
        `${p.label} не віддає проміжні кадри в цьому API`);
    dim('add-ref-btn', p.supportsReferences !== false,
        `${p.label} не приймає додаткових зображень`);
}

function initQuality() {
    const group = $('quality-toggle');
    if (!group) return;
    const saved = localStorage.getItem(LS.quality) || 'medium';
    group.innerHTML = '';
    for (const q of QUALITIES) {
        const btn = document.createElement('button');
        btn.className = 'seg-btn' + (q === saved ? ' active' : '');
        btn.textContent = q === 'auto' ? 'Авто' : q === 'low' ? 'Низька'
                        : q === 'medium' ? 'Середня' : 'Висока';
        btn.dataset.value = q;
        btn.addEventListener('click', () => {
            localStorage.setItem(LS.quality, q);
            group.querySelectorAll('.seg-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.value === q));
            refreshPlanLine();
        });
        group.appendChild(btn);
    }
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

async function refreshPlanLine() {
    const el = $('plan-line');
    if (!el) return;
    try {
        const doc = app.activeDocument;
        if (!doc) { el.textContent = 'Немає відкритого документа'; el.className = 'plan dim'; return; }

        const sel = await readSelectionBounds(doc).catch(() => null);
        if (!sel || !sel.bounds) {
            el.textContent = 'Виділіть прямокутну область';
            el.className = 'plan dim';
            return;
        }
        const target = geometry.integerTarget(sel.bounds);
        if (target.w < 1 || target.h < 1) {
            el.textContent = 'Виділення порожнє';
            el.className = 'plan dim';
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
            what = `${w}×${h} · ${(w * h / 1e6).toFixed(2)} МП`;
        } else if (plan.aspectRatio) {
            what = `${plan.aspectRatio} · ${plan.imageSize}`;
        } else {
            what = 'розмір за замовчуванням моделі';
        }
        const losslessNote = s.lossless && ctx.w * ctx.h > capture.LOSSLESS_MAX_PX
            ? ' · вхід JPEG (область > 2 МП)' : s.lossless ? ' · вхід PNG' : ' · вхід JPEG';
        el.textContent = `Запит: ${what}${losslessNote} · виділення ${target.w}×${target.h}` +
                         (s.padPercent ? ` · контекст ${ctx.w}×${ctx.h}` : '') +
                         (references.length ? ` · +${references.length} реф.` : '');
        el.className = 'plan';
    } catch (e) {
        el.textContent = '';
        console.warn('[ui] план не порахувався:', e.message);
    }
}

/* ── Постійний журнал витрат ───────────────────────────────────────────────── */

function loadUsageLedger() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LS.usage));
        // Об'єктова форма лишає простір для майбутньої міграції, але читаємо й
        // ранню масивну форму, якщо вона встигла потрапити в локальну збірку.
        const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
        return usageTracker.prune(entries || []);
    } catch (e) {
        console.warn('[usage] журнал пошкоджений — починаю порожній:', e.message);
        return [];
    }
}

function saveUsageLedger(entries) {
    const clean = usageTracker.prune(entries);
    localStorage.setItem(LS.usage, JSON.stringify({ version: 1, entries: clean }));
    return clean;
}

function recordUsage(meta, usage) {
    const entries = loadUsageLedger();
    entries.unshift(usageTracker.createEntry(meta, usage));
    saveUsageLedger(entries);
    renderUsage();
}

function amountWithUnknown(summary) {
    const amount = `≈${usageTracker.formatUsd(summary.usd)}`;
    return summary.unknownCost ? `${amount} + ${summary.unknownCost} без оцінки` : amount;
}

function renderUsage() {
    const compact = $('cost-line');
    const summaryEl = $('usage-summary');
    const listEl = $('usage-list');
    const stats = usageTracker.summarize(loadUsageLedger());

    if (!stats.last) {
        if (compact) { compact.textContent = ''; compact.classList.add('hidden'); }
        if (summaryEl) summaryEl.textContent = 'Запитів іще немає.';
        if (listEl) listEl.innerHTML = '';
        setBadge('usage-badge', '');
        return;
    }

    const lastAmount = Number.isFinite(stats.last.costUsd)
        ? `≈${usageTracker.formatUsd(stats.last.costUsd)}` : 'вартість —';
    if (compact) {
        compact.textContent = `Останній: ${lastAmount} · сьогодні: ${amountWithUnknown(stats.today)} ` +
            `(${stats.today.requests}) · 7 днів: ${amountWithUnknown(stats.sevenDays)} ` +
            `(${stats.sevenDays.requests})`;
        compact.classList.remove('hidden');
    }
    setBadge('usage-badge', `${usageTracker.formatUsd(stats.today.usd)} · ${stats.today.requests}`);

    if (summaryEl) {
        summaryEl.innerHTML = '';
        for (const [label, data] of [['Сьогодні', stats.today], ['7 днів', stats.sevenDays], ['Усього в журналі', stats.all]]) {
            const card = document.createElement('div');
            card.className = 'usage-card';
            const name = document.createElement('span');
            name.className = 'usage-card-label';
            name.textContent = label;
            const value = document.createElement('strong');
            value.textContent = amountWithUnknown(data);
            const meta = document.createElement('span');
            meta.className = 'usage-card-meta';
            meta.textContent = `${data.requests} зап. · ${usageTracker.formatTokens(data.inputTokens)} вх. / ` +
                `${usageTracker.formatTokens(data.outputTokens)} вих.`;
            card.appendChild(name); card.appendChild(value); card.appendChild(meta);
            summaryEl.appendChild(card);
        }
    }

    if (listEl) {
        listEl.innerHTML = '';
        for (const entry of stats.recent) {
            const row = document.createElement('div');
            row.className = 'usage-row';
            const info = document.createElement('div');
            info.className = 'usage-info';
            const main = document.createElement('div');
            main.className = 'usage-main';
            main.textContent = `${entry.providerLabel || entry.provider} · ${entry.model}`;
            const meta = document.createElement('div');
            meta.className = 'usage-meta';
            const when = new Date(entry.at);
            const date = when.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
            const time = when.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            const shape = [entry.quality, entry.size, entry.aspectRatio].filter(Boolean).join(' · ');
            meta.textContent = `${date} ${time}${shape ? ` · ${shape}` : ''} · ` +
                `${usageTracker.formatTokens(entry.inputTokens)} вх. / ` +
                `${usageTracker.formatTokens(entry.outputTokens)} вих.`;
            const amount = document.createElement('div');
            amount.className = 'usage-amount';
            amount.textContent = Number.isFinite(entry.costUsd)
                ? `≈${usageTracker.formatUsd(entry.costUsd)}` : '—';
            info.appendChild(main); info.appendChild(meta);
            row.appendChild(info); row.appendChild(amount);
            listEl.appendChild(row);
        }
    }
}

/* ── Референси ─────────────────────────────────────────────────────────────── */

function renderRefs() {
    const list = $('ref-list');
    if (list) {
        list.innerHTML = '';
        references.forEach((r, i) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = r.name;
            const x = document.createElement('button');
            x.className = 'chip-x';
            x.textContent = '✕';
            x.addEventListener('click', () => { references.splice(i, 1); renderRefs(); refreshPlanLine(); });
            chip.appendChild(x);
            list.appendChild(chip);
        });
    }
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
        setStatus('Не вдалось додати референси: ' + e.message);
    }
}

/* ── Пресети, історія, кеш ─────────────────────────────────────────────────── */

function renderPresets() {
    const list = $('preset-list');
    if (!list) return;
    list.innerHTML = '';
    for (const p of presetManager.getAll()) {
        const row = document.createElement('div');
        row.className = 'preset-row';
        const cb = document.createElement('sp-checkbox');
        if (p.active) cb.setAttribute('checked', '');
        cb.textContent = p.name;
        cb.addEventListener('change', e => { presetManager.toggleActive(p.id, e.target.checked); });
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.textContent = '✕';
        del.title = 'Видалити';
        del.addEventListener('click', () => { presetManager.delete(p.id); renderPresets(); });
        row.append(cb, del);
        list.appendChild(row);
    }
    const n = presetManager.getAll().filter(p => p.active).length;
    setBadge('preset-count', n ? String(n) : '');
}

function renderHistory() {
    const list = $('history-list');
    if (!list) return;
    list.innerHTML = '';
    for (const h of historyManager.getAll()) {
        const row = document.createElement('div');
        row.className = 'history-row';
        const txt = document.createElement('span');
        txt.className = 'history-prompt';
        txt.textContent = (h.prompt || '').slice(0, 90) || '(без промпту)';
        txt.title = 'Підставити промпт і налаштування';
        txt.addEventListener('click', () => {
            const el = $('prompt-input');
            if (el) { el.value = h.prompt || ''; localStorage.setItem(LS.prompt, el.value); }
            if (h.ctx) { lastRun = { ...h, references: [] }; setBusy(false); }
            refreshPlanLine();
        });
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.textContent = '✕';
        del.addEventListener('click', () => { historyManager.delete(h.id); renderHistory(); });
        row.append(txt, del);
        list.appendChild(row);
    }
}

function renderCache() {
    const list = $('cache-list');
    const entries = cache.list();
    if (list) {
        list.innerHTML = '';
        for (const e of entries) {
            const row = document.createElement('div');
            row.className = 'cache-row';
            const txt = document.createElement('span');
            txt.className = 'cache-info';
            const m = e.meta || {};
            const when = new Date(e.at).toLocaleTimeString();
            txt.textContent = `${when} · ${(e.size / 1024).toFixed(0)} КБ · ` +
                              `${(m.prompt || '').slice(0, 40) || '(без промпту)'}`;
            const ins = document.createElement('button');
            ins.className = 'mini-btn';
            ins.textContent = 'Вставити';
            ins.title = 'Вставити ще раз — без запиту до провайдера';
            ins.addEventListener('click', () => reinsert(e.id));
            const del = document.createElement('button');
            del.className = 'icon-btn';
            del.textContent = '✕';
            del.addEventListener('click', async () => { await cache.remove(e.id); renderCache(); });
            row.append(txt, ins, del);
            list.appendChild(row);
        }
    }
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
                el.textContent = zero
                    ? 'Вставлено точно: залишок 0'
                    : `Залишок: dx=${r.dx} dy=${r.dy} dw=${r.dw} dh=${r.dh}`;
                el.className = 'residual' + (zero ? ' ok' : ' warn');
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
    }, { commandName: 'Вставка згенерованого' });
}

async function reinsert(cacheId) {
    if (busy) return;
    const entry = cache.list().find(e => e.id === cacheId);
    if (!entry) { setStatus('Запис зник із кешу'); renderCache(); return; }
    const doc = app.activeDocument;
    if (!doc) { await core.showAlert('Відкрийте документ.'); return; }

    setBusy(true);
    try {
        setStatus('Читаю з кешу…');
        const b64 = await cache.get(cacheId);
        if (!b64) { setStatus('Файл кешу недоступний'); renderCache(); return; }
        const m = entry.meta || {};
        // Якщо є активне виділення — вставляємо в НЬОГО; інакше в збережену область.
        const sel = await readSelectionBounds(doc).catch(() => null);
        let ctx = m.ctx, target = m.target;
        if (sel && sel.bounds) {
            target = geometry.integerTarget(sel.bounds);
            ctx = expandForContext(target, doc, Number(m.padPercent) || 0);
            setStatus('Вставляю з кешу в поточне виділення…');
        } else if (!ctx) {
            setStatus('У кеші немає координат, а виділення відсутнє');
            return;
        } else {
            setStatus('Вставляю з кешу в збережену область…');
        }
        showPreview(b64);
        await insertImage(b64, ctx, target, readSettings().feather);
        setStatus('Вставлено з кешу — без запиту до провайдера');
    } catch (e) {
        console.error('[main] повтор із кешу:', e);
        setStatus('Не вдалось: ' + (e.message || e));
    } finally {
        setBusy(false);
    }
}

/* ── Головний потік ────────────────────────────────────────────────────────── */

async function onGenerate(reuse) {
    if (busy) return;

    const doc = app.activeDocument;
    if (!doc) { await core.showAlert('Відкрийте документ.'); return; }

    const s = readSettings();
    const provider = currentProvider();
    const model = localStorage.getItem(LS.model);
    if (!model) { await core.showAlert('Виберіть модель.'); return; }

    const prompt = reuse && lastRun ? lastRun.prompt : buildPrompt();
    if (!prompt) { await core.showAlert('Напишіть, що потрібно змінити.'); return; }

    const apiKey = await window.aiAuth.getKey(provider.keyName);
    if (!apiKey) { await core.showAlert(`Немає ключа ${provider.label}. Введіть його в розділі API.`); return; }

    const docId = doc.id;
    abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setBusy(true);
    showPreview(null);
    const el = $('residual-text');
    if (el) el.textContent = '';

    try {
        /* 1. Область: або з живого виділення, або та сама, що минулого разу */
        let target, ctx;
        if (reuse && lastRun && lastRun.ctx) {
            target = lastRun.target;
            ctx = lastRun.ctx;
            setStatus('Та сама область, що минулого разу…');
        } else {
            setStatus('Читаю виділення…');
            const sel = await core.executeAsModal(() => readSelectionBounds(app.activeDocument),
                { commandName: 'Читання виділення' });
            if (!sel || !sel.bounds) { await core.showAlert('Виділіть прямокутну область.'); return; }
            target = geometry.integerTarget(sel.bounds);
            if (target.w < 1 || target.h < 1) { await core.showAlert('Виділення порожнє.'); return; }
            if (!sel.solid) {
                // Не проблема: маска шару робиться з каналу справжнього виділення,
                // тому ласо й еліпс обрізаються правильно. Запит іде по bounding box.
                console.log('[main] виділення не прямокутне — запит по bounding box, ' +
                            'маска шару по фактичній формі');
            }
            ctx = expandForContext(target, doc, s.padPercent);
        }

        /* 2. Що просити в провайдера */
        const caps = provider.capsFor(model);
        const plan = geometry.planRequest(caps, ctx, s.quality);
        console.log('[main] план запиту:', JSON.stringify(plan), 'ctx', ctx.w + '×' + ctx.h);

        /* 3. Захоплення пікселів — документ користувача не змінюється */
        let cap = { blob: null, lossless: false };
        if (!s.ignorePixels) {
            setStatus('Захоплюю область…');
            cap = await core.executeAsModal(() => capture.captureRegion(ctx, s.layerOnly, s.lossless),
                { commandName: 'Захоплення області' });
            console.log(`[main] захоплено: ${cap.docMode} ${cap.bpc}біт` +
                        `${cap.viaDuplicate ? ' (через дублікат)' : ''}` +
                        `${cap.lossless ? ' PNG' : ' JPEG'}`);
        }

        /* Request-маска: лише для провайдерів, що її приймають, і лише коли є
           контекст навколо. Мʼякість — та сама, що в маски шару. */
        let maskBlob = null;
        if (provider.supportsMask && s.padPercent > 0 && cap.blob) {
            try {
                const png = capture.buildRectMaskPng(ctx.w, ctx.h, {
                    left: target.left - ctx.left, top: target.top - ctx.top,
                    right: target.right - ctx.left, bottom: target.bottom - ctx.top,
                }, s.feather);
                maskBlob = new Blob([png], { type: 'image/png' });
                console.log(`[main] маска ${ctx.w}×${ctx.h}, край ${s.feather} px: ` +
                            `${(png.length / 1024).toFixed(1)} КБ`);
            } catch (e) { console.warn('[main] маска не побудована:', e.message); }
        }

        /* 4. Генерація — поза модальним контекстом, щоб Photoshop не блокувався */
        setStatus('Генерація…');
        const wantPreview = s.livePreview && provider.supportsStream !== false;
        const refBlobs = (provider.supportsReferences !== false)
            ? references.map(r => r.blob) : [];

        const res = await provider.generate({
            apiKey, model, prompt,
            imageBlob: cap.blob, maskBlob,
            references: refBlobs,
            plan,
            background: s.transparent && provider.supportsTransparent !== false ? 'transparent' : null,
            ignorePixels: s.ignorePixels,
            signal: abortCtrl ? abortCtrl.signal : undefined,
            onPartial: wantPreview ? (b64, idx) => {
                showPreview(b64);
                setStatus(`Генерація… проміжний кадр ${(idx ?? 0) + 1}`);
            } : null,
            onProgress: st => setStatus(st),
        });

        const images = (res && res.images) || [];
        if (!images.length) { await core.showAlert('Провайдер не повернув зображень.'); return; }
        showPreview(images[0]);
        // Записуємо одразу після успішної відповіді API: гроші вже витрачені,
        // навіть якщо користувач перемкне документ і вставку доведеться скасувати.
        recordUsage({
            provider: provider.id,
            providerLabel: provider.label,
            model,
            quality: s.quality,
            plan,
            imageCount: images.length,
            hasImageInput: !!cap.blob || refBlobs.length > 0,
        }, res.usage);

        /* 5. Вставка */
        if (!app.activeDocument || app.activeDocument.id !== docId) {
            await core.showAlert('Активний документ змінився під час генерації — вставку скасовано.');
            return;
        }
        setStatus('Вставляю…');
        await insertImage(images[0], ctx, target, s.feather);

        /* 6. Пам'ять про запуск: кеш + історія + кнопка «Перегенерувати» */
        const meta = { prompt, provider: provider.id, model, ctx, target,
                       padPercent: s.padPercent, quality: s.quality };
        const cacheId = await cache.save(images[0], meta);
        renderCache();

        lastRun = { ...meta };
        historyManager.add({ ...meta, cacheId, settings: s });
        renderHistory();
        setStatus('Готово');

    } catch (e) {
        if (e && e.cancelled) {
            setStatus('Скасовано');
        } else {
            console.error('[main]', e);
            await core.showAlert(`Не вдалось:\n${e && e.message ? e.message : e}`);
            setStatus('Помилка');
        }
    } finally {
        abortCtrl = null;
        setBusy(false);
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
        if (prompt) prompt.addEventListener('input', () => localStorage.setItem(LS.prompt, prompt.value));
    } catch (e) { console.error('[ui] налаштування:', e.message); }

    // Перевірка рендеру — ПІСЛЯ біндингу, бо підміна забирає елемент із DOM.
    try {
        ensureNumericControl('context-pad', LS.pad, [0, 5, 10, 15, 25, 40], '%');
        ensureNumericControl('edge-feather', LS.feather, [0, 8, 16, 32, 64, 128, 256], '');
    } catch (e) { console.error('[ui] контроли чисел:', e.message); }

    try { renderPresets(); } catch (e) { console.error('[ui] пресети:', e.message); }
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
    if (btn) btn.addEventListener('click', () => onGenerate(false));

    const regen = $('regen-btn');
    if (regen) regen.addEventListener('click', () => onGenerate(true));

    const cancel = $('cancel-btn');
    if (cancel) cancel.addEventListener('click', () => {
        if (abortCtrl) { abortCtrl.abort(); setStatus('Скасовую…'); }
    });

    // Cmd+Enter / Ctrl+Enter — генерувати; Esc — скасувати
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onGenerate(false);
        } else if (e.key === 'Escape' && busy && abortCtrl) {
            e.preventDefault();
            abortCtrl.abort();
            setStatus('Скасовую…');
        }
    });

    const addRef = $('add-ref-btn');
    if (addRef) addRef.addEventListener('click', pickReferences);
    const clearRef = $('clear-ref-btn');
    if (clearRef) clearRef.addEventListener('click', () => { references = []; renderRefs(); refreshPlanLine(); });

    const clearCache = $('clear-cache-btn');
    if (clearCache) clearCache.addEventListener('click', async () => {
        await cache.clear(); renderCache(); setStatus('Кеш очищено');
    });

    const clearUsage = $('clear-usage-btn');
    if (clearUsage) clearUsage.addEventListener('click', () => {
        localStorage.removeItem(LS.usage);
        // Старий безчасовий лічильник більше не читається; очищаємо його разом
        // із новим журналом, якщо він лишився від попередньої версії.
        localStorage.removeItem('ai_session_usage');
        renderUsage();
        setStatus('Статистику очищено');
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

    // Секції, що згортаються
    for (const [head, body] of [['opts-header', 'opts-body'], ['usage-header', 'usage-body'],
                                ['ref-header', 'ref-body'], ['cache-header', 'cache-body'],
                                ['preset-header', 'preset-body'], ['history-header', 'history-body']]) {
        const h = $(head), b = $(body);
        if (h && b) h.addEventListener('click', () => b.classList.toggle('hidden'));
    }
});

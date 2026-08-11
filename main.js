/* ============================================================================
 *  main.js — єдиний потік: виділення → промпт → провайдер → Smart Object.
 *
 *  Тут НЕМА геометрії (geometry.js), НЕМА роботи з пікселями (capture.js),
 *  НЕМА вставки (place.js) і НЕМА знання про провайдерів (providers/).
 *  Старий main.js мав 2797 рядків, з яких на цей сценарій працювало ~850.
 * ========================================================================== */

const { app, core } = require('photoshop');
const { batchPlay } = require('photoshop').action;

const providers = require('./providers/index.js');
const geometry   = require('./geometry.js');
const place      = require('./place.js');
const capture    = require('./capture.js');
const presetManager  = require('./presets.js');
const historyManager = require('./history.js');

const LS = {
    provider: 'ai_provider', model: 'ai_model', quality: 'ai_quality',
    n: 'ai_variations', prompt: 'ai_prompt', layerOnly: 'ai_layer_only',
    pad: 'ai_context_pad',
};

const $ = id => document.getElementById(id);
const QUALITIES = ['low', 'medium', 'high', 'auto'];

let busy = false;

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

/* ── UI ────────────────────────────────────────────────────────────────────── */

function setStatus(text) {
    const el = $('status-text');
    if (el) el.textContent = text || '';
}

function setBusy(on) {
    busy = on;
    const btn = $('generate-btn');
    if (btn) btn.disabled = on;            // захист від подвійного кліку — у старому його не було
    const sp = $('spinner');
    if (sp) sp.classList.toggle('hidden', !on);
}

/** sp-picker у частині версій PS не оновлюється через innerHTML — перестворюємо. */
function fillPicker(id, items, selectedValue) {
    const picker = $(id);
    if (!picker) return;
    const old = picker.querySelector('sp-menu');
    if (old) old.remove();
    const menu = document.createElement('sp-menu');
    menu.setAttribute('slot', 'options');
    for (const it of items) {
        const item = document.createElement('sp-menu-item');
        item.setAttribute('value', it.value);
        item.textContent = it.label;
        if (it.value === selectedValue) item.setAttribute('selected', '');
        menu.appendChild(item);
    }
    picker.appendChild(menu);
}

function currentProvider() {
    return providers.get(localStorage.getItem(LS.provider)) || providers.first();
}

async function refreshModels() {
    const p = currentProvider();
    let list = [];
    try {
        const apiKey = await window.aiAuth.getKey(p.keyName);
        list = await p.models(apiKey);
    } catch (e) {
        console.warn('[ui] перелік моделей не отримано:', e.message);
    }
    if (!list.length) { setStatus('Не вдалось отримати перелік моделей'); return; }

    const saved = localStorage.getItem(LS.model);
    const pick = list.some(m => m.id === saved) ? saved : list[0].id;
    localStorage.setItem(LS.model, pick);
    fillPicker('model-select', list.map(m => ({ value: m.id, label: m.label })), pick);
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
        });
        group.appendChild(btn);
    }
}

/**
 * Ініціалізація UI. Кожен блок в окремому try: у старому плагіні
 * ReferenceError у initializeModels обривав ініціалізацію, і разом із ним
 * тихо вмирали refine-пікер та вкладка чату.
 */
async function initUI() {
    try {
        const list = providers.list();
        const saved = localStorage.getItem(LS.provider) || list[0].id;
        localStorage.setItem(LS.provider, saved);
        fillPicker('provider-select', list.map(p => ({ value: p.id, label: p.label })), saved);
        const picker = $('provider-select');
        if (picker) picker.addEventListener('change', async e => {
            localStorage.setItem(LS.provider, e.target.value);
            localStorage.removeItem(LS.model);
            await window.aiAuth.refreshAuthUI();
            await refreshModels();
        });
    } catch (e) { console.error('[ui] провайдери:', e.message); }

    try { await refreshModels(); } catch (e) { console.error('[ui] моделі:', e.message); }

    try {
        const picker = $('model-select');
        if (picker) picker.addEventListener('change', e => localStorage.setItem(LS.model, e.target.value));
    } catch (e) { console.error('[ui] модель:', e.message); }

    try { initQuality(); } catch (e) { console.error('[ui] якість:', e.message); }

    try {
        const bind = (id, key, def, prop = 'value') => {
            const el = $(id);
            if (!el) return;
            const saved = localStorage.getItem(key);
            if (saved !== null) el[prop] = prop === 'checked' ? saved === 'true' : saved;
            else if (def !== undefined) el[prop] = def;
            el.addEventListener('change', () =>
                localStorage.setItem(key, String(prop === 'checked' ? el.checked : el.value)));
        };
        bind('prompt-input', LS.prompt, '');
        bind('variations-value', LS.n, '1');
        bind('context-pad', LS.pad, '15');
        bind('use-layer-only', LS.layerOnly, false, 'checked');
        const prompt = $('prompt-input');
        if (prompt) prompt.addEventListener('input', () => localStorage.setItem(LS.prompt, prompt.value));
    } catch (e) { console.error('[ui] налаштування:', e.message); }

    try { renderPresets(); } catch (e) { console.error('[ui] пресети:', e.message); }
    try { await historyManager.load(); renderHistory(); } catch (e) { console.error('[ui] історія:', e.message); }
}

/* ── Пресети й історія ─────────────────────────────────────────────────────── */

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
    const badge = $('preset-count');
    if (badge) {
        const n = presetManager.getAll().filter(p => p.active).length;
        badge.textContent = n ? String(n) : '';
    }
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
        txt.title = 'Підставити промпт';
        txt.addEventListener('click', () => {
            const el = $('prompt-input');
            if (el) { el.value = h.prompt || ''; localStorage.setItem(LS.prompt, el.value); }
        });
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.textContent = '✕';
        del.addEventListener('click', () => { historyManager.delete(h.id); renderHistory(); });
        row.append(txt, del);
        list.appendChild(row);
    }
}

function buildPrompt() {
    let text = ($('prompt-input')?.value || '').trim();
    for (const p of presetManager.getAll()) {
        if (p.active && p.content) text += ' ' + p.content;
    }
    return text.trim();
}

/* ── Головний потік ────────────────────────────────────────────────────────── */

async function onGenerate() {
    if (busy) return;

    const doc = app.activeDocument;
    if (!doc) { await core.showAlert('Відкрийте документ.'); return; }

    const prompt = buildPrompt();
    if (!prompt) { await core.showAlert('Напишіть, що потрібно змінити.'); return; }

    const provider = currentProvider();
    const model = localStorage.getItem(LS.model);
    if (!model) { await core.showAlert('Виберіть модель.'); return; }
    const apiKey = await window.aiAuth.getKey(provider.keyName);
    if (!apiKey) { await core.showAlert(`Немає ключа ${provider.label}. Введіть його в розділі API.`); return; }

    const quality = localStorage.getItem(LS.quality) || 'medium';
    const n = Math.max(1, Math.min(4, parseInt($('variations-value')?.value || '1', 10) || 1));
    const padPercent = Math.max(0, Math.min(50, parseInt($('context-pad')?.value || '15', 10) || 0));
    const layerOnly = $('use-layer-only')?.checked === true;

    const docId = doc.id;
    setBusy(true);
    try {
        // 1. Виділення
        setStatus('Читаю виділення…');
        const sel = await core.executeAsModal(() => readSelectionBounds(app.activeDocument),
            { commandName: 'Читання виділення' });
        if (!sel || !sel.bounds) { await core.showAlert('Виділіть прямокутну область.'); return; }

        const target = geometry.integerTarget(sel.bounds);
        if (target.w < 1 || target.h < 1) { await core.showAlert('Виділення порожнє.'); return; }
        if (!sel.solid) {
            console.warn('[main] виділення не прямокутне — геометрія рахується по його bounding box');
            setStatus('Увага: виділення не прямокутне');
        }

        const ctx = expandForContext(target, doc, padPercent);

        // 2. Що просити в провайдера
        const caps = provider.capsFor(model);
        const plan = geometry.planRequest(caps, ctx, quality);
        console.log('[main] план запиту:', JSON.stringify(plan), 'ctx', ctx.w + '×' + ctx.h);

        // 3. Захоплення пікселів — документ користувача не змінюється
        setStatus('Захоплюю область…');
        const cap = await core.executeAsModal(() => capture.captureRegion(ctx, layerOnly),
            { commandName: 'Захоплення області' });
        console.log(`[main] захоплено: ${cap.docMode} ${cap.bpc}біт` +
                    `${cap.viaDuplicate ? ' (через дублікат)' : ''}`);

        // Маска: показує моделі, що саме змінювати. Має сенс лише коли є контекст.
        let maskBlob = null;
        if (provider.supportsMask && padPercent > 0) {
            try {
                const png = capture.buildRectMaskPng(ctx.w, ctx.h, {
                    left: target.left - ctx.left, top: target.top - ctx.top,
                    right: target.right - ctx.left, bottom: target.bottom - ctx.top,
                });
                maskBlob = new Blob([png], { type: 'image/png' });
                console.log(`[main] маска ${ctx.w}×${ctx.h}: ${(png.length / 1024).toFixed(1)} КБ`);
            } catch (e) { console.warn('[main] маска не побудована:', e.message); }
        }

        // 4. Генерація — поза модальним контекстом, щоб Photoshop не блокувався
        setStatus('Генерація…');
        const images = await provider.generate({
            apiKey, model, prompt,
            imageBlob: cap.blob, maskBlob, plan, n,
            onProgress: (cur, total, status) => setStatus(`Генерація ${cur}/${total} — ${status}`),
        });
        if (!images.length) { await core.showAlert('Провайдер не повернув зображень.'); return; }

        // 5. Вставка
        if (!app.activeDocument || app.activeDocument.id !== docId) {
            await core.showAlert('Активний документ змінився під час генерації — вставку скасовано.');
            return;
        }
        setStatus('Вставляю…');
        await core.executeAsModal(async () => {
            const channelName = 'AiSel_' + Date.now();
            let haveChannel = false;
            try {
                await batchPlay([{
                    _obj: 'duplicate',
                    _target: [{ _ref: 'channel', _enum: 'channel', _value: 'selection' }],
                    name: channelName,
                }], {});
                haveChannel = true;
            } catch (e) { console.warn('[main] виділення не збережено в канал:', e.message); }

            try {
                for (let i = 0; i < images.length; i++) {
                    const report = await place.placeGeneratedSmartObject(
                        images[i], ctx, haveChannel ? channelName : null);
                    console.log(`[main] вставка ${i + 1}/${images.length}:`,
                        'residual', JSON.stringify(report.residual),
                        report.warnings.length ? 'warnings: ' + report.warnings.join('; ') : '');
                }
            } finally {
                if (haveChannel) {
                    try {
                        await batchPlay([{ _obj: 'delete',
                            _target: [{ _ref: 'channel', _name: channelName }] }], {});
                    } catch (e) {}
                }
            }
        }, { commandName: 'Вставка згенерованого' });

        historyManager.add({
            prompt, model, provider: provider.id,
            settings: { quality, n, padPercent, layerOnly },
        });
        renderHistory();
        setStatus(`Готово: ${images.length} шар${images.length > 1 ? 'и' : ''}`);

    } catch (e) {
        console.error('[main]', e);
        await core.showAlert(`Не вдалось:\n${e && e.message ? e.message : e}`);
        setStatus('Помилка');
    } finally {
        setBusy(false);
    }
}

/* ── Запуск ────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
    initUI();

    const btn = $('generate-btn');
    if (btn) btn.addEventListener('click', onGenerate);

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
    for (const [head, body] of [['preset-header', 'preset-body'], ['history-header', 'history-body']]) {
        const h = $(head), b = $(body);
        if (h && b) h.addEventListener('click', () => b.classList.toggle('hidden'));
    }
});

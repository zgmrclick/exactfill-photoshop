/* ============================================================================
 *  auth.js — ключі API, по одному на провайдера.
 *
 *  Старий auth.js знав рівно один ключ ('openAiApiKey') і був жорстко зшитий
 *  з UI. Оскільки провайдерів тепер два, ключ став параметром.
 *
 *  secureStorage ізольований per plugin id, тому ключі зі старих плагінів сюди
 *  не переїдуть — їх треба ввести заново. Це не помилка, це властивість UXP.
 * ========================================================================== */

const { shell, storage } = require('uxp');
const authKeys = require('./storage-keys.js').LS;
const secureStore = storage.secureStorage;
const authI18n = require('./i18n.js');

/**
 * secureStorage віддає ключ як Uint8Array, а не рядок — звідси
 * String.fromCharCode. Робимо порціями: apply на великому масиві переповнює стек.
 */
async function getKey(keyName) {
    try {
        const raw = await secureStore.getItem(keyName);
        if (!raw) return null;
        if (typeof raw === 'string') return raw;
        let s = '';
        const CHUNK = 4096;
        for (let i = 0; i < raw.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, raw.subarray(i, Math.min(i + CHUNK, raw.length)));
        }
        return s || null;
    } catch (e) {
        // «not found» у secureStorage кидається як виняток, а не повертає null
        return null;
    }
}

async function setKey(keyName, value) {
    await secureStore.setItem(keyName, value);
}

async function hasKey(keyName) {
    return !!(await getKey(keyName));
}

/* ── UI ────────────────────────────────────────────────────────────────────── */

/* Адреса сторінки ключа живе В ПРОВАЙДЕРІ (providers/*.js keyPage) — щоб при
   додаванні третього провайдера не треба було правити ще й цей файл. Тут лише
   резерв на випадок, коли поле не заповнене. */
const KEY_LINKS = {
    openAiApiKey: 'https://platform.openai.com/api-keys',
    googleApiKey: 'https://aistudio.google.com/apikey',
};

/** Яким ключем цікавиться панель зараз — залежить від обраного провайдера. */
function activeKeyName() {
    const providers = require('./providers/index.js');
    const id = localStorage.getItem(authKeys.provider) || providers.first().id;
    const p = providers.get(id) || providers.first();
    return p.keyName;
}

async function refreshAuthUI() {
    const keyName = activeKeyName();
    const ok = await hasKey(keyName);

    const auth = document.getElementById('auth');
    const main = document.getElementById('main');
    const signout = document.getElementById('signout');
    if (auth) auth.classList.toggle('hidden', ok);
    if (main) main.classList.toggle('hidden', !ok);
    if (signout) {
        signout.classList.toggle('hidden', !ok);
        signout.textContent = authI18n.t('auth.change');
    }

    const providers = require('./providers/index.js');
    const p = providers.get(localStorage.getItem(authKeys.provider)) || providers.first();
    const label = document.getElementById('auth-provider-label');
    if (label) label.textContent = p.label;
    const link = document.getElementById('open-key-page');
    if (link) link.dataset.url = p.keyPage || KEY_LINKS[keyName] || '';
}

async function submitAuth() {
    const input = document.getElementById('api-key-input');
    const value = input && input.value && input.value.trim();
    if (!value) return;
    try {
        await setKey(activeKeyName(), value);
        if (input) input.value = '';
        await refreshAuthUI();
        /* ⚠️ Перелік моделей залежить від КЛЮЧА: доступність питається в
           /v1/models. Без цієї події щойно введений ключ починав фільтрувати
           пікер лише після перевідкриття панелі — тобто користувач бачив
           моделі, яких у нього нема, і отримував 404 замість пояснення. */
        if (typeof document !== 'undefined' && typeof Event !== 'undefined') {
            document.dispatchEvent(new Event('exactfill:keychange'));
        }
    } catch (e) {
        console.error('[auth] ключ не збережено:', e && e.message);
        const status = document.getElementById('auth-status');
        if (status) status.textContent = authI18n.t('auth.saveError', {
            error: e && e.message ? e.message : e,
        });
    }
}

async function toggleAuthEdit() {
    const auth = document.getElementById('auth');
    const main = document.getElementById('main');
    const btn = document.getElementById('signout');
    if (!auth || !main || !btn) return;

    const editing = !auth.classList.contains('hidden');
    if (editing) {
        await refreshAuthUI();                 // «Залишити» — просто відновлюємо стан
    } else {
        main.classList.add('hidden');
        auth.classList.remove('hidden');
        btn.textContent = authI18n.t('auth.keep');
        const input = document.getElementById('api-key-input');
        if (input) input.value = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    refreshAuthUI();

    const signout = document.getElementById('signout');
    if (signout) signout.addEventListener('click', toggleAuthEdit);

    const submit = document.getElementById('submit-auth');
    if (submit) submit.addEventListener('click', submitAuth);

    const link = document.getElementById('open-key-page');
    if (link) {
        link.addEventListener('click', async e => {
            e.preventDefault();
            const url = link.dataset.url;
            if (!url) return;
            try {
                await shell.openExternal(url, authI18n.t('auth.openConsent'));
            } catch (err) {
                console.error('[auth] посилання не відкрилось:', err && err.message);
                const status = document.getElementById('auth-status');
                if (status) status.textContent = authI18n.t('auth.openError', {
                    error: err && err.message ? err.message : err,
                });
            }
        });
    }
});

document.addEventListener('exactfill:localechange', () => refreshAuthUI());

// main.js викликає refreshAuthUI при зміні провайдера — панель мусить
// перемкнутися на потрібний ключ
window.aiAuth = { getKey, setKey, hasKey, refreshAuthUI, activeKeyName };

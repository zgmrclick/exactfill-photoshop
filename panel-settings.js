/* ============================================================================
 *  panel-settings.js — що саме зараз вибрано в панелі.
 *
 *  Виділено з main.js (був 1271 рядок, який робив UI, оркестрацію, сховище й
 *  рендер статистики одночасно). Тут єдина відповідальність: перетворити
 *  localStorage + стан контролів на об'єкт налаштувань запиту.
 *
 *  ⚠️ ЧОМУ ЦЕ ВАРТО БУЛО ВИНОСИТИ, а не лишати «як є»: саме тут живе зведення
 *  рівня якості до можливостей моделі. Помилка в ньому не падає й не видно в
 *  панелі — вона просто доїжджає до API як HTTP 400 або, гірше, як мовчазно
 *  дорожчий запит. Окремим модулем це перевіряється в node, а не в Photoshop.
 * ========================================================================== */

const { LS } = require('./storage-keys.js');
const providers = require('./providers/index.js');
const geometry = require('./geometry.js');

const $ = id => (typeof document === 'undefined' ? null : document.getElementById(id));

/** Ціле з контрола, зажате в межі. Порожній або зіпсований контрол → def. */
const num = (id, def, lo, hi) => {
    const v = parseInt($(id)?.value ?? String(def), 10);
    return Math.max(lo, Math.min(hi, isNaN(v) ? def : v));
};
const checked = id => $(id)?.checked === true;

function currentProvider() {
    return providers.get(localStorage.getItem(LS.provider)) || providers.first();
}

/** Можливості саме тієї моделі, що вибрана просто зараз. */
function currentCaps() {
    try {
        return currentProvider().capsFor(localStorage.getItem(LS.model)) || {};
    } catch (e) {
        return {};
    }
}

function allowedQualities() {
    const list = currentCaps().qualities;
    return (Array.isArray(list) && list.length)
        ? list : geometry.QUALITY_LADDER.concat('auto');
}

/**
 * ЄДИНЕ джерело рівня якості для всієї панелі — і для картки плану, і для
 * запиту. Раніше `readSettings` читав localStorage напряму, і рівень, недоступний
 * у новій моделі, доїжджав до API як є.
 *
 * Зведений результат СВІДОМО не записується назад у localStorage: там лежить
 * побажання користувача, а не те, що вміє сьогоднішня модель. Завдяки цьому
 * `max` повертається сам, щойно він знову стає доступним.
 */
function currentQuality() {
    return geometry.coerceQuality(localStorage.getItem(LS.quality) || 'medium',
                                  allowedQualities());
}

function readSettings() {
    return {
        quality: currentQuality(),
        padPercent: num('context-pad', 15, 0, 50),
        feather: num('edge-feather', 16, 0, 256),
        layerOnly: checked('use-layer-only'),
        lossless: checked('lossless-input'),
        transparent: checked('transparent-bg'),
        ignorePixels: checked('ignore-pixels'),
        livePreview: checked('live-preview'),
    };
}

module.exports = {
    LS, num, checked,
    currentProvider, currentCaps, allowedQualities, currentQuality, readSettings,
};

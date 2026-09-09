/* ============================================================================
 *  ledger.js — журнал витрат на диску.
 *
 *  ⚠️ ЧОМУ ОКРЕМИЙ ФАЙЛ, А НЕ ЧАСТИНА usage.js: usage.js СВІДОМО чистий —
 *  «без Photoshop/DOM/localStorage», і саме тому тарифну арифметику можна
 *  ганяти в node. Перенести туди localStorage означало б зламати це рішення
 *  заради економії одного файлу. Тому зберігання живе тут, а формат і
 *  арифметика лишаються там.
 *
 *  Виділено з main.js: панель не має знати, під яким ключем і в якій формі
 *  лежить журнал.
 * ========================================================================== */

const ledgerKeys = require('./storage-keys.js').LS;
const usageTracker = require('./usage.js');

/**
 * Читає журнал. Пошкоджений журнал НЕ валить панель: гірше за втрачену
 * статистику лише панель, яка через неї не відкривається.
 */
function load() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ledgerKeys.usage));
        // Об'єктова форма лишає простір для майбутньої міграції, але читаємо й
        // ранню масивну форму, якщо вона встигла потрапити в локальну збірку.
        const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
        return usageTracker.prune(entries || []);
    } catch (e) {
        console.warn('[usage] журнал пошкоджений — починаю порожній:', e.message);
        return [];
    }
}

function save(entries) {
    const clean = usageTracker.prune(entries);
    localStorage.setItem(ledgerKeys.usage, JSON.stringify({ version: 1, entries: clean }));
    return clean;
}

/** Додає запис і повертає оновлений журнал — рендер робить той, хто викликав. */
function record(meta, usage) {
    const entries = load();
    entries.unshift(usageTracker.createEntry(meta, usage));
    return save(entries);
}

const summarize = () => usageTracker.summarize(load());

module.exports = { load, save, record, summarize };

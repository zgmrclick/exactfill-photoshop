/* ============================================================================
 *  providers/index.js — реєстр провайдерів. Тонкий свідомо.
 *
 *  Сенс усього шару: main.js не знає нічого про OpenAI чи Google. Додати
 *  третього провайдера = один файл поруч + один рядок тут. Саме через це
 *  двом окремим плагінам більше немає причини існувати.
 * ========================================================================== */

const openai = require('./openai.js');
const google = require('./google.js');

const ALL = [openai, google];

/** Для наповнення пікера провайдера. */
function list() {
    return ALL.map(p => ({ id: p.id, label: p.label, supportsMask: p.supportsMask }));
}

function get(id) {
    return ALL.find(p => p.id === id) || null;
}

/** Перший — типовий, коли в localStorage ще нічого не збережено. */
function first() {
    return ALL[0];
}

module.exports = { list, get, first };

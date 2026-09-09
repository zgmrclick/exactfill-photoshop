/* ============================================================================
 *  storage-keys.js — ЄДИНЕ місце, де оголошені ключі localStorage.
 *
 *  ⚠️ НАВІЩО ОКРЕМИЙ ФАЙЛ. До нього `ai_provider` був написаний рядковим
 *  літералом у пʼяти файлах: main.js, auth.js, i18n.js і шість разів у
 *  public-ui.js. Перейменування ключа в одному місці НЕ ламало панель — вона
 *  просто починала читати інший ключ. Ламався звіт про ваду: у діагностиці
 *  зʼявлялось «Provider: unknown», і причину довелося б шукати в останню чергу.
 *  Класична тиха розбіжність, на які цей плагін уже наступав (те саме було з
 *  presetManager.load() і з buildCommand).
 *
 *  Модуль навмисно БЕЗ ЖОДНОЇ залежності: його тягнуть і i18n.js, і auth.js, і
 *  public-ui.js — усе, що завгодно, тільки не цикл.
 *
 *  Префікс `ai_` і назви лишаються як є: у користувачів уже збережені
 *  налаштування під цими іменами, і перейменування стерло б їх мовчки.
 * ========================================================================== */

const LS = {
    provider: 'ai_provider',
    model: 'ai_model',
    quality: 'ai_quality',
    prompt: 'ai_prompt',
    layerOnly: 'ai_layer_only',
    pad: 'ai_context_pad',
    feather: 'ai_edge_feather',
    lossless: 'ai_lossless',
    transparent: 'ai_transparent',
    ignorePixels: 'ai_ignore_pixels',
    preview: 'ai_live_preview',
    usage: 'ai_usage_ledger_v1',
    transport: 'ai_transport',
    cache: 'ai_result_cache_v1',
    locale: 'exactfill_locale',   // без префікса ai_ — так воно вже збережено в користувачів
};

/** Ключі, які плагін лише ПРИБИРАЄ. Тримаємо їх тут, щоб не завести повторно. */
const LEGACY = {
    sessionUsage: 'ai_session_usage',      // журнал сесії, витіснений LS.usage
    presets: 'googleAiPresets',            // спадок форку, лишився через збережені пресети
    history: 'nanobanana_prompt_history',  // те саме
};

module.exports = { LS, LEGACY };

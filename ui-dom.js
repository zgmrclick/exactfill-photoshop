/* ============================================================================
 *  ui-dom.js — дрібні цеглинки для ручної збірки DOM.
 *
 *  ⚠️ НАВІЩО: у панелі п'ять функцій рендеру (витрати, референси, пресети,
 *  історія, кеш) повторювали той самий трирядковий шаблон
 *  «createElement → className → textContent → appendChild» близько сорока разів.
 *  Помилка в такому шаблоні не падає — вона просто не малює рядок.
 *
 *  Тут НЕМА шаблонізатора і немає innerHTML з даними: у панелі трапляється
 *  довільний текст користувача (промпти, назви пресетів), і єдиний безпечний
 *  спосіб його показати — textContent.
 *
 *  Модуль підключається через require(), не через <script>, тому його
 *  top-level імена не конфліктують зі спільним scope панелі.
 * ========================================================================== */

/** Елемент із класом і текстом. Порожні className/text просто не ставимо. */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}

/** Прибирає дітей. Окремо від fill(), бо порожній стан теж треба вміти. */
function clear(node) {
    if (node) node.innerHTML = '';
}

/**
 * Замінює вміст контейнера набором готових дітей.
 * Відсутній контейнер — не помилка: секцію могли прибрати з розмітки, і рендер
 * не має через це валити всю ініціалізацію.
 */
function fill(node, children) {
    if (!node) return;
    node.innerHTML = '';
    for (const child of children) if (child) node.appendChild(child);
    return node;
}

/**
 * Кнопка-хрестик, якою в панелі видаляють усе: референс, пресет, запис історії,
 * запис кешу. Була скопійована чотири рази, і в одній копії загубився title.
 */
function iconButton({ title, onClick, className = 'icon-btn', glyph = '✕' }) {
    const btn = el('button', className, glyph);
    btn.type = 'button';
    if (title) btn.title = title;
    // ⚠️ Гліф ✕ для екранного читача — це «знак множення». Без aria-label
    // кнопка озвучувалась саме так, тому підпис тут обов'язковий, а не окраса.
    btn.setAttribute('aria-label', title || glyph);
    btn.addEventListener('click', onClick);
    return btn;
}

module.exports = { el, clear, fill, iconButton };

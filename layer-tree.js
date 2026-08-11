'use strict';

/**
 * Залишає видимою лише гілку дерева, що містить активний шар.
 *
 * Видимість змінюється тільки на дублікаті документа. На відміну від
 * видалення верхньорівневих шарів, це коректно працює, коли активний шар
 * вкладений у групу: група та її предки лишаються видимими, сусідні гілки — ні.
 *
 * @returns {boolean} чи знайдено keepId у цій гілці
 */
function isolateLayerTree(layers, keepId) {
    let found = false;
    for (const layer of Array.from(layers || [])) {
        let inKeptBranch = layer.id === keepId;

        if (!inKeptBranch) {
            let children = [];
            try { children = layer.layers ? Array.from(layer.layers) : []; } catch (e) {}
            if (children.length) inKeptBranch = isolateLayerTree(children, keepId);
        }

        // Це виконується на копії документа. Помилку не ковтаємо: краще
        // скасувати захоплення, ніж непомітно відправити провайдеру весь макет.
        layer.visible = inKeptBranch;
        if (inKeptBranch) found = true;
    }
    return found;
}

module.exports = { isolateLayerTree };

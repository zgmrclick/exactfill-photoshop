/* ============================================================================
 *  geometry.js — уся арифметика розмірів і позицій в одному місці.
 *
 *  Правило №1: округлюємо КРАЙ, а не ширину.
 *      round(right) - round(left)   ← ніколи не зсуває ліву межу
 *      round(right - left)          ← зсуває на +1 px при непарній ширині
 *  Саме друга форма (main.js:581-582 старого плагіна) давала детермінований
 *  зсув вправо-вниз на кожному непарному виділенні.
 *
 *  Правило №2: жодних відсотків і жодного центру. Позиція завжди абсолютна.
 *
 *  Чистий модуль: без require('photoshop'), тестується в node.
 * ========================================================================== */

/** Розгортає {_unit,_value} із ActionDescriptor або віддає число як є. */
const unwrap = n => (n && typeof n === 'object' && '_value' in n) ? n._value : n;

/**
 * Межі виділення → цілі пікселі документа.
 * Округлює чотири КРАЯ незалежно, тому ширина виходить як різниця вже цілих
 * країв. Ліва/верхня межа ніколи не зсувається.
 */
function integerTarget(bounds) {
    const left   = Math.round(unwrap(bounds.left));
    const top    = Math.round(unwrap(bounds.top));
    const right  = Math.round(unwrap(bounds.right));
    const bottom = Math.round(unwrap(bounds.bottom));
    return { left, top, right, bottom, w: right - left, h: bottom - top };
}

/**
 * Куди ставити рамку Smart Object.
 *   'exact' — рівно у виділення. Пропорція збіглась із точністю ASPECT_TOL,
 *             залишкова нерівномірність невидима (≤0.5 %).
 *   'cover' — нативна пропорція збережена, надлишок звисає за виділення і
 *             ховається маскою шару. Порожніх смуг не буває ніколи.
 *
 * Замінює DISTORTION_THRESHOLD = 0.1 старого плагіна, який дозволяв 10 %
 * видимої деформації — тобто квадрат міг стати помітним прямокутником.
 */
const ASPECT_TOL = 0.005;

function planFrame(target, nat) {
    const aspectErr = Math.abs((target.w / target.h) / (nat.w / nat.h) - 1);
    if (aspectErr <= ASPECT_TOL) {
        return {
            mode: 'exact',
            left: target.left, top: target.top,
            right: target.right, bottom: target.bottom,
        };
    }
    const s  = Math.max(target.w / nat.w, target.h / nat.h);
    const fw = Math.round(nat.w * s);
    const fh = Math.round(nat.h * s);
    // ОДНЕ округлення на вісь, не два — інакше повертається та сама похибка,
    // від якої тікали.
    const left = target.left + Math.round((target.w - fw) / 2);
    const top  = target.top  + Math.round((target.h - fh) / 2);
    return { mode: 'cover', left, top, right: left + fw, bottom: top + fh };
}

/* ── Розмір запиту до провайдера ───────────────────────────────────────────── */

/**
 * Бюджет пікселів за рівнем якості. Керує ЦІНОЮ і роздільністю, але НЕ
 * геометрією: пропорція виділення зберігається завжди. Старий плагін на
 * quality='high' свідомо брав найбільший кандидат із фіксованого списку
 * (preferLarge) — тобто ламав пропорцію заради розміру. Тут навпаки.
 */
const QUALITY_BUDGET = {
    low:    1_200_000,   // ≈1.2 MP — дешево, вистачає для дрібних правок
    medium: 3_000_000,   // ≈3 MP
    high:   8_294_400,   // максимум gpt-image-2 (3840×2160)
    auto:   3_000_000,
};

/**
 * Точний розмір для моделі, що приймає довільну роздільність (gpt-image-2).
 * Обмеження моделі приходять у caps, а не хардкодяться:
 *   step    — кратність сторони (16)
 *   maxEdge — максимальна сторона (3840)
 *   minPx   — мінімальна сума пікселів (655 360)
 *   maxPx   — максимальна сума пікселів (8 294 400)
 *   maxRatio— максимальне співвідношення сторін (3)
 *
 * Повертає 'WxH' або null, якщо вписатися неможливо (тоді викликач падає
 * на фіксований список через bestFixedSize).
 */
function exactSize(target, caps, quality = 'medium') {
    const step    = caps.step    || 16;
    const maxEdge = caps.maxEdge || 4096;
    const minPx   = caps.minPx   || 1;
    const maxPx   = caps.maxPx   || Infinity;
    if (target.w < 1 || target.h < 1) return null;

    const ratio = target.w / target.h;
    if (caps.maxRatio) {
        const r = Math.max(ratio, 1 / ratio);
        if (r > caps.maxRatio) return null;   // пропорцію не підганяємо — це видима деформація
    }

    // Бажана площа: рівно виділення, але не менше мінімуму API і не більше
    // бюджету якості. Просити більше за виділення сенсу немає — деталей це не
    // додасть, а грошей коштує.
    const wantPx = Math.min(
        Math.max(target.w * target.h, minPx),
        Math.min(QUALITY_BUDGET[quality] ?? QUALITY_BUDGET.medium, maxPx),
    );

    // Послідовні k-коригування псують пропорцію (кратність step округлює
    // сторони по-різному), і exact вироджується в cover зі звисом. Тому не
    // коригуємо, а ПЕРЕБИРАЄМО: 240 варіантів для maxEdge=3840 — дешево.
    let best = null;
    for (let w = step; w <= maxEdge; w += step) {
        // найближче кратне step, що тримає пропорцію
        let h = Math.round((w / ratio) / step) * step;
        if (h < step) h = step;
        if (h > maxEdge) continue;
        const px = w * h;
        if (px < minPx || px > maxPx) continue;
        if (caps.maxRatio) {
            const r = Math.max(w / h, h / w);
            if (r > caps.maxRatio) continue;
        }
        const aspectErr = Math.abs((w / h) / ratio - 1);
        const pxErr     = Math.abs(px - wantPx) / wantPx;
        // Пропорція важливіша за площу: похибка пропорції видна як деформація,
        // похибка площі — лише як зайвий ресемпл.
        const score = aspectErr * 1000 + pxErr;
        if (!best || score < best.score) best = { w, h, score, aspectErr, px };
    }
    return best ? `${best.w}x${best.h}` : null;
}

/**
 * Найближчий за пропорцією розмір із фіксованого списку — для моделей, що
 * довільної роздільності не приймають (gpt-image-1/1.5/mini).
 * НЕ бере «найбільший» — бере найточніший за пропорцією, бо решту доробить
 * downscale при вставці.
 */
function bestFixedSize(target, sizes) {
    if (!sizes || !sizes.length) return null;
    const ratio = target.w / target.h;
    let best = sizes[0], bestDiff = Infinity;
    for (const s of sizes) {
        const [sw, sh] = s.split('x').map(Number);
        const diff = Math.abs(ratio - sw / sh);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
}

/**
 * Найближче співвідношення сторін із переліку 'W:H' — для Gemini, який
 * приймає aspectRatio + imageSize, а не пікселі.
 */
function bestAspect(target, aspects) {
    if (!aspects || !aspects.length) return null;
    const ratio = target.w / target.h;
    let best = aspects[0], bestDiff = Infinity;
    for (const a of aspects) {
        const [aw, ah] = a.split(':').map(Number);
        const diff = Math.abs(ratio - aw / ah);
        if (diff < bestDiff) { bestDiff = diff; best = a; }
    }
    return best;
}

/**
 * Єдина точка, де вирішується, що просити в провайдера.
 * Повертає об'єкт, який провайдер кладе у свій payload як є:
 *   { size: 'WxH', quality }                    — OpenAI
 *   { aspectRatio: 'W:H', imageSize: '2K' }     — Google
 */
function planRequest(caps, target, quality = 'medium') {
    if (caps.arbitrary) {
        const size = exactSize(target, caps, quality);
        if (size) return { size, quality };
        // не вписались — падаємо на фіксований список тієї ж моделі
    }
    if (caps.sizes) {
        return { size: bestFixedSize(target, caps.sizes), quality };
    }
    if (caps.aspects) {
        const budget = QUALITY_BUDGET[quality] ?? QUALITY_BUDGET.medium;
        const order  = caps.imageSizes || ['1K'];
        // 1K≈1 MP, 2K≈4 MP, 4K≈16 MP — беремо найбільший, що влазить у бюджет
        const px = { '512': 262_144, '1K': 1_048_576, '2K': 4_194_304, '4K': 16_777_216 };
        let pick = order[0];
        for (const s of order) if ((px[s] || 0) <= budget) pick = s;
        return { aspectRatio: bestAspect(target, caps.aspects), imageSize: pick };
    }
    return { quality };
}

module.exports = {
    unwrap,
    integerTarget,
    planFrame,
    exactSize,
    bestFixedSize,
    bestAspect,
    planRequest,
    ASPECT_TOL,
    QUALITY_BUDGET,
};

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
 * Радіус для внутрішнього змішування layer mask.
 *
 * Користувацьке значення означає повну ширину переходу. Photoshop feather
 * розтікається по обидва боки поточної межі, тому спершу стискаємо selection
 * на половину ширини, а потім feather-имо на той самий радіус. Зовнішній край
 * градієнта тоді закінчується на початковій межі виділення і не може дійти до
 * фізичного краю Smart Object.
 */
function insetBlendRadius(bounds, blendWidth) {
    const w = Math.max(0, unwrap(bounds.right) - unwrap(bounds.left));
    const h = Math.max(0, unwrap(bounds.bottom) - unwrap(bounds.top));
    const wanted = Math.max(0, Number(blendWidth) || 0) / 2;

    // Після contract + feather має лишитися непрозоре ядро. Інакше велике
    // значення на маленькому виділенні зробить увесь результат напівпрозорим.
    const maxRadius = Math.max(0, Math.min(w, h) / 4 - 1);
    return Math.floor(Math.min(wanted, maxRadius, 500));
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

/* ── Рівні якості ──────────────────────────────────────────────────────────── */

/**
 * Канонічна драбина рівнів за зростанням витрат. `auto` поза нею свідомо: це не
 * рівень, а «вирішить провайдер».
 *
 * ⚠️ ЯКІ РІВНІ ІСНУЮТЬ — вирішує МОДЕЛЬ (caps.qualities), не панель. `xhigh` і
 * `max` приймає лише gpt-image-2.5; для gpt-image-1 це HTTP 400 замість картинки.
 */
const QUALITY_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Зводить збережений рівень до того, що приймає поточна модель.
 *
 * ⚠️ ЗАВЖДИ ВНИЗ. Якщо на gpt-image-2.5 обрано `max`, а користувач перемкнувся
 * на gpt-image-1, беремо `high` — найвищий доступний, але не вищий за бажаний.
 * Підняти рівень означало б мовчки збільшити рахунок за чужим рішенням.
 */
function coerceQuality(saved, allowed) {
    const list = (Array.isArray(allowed) && allowed.length)
        ? allowed : QUALITY_LADDER.concat('auto');
    if (list.includes(saved)) return saved;
    for (let i = QUALITY_LADDER.indexOf(saved); i >= 0; i--) {
        if (list.includes(QUALITY_LADDER[i])) return QUALITY_LADDER[i];
    }
    return list.includes('auto') ? 'auto' : list[0];
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
    high:   8_294_400,   // максимум gpt-image-2/2.5 (8 294 400 px)
    // ⚠️ xhigh і max НЕ дають більше пікселів: 'high' уже впирається в maxPx
    // самої моделі. У gpt-image-2.5 ці рівні купують більше зусиль рендера на
    // тій самій роздільності, і платимо ми вихідними токенами, а не площею.
    // Через це картка плану показує для high/xhigh/max однакові мегапікселі —
    // це правда, а не помилка розрахунку.
    xhigh:  8_294_400,
    max:    8_294_400,
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

    // Бажана площа = площа виділення × множник рівня якості, затиснута між
    // мінімумом API і бюджетом рівня.
    //
    // Чому МНОЖНИК, а не просто площа виділення: генерація з надлишком і
    // зменшення до рамки — це суперсемплінг, він дає чистіший край і дрібні
    // деталі. Раніше тут стояло max(площа, minPx) ДО обмеження бюджетом, і для
    // виділення 1000×600 (0.6 MP < minPx 655 360) усі три рівні якості давали
    // однакове 1120×672 — повзунок був декоративним.
    //
    // Чому не «увесь бюджет на high»: для виділення 40×40 це просило б
    // 2880×2880 = 8.29 MP, тобто гроші за пікселі, які одразу викидаються.
    const AIM = { low: 1, medium: 2, high: 8, xhigh: 8, max: 8, auto: 2 };
    const aim = AIM[quality] ?? AIM.medium;
    const budget = Math.min(QUALITY_BUDGET[quality] ?? QUALITY_BUDGET.medium, maxPx);
    const wantPx = Math.max(minPx, Math.min(budget, target.w * target.h * aim));

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
        // 1K≈1 MP, 2K≈4 MP, 4K≈16 MP
        const px = { '512': 262_144, '1K': 1_048_576, '2K': 4_194_304, '4K': 16_777_216 };
        const order = (caps.imageSizes || ['1K']).slice()
            .sort((a, b) => (px[a] || 0) - (px[b] || 0));

        // Раніше тут брався найбільший розмір, що влазить у бюджет якості. Пороги
        // сходились погано: 1K = 1.05 MP, 2K = 4.19 MP, а бюджети 1.2 / 3 / 8.29 MP —
        // тому low І medium давали однакове 1K, і повзунок був майже декоративним.
        // Рівні Gemini дискретні, тому й вибираємо їх позицією, а не арифметикою.
        const idx = { low: 0, medium: 1, high: order.length - 1,
                      xhigh: order.length - 1, max: order.length - 1, auto: 1 };
        let i = Math.min(idx[quality] ?? 1, order.length - 1);

        // Але не просити безглуздо більше за саму область: для виділення 200×200
        // «висока якість» інакше замовляла б 4K = 16 MP, які одразу викидаються.
        const ceiling = target.w * target.h * 8;
        while (i > 0 && (px[order[i]] || 0) > ceiling) i--;

        return { aspectRatio: bestAspect(target, caps.aspects), imageSize: order[i] };
    }
    return { quality };
}

module.exports = {
    unwrap,
    QUALITY_LADDER,
    coerceQuality,
    integerTarget,
    insetBlendRadius,
    planFrame,
    exactSize,
    bestFixedSize,
    bestAspect,
    planRequest,
    ASPECT_TOL,
    QUALITY_BUDGET,
};

/* ============================================================================
 *  place.js — центральна функція вставки згенерованого зображення.
 *
 *  Принцип: НЕ передбачаємо, куди Photoshop покладе шар. КЛАДЕМО → МІРЯЄМО →
 *  діємо ВІДНОСНО ВИМІРЯНОГО → міряємо знову. Відсоток масштабу тут не є
 *  джерелом похибки саме тому, що знаменник — щойно прочитана рамка, а не
 *  припущення. putPixels не задіяний ніде, тому працює в RGB, CMYK, Grayscale,
 *  8/16/32 біт.
 *  Замінює: main.js:556-661 (getImageDataFromBase64), :779-871
 *  (pasteSingleAsSmartObject), :873-963 (pasteBackImages).
 *
 *  ВИМІРЯНО в Photoshop 27.5.0 (не з документації — Adobe batchPlay-ID не
 *  документує). Кроки 4-5 нижче перенесені дослівно у verify/probe6.jsx і
 *  прогнані: матриця 14 кейсів × RGB 8/16/32, CMYK 8/16, Grayscale 16 ×
 *  300 і 72 ppi × парне/непарне/дробові межі/1×1/cover/поза канвою/
 *  відʼємний початок/збільшення — residual 0 всюди, один прохід на кейс.
 *  Протоколи: verify/probe6.txt (цей алгоритм), verify/probe2-5.txt (як
 *  до нього дійшли). Метрика в консолі — report.residual, мусить бути нулем.
 * ========================================================================== */
const { app, core, imaging, constants } = require('photoshop');
const { batchPlay } = require('photoshop').action;
const uxpStorage = require('uxp').storage;

/**
 * Єдиний дозволений спосіб торкатися imaging у всьому плагіні: dispose у finally
 * структурно неможливо забути, і ImageData не перетинає межу функції.
 * Шлях ВСТАВКИ (нижче) не викликає його жодного разу — саме тому він не падає в
 * CMYK і не тече. Хелпер потрібен лише шляху ЗАХОПЛЕННЯ (capture.js).
 */
async function withPixels(params, fn) {
    const res = await imaging.getPixels(params);
    try { return await fn(res.imageData, res); }
    finally { try { res.imageData.dispose(); } catch (e) { console.warn('[dispose]', e.message); } }
}

/* PNG-хелпери — у png.js (там справжній deflate, а не stored-блоки старого коду). */
const { readPngSize, setPngResolution } = require('./png.js');

function base64ToBytes(b64) {
    const bin = atob(b64.replace(/^data:[^,]+,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/* ── Канал вимірювання ────────────────────────────────────────────────────── */
const PX = v => ({ _unit: 'pixelsUnit', _value: v });
const unwrap = n => (n && typeof n === 'object' && '_value' in n) ? n._value : n;

/**
 * Читає ФАКТИЧНУ рамку Smart Object через smartObjectMore.transform (8 чисел =
 * 4 кути). Це єдиний правдивий канал: layer.bounds віддає лише площу з
 * непрозорими пікселями В МЕЖАХ КАНВИ (для SO 100×100 повертав 62×62), тому
 * прозорі краї AI-картинки й вихід за канву ламають будь-яку корекцію на bounds.
 */
async function readSoFrame() {
    let res;
    try {
        res = await batchPlay([{
            _obj: 'get',
            _target: [
                { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
                { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
            ],
        }], {});
    } catch (e) {
        console.warn('[place] get layer не вдався:', e.message);
        return null;
    }
    const more = res && res[0] && res[0].smartObjectMore;
    if (!more || !more.transform || more.transform.length < 8) return null;
    const q = Array.prototype.slice.call(more.transform, 0, 8).map(unwrap);
    if (q.some(v => typeof v !== 'number' || !isFinite(v))) return null;
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];

    // Перекіс = transform РОЗБІГАЄТЬСЯ з nonAffineTransform. Сама присутність
    // ключа ознакою не є: виміряно в PS 27.5 — одразу після чистого place
    // nonAffineTransform побайтово дублює transform. Перевірка на !!more.
    // nonAffineTransform давала б хибне попередження на КОЖНІЙ вставці.
    let skewed = false;
    if (more.nonAffineTransform && more.nonAffineTransform.length >= 8) {
        const n = Array.prototype.slice.call(more.nonAffineTransform, 0, 8).map(unwrap);
        for (let i = 0; i < 8; i++) {
            if (Math.abs(n[i] - q[i]) > 0.001) { skewed = true; break; }
        }
    }
    return {
        left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
        top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys),
        size: more.size ? { w: unwrap(more.size.width), h: unwrap(more.size.height) } : null,
        skewed,
    };
}

/** Резервний канал, коли smartObjectMore недоступний. Правдивий лише поки шар
 *  повністю в канві й непрозорий — тому позначаємо результат як ненадійний. */
function readLayerFrameFallback(layer, doc) {
    const b = layer.bounds;
    const L = unwrap(b.left), T = unwrap(b.top), R = unwrap(b.right), B = unwrap(b.bottom);
    const clipped = L <= 0 || T <= 0 || R >= doc.width || B >= doc.height;
    return { left: L, top: T, right: R, bottom: B, size: null, skewed: false, unreliable: clipped };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  ДВІ ПРИМІТИВИ ГЕОМЕТРІЇ. Обидві виміряні в живому Photoshop 27.5.0
 *  (див. verify/probe4.txt і verify/probe6.txt): матриця 14 кейсів
 *  × RGB8/CMYK8/CMYK16/RGB16/RGB32/Gray8 × 300 і 72 ppi дала residual 0.
 *
 *  ⚠️ ЧОГО ТУТ БІЛЬШЕ НЕМА І ЧОМУ. Раніше тут стояв `transform` із
 *  `rectangle`→`quadrilateral` — «абсолютне» виставлення чотирьох кутів.
 *  Виміряно: ця команда НІЧОГО НЕ РОБИТЬ. Вона не кидає помилки, повертає
 *  успіх і лишає рамку незмінною — у всіх трьох варіантах одиниць
 *  (pixelsUnit, distanceUnit, голі double). Найгірший вид відмови: ні
 *  винятком, ні статичною перевіркою не ловиться, лише виміром after-стану.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Масштаб у ВІДСОТКАХ від поточної рамки, центр — QCSAverage.
 * Відсоток тут не є джерелом накопичення похибки, бо `pw` рахується не від
 * припущення, а від ЩОЙНО ВИМІРЯНОЇ рамки, і після кроку рамка міряється знову.
 * Photoshop сам прилипає до цілого пікселя: рамка 245.76 при pw=81.7871 %
 * дала рівно 201 (виміряно в RGB 16-біт 72 ppi).
 */
async function scaleSo(pw, ph) {
    // на збільшенні Smoother, на зменшенні Sharper — Photoshop застосовує
    // інтерполяцію до НАТИВНОГО растру SO (size лишався 1024×1024 навіть при
    // масштабі 0.0977 %), тому повторні виклики не деградують якість
    const interp = (pw >= 100 || ph >= 100) ? 'bicubicSmoother' : 'bicubicSharper';
    await batchPlay([{
        _obj: 'transform',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
        freeTransformCenterState: { _obj: 'quadCenterState', _enum: 'quadCenterState', _value: 'QCSAverage' },
        width:  { _unit: 'percentUnit', _value: pw },
        height: { _unit: 'percentUnit', _value: ph },
        interpolation: { _enum: 'interpolationType', _value: interp },
        _options: { dialogOptions: 'dontDisplay' },
    }], {});
}

/**
 * Зсув шару в ПІКСЕЛЯХ.
 *
 * ⚠️ Одиниці критичні. `distanceUnit` (charID `#Rlt`) — це ПУНКТИ (1/72″), і
 * Photoshop перераховує їх через ppi документа: запит на −567 у 300-ppi
 * документі давав −2362 = −567 × 300/72. `pixelsUnit` коректний і на 300, і
 * на 72 ppi — перевірено окремо на обох.
 *
 * Дробові дельти не підтримуються: move(0.25, −0.75) фактично дав (0, −1).
 * Тому округляємо явно — це семантика API, а не втрата точності: після
 * масштабування рамка вже ціла, тому дельта теж ціла.
 */
async function moveSo(dx, dy, layer) {
    const h = Math.round(dx), v = Math.round(dy);
    if (h === 0 && v === 0) return;
    try {
        await batchPlay([{
            _obj: 'move',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            to: { _obj: 'offset', horizontal: PX(h), vertical: PX(v) },
            _options: { dialogOptions: 'dontDisplay' },
        }], {});
    } catch (e) {
        // резерв на DOM — виміряно як рівноцінний
        if (layer) await layer.translate(h, v);
        else throw e;
    }
}

/* ── Преференс «Resize Image During Place» ─────────────────────────────────── */
const PREF_TARGET = [
    { _ref: 'property', _property: 'generalPreferences' },
    { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' },
];
async function getResizeDuringPlace() {
    try {
        const r = await batchPlay([{ _obj: 'get', _target: PREF_TARGET }], {});
        const v = r && r[0] && r[0].generalPreferences && r[0].generalPreferences.resizePastePlace;
        return typeof v === 'boolean' ? v : null;
    } catch (e) { return null; }
}
async function setResizeDuringPlace(value) {
    try {
        await batchPlay([{ _obj: 'set', _target: PREF_TARGET,
            to: { _obj: 'generalPreferences', resizePastePlace: value } }], {});
        return true;
    } catch (e) { console.warn('[place] преференс resizePastePlace не змінився:', e.message); return false; }
}

/* Геометрія — у geometry.js (чистий модуль, протестований у node на 9 випадках). */
const { integerTarget, insetBlendRadius, planFrame } = require('./geometry.js');

/* ══════════════════════════════════════════════════════════════════════════
 *  ГОЛОВНА ФУНКЦІЯ
 *  b64        — PNG у base64 від провайдера
 *  bounds     — межі виділення в пікселях документа (можуть бути дробові)
 *  channelName— альфа-канал зі збереженим виділенням; null = прямокутна маска
 *  opts.maskBounds — початкові межі виділення для гарантованого fallback
 *  Викликати ВСЕРЕДИНІ core.executeAsModal.
 * ═════════════════════════════════════════════════════════════════════════ */
async function placeGeneratedSmartObject(b64, bounds, channelName, opts = {}) {
    const maskFeather = Math.max(0, Number(opts.maskFeather) || 0);
    const doc = app.activeDocument;
    if (!doc) throw new Error('Немає активного документа');

    const target = integerTarget(bounds);
    if (target.w < 1 || target.h < 1) throw new Error(`Порожня цільова область ${target.w}×${target.h}`);

    const png = setPngResolution(base64ToBytes(b64), doc.resolution);
    const nat = readPngSize(png);
    const dst = planFrame(target, nat);

    let tempFile = null;
    let prefWas = null;
    const disposables = [];      // інваріант: усе, що має dispose(), йде сюди
    const report = { mode: dst.mode, nat, target, applied: null, residual: null, warnings: [] };

    try {
        /* 1. PNG на диск + session token. Байти йдуть у Photoshop файлом —
              imaging API не задіяний узагалі, тому CMYK/16/32 біт безпечні. */
        const fs = uxpStorage.localFileSystem;
        const folder = await fs.getTemporaryFolder();
        tempFile = await folder.createFile(`ai_${Date.now()}_${Math.floor(Math.random() * 1e4)}.png`,
            { overwrite: true });
        await tempFile.write(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
            { format: uxpStorage.formats.binary });
        const token = fs.createSessionToken(tempFile);

        /* 2. Гасимо fit-to-canvas: він ЗМЕНШУЄ все, що не влазить у канву.
              Не критично для точності (корекція нижче все одно виправить),
              але без нього SO може приїхати обрізаним по канві. */
        prefWas = await getResizeDuringPlace();
        if (prefWas === true) await setResizeDuringPlace(false);

        /* 3. Place. Позицію й масштаб НЕ намагаємось задати — вони все одно
              залежать від pHYs, преференсів і канви. Нам важливо лише, щоб шар
              з'явився як Smart Object із нативним растром усередині. */
        await batchPlay([{
            _obj: 'placeEvent',
            null: { _path: token, _kind: 'local' },
            linked: false,
            freeTransformCenterState: { _obj: 'quadCenterState', _enum: 'quadCenterState', _value: 'QCSAverage' },
            offset: { _obj: 'offset', horizontal: PX(0), vertical: PX(0) },
            _options: { dialogOptions: 'dontDisplay' },
        }], {});

        const layer = doc.activeLayers[0];
        if (!layer) throw new Error('Place не створив шар');
        try { layer.name = `AI ${new Date().toLocaleTimeString()}`; } catch (e) {}

        /* 4. Скидання трансформацій до нативного 1:1. Виміряно: команда дає
              рівно нативну ширину (4266.667 → 1024) і ПРИ ЦЬОМУ рухає шар —
              нам байдуже, бо крок 5 міряє після. Користь у тому, що вона
              нормалізує і PPI-масштабування, і fit-to-canvas, тому відсоток
              на кроці 5 рахується від нативного растру, а не від обрізаного. */
        try {
            await batchPlay([{ _obj: 'placedLayerResetTransforms',
                _options: { dialogOptions: 'dontDisplay' } }], {});
        } catch (e) { report.warnings.push('placedLayerResetTransforms недоступний'); }

        /* 5. ЗАМИКАННЯ ЗВОРОТНОГО ЗВ'ЯЗКУ: виміряти → масштаб від виміряного →
              виміряти → зсув від виміряного → виміряти. Ніде не використовується
              жодна ПЕРЕДБАЧЕНА величина; кожна дія рахується від щойно
              прочитаної рамки. Виміряно на матриці 14 кейсів: одного проходу
              досить у всіх, другий залишений як страховка. */
        const measure = async () => {
            let f = await readSoFrame();
            if (f) {
                // Гейт правдоподібності: рамка мусить бути ненульова і в межах
                // ±2 канви. Якщо smartObjectMore колись почне віддавати не
                // координати документа — виявиться тут, і ми чесно перейдемо
                // на резервний канал, а не тихо поставимо шар не туди.
                const w = f.right - f.left, h = f.bottom - f.top;
                const sane = w > 0.005 && h > 0.005
                    && f.left > -3 * doc.width && f.right < 4 * doc.width
                    && f.top > -3 * doc.height && f.bottom < 4 * doc.height;
                if (!sane) {
                    report.warnings.push('smartObjectMore.transform неправдоподібний — резерв на layer.bounds');
                    f = null;
                }
            }
            if (!f) {
                f = readLayerFrameFallback(layer, doc);
                if (f.unreliable) report.warnings.push('layer.bounds обрізаний канвою — точність не гарантована');
            }
            return f;
        };

        let cur = await measure();
        if (cur.size && (Math.abs(cur.size.w - nat.w) > 1 || Math.abs(cur.size.h - nat.h) > 1)) {
            report.warnings.push(`smartObjectMore.size ${cur.size.w}×${cur.size.h} ≠ IHDR ${nat.w}×${nat.h}`);
        }
        report.applied = { left: dst.left, top: dst.top, right: dst.right, bottom: dst.bottom };

        const tw = dst.right - dst.left, th = dst.bottom - dst.top;
        const hit = f => Math.abs(dst.left - f.left) < 0.01 && Math.abs(dst.top - f.top) < 0.01
                      && Math.abs(tw - (f.right - f.left)) < 0.01
                      && Math.abs(th - (f.bottom - f.top)) < 0.01;

        for (let pass = 0; pass < 2 && !hit(cur); pass++) {
            const cw = cur.right - cur.left, ch = cur.bottom - cur.top;
            if (cw < 0.005 || ch < 0.005) {
                report.warnings.push(`рамка виродилась (${cw}×${ch}) — масштаб пропущено`);
                break;
            }
            const pw = tw / cw * 100, ph = th / ch * 100;
            if (Math.abs(pw - 100) > 1e-9 || Math.abs(ph - 100) > 1e-9) {
                await scaleSo(pw, ph);
                cur = await measure();
            }
            await moveSo(dst.left - cur.left, dst.top - cur.top, layer);
            cur = await measure();
        }

        report.residual = {
            dx: +(dst.left - cur.left).toFixed(3), dy: +(dst.top - cur.top).toFixed(3),
            dw: +(tw - (cur.right - cur.left)).toFixed(3),
            dh: +(th - (cur.bottom - cur.top)).toFixed(3),
        };
        if (cur.skewed) report.warnings.push('SO має неафінний трансформ (transform ≠ nonAffineTransform)');

        /* 6. Маска шару: показуємо рівно виділення. Для cover це ще й обріз
              надлишку; для exact — захист від субпіксельного краю. */
        const maskTarget = integerTarget(opts.maskBounds || target);
        const maskApplied = await applySelectionMask(channelName, maskTarget, maskFeather);
        report.mask = { applied: maskApplied, source: channelName ? 'selection' : 'rectangle',
            feather: maskFeather };
        if (!maskApplied) throw new Error('Photoshop не створив маску шару');

        console.log('[place]', JSON.stringify(report));
        return report;

    } catch (e) {
        console.error('[place] помилка:', e && e.message);
        throw e;
    } finally {
        // У цьому шляху disposables лишається порожнім — і це головна перемога:
        // ImageData на вставці не створюється взагалі, тому нема чому текти й
        // нема чому падати в CMYK. finally стоїть як інваріант на майбутнє.
        for (const d of disposables) { try { d.dispose(); } catch (e) {} }
        if (prefWas === true) { try { await setResizeDuringPlace(true); } catch (e) {} }
        if (tempFile) { try { await tempFile.delete(); } catch (e) {} }
    }
}

/**
 * Відновлює виділення з альфа-каналу (резерв — прямокутник) і робить маску.
 * Повертає true лише коли команда створення layer mask справді виконалась.
 *
 * feather — ширина ВНУТРІШНЬОГО переходу маски в пікселях. Це ДРУГА маска,
 * не та, що йде в OpenAI: request-маску Gemini не приймає взагалі, а ця
 * працює на боці Photoshop для обох провайдерів.
 *
 * Важливо: звичайний feather симетричний і виходить за межу виділення. Якщо
 * контекст навколо вужчий за feather, напівпрозора маска доходить до фізичного
 * краю Smart Object і там виникає новий різкий шов. Тому contract + feather
 * розміщує весь перехід ВСЕРЕДИНІ початкової області: на її межі AI-шар уже
 * повністю прихований, а в центрі лишається повністю непрозорим.
 */
async function applySelectionMask(channelName, target, feather = 0) {
    const restore = async () => {
        if (channelName) {
            try {
                const channel = app.activeDocument.channels.getByName(channelName);
                await app.activeDocument.selection.load(channel, constants.SelectionType.REPLACE);
                return true;
            } catch (e) {
                console.warn('[place] selection-канал не відновився, беру прямокутник:', e.message);
            }
        }
        try {
            await app.activeDocument.selection.selectRectangle({
                top: target.top, left: target.left,
                bottom: target.bottom, right: target.right,
            }, constants.SelectionType.REPLACE, 0, false);
            return true;
        } catch (e) {
            console.error('[place] прямокутне виділення для маски не створилось:', e.message);
            return false;
        }
    };
    if (!await restore()) return;
    if (feather > 0) {
        // Використовуємо офіційний DOM API (PS 25+), а не сирий batchPlay
        // `_obj: feather`. Останній у PS 27.5 показував системний діалог
        // «Команда Растушевка сейчас недоступна», навіть коли помилку ловив catch.
        //
        // Стискаємо selection перед feather, щоб зовнішній край градієнта
        // закінчився на початковій межі, а не звисав до краю Smart Object.
        try {
            const sel = app.activeDocument.selection;
            const b = sel && sel.bounds;
            if (b) {
                const radius = insetBlendRadius(b, feather);
                if (radius >= 1) {
                    await sel.contract(radius, true);
                    await sel.feather(radius, true);
                    console.log(`[place] внутрішнє змішування: ${radius * 2} px ` +
                                `(contract ${radius} + feather ${radius})`);
                }
            }
        } catch (e) {
            // contract міг змінити selection до помилки feather — відновлюємо
            // вихідну форму, щоб не створити випадково обрізану маску.
            console.warn('[place] внутрішнє змішування не вдалось:', e.message);
            await restore();
        }
    }
    try {
        await batchPlay([{ _obj: 'make', new: { _class: 'channel' },
            at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
            using: { _enum: 'userMaskEnabled', _value: 'revealSelection' } }], {});
    } catch (e) {
        console.error('[place] маска не створилась:', e.message);
        return false;
    }
    await restore();
    return true;
}

module.exports = {
    placeGeneratedSmartObject,
    withPixels,
    // реекспорт для зручності викликачів — реалізації в png.js / geometry.js
    setPngResolution, readPngSize,
    integerTarget, planFrame,
};

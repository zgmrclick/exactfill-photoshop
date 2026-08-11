/* ============================================================================
 *  place.js — центральна функція вставки згенерованого зображення.
 *
 *  Принцип: НЕ передбачаємо, куди Photoshop покладе шар, а КЛАДЕМО, МІРЯЄМО
 *  і ВИСТАВЛЯЄМО рамку в АБСОЛЮТНИХ координатах документа. Жодного відсотка,
 *  жодного центру, жодного putPixels — тому працює в RGB і CMYK, 8/16/32 біт.
 *  Замінює: main.js:556-661 (getImageDataFromBase64), :779-871
 *  (pasteSingleAsSmartObject), :873-963 (pasteBackImages).
 *  Перевірено node --check + 8 геометричних кейсів (див. verify кроку 4).
 * ========================================================================== */
const { app, core, imaging } = require('photoshop');
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
    return {
        left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
        top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys),
        size: more.size ? { w: unwrap(more.size.width), h: unwrap(more.size.height) } : null,
        nonAffine: !!more.nonAffineTransform,
    };
}

/** Резервний канал, коли smartObjectMore недоступний. Правдивий лише поки шар
 *  повністю в канві й непрозорий — тому позначаємо результат як ненадійний. */
function readLayerFrameFallback(layer, doc) {
    const b = layer.bounds;
    const L = unwrap(b.left), T = unwrap(b.top), R = unwrap(b.right), B = unwrap(b.bottom);
    const clipped = L <= 0 || T <= 0 || R >= doc.width || B >= doc.height;
    return { left: L, top: T, right: R, bottom: B, size: null, nonAffine: false, unreliable: clipped };
}

/**
 * АБСОЛЮТНЕ виставлення рамки: rectangle→quadrilateral. Photoshop натягує
 * прямокутник `rectangle` (поточна рамка SO) на чотири кути `quadrilateral`
 * (ЦІЛЬ у координатах документа). Оскільки ціль — абсолютні цілі числа, а не
 * відсоток від поточного стану, помилка не накопичується і не залежить від
 * парності виділення, від docWidth, від того, чи API віддав більше чи менше.
 * Це і є заміна percentUnit-трансформу з main.js:811-831.
 */
async function setSoFrame(cur, dst) {
    await batchPlay([{
        _obj: 'transform',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
        freeTransformCenterState: { _obj: 'quadCenterState', _enum: 'quadCenterState', _value: 'QCSAverage' },
        rectangle: [PX(cur.left), PX(cur.top), PX(cur.right), PX(cur.bottom)],
        quadrilateral: [
            PX(dst.left), PX(dst.top),          // верхній лівий
            PX(dst.right), PX(dst.top),         // верхній правий
            PX(dst.right), PX(dst.bottom),      // нижній правий
            PX(dst.left), PX(dst.bottom),       // нижній лівий
        ],
        interpolation: { _enum: 'interpolationType', _value: 'bicubicSharper' },
        _options: { dialogOptions: 'dontDisplay' },
    }], {});
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
const { integerTarget, planFrame } = require('./geometry.js');

/* ══════════════════════════════════════════════════════════════════════════
 *  ГОЛОВНА ФУНКЦІЯ
 *  b64        — PNG у base64 від провайдера
 *  bounds     — межі виділення в пікселях документа (можуть бути дробові)
 *  channelName— альфа-канал зі збереженим виділенням (для маски); null = без маски
 *  Викликати ВСЕРЕДИНІ core.executeAsModal.
 * ═════════════════════════════════════════════════════════════════════════ */
async function placeGeneratedSmartObject(b64, bounds, channelName) {
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

        /* 4. Скидання трансформацій — СТРАХОВКА, не несуча стіна. Якщо ID у цій
              версії недоступний або нічого не робить — крок 5 все одно доведе. */
        try {
            await batchPlay([{ _obj: 'placedLayerResetTransforms',
                _options: { dialogOptions: 'dontDisplay' } }], {});
        } catch (e) { report.warnings.push('placedLayerResetTransforms недоступний'); }

        /* 5. ЗАМИКАННЯ ЗВОРОТНОГО ЗВ'ЯЗКУ: виміряти → виставити абсолютно →
              перевірити → добити цілим пікселем. */
        let cur = await readSoFrame();
        if (cur && cur.size && (Math.abs(cur.size.w - nat.w) > 1 || Math.abs(cur.size.h - nat.h) > 1)) {
            report.warnings.push(`smartObjectMore.size ${cur.size.w}×${cur.size.h} ≠ IHDR ${nat.w}×${nat.h}`);
        }
        // Гейт правдоподібності: рамка мусить бути ненульова і в межах ±2 канви.
        // Якщо smartObjectMore віддає координати не в системі документа —
        // це виявиться тут, і ми чесно перейдемо на резервний канал.
        if (cur) {
            const w = cur.right - cur.left, h = cur.bottom - cur.top;
            const sane = w > 0.5 && h > 0.5
                && cur.left > -2 * doc.width && cur.right < 3 * doc.width
                && cur.top > -2 * doc.height && cur.bottom < 3 * doc.height;
            if (!sane) { report.warnings.push('smartObjectMore.transform неправдоподібний — резерв на layer.bounds'); cur = null; }
        }
        if (!cur) {
            cur = readLayerFrameFallback(layer, doc);
            if (cur.unreliable) report.warnings.push('layer.bounds обрізаний канвою — точність не гарантована');
        }

        await setSoFrame(cur, dst);
        report.applied = { left: dst.left, top: dst.top, right: dst.right, bottom: dst.bottom };

        // Один перевірочний read. Оскільки виставлення АБСОЛЮТНЕ, другий прохід
        // збігається за один крок — це не ітерація відсотками.
        let after = await readSoFrame();
        if (after) {
            const dw = (dst.right - dst.left) - (after.right - after.left);
            const dh = (dst.bottom - dst.top) - (after.bottom - after.top);
            if (Math.abs(dw) > 0.01 || Math.abs(dh) > 0.01) {
                await setSoFrame(after, dst);
                after = await readSoFrame();
            }
            if (after) {
                const dx = dst.left - after.left, dy = dst.top - after.top;
                if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
                    // translate — документовані ПІКСЕЛІ (не відсотки), тому зсув точний
                    try { await layer.translate(Math.round(dx), Math.round(dy)); } catch (e) {}
                    after = await readSoFrame();
                }
                report.residual = after ? {
                    dx: +(dst.left - after.left).toFixed(3), dy: +(dst.top - after.top).toFixed(3),
                    dw: +((dst.right - dst.left) - (after.right - after.left)).toFixed(3),
                    dh: +((dst.bottom - dst.top) - (after.bottom - after.top)).toFixed(3),
                } : null;
                if (after && after.nonAffine) report.warnings.push('SO отримав неафінний трансформ — перевірити порядок кутів');
            }
        } else {
            report.warnings.push('після трансформу рамку прочитати не вдалось — залишок не виміряний');
        }

        /* 6. Маска шару: показуємо рівно виділення. Для cover це ще й обріз
              надлишку; для exact — захист від субпіксельного краю. */
        if (channelName) await applySelectionMask(channelName, target);

        console.log('[place]', JSON.stringify(report));
        return report;

    } catch (e) {
        console.error('[place] помилка:', e && e.message);
        try { await core.showAlert(`Вставка не вдалась:\n${e && e.message}`); } catch (_) {}
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

/** Відновлює виділення з альфа-каналу (резерв — прямокутник) і робить маску. */
async function applySelectionMask(channelName, target) {
    const restore = async () => {
        try {
            await batchPlay([{ _obj: 'set', _target: { _ref: 'selection' },
                to: { _ref: 'channel', _name: channelName } }], {});
            return true;
        } catch (e) {
            try {
                await batchPlay([{ _obj: 'set', _target: { _ref: 'selection' },
                    to: { _obj: 'rectangle',
                        top: PX(target.top), left: PX(target.left),
                        bottom: PX(target.bottom), right: PX(target.right) } }], {});
                return true;
            } catch (e2) { return false; }
        }
    };
    if (!await restore()) return;
    try {
        await batchPlay([{ _obj: 'make', new: { _class: 'channel' },
            at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
            using: { _enum: 'userMaskEnabled', _value: 'revealSelection' } }], {});
    } catch (e) { console.error('[place] маска не створилась:', e.message); }
    await restore();
}

module.exports = {
    placeGeneratedSmartObject,
    withPixels,
    // реекспорт для зручності викликачів — реалізації в png.js / geometry.js
    setPngResolution, readPngSize,
    integerTarget, planFrame,
};
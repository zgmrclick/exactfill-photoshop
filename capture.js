/* ============================================================================
 *  capture.js — ЄДИНИЙ конвейєр захоплення пікселів. Більше ніде в плагіні
 *  imaging.getPixels не викликається.
 *
 *  Головне правило: ДОКУМЕНТ КОРИСТУВАЧА НЕ ТОРКАЄМО НІКОЛИ.
 *  Старий плагін робив convertMode CMYK→RGB і 16→8 на живому документі, а в
 *  pastePhase ще й повертав назад — необоротно для всього макета: плашка
 *  0/0/0/100 ставала чотириколірним rich black, а сепарацію назад робив робочий
 *  профіль із Color Settings, а не профіль документа. На екрані майже не видно,
 *  вилізає на плівці.
 *
 *  Два шляхи:
 *    RGB / Grayscale / Lab → imaging.getPixels із colorSpace + componentSize.
 *        getPixels документовано КОНВЕРТУЄ («If omitted, then the color space of
 *        the source document is used to convert colors»), а componentSize
 *        (-1|8|16|32) замінює convertMode depth:8 одним полем.
 *    CMYK та решта режимів → через ДУБЛІКАТ документа.
 *        Причина: getPixels/getData() у CMYK ВАЛИТЬ Photoshop (баг-репорт 26.9;
 *        Grayscale/RGB/Lab працюють, Bitmap/Indexed/Multichannel падають
 *        gracefully, CMYK — крашем). Документованого CMYK у imaging немає
 *        взагалі: createImageDataFromBuffer.colorSpace перелічує лише
 *        RGB/Grayscale/Lab.
 * ========================================================================== */

const { app, core, imaging } = require('photoshop');
const { batchPlay } = require('photoshop').action;
const uxpStorage = require('uxp').storage;

const { withPixels } = require('./place.js');
const { buildRectMaskPng, encodePng } = require('./png.js');
const { isolateLayerTree } = require('./layer-tree.js');
const captureI18n = require('./i18n.js');

/** Режими, які imaging API обслуговує безпечно. Решта — через дублікат. */
const SAFE_MODES = ['RGBColorMode', 'grayscaleMode', 'GrayscaleMode', 'labColorMode', 'LabColorMode'];

const isSafeMode = mode => SAFE_MODES.some(m => String(mode).toLowerCase() === m.toLowerCase());

/**
 * Поріг для входу без втрат.
 *
 * Навіщо поріг: JPEG q12 з'їдає дрібний шрифт і контури — модель сумлінно
 * відтворює артефакти, які ми самі й створили. PNG цього не робить. Але наш
 * deflate — fixed-Huffman із RLE лише на distance 1 і rowStride: на однорідній
 * масці це стиснення в сотні разів, на фотографії — майже літерали. Тобто
 * 2000×1500 RGB дасть ~9 МБ і кілька секунд роботи в JS.
 *
 * 2 МП — межа, де це ще швидко. Вище неї PNG пише сам Photoshop через дублікат
 * документа: формат від порогу НЕ залежить, залежить лише виконавець.
 */
const LOSSLESS_MAX_PX = 2_000_000;

/**
 * Складає JPEG із ImageData.
 * encodeImageData вимагає colorSpace === 'RGB', тому 4 компоненти (RGBA) треба
 * звести до 3. Арифметики бітності тут НЕМА свідомо: ми просимо componentSize:8
 * у getPixels, тому старий баг (16→8 через >>8 при діапазоні [0..32768], що
 * давало вдвічі темніше зображення) неможливий за побудовою.
 */
async function imageDataToJpegBlob(imageData) {
    let toEncode = imageData;
    let temp = null;

    if (imageData.components === 4) {
        const src = await imageData.getData();
        const count = imageData.width * imageData.height;
        const rgb = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            rgb[i * 3]     = src[i * 4];
            rgb[i * 3 + 1] = src[i * 4 + 1];
            rgb[i * 3 + 2] = src[i * 4 + 2];
        }
        temp = await imaging.createImageDataFromBuffer(rgb, {
            width: imageData.width,
            height: imageData.height,
            components: 3,
            componentSize: 8,
            colorSpace: 'RGB',
            chunky: true,
        });
        toEncode = temp;
    }

    try {
        const encoded = await imaging.encodeImageData({ imageData: toEncode });
        const bytes = encoded instanceof Uint8Array ? encoded : Uint8Array.from(encoded);
        return new Blob([bytes], { type: 'image/jpeg' });
    } finally {
        if (temp) { try { temp.dispose(); } catch (e) {} }
    }
}

/**
 * Складає PNG із ImageData нашим кодером — вхід без втрат.
 * Альфу відкидаємо: провайдеру вона не потрібна, а 3 компоненти замість 4 —
 * на чверть менше байтів у deflate.
 */
async function imageDataToPngBlob(imageData) {
    const src = await imageData.getData();
    const w = imageData.width, h = imageData.height;
    const comps = imageData.components;
    let rgb;
    if (comps === 3) {
        rgb = src instanceof Uint8Array ? src : Uint8Array.from(src);
    } else if (comps === 4) {
        const count = w * h;
        rgb = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            rgb[i * 3]     = src[i * 4];
            rgb[i * 3 + 1] = src[i * 4 + 1];
            rgb[i * 3 + 2] = src[i * 4 + 2];
        }
    } else if (comps === 1) {
        // Grayscale-документ: розгортаємо в RGB, бо провайдери чекають колір
        const count = w * h;
        rgb = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            const v = src[i];
            rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
        }
    } else {
        throw new Error(captureI18n.t('capture.components', { count: comps }));
    }
    const t0 = Date.now();
    const png = encodePng(rgb, w, h, 3);
    console.log(`[capture] PNG ${w}×${h}: ${(png.length / 1048576).toFixed(2)} МБ ` +
                `за ${Date.now() - t0} мс`);
    return new Blob([png], { type: 'image/png' });
}

/** Прямий шлях — документ не змінюється жодним чином. */
async function captureDirect(bounds, useLayerOnly, lossless) {
    const params = {
        sourceBounds: {
            left: bounds.left, top: bounds.top,
            right: bounds.right, bottom: bounds.bottom,
        },
        applyAlpha: false,
        colorSpace: 'RGB',
        // без явного профілю конверсія недетермінована — відомий симптом
        // «black or negative type of image colors»
        colorProfile: 'sRGB IEC61966-2.1',
        componentSize: 8,
    };
    if (useLayerOnly) {
        const layer = app.activeDocument.activeLayers[0];
        if (layer) params.layerID = layer.id;
    }
    return withPixels(params, lossless ? imageDataToPngBlob : imageDataToJpegBlob);
}

/**
 * Шлях через дублікат: конвертуємо КОПІЮ, зберігаємо JPEG, копію закриваємо.
 * imaging тут не задіяний узагалі, тому CMYK не має де впасти.
 */
async function captureViaDuplicate(bounds, useLayerOnly, lossless) {
    const doc = app.activeDocument;
    let dup = null;
    let file = null;
    try {
        dup = await doc.duplicate();

        if (useLayerOnly) {
            // Не видаляємо верхньорівневі шари: активний шар може бути
            // вкладений у групу. Ізолюємо його гілку видимістю на копії.
            const keep = dup.activeLayers[0];
            if (!keep || !isolateLayerTree(dup.layers, keep.id)) {
                throw new Error(captureI18n.t('capture.layerMissing'));
            }
        }

        // ЗАПОБІЖНИК. convertMode без _target діє на АКТИВНИЙ документ. Якщо
        // duplicate() чомусь не зробив копію активною, ми б сконвертували
        // документ користувача — той самий необоротний CMYK→RGB, від якого
        // тікали. Тому перевіряємо явно і краще відмовимось, ніж зіпсуємо макет.
        if (!app.activeDocument || app.activeDocument.id !== dup.id) {
            throw new Error(captureI18n.t('capture.copyInactive'));
        }
        const onDup = [{ _ref: 'document', _id: dup.id }];

        // Спершу режим і бітність, потім кроп: convertMode на меншому полотні
        // дешевший, але кроп ДО конверсії міняє bounds, тому порядок саме такий.
        if (!isSafeMode(dup.mode)) {
            await batchPlay([{
                _obj: 'convertMode',
                _target: onDup,
                to: { _class: 'RGBColorMode' },
                merge: false, flatten: false,
                _options: { dialogOptions: 'dontDisplay' },
            }], {});
        }
        if (dup.bitsPerChannel !== 8) {
            await batchPlay([{ _obj: 'convertMode', _target: onDup, depth: 8,
                _options: { dialogOptions: 'dontDisplay' } }], {});
        }

        await dup.crop({
            left: bounds.left, top: bounds.top,
            right: bounds.right, bottom: bounds.bottom,
        });

        const folder = await uxpStorage.localFileSystem.getTemporaryFolder();
        // PNG пише сам Photoshop — наш кодер тут не задіяний, тому поріг
        // швидкості на цей шлях не поширюється взагалі.
        if (lossless) {
            file = await folder.createFile(`cap_${Date.now()}.png`, { overwrite: true });
            await dup.saveAs.png(file, { compression: 6, interlaced: false }, true);
            const buf = await file.read({ format: uxpStorage.formats.binary });
            return new Blob([buf], { type: 'image/png' });
        }
        file = await folder.createFile(`cap_${Date.now()}.jpg`, { overwrite: true });
        await dup.saveAs.jpg(file, { quality: 12 }, true);

        const buf = await file.read({ format: uxpStorage.formats.binary });
        return new Blob([buf], { type: 'image/jpeg' });

    } finally {
        if (dup) { try { await dup.closeWithoutSaving(); } catch (e) {
            console.error('[capture] копія документа не закрилась:', e.message);
        } }
        if (file) { try { await file.delete(); } catch (e) {} }
    }
}

/**
 * Захоплює виділену область як JPEG.
 * Викликати ВСЕРЕДИНІ core.executeAsModal.
 *
 * @param {{left,top,right,bottom}} bounds — цілі межі (geometry.integerTarget)
 * @param {boolean} useLayerOnly — лише активний шар замість зведеного
 * @param {boolean} wantLossless — просити PNG замість JPEG. Вище LOSSLESS_MAX_PX
 *        це означає шлях через дублікат, а НЕ мовчазне повернення до JPEG.
 * @param {boolean} requirePng — PNG обов'язковий: у запит іде маска, а OpenAI вимагає
 *        однаковий формат входу й маски. Практично рівносильний wantLossless;
 *        лишається окремим, бо це вимога протоколу, а не побажання користувача.
 * @returns {Promise<{blob:Blob, docMode:string, bpc:number, viaDuplicate:boolean, lossless:boolean}>}
 */
async function captureRegion(bounds, useLayerOnly = false, wantLossless = true,
                             requirePng = false) {
    const doc = app.activeDocument;
    if (!doc) throw new Error(captureI18n.t('capture.noDocument'));

    const docMode = String(doc.mode);
    const bpc = doc.bitsPerChannel;
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    if (w < 1 || h < 1) {
        throw new Error(captureI18n.t('capture.emptyArea', { width: w, height: h }));
    }

    const lossless = wantLossless || requirePng;
    /* Поріг стосується лише НАШОГО JS-кодера (fixed-Huffman без справжнього
       deflate): на фотографії 2000×1500 він дає ~9 МБ і кілька секунд у JS.
       Photoshop свій PNG пише сам і жодного порогу не потребує.

       ⚠️ РАНІШЕ ТУТ БУЛА ТИХА ВТРАТА ФУНКЦІЇ: вище порогу галка «вхід без втрат»
       мовчки ставала JPEG — але лише коли маска не потрібна. Тобто той самий
       перемикач працював чи ні залежно від зовсім іншого налаштування (відсотка
       контексту). Тепер поріг не скасовує вибір користувача, а лише перемикає
       ВИКОНАВЦЯ: вище нього PNG пише Photoshop через дублікат документа. */
    const viaDuplicateOnly = lossless && w * h > LOSSLESS_MAX_PX;
    if (viaDuplicateOnly) {
        console.log(`[capture] ${w}×${h} = ${(w * h / 1e6).toFixed(1)} МП — вище порогу ` +
                    `${LOSSLESS_MAX_PX / 1e6} МП для власного кодера: PNG пише Photoshop ` +
                    'через дублікат документа');
    }

    if (!viaDuplicateOnly && isSafeMode(docMode)) {
        try {
            const blob = await captureDirect(bounds, useLayerOnly, lossless);
            return { blob, docMode, bpc, viaDuplicate: false, lossless };
        } catch (e) {
            // Відома регресія: componentSize:8 із 16-бітного документа кидає
            // «Photoshop Error. Code: -1» починаючи з PS 26.3 (у 25.0 працювало).
            // Вручну 16→8 НЕ конвертуємо — саме там був баг подвійного затемнення.
            console.warn(`[capture] прямий шлях не вдався (${e.message}) — через дублікат`);
        }
    }

    const blob = await captureViaDuplicate(bounds, useLayerOnly, lossless);
    return { blob, docMode, bpc, viaDuplicate: true, lossless };
}

/**
 * Маска для запиту — або null із поясненням, ЧОМУ її нема.
 *
 * ⚠️ ІНВАРІАНТ, ЗАРАДИ ЯКОГО ЦЕ ОКРЕМА ФУНКЦІЯ: маска їде ЛИШЕ разом із
 * PNG-входом. OpenAI вимагає, щоб вхід і маска були одного формату, і
 * розбіжність сервер НЕ відхиляє — він мовчки ігнорує маску, а модель
 * перемальовує весь кадр. Симптом у користувача: «модель не бачить виділення».
 * Тому краще свідомо втратити маску й записати причину, ніж відправити запит,
 * який тихо зробить не те.
 *
 * Раніше це жило рядками всередині onGenerate, і єдиним гейтом був регекс по
 * тексту main.js у platform.test.js. Тепер інваріант перевіряється як функція.
 *
 * @returns {{blob: Blob|null, bytes: number, reason: string}} reason непорожній
 *          рівно тоді, коли маски не буде
 */
function maskForRequest({ ctx, target, feather = 0, input }) {
    if (!input) return { blob: null, bytes: 0, reason: 'входу нема — маска ні до чого' };
    if (input.type !== 'image/png') {
        return { blob: null, bytes: 0,
                 reason: `вхід ${input.type}, а не PNG: OpenAI вимагає однаковий формат входу й маски` };
    }
    try {
        const png = buildRectMaskPng(ctx.w, ctx.h, {
            left: target.left - ctx.left, top: target.top - ctx.top,
            right: target.right - ctx.left, bottom: target.bottom - ctx.top,
        }, feather);
        return { blob: new Blob([png], { type: 'image/png' }), bytes: png.length, reason: '' };
    } catch (e) {
        return { blob: null, bytes: 0, reason: `маска не побудована: ${e.message}` };
    }
}

module.exports = { captureRegion, buildRectMaskPng, maskForRequest, isSafeMode, LOSSLESS_MAX_PX };

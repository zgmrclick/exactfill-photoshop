/* ============================================================================
 *  providers/openai.js — провайдер OpenAI (gpt-image-*).
 *
 *  Викинуто проти старого openAiSdk.js:
 *    • generateImageWithContext + увесь шлях /v1/responses — імпортувався, але
 *      не викликався НІДЕ (rg давав одне попадання — сам import)
 *    • refinePrompt, generateChat — мертві фічі, які користувач не використовує
 *    • OPENAI_IMAGE2_SIZES / OPENAI_IMAGE1_SIZES — декларації, що нічого
 *      не валідували; тепер обмеження живуть у caps і споживаються geometry.js
 *
 *  Ключове: gpt-image-2 приймає ДОВІЛЬНИЙ розмір (кратний 16, edge ≤3840,
 *  ratio ≤3:1, сума пікселів 655 360…8 294 400). Тому просимо рівно розмір
 *  виділення — і ресемпл при вставці стає косметичним замість масштабування
 *  всього кадру. Старий код сам відмовлявся це робити: поріг «≥1 MP» був
 *  хибний, а на quality=high preferLarge свідомо брав найбільший кандидат.
 * ========================================================================== */

const { buildMultipart, request, requestStream, withRetry, HttpError } = require('./http.js');
const openAiI18n = require('../i18n.js');

const BASE = 'https://api.openai.com/v1/';
const PARTIAL_IMAGES = 3;

/* ── Можливості моделей ────────────────────────────────────────────────────── *
 * ⚠️ caps — ЄДИНА декларація того, що модель уміє. Її читають geometry.js
 * (розмір запиту), main.js (які кнопки якості малювати) і editImage нижче (які
 * поля класти в multipart). Раніше частина цього знання жила рядковими
 * винятками на кшталт `if (model !== 'gpt-image-2')`, і кожна нова модель
 * вимагала правок у чотирьох файлах. Тепер нова модель — це один рядок MODELS.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Геометричні можливості — читає geometry.js, не хардкодить сам.
 *
 * `stablePx` — межа, вище якої документація OpenAI називає результат
 * експериментальним (понад 2560×1440). Запит проходить, але саме тут і
 * найдорожче, і найменш передбачувано, тому картка плану про це попереджає.
 */
const ARBITRARY = {
    arbitrary: true, step: 16, maxEdge: 3840,
    minPx: 655360, maxPx: 8294400, maxRatio: 3,
    stablePx: 2560 * 1440,
};
const FIXED = {
    arbitrary: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
};

/**
 * Рівні якості. Порядок = зростання витрат; UI малює саме в ньому.
 * ⚠️ xhigh і max приймає ЛИШЕ gpt-image-2.5. Надіслати їх старій моделі — це
 * HTTP 400, тому список обов'язково їде разом із моделлю, а не глобально.
 */
const Q_CLASSIC  = ['low', 'medium', 'high', 'auto'];
const Q_EXTENDED = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

const caps = (geometry, extra) => ({ ...geometry, ...extra });

/**
 * `inputFidelity` — чи класти в запит `input_fidelity: high`.
 * gpt-image-2 і 2.5 обробляють вхід на високій точності самі, а параметр їм
 * невідомий і валить запит. Старі моделі без нього гірше тримають вхідні
 * пікселі, тому там він потрібен.
 */
/*
 * `hintKey` — ключ i18n, який main.js кладе в title пікера. Самі назви
 * «Sunburst» і «Flare» нічого не кажуть про різницю, а перекладати їх не можна:
 * це офіційні ідентифікатори, які користувач бачить у панелі OpenAI.
 */
const MODELS = [
    { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', hintKey: 'model.sunburst',
      caps: caps(ARBITRARY, { qualities: Q_EXTENDED, inputFidelity: false }) },
    { id: 'gpt-image-2.5-flare',    label: 'GPT Image 2.5 Flare',    hintKey: 'model.flare',
      caps: caps(ARBITRARY, { qualities: Q_EXTENDED, inputFidelity: false }) },
    { id: 'gpt-image-2',            label: 'GPT Image 2',
      caps: caps(ARBITRARY, { qualities: Q_CLASSIC,  inputFidelity: false }) },
    { id: 'gpt-image-1.5',          label: 'GPT Image 1.5',
      caps: caps(FIXED,     { qualities: Q_CLASSIC,  inputFidelity: true }) },
    { id: 'gpt-image-1',            label: 'GPT Image 1',
      caps: caps(FIXED,     { qualities: Q_CLASSIC,  inputFidelity: true }) },
    { id: 'gpt-image-1-mini',       label: 'GPT Image 1 mini',
      caps: caps(FIXED,     { qualities: Q_CLASSIC,  inputFidelity: true }) },
];

/** Незнайома модель: найобережніші припущення, а не найзручніші. */
const UNKNOWN_CAPS = caps(FIXED, { qualities: Q_CLASSIC, inputFidelity: false });

function authHeader(apiKey) {
    // ключ ніде не логуємо — навіть частково
    return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Перелік моделей.
 *
 * CAPS СТАТИЧНІ І ЛИШАЮТЬСЯ ТАКИМИ: /v1/models віддає сотні записів, у яких
 * немає ні розмірів, ні рівнів якості, а вгадувати їх за назвою — гадання.
 * Нову модель усе одно треба вписати в MODELS разом із caps.
 *
 * ⚠️ І КАТАЛОГ /v1/models ТУТ НЕ ПИТАЄМО — ЦЕ ВИСНОВОК З ВИМІРУ (2026-09-09).
 * Того дня тут побували дві версії перевірки доступності: спершу фільтр (чого
 * немає в каталозі — прибрати з пікера), потім помʼякшена позначка `listed`.
 * Обидві прибрані, бо проба самого ендпоінта генерації показала, що
 * gpt-image-2.5-sunburst і -flare ПРАЦЮЮТЬ на ключі, якого немає в каталозі.
 * Фільтр сховав би дві робочі моделі; позначка попереджала б про вигадану
 * проблему. /v1/models відповідає на питання «що OpenAI перелічує», а не «що
 * цьому ключу дозволено» — це різні речі, і друге питання має рівно одну
 * авторитетну адресу: той ендпоінт, яким ти справді користуєшся.
 *
 * Що лишилось замість перевірки: explainModelError() нижче робить справжню
 * відмову зрозумілою. Діагностика доступу — verify/check-models.sh, крок 2
 * (безкоштовна проба з контролями).
 *
 * @param {string|null} _apiKey — не використовується; параметр є заради
 *        єдиного інтерфейсу з google.js, де ListModels справді залежить
 *        від ключа і є там джерелом правди.
 */
async function models(_apiKey) {
    return MODELS.map(m => ({ ...m }));
}

/**
 * Перетворює «404 model_not_found» на пояснення українською/англійською.
 *
 * ⚠️ Друга половина рішення «не ховати, а пояснювати» (2026-09-09). Прибрати
 * модель із пікера легко — але тоді разом із пунктом зникає й причина, і
 * користувач не має ЖОДНОГО способу дізнатись, що сталося. Тому пункт лишаємо,
 * а натомість зобовʼязані зробити відмову зрозумілою: ID правильний, модель
 * існує, бракує саме доступу для цього ключа.
 *
 * Чужі помилки повертаються тим самим обʼєктом — і це перевіряє тест: обгортка,
 * що «на всяк випадок» переписує все підряд, ховає справжню причину так само
 * надійно, як прибраний пункт пікера.
 */
function explainModelError(e, model) {
    if (!e || e.status !== 404) return e;
    const looksLikeModel = e.code === 'model_not_found'
        || /does not exist or you do not have access/i.test(e.message || '');
    if (!looksLikeModel) return e;
    const out = new HttpError(404, openAiI18n.t('error.modelNotOpen', { model }));
    out.code = 'model_not_found';
    return out;
}

function capsFor(modelId) {
    const m = MODELS.find(x => x.id === modelId);
    return m ? m.caps : UNKNOWN_CAPS;
}

/** Витягує base64 PNG із відповіді, або кидає читабельну помилку. */
function extractImages(json, n) {
    if (!json || !Array.isArray(json.data)) {
        throw new HttpError(0, openAiI18n.t('provider.openaiNoData'));
    }
    const out = [];
    for (const item of json.data) {
        if (item && typeof item.b64_json === 'string') out.push(item.b64_json);
        else if (item && item.url) {
            throw new HttpError(0, openAiI18n.t('provider.openaiUrl'));
        }
    }
    if (!out.length) {
        const refusal = json.data[0]?.revised_prompt ? openAiI18n.t('provider.openaiRewritten') : '';
        throw new HttpError(0, openAiI18n.t('provider.openaiNoImages', { refusal }));
    }
    return out.slice(0, n);
}

const blobName = (blob, i) => {
    const t = (blob && blob.type) || 'image/png';
    const ext = t.includes('jpeg') ? 'jpg' : t.includes('webp') ? 'webp' : 'png';
    return { filename: `img${i}.${ext}`, contentType: t };
};

/**
 * Спільний читач SSE для /images/edits і /images/generations.
 * OpenAI віддає до трьох partial-подій, потім одну completed-подію.
 */
async function readImageStream({ url, headers, body, signal, onPartial,
                                 partialType, completedType }) {
    let done = null;
    const last = await requestStream(url, { method: 'POST', headers, body, signal }, ev => {
        if (!ev || !ev.type) return;
        if (ev.type === partialType && ev.b64_json) {
            onPartial(ev.b64_json, ev.partial_image_index);
        } else if (ev.type === completedType) {
            done = ev;
        } else if (ev.type === 'error' || ev.error) {
            throw new HttpError(0, ev.error?.message || openAiI18n.t('provider.openaiStreamError'));
        }
    });
    const fin = done || last;
    if (!fin || fin.type !== completedType || !fin.b64_json) {
        throw new HttpError(0, openAiI18n.t('provider.openaiStreamIncomplete'));
    }
    return { images: [fin.b64_json], usage: fin.usage || null };
}

/**
 * Редагування наявних пікселів — основний шлях плагіна.
 *
 * imageBlob — захоплена область (PNG без втрат або JPEG, див. capture.js).
 * references — додаткові зображення-референси; API приймає масив `image[]`
 * (задокументований приклад — кошик подарунків із чотирьох файлів). Маска
 * застосовується до ПЕРШОГО зображення, тому наша область іде першою.
 * onPartial — якщо задано, просимо stream:true і віддаємо проміжні кадри
 * (події `image_edit.partial_image`).
 */
async function editImage({ apiKey, model, prompt, imageBlob, maskBlob, references,
                          plan, background, signal, onPartial }) {
    const modelCaps = capsFor(model);
    const fields = [
        { name: 'model',  data: model },
        { name: 'prompt', data: prompt },
        { name: 'output_format', data: 'png' },
    ];

    const imgs = [imageBlob].concat(references || []).filter(Boolean);
    if (imgs.length === 1) {
        const meta = blobName(imgs[0], 0);
        fields.push({ name: 'image', data: imgs[0], ...meta });
    } else {
        // масив лишаємо лише коли він справді потрібен: одиночний `image`
        // працює давно й перевірено, а `image[]` — новіша форма
        imgs.forEach((b, i) => fields.push({ name: 'image[]', data: b, ...blobName(b, i) }));
    }

    if (plan.size)  fields.push({ name: 'size', data: plan.size });
    if (plan.quality && plan.quality !== 'auto') {
        fields.push({ name: 'quality', data: plan.quality });
    }
    if (maskBlob) {
        fields.push({ name: 'mask', data: maskBlob, filename: 'mask.png', contentType: 'image/png' });
    }
    if (background) fields.push({ name: 'background', data: background });
    // input_fidelity знають лише моделі покоління 1.x. gpt-image-2 і 2.5 і так
    // тримають вхід на високій точності, а сам параметр їм невідомий і валить
    // запит — тому рішення живе в caps моделі, а не в перевірці її назви.
    if (modelCaps.inputFidelity) {
        fields.push({ name: 'input_fidelity', data: 'high' });
    }
    if (onPartial) {
        fields.push({ name: 'stream', data: 'true' });
        // За замовчуванням partial_images=0: сервер тоді надсилає лише completed.
        fields.push({ name: 'partial_images', data: String(PARTIAL_IMAGES) });
    }

    const { body, contentType } = await buildMultipart(fields);
    const headers = { ...authHeader(apiKey), 'Content-Type': contentType };
    const url = `${BASE}images/edits`;

    if (onPartial) {
        return readImageStream({
            url, headers, body, signal, onPartial,
            partialType: 'image_edit.partial_image',
            completedType: 'image_edit.completed',
        });
    }

    const json = await request(url, { method: 'POST', headers, body, signal });
    return { images: extractImages(json, 1), usage: json.usage || null };
}

/** Генерація з нуля — коли пікселі свідомо ігноруються. */
async function generateFresh({ apiKey, model, prompt, plan, background, signal, onPartial }) {
    const payload = { model, prompt, n: 1, output_format: 'png' };
    if (plan.size) payload.size = plan.size;
    if (plan.quality && plan.quality !== 'auto') payload.quality = plan.quality;
    if (background) payload.background = background;

    if (onPartial) {
        payload.stream = true;
        payload.partial_images = PARTIAL_IMAGES;
    }

    const url = `${BASE}images/generations`;
    const headers = { ...authHeader(apiKey), 'Content-Type': 'application/json' };
    const body = JSON.stringify(payload);

    if (onPartial) {
        return readImageStream({
            url, headers, body, signal, onPartial,
            partialType: 'image_generation.partial_image',
            completedType: 'image_generation.completed',
        });
    }

    const json = await request(url, {
        method: 'POST',
        headers,
        body,
        signal,
    });
    return { images: extractImages(json, 1), usage: json.usage || null };
}

/**
 * Єдиний вихід контракту: { images: [base64 PNG], usage }.
 * usage приходить від самого API (input_tokens / output_tokens / image_tokens),
 * а usage.js оцінює USD за версіонованою таблицею офіційних тарифів.
 */
async function generate({ apiKey, model, prompt, imageBlob, maskBlob, references,
                          plan, background, ignorePixels, signal, onPartial, onProgress }) {
    if (!apiKey) throw new Error(openAiI18n.t('provider.noKey', { provider: 'OpenAI' }));
    if (!prompt || !prompt.trim()) throw new Error(openAiI18n.t('provider.emptyPrompt'));

    // Запобіжник, а не основний механізм: рівень якості вже узгоджено з моделлю
    // в UI. Але між вибором і запитом користувач міг перемкнути модель, а
    // `xhigh`/`max` знає лише 2.5 — сервер відповів би 400 замість картинки.
    const allowed = capsFor(model).qualities;
    if (plan && plan.quality && allowed && !allowed.includes(plan.quality)) {
        console.warn(`[openai] ${model} не приймає quality=${plan.quality} — прошу без нього`);
        plan = { ...plan, quality: 'auto' };
    }

    if (onProgress) onProgress(openAiI18n.t('provider.generating'));
    const useEdit = imageBlob && !ignorePixels;
    // «модель не бачить виділену область» діагностується лише цим рядком:
    // без нього неможливо відрізнити редагування від генерації з нуля
    console.log(`[openai] ${useEdit ? 'images/edits' : 'images/generations (БЕЗ пікселів області)'}` +
                `${imageBlob ? `, вхід ${(imageBlob.size / 1024).toFixed(0)} КБ` : ', входу немає'}` +
                `${useEdit && maskBlob ? ', маска є' : ''}${ignorePixels ? ', «ігнорувати пікселі» увімкнено' : ''}`);
    let res;
    try {
        res = await withRetry(() => (useEdit
            ? editImage({ apiKey, model, prompt, imageBlob, maskBlob, references,
                          plan, background, signal, onPartial })
            : generateFresh({ apiKey, model, prompt, plan, background, signal, onPartial })), { signal });
    } catch (e) {
        // Єдина точка, де відомі й модель, і помилка — тому пояснення саме тут.
        throw explainModelError(e, model);
    }
    if (onProgress) onProgress(openAiI18n.t('provider.done'));
    return res;
}

module.exports = {
    id: 'openai',
    label: 'OpenAI',
    keyName: 'openAiApiKey',
    supportsMask: true,
    supportsReferences: true,
    supportsTransparent: true,
    supportsStream: true,
    keyPage: 'https://platform.openai.com/api-keys',
    models,
    explainModelError,
    capsFor,
    generate,
};

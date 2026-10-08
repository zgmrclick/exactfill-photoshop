/* ============================================================================
 *  providers/google.js — провайдер Google (Gemini image).
 *
 *  Викинуто проти старого googleAiSdk.js:
 *    • увесь Imagen (imagen-3.0-generate-001 / -fast-) — вимкнений 2026-08-17
 *    • gemini-1.5-pro/flash-latest, gemini-2.0-flash-exp — мертві
 *    • ключ у query-рядку URL (`?key=…`) — це витік у логи проксі й у
 *      діагностику; тепер заголовок x-goog-api-key
 *
 *  Повернуто: generationConfig.imageConfig.{aspectRatio,imageSize}. Коментар у
 *  старому коді «не документоване поле Gemini API, прибрано» — хибний: поле
 *  живе, imageSize пише ВЕЛИКУ «K» ('1K'|'2K'|'4K'). 400-ку в минулому давала
 *  або мала «k», або модель, що тримає лише 1K.
 *
 *  Оскільки форма конфігу в Gemini API рухається (imageConfig → responseFormat),
 *  тут НЕ вгадуємо: пробуємо з конфігом, і при 400 про нього повторюємо без
 *  нього. Краще втратити керування розміром, ніж усю генерацію.
 * ========================================================================== */

const { blobToBase64, request, withRetry, HttpError } = require('./http.js');
const googleI18n = require('../i18n.js');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/';

/** Gemini не приймає пікселі — лише співвідношення сторін і рівень розміру. */
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/**
 * `qualities` тут не їде в запит — Gemini рівня якості не приймає взагалі.
 * Але той самий перемикач у панелі обирає imageSize (див. geometry.planRequest),
 * тому список має бути оголошений: main.js малює кнопки з caps, а не з
 * глобальної константи. `xhigh`/`max` — суто OpenAI 2.5, тут їх немає.
 */
const Q_CLASSIC = ['low', 'medium', 'high', 'auto'];

/**
 * Панорамні формати модель-сторінка 2.1 називає прямо (там виправлено
 * артефакти тайлінгу на 2K/4K). Старшим моделям їх не додаємо: якщо API
 * відкине формат, callWithFallback повторить запит уже БЕЗ керування розміром.
 */
const ASPECTS_WIDE = ASPECTS.concat(['1:4', '4:1', '1:8', '8:1']);

const CAPS_PRO   = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K', '2K', '4K'], qualities: Q_CLASSIC };
const CAPS_FLASH = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K', '2K'], qualities: Q_CLASSIC };
const CAPS_NB21  = { arbitrary: false, aspects: ASPECTS_WIDE, imageSizes: ['1K', '2K', '4K'], qualities: Q_CLASSIC };
// «only supports 1K resolution» — документація image-generation, 2026-10
const CAPS_LITE  = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K'], qualities: Q_CLASSIC };

/**
 * Порядок — це вибір за замовчуванням: main.js бере list[0], коли збереженої
 * моделі в переліку немає. Тому найновіша рекомендована модель стоїть першою.
 * Підписи збігаються з displayName у ListModels, щоб пункт не перейменовувався,
 * коли перелік приходить із мережі замість вбудованого.
 *
 * gemini-3.1-flash-image (Nano Banana 2) Google вимикає 2026-10-29; коли вона
 * зникне з ListModels, збережений вибір сам перескочить на list[0], тобто 2.1.
 */
const FALLBACK_MODELS = [
    { id: 'models/gemini-nano-banana-2.1',      label: 'Nano Banana 2.1',     caps: CAPS_NB21 },
    { id: 'models/gemini-3-pro-image',          label: 'Nano Banana Pro',     caps: CAPS_PRO },
    { id: 'models/gemini-3.1-flash-image',      label: 'Nano Banana 2',       caps: CAPS_FLASH },
    { id: 'models/gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite',  caps: CAPS_LITE },
];

/**
 * Вимкнені Google, але ListModels їх ще перелічує (виміряно 2026-10-08).
 * gemini-2.5-flash-image — shutdown 2026-10-02 за сторінкою цін; стояла першою
 * в каталозі, тобто ставала моделлю за замовчуванням для нового ключа.
 */
const RETIRED = new Set(['models/gemini-2.5-flash-image']);

const authHeaders = apiKey => ({
    'x-goog-api-key': apiKey,          // НЕ в query-рядку — щоб не текло в логи
    'Content-Type': 'application/json',
});

/**
 * Динамічний перелік — корисна ідея зі старого плагіна: моделі Google
 * змінюються швидко, і статичний список старіє. При збої тихо падаємо на
 * FALLBACK_MODELS, бо без переліку UI просто порожній.
 */
async function models(apiKey) {
    if (!apiKey) return FALLBACK_MODELS.map(m => ({ ...m }));
    try {
        const json = await request(`${BASE}models`, { headers: authHeaders(apiKey), timeoutMs: 20000 });
        const found = pickImageModels((json && json.models) || []);
        if (found.length) return found;
    } catch (e) {
        console.warn('[google] перелік моделей не отримано, беремо вбудований:', e.message);
    }
    return FALLBACK_MODELS.map(m => ({ ...m }));
}

/**
 * Відповідь ListModels → пункти пікера. Чиста функція, щоб тест годував її
 * справжнім знімком каталогу без підміни мережі.
 *
 * ⚠️ Ознака «-image» в ID більше не достатня: Nano Banana 2.1 має ID
 * `gemini-nano-banana-2.1` без цього суфікса, і старий фільтр ховав її мовчки.
 */
function pickImageModels(list) {
    const found = [];
    for (const m of list) {
        const name = String(m.name || '');
        const low = name.toLowerCase();
        // лише генератори зображень; Imagen свідомо не беремо — вимкнений
        if (!low.includes('-image') && !low.includes('nano-banana')) continue;
        if (low.includes('imagen')) continue;
        if (RETIRED.has(name)) continue;
        const methods = m.supportedGenerationMethods || m.supported_generation_methods;
        if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
        found.push({
            id: name,
            label: (m.displayName || name.replace(/^models\//, '')),
            caps: capsFor(name),
        });
    }
    // Каталог дублює GA-моделі preview-аліасами з ТІЄЮ САМОЮ назвою
    // (три пункти «Nano Banana Pro»). Розрізнити їх у пікері неможливо — лишаємо GA.
    const gaLabels = new Set(found.filter(m => !isPreview(m.id)).map(m => m.label));
    const unique = found.filter(m => !(isPreview(m.id) && gaLabels.has(m.label)));
    // Відомі — у порядку FALLBACK_MODELS (перша = за замовчуванням), невідомі — за ними.
    const rank = id => {
        const i = FALLBACK_MODELS.findIndex(x => x.id === id);
        return i < 0 ? FALLBACK_MODELS.length : i;
    };
    return unique
        .map((m, i) => ({ m, i }))
        .sort((a, b) => (rank(a.m.id) - rank(b.m.id)) || (a.i - b.i))
        .map(x => x.m);
}

const isPreview = id => /-preview$/i.test(id);

function capsFor(modelId) {
    const id = String(modelId);
    const m = FALLBACK_MODELS.find(x => x.id === id || x.id === `models/${id}`);
    if (m) return m.caps;
    // Невідома модель — найобережніші припущення; 4K лише в Pro-лінійки.
    return id.toLowerCase().includes('-pro-') ? CAPS_PRO : CAPS_FLASH;
}

/** Пояснює причину, коли модель нічого не віддала. */
function describeRefusal(json) {
    const fb = json && json.promptFeedback;
    if (fb && fb.blockReason) {
        return googleI18n.t('provider.googleBlocked', {
            reason: `${fb.blockReason}${fb.blockReasonMessage ? ` — ${fb.blockReasonMessage}` : ''}`,
        });
    }
    const cand = json && json.candidates && json.candidates[0];
    if (cand && cand.finishReason && cand.finishReason !== 'STOP') {
        return googleI18n.t('provider.googleFinish', {
            reason: cand.finishReason,
            detail: '',
        });
    }
    // інколи модель відповідає текстом замість картинки — покажемо його
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map(p => p.text).filter(Boolean).join(' ').trim();
    if (text) return googleI18n.t('provider.googleText', { text: text.slice(0, 300) });
    return googleI18n.t('provider.googleNoImage');
}

function extractImage(json) {
    const parts = json?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
        const inline = p.inline_data || p.inlineData;
        if (inline && inline.data) return inline.data;
    }
    throw new HttpError(0, describeRefusal(json));
}

/** Gemini називає облік інакше, ніж OpenAI — зводимо до однієї форми. */
function normalizeUsage(json) {
    const u = json && (json.usageMetadata || json.usage_metadata);
    if (!u) return null;
    return {
        input_tokens: u.promptTokenCount ?? u.prompt_token_count ?? null,
        output_tokens: u.candidatesTokenCount ?? u.candidates_token_count ?? null,
        total_tokens: u.totalTokenCount ?? u.total_token_count ?? null,
        thought_tokens: u.thoughtsTokenCount ?? u.thoughts_token_count ?? null,
        // Для вартості важливо відрізнити TEXT від IMAGE: у Gemini вони мають
        // різні ставки, а candidatesTokenCount містить обидві модальності.
        input_tokens_details: u.promptTokensDetails ?? u.prompt_tokens_details ?? null,
        output_tokens_details: u.candidatesTokensDetails ?? u.candidates_tokens_details ?? null,
    };
}

async function callOnce({ apiKey, model, prompt, imageBlob, references, plan,
                          withImageConfig, signal }) {
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            candidateCount: 1,
            responseModalities: ['TEXT', 'IMAGE'],   // без цього картинки не буде
        },
    };
    if (withImageConfig && (plan.aspectRatio || plan.imageSize)) {
        payload.generationConfig.imageConfig = {};
        if (plan.aspectRatio) payload.generationConfig.imageConfig.aspectRatio = plan.aspectRatio;
        if (plan.imageSize)   payload.generationConfig.imageConfig.imageSize   = plan.imageSize;
    }
    // Порядок важливий: спершу область, яку правимо, потім референси —
    // модель трактує перше зображення як основне.
    for (const blob of [imageBlob].concat(references || []).filter(Boolean)) {
        payload.contents[0].parts.push({
            inline_data: {
                mime_type: blob.type || 'image/png',
                data: await blobToBase64(blob),
            },
        });
    }

    let path = String(model).replace(/^\/+/, '');
    if (!path.startsWith('models/')) path = 'models/' + path;
    const json = await request(`${BASE}${path}:generateContent`, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(payload),
        signal,
    });
    return { images: [extractImage(json)], usage: normalizeUsage(json) };
}

/**
 * Одна спроба з imageConfig; якщо API його не приймає — повтор без нього.
 * Форма цього конфігу в Gemini рухалась (imageConfig → responseFormat.image),
 * тому не вгадуємо, а деградуємо: краще згенерувати без керування розміром,
 * ніж не згенерувати нічого.
 */
async function callWithFallback(args) {
    try {
        return await callOnce({ ...args, withImageConfig: true });
    } catch (e) {
        const msg = String(e && e.message).toLowerCase();
        const isConfigReject = e && e.status === 400 &&
            (msg.includes('imageconfig') || msg.includes('image_config') ||
             msg.includes('imagesize') || msg.includes('image_size') ||
             msg.includes('aspectratio') || msg.includes('aspect_ratio') ||
             msg.includes('unknown name'));
        if (!isConfigReject) throw e;
        console.warn('[google] imageConfig не прийнято — повтор без керування розміром');
        return callOnce({ ...args, withImageConfig: false });
    }
}

async function generate({ apiKey, model, prompt, imageBlob, references, plan,
                          ignorePixels, signal, onProgress }) {
    if (!apiKey) throw new Error(googleI18n.t('provider.noKey', { provider: 'Google' }));
    if (!prompt || !prompt.trim()) throw new Error(googleI18n.t('provider.emptyPrompt'));

    if (onProgress) onProgress(googleI18n.t('provider.generating'));
    // те саме, що в openai.js: інакше «щось геть не те» не діагностується здалеку
    console.log(`[google] ${imageBlob && !ignorePixels
        ? `область іде в запит, вхід ${(imageBlob.size / 1024).toFixed(0)} КБ`
        : 'БЕЗ пікселів області'}${ignorePixels ? ', «ігнорувати пікселі» увімкнено' : ''}`);
    const res = await withRetry(() => callWithFallback({
        apiKey, model, prompt,
        imageBlob: ignorePixels ? null : imageBlob,
        references, plan, signal,
    }), { signal });
    if (onProgress) onProgress(googleI18n.t('provider.done'));
    return res;
}

module.exports = {
    id: 'google',
    label: 'Google Gemini',
    keyName: 'googleApiKey',
    // Параметра маски в Gemini немає. Область правки модель бачить із того, що
    // ми надсилаємо саме виділену область (плюс контекст навколо) — тому
    // прямокутної маски тут просто не існує, і main.js її не будує.
    // Шов усе одно мʼякшиться: розмиття layer-маски робиться на боці Photoshop.
    supportsMask: false,
    supportsReferences: true,
    // Прозорого фону параметром немає — лишається просити словами в промпті.
    supportsTransparent: false,
    // Проміжні кадри є лише в новому Interactions API (/v1beta/interactions);
    // цей файл ходить у generateContent, тому потоку тут поки немає.
    supportsStream: false,
    keyPage: 'https://aistudio.google.com/apikey',
    models,
    pickImageModels,
    capsFor,
    generate,
};

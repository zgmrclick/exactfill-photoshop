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

const BASE = 'https://generativelanguage.googleapis.com/v1beta/';

/** Gemini не приймає пікселі — лише співвідношення сторін і рівень розміру. */
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const CAPS_PRO   = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K', '2K', '4K'] };
const CAPS_FLASH = { arbitrary: false, aspects: ASPECTS, imageSizes: ['1K', '2K'] };

const FALLBACK_MODELS = [
    { id: 'models/gemini-3-pro-image',          label: 'Gemini 3 Pro Image',        caps: CAPS_PRO },
    { id: 'models/gemini-3.1-flash-image',      label: 'Gemini 3.1 Flash Image',    caps: CAPS_FLASH },
    { id: 'models/gemini-3.1-flash-lite-image', label: 'Gemini 3.1 Flash Lite',     caps: CAPS_FLASH },
    { id: 'models/gemini-2.5-flash-image',      label: 'Gemini 2.5 Flash Image',    caps: CAPS_FLASH },
];

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
        const list = (json && json.models) || [];
        const found = [];
        for (const m of list) {
            const name = String(m.name || '');
            const low = name.toLowerCase();
            // лише генератори зображень; Imagen свідомо не беремо — вимкнений
            if (!low.includes('-image')) continue;
            if (low.includes('imagen')) continue;
            const isPro = low.includes('-pro-');
            found.push({
                id: name,
                label: (m.displayName || name.replace(/^models\//, '')),
                caps: isPro ? CAPS_PRO : CAPS_FLASH,
            });
        }
        if (found.length) return found;
    } catch (e) {
        console.warn('[google] перелік моделей не отримано, беремо вбудований:', e.message);
    }
    return FALLBACK_MODELS.map(m => ({ ...m }));
}

function capsFor(modelId) {
    const m = FALLBACK_MODELS.find(x => x.id === modelId);
    if (m) return m.caps;
    return String(modelId).toLowerCase().includes('-pro-') ? CAPS_PRO : CAPS_FLASH;
}

/** Пояснює причину, коли модель нічого не віддала. */
function describeRefusal(json) {
    const fb = json && json.promptFeedback;
    if (fb && fb.blockReason) {
        return `Gemini заблокував запит: ${fb.blockReason}` +
               (fb.blockReasonMessage ? ` — ${fb.blockReasonMessage}` : '');
    }
    const cand = json && json.candidates && json.candidates[0];
    if (cand && cand.finishReason && cand.finishReason !== 'STOP') {
        const map = {
            SAFETY: 'спрацював фільтр безпеки',
            RECITATION: 'відповідь визнано цитуванням',
            PROHIBITED_CONTENT: 'заборонений вміст',
            IMAGE_SAFETY: 'фільтр безпеки для зображень',
            MAX_TOKENS: 'вичерпано ліміт токенів',
        };
        return `Gemini не завершив генерацію (${cand.finishReason}` +
               (map[cand.finishReason] ? `: ${map[cand.finishReason]}` : '') + ')';
    }
    // інколи модель відповідає текстом замість картинки — покажемо його
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map(p => p.text).filter(Boolean).join(' ').trim();
    if (text) return `Gemini відповів текстом замість зображення: ${text.slice(0, 300)}`;
    return 'Gemini не повернув зображення';
}

function extractImage(json) {
    const parts = json?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
        const inline = p.inline_data || p.inlineData;
        if (inline && inline.data) return inline.data;
    }
    throw new HttpError(0, describeRefusal(json));
}

async function callOnce({ apiKey, model, prompt, imageBlob, plan, withImageConfig }) {
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
    if (imageBlob) {
        payload.contents[0].parts.push({
            inline_data: {
                mime_type: imageBlob.type || 'image/jpeg',
                data: await blobToBase64(imageBlob),
            },
        });
    }

    const path = String(model).replace(/^\/+/, '');
    const json = await request(`${BASE}${path}:generateContent`, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(payload),
    });
    return extractImage(json);
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

async function generate({ apiKey, model, prompt, imageBlob, plan, n = 1, onProgress }) {
    if (!apiKey) throw new Error('Немає ключа Google — увійдіть у розділі API');
    if (!prompt || !prompt.trim()) throw new Error('Порожній промпт');

    const total = Math.max(1, n);
    const out = [];
    for (let i = 0; i < total; i++) {
        if (onProgress) onProgress(i, total, 'Генерація…');
        try {
            const b64 = await withRetry(() => callWithFallback({ apiKey, model, prompt, imageBlob, plan }));
            out.push(b64);
            if (onProgress) onProgress(i + 1, total, 'Готово');
        } catch (e) {
            if (onProgress) onProgress(i + 1, total, 'Помилка', e);
            if (!out.length) throw e;
            console.error(`[google] варіація ${i + 1}/${total} не вдалась: ${e.message}`);
        }
    }
    return out;
}

module.exports = {
    id: 'google',
    label: 'Google Gemini',
    keyName: 'googleApiKey',
    // Параметра маски в Gemini немає. Область правки модель бачить із того, що
    // ми надсилаємо саме виділену область (плюс контекст навколо) — тому
    // прямокутної маски тут просто не існує, і main.js її не будує.
    supportsMask: false,
    models,
    capsFor,
    generate,
};

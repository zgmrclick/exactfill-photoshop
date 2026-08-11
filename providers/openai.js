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

const { buildMultipart, request, withRetry, HttpError } = require('./http.js');

const BASE = 'https://api.openai.com/v1/';

/** Геометричні можливості моделей — читає geometry.js, не хардкодить сам. */
const ARBITRARY = {
    arbitrary: true, step: 16, maxEdge: 3840,
    minPx: 655360, maxPx: 8294400, maxRatio: 3,
};
const FIXED = {
    arbitrary: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
};

const MODELS = [
    { id: 'gpt-image-2',      label: 'GPT Image 2',      caps: ARBITRARY },
    { id: 'gpt-image-1.5',    label: 'GPT Image 1.5',    caps: FIXED },
    { id: 'gpt-image-1',      label: 'GPT Image 1',      caps: FIXED },
    { id: 'gpt-image-1-mini', label: 'GPT Image 1 mini', caps: FIXED },
];

function authHeader(apiKey) {
    // ключ ніде не логуємо — навіть частково
    return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Перелік моделей. Статичний: /v1/models віддає сотні записів, а фільтрувати
 * їх за назвою — гадання. Якщо OpenAI додасть модель, її треба додати сюди
 * разом із caps, бо без caps geometry.js не знає, що просити.
 */
async function models() {
    return MODELS.map(m => ({ ...m }));
}

function capsFor(modelId) {
    const m = MODELS.find(x => x.id === modelId);
    return m ? m.caps : FIXED;
}

/** Витягує base64 PNG із відповіді, або кидає читабельну помилку. */
function extractImages(json, n) {
    if (!json || !Array.isArray(json.data)) {
        throw new HttpError(0, 'Відповідь OpenAI без масиву data — можливо, змінився формат API');
    }
    const out = [];
    for (const item of json.data) {
        if (item && typeof item.b64_json === 'string') out.push(item.b64_json);
        else if (item && item.url) {
            throw new HttpError(0, 'OpenAI повернув URL замість base64 — плагін очікує b64_json');
        }
    }
    if (!out.length) {
        const refusal = json.data[0]?.revised_prompt ? ' (промпт було переписано)' : '';
        throw new HttpError(0, `OpenAI не повернув зображень${refusal}`);
    }
    return out.slice(0, n);
}

/**
 * Редагування наявних пікселів — основний шлях плагіна.
 * imageBlob — JPEG виділеної області; maskBlob — PNG з альфою (опційно).
 */
async function editImage({ apiKey, model, prompt, imageBlob, maskBlob, plan, n }) {
    const fields = [
        { name: 'model',  data: model },
        { name: 'prompt', data: prompt },
        { name: 'n',      data: '1' },              // n>1 просимо циклом — так надійніше
        { name: 'output_format', data: 'png' },
        { name: 'image',  data: imageBlob, filename: 'input.jpg', contentType: 'image/jpeg' },
    ];
    if (plan.size)  fields.push({ name: 'size', data: plan.size });
    if (plan.quality && plan.quality !== 'auto') {
        fields.push({ name: 'quality', data: plan.quality });
    }
    if (maskBlob) {
        fields.push({ name: 'mask', data: maskBlob, filename: 'mask.png', contentType: 'image/png' });
    }
    // input_fidelity недоступний для gpt-image-2: він і так обробляє входи
    // на високій точності, і параметр викликає помилку.
    if (model !== 'gpt-image-2') {
        fields.push({ name: 'input_fidelity', data: 'high' });
    }

    const { body, contentType } = await buildMultipart(fields);
    const json = await request(`${BASE}images/edits`, {
        method: 'POST',
        headers: { ...authHeader(apiKey), 'Content-Type': contentType },
        body,
    });
    return extractImages(json, n);
}

/** Генерація з нуля — коли пікселів немає (порожнє виділення на прозорому). */
async function generateFresh({ apiKey, model, prompt, plan, n }) {
    const payload = {
        model, prompt, n: 1,
        output_format: 'png',
    };
    if (plan.size) payload.size = plan.size;
    if (plan.quality && plan.quality !== 'auto') payload.quality = plan.quality;

    const json = await request(`${BASE}images/generations`, {
        method: 'POST',
        headers: { ...authHeader(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return extractImages(json, n);
}

/**
 * Єдиний вихід контракту: масив base64 PNG.
 * n варіацій робимо окремими запитами — якщо третій упаде, перші два вже є.
 */
async function generate({ apiKey, model, prompt, imageBlob, maskBlob, plan, n = 1, onProgress }) {
    if (!apiKey) throw new Error('Немає ключа OpenAI — увійдіть у розділі API');
    if (!prompt || !prompt.trim()) throw new Error('Порожній промпт');

    const total = Math.max(1, n);
    const out = [];
    for (let i = 0; i < total; i++) {
        if (onProgress) onProgress(i, total, 'Генерація…');
        try {
            const imgs = await withRetry(() => (imageBlob
                ? editImage({ apiKey, model, prompt, imageBlob, maskBlob, plan, n: 1 })
                : generateFresh({ apiKey, model, prompt, plan, n: 1 })));
            out.push(...imgs);
            if (onProgress) onProgress(i + 1, total, 'Готово');
        } catch (e) {
            if (onProgress) onProgress(i + 1, total, 'Помилка', e);
            // Перше зображення критичне: без нього нема чого вставляти.
            if (!out.length) throw e;
            console.error(`[openai] варіація ${i + 1}/${total} не вдалась: ${e.message}`);
        }
    }
    return out;
}

module.exports = {
    id: 'openai',
    label: 'OpenAI',
    keyName: 'openAiApiKey',
    supportsMask: true,
    models,
    capsFor,
    generate,
};

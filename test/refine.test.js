/* ============================================================================
 *  Маршрут уточнення: /v1/responses з інструментом image_generation.
 *
 *  Живий прогін тут — найдорожчий спосіб знайти помилку у формі тіла запиту:
 *  за неправильний ключ платить не валідатор, а користувач часом і грошима.
 *  Тому все, що можна перевірити без мережі, перевіряється без мережі:
 *  що саме кладеться в input, коли туди йдуть пікселі, а коли — id розмови,
 *  і що робиться з відповіддю, у якій картинки не виявилось.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');

const openai = require('../providers/openai.js');
const usage = require('../usage.js');
const { refineTool, refineInput, extractResponseImage, rejectsToolModel } = openai._refineParts;

test('перший хід везе пікселі, наступні — лише текст', () => {
    const first = refineInput({ prompt: 'тінь м’якше', previousResponseId: null, previousImage: 'QUJD' });
    assert.equal(first.length, 1);
    const parts = first[0].content;
    assert.equal(parts[0].type, 'input_text');
    assert.equal(parts[1].type, 'input_image');
    assert.match(parts[1].image_url, /^data:image\/png;base64,QUJD$/,
        'пікселі мусять їхати data-URI, без Files API');

    /* ⚠️ ГОЛОВНЕ ТУТ — ЧОГО В ХОДІ ≥2 БУТИ НЕ ПОВИННО. Приклад із документації
       подає назад сам image_generation_call за id; з міркувальною моделлю це
       400 (виміряно на живому API 2026-09-09): вузол не можна вставити без
       його reasoning-батька. Ланцюг тягне сервер через previous_response_id. */
    const next = refineInput({ prompt: 'тепер тепліше', previousResponseId: 'resp_1', previousImage: 'QUJD' });
    assert.equal(next.length, 1, 'жодних додаткових елементів input — лише репліка');
    assert.equal(next[0].content.length, 1, 'коли розмова триває, пікселі повторно не шлемо');
    assert.equal(JSON.stringify(next).includes('image_generation_call'), false,
        'подавати виклик назад руками — саме та помилка, від якої цей тест');
});

test('інструмент несе лише те, що йому дали, і нічого зайвого', () => {
    const full = refineTool({ plan: { size: '1024x1024', quality: 'high' },
                              model: 'gpt-image-2', withModel: true, partials: true });
    assert.deepEqual(full, {
        type: 'image_generation', output_format: 'png', model: 'gpt-image-2',
        size: '1024x1024', quality: 'high', partial_images: 3,
    });

    // quality=auto означає «хай вирішує сервер» — надсилати його як значення
    // не можна, інакше ми нав'язуємо рівень, якого користувач не вибирав.
    const auto = refineTool({ plan: { quality: 'auto' }, model: 'gpt-image-2', withModel: false });
    // Формат лишається завжди: у Responses дефолт не png, а без pHYs вставка
    // втрачає роздільність документа — див. OUTPUT_FORMAT.
    assert.deepEqual(auto, { type: 'image_generation', output_format: 'png' });
});

test('відповідь без картинки пояснює себе текстом моделі, а не мовчить', () => {
    const withImage = extractResponseImage({
        id: 'resp_7',
        output: [{ type: 'message', content: [{ text: 'ось' }] },
                 { type: 'image_generation_call', id: 'ig_9', result: 'QUJD' }],
        usage: { input_tokens: 10, output_tokens: 20 },
    });
    assert.deepEqual(withImage.images, ['QUJD']);
    assert.equal(withImage.responseId, 'resp_7', 'без нього наступний хід почав би розмову спочатку');
    assert.equal(withImage.callId, 'ig_9', 'id виклику лишається заради логу');

    assert.throws(
        () => extractResponseImage({ output: [{ type: 'message', content: [{ text: 'не можу цього робити' }] }] }),
        /не можу цього робити/);
});

test('порожній виклик без result не вважається картинкою', () => {
    assert.throws(() => extractResponseImage({ output: [{ type: 'image_generation_call', id: 'ig_1' }] }),
        /.+/);
});

test('відкат без model спрацьовує лише на скаргу саме про це поле', () => {
    assert.ok(rejectsToolModel({ status: 400, message: "Unknown parameter: 'tools[0].model'." }));
    assert.ok(rejectsToolModel({ status: 400, message: 'Unsupported model field in tool' }));
    // Найважливіше — чого відкат робити НЕ можна: інакше зрозуміла відмова
    // «моделі нема» перетворилась би на другий такий самий запит і ту саму
    // помилку, але вже без згадки про причину.
    assert.equal(rejectsToolModel({ status: 404, message: "The model 'gpt-5.6' does not exist" }), false);
    assert.equal(rejectsToolModel({ status: 400, message: 'Invalid prompt' }), false);
    assert.equal(rejectsToolModel(null), false);
});

test('маршрут — частина ключа прогнозу, а не подробиця запису', () => {
    const at = new Date().toISOString();
    const row = (route, out) => ({ at, model: 'gpt-image-2', quality: 'low', route,
                                   inputTokens: 400, outputTokens: out });
    // Три дорогі уточнення не мають робити дорожчим прогноз звичайної генерації.
    const history = [row('responses', 50000), row('responses', 50000), row('responses', 50000),
                     row('edits', 140), row('edits', 141), row('edits', 142)];
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2',
                                   quality: 'low', plan: {}, history });
    assert.equal(f.method, 'own-history');
    assert.equal(f.samples, 3, 'у медіану мусять потрапити лише записи edits');
    assert.ok(f.usd < 0.02, `прогноз ${f.usd} — записи responses просочились у медіану`);
});

test('старі записи без поля route читаються як edits', () => {
    const at = new Date().toISOString();
    const old = n => ({ at, model: 'gpt-image-2', quality: 'low', inputTokens: 400, outputTokens: n });
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2', quality: 'low',
                                   plan: {}, history: [old(140), old(141), old(142)] });
    assert.equal(f.samples, 3, 'журнал до 2026-09-09 не має route — і не мусить зникати з прогнозу');
});

test('createEntry проставляє маршрут', () => {
    assert.equal(usage.createEntry({ provider: 'openai', model: 'gpt-image-2' }, null).route, 'edits');
    assert.equal(usage.createEntry({ provider: 'openai', model: 'gpt-image-2', route: 'responses' }, null).route,
        'responses');
});

test('провайдер оголошує вміння розмовляти, і воно не бутафорське', () => {
    assert.equal(openai.supportsRefine, true);
    assert.equal(typeof openai.refine, 'function');
    const google = require('../providers/google.js');
    assert.notEqual(google.supportsRefine, true, 'у Gemini цього маршруту немає — кнопка мусить бути сірою');
});

test('уточнення без джерела відмовляється до мережі', async () => {
    await assert.rejects(
        () => openai.refine({ apiKey: 'sk-x', model: 'gpt-image-2', prompt: 'x',
                              previousResponseId: null, previousImage: null, plan: {} }),
        /.+/);
});

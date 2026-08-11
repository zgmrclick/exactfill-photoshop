const test = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../usage.js');

const closeTo = (actual, expected, epsilon = 1e-9) => {
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
};

test('OpenAI рахує окремі text/image input і image output токени', () => {
    const result = usage.estimateCost({
        provider: 'openai', model: 'gpt-image-1.5', quality: 'medium',
        plan: { size: '1024x1024' }, imageCount: 1, hasImageInput: true,
    }, {
        input_tokens: 3000,
        output_tokens: 1000,
        input_tokens_details: { text_tokens: 1000, image_tokens: 2000 },
    });
    closeTo(result.usd, 0.053);
    assert.equal(result.method, 'tokens');
});

test('OpenAI fixed-модель використовує офіційну ціну картинки без output usage', () => {
    const result = usage.estimateCost({
        provider: 'openai', model: 'gpt-image-1', quality: 'medium',
        plan: { size: '1024x1536' }, imageCount: 1, hasImageInput: false,
    }, null);
    closeTo(result.usd, 0.063);
    assert.equal(result.method, 'flat');
});

test('GPT Image 2 не вигадує ціну, коли API не повернув output usage', () => {
    const result = usage.estimateCost({
        provider: 'openai', model: 'gpt-image-2', quality: 'high',
        plan: { size: '2048x2048' }, imageCount: 1, hasImageInput: true,
    }, { input_tokens: 1000 });
    assert.equal(result.usd, null);
    assert.equal(result.method, 'missing-output-usage');
});

test('Gemini без деталізації output бере ціну запитаного розміру', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'models/gemini-3.1-flash-image',
        plan: { imageSize: '2K' }, imageCount: 1,
    }, { input_tokens: 2000, output_tokens: 1800 });
    closeTo(result.usd, 0.102);
    assert.equal(result.method, 'tokens+flat');
});

test('Gemini з modality usage рахує image і text output за різними ставками', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'gemini-3.1-flash-image',
        plan: { imageSize: '2K' }, imageCount: 1,
    }, {
        input_tokens: 2000,
        thought_tokens: 50,
        output_tokens_details: [
            { modality: 'IMAGE', tokenCount: 1600 },
            { modality: 'TEXT', tokenCount: 100 },
        ],
    });
    closeTo(result.usd, 0.09745);
    assert.equal(result.method, 'modality-tokens');
});

test('Gemini Pro 4K fallback включає input і картинку', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'gemini-3-pro-image',
        plan: { imageSize: '4K' }, imageCount: 1,
    }, { input_tokens: 1000 });
    closeTo(result.usd, 0.242);
});

test('журнал дає останній запит, сьогодні та останні сім календарних днів', () => {
    const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
    const entry = (daysAgo, cost) => ({
        at: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        inputTokens: 100, outputTokens: 200, costUsd: cost,
    });
    const result = usage.summarize([entry(8, 8), entry(2, 2), entry(0, 1)], now);
    assert.equal(result.last.costUsd, 1);
    assert.equal(result.today.requests, 1);
    assert.equal(result.today.usd, 1);
    assert.equal(result.sevenDays.requests, 2);
    assert.equal(result.sevenDays.usd, 3);
    assert.equal(result.all.requests, 3);
});

test('журнал обмежений 500 записами', () => {
    const now = Date.now();
    const entries = Array.from({ length: 520 }, (_, i) => ({
        at: new Date(now - i * 1000).toISOString(), costUsd: 0.01,
    }));
    assert.equal(usage.prune(entries, now).length, usage.MAX_ENTRIES);
});

test('дрібна вартість запиту не губить тисячні долара у відображенні', () => {
    assert.equal(usage.formatUsd(0.034), '$0.034');
    assert.equal(usage.formatUsd(0.0054), '$0.0054');
});

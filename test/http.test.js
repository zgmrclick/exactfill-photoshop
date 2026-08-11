const assert = require('node:assert/strict');
const test = require('node:test');
const { request, parseSse, requestStream, parseRetryAfter, withRetry, HttpError } = require('../providers/http.js');

test('network failure names the blocked host and firewall action', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new TypeError('Failed to fetch'); };
    try {
        await assert.rejects(
            request('https://api.openai.com/v1/models', { timeoutMs: 100 }),
            error => error instanceof HttpError &&
                error.message.includes('api.openai.com') &&
                error.message.includes('firewall') &&
                error.message.includes('outbound HTTPS')
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('parseSse читає OpenAI image events з LF', () => {
    const events = parseSse(
        'event: image_edit.partial_image\n' +
        'data: {"type":"image_edit.partial_image","b64_json":"one","partial_image_index":0}\n\n' +
        'event: image_edit.completed\n' +
        'data: {"type":"image_edit.completed","b64_json":"final"}\n\n'
    );
    assert.deepEqual(events.map(x => x.type), [
        'image_edit.partial_image',
        'image_edit.completed',
    ]);
});

test('parseSse не буферизує CRLF і пропускає DONE', () => {
    const events = parseSse(
        'event: image_generation.partial_image\r\n' +
        'data: {"type":"image_generation.partial_image","b64_json":"one","partial_image_index":0}\r\n\r\n' +
        'data: [DONE]\r\n\r\n'
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].b64_json, 'one');
});

test('requestStream віддає partial до completed навіть коли подію розрізано між чанками', async () => {
    const originalFetch = global.fetch;
    const chunks = [
        'event: image_edit.partial_image\r\ndata: {"type":"image_edit.partial_',
        'image","b64_json":"one","partial_image_index":0}\r\n\r\n',
        'event: image_edit.completed\r\ndata: {"type":"image_edit.completed","b64_json":"final"}\r\n\r\n',
    ].map(s => Uint8Array.from(Buffer.from(s, 'ascii')));
    let index = 0;
    global.fetch = async () => ({
        ok: true,
        body: { getReader: () => ({ read: async () => index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined } }) },
    });

    try {
        const seen = [];
        const last = await requestStream('https://api.openai.com/v1/images/edits', {}, ev => {
            seen.push(ev.type);
        });
        assert.deepEqual(seen, ['image_edit.partial_image', 'image_edit.completed']);
        assert.equal(last.b64_json, 'final');
    } finally {
        global.fetch = originalFetch;
    }
});

test('Retry-After читає і секунди, і HTTP-дату', () => {
    const now = Date.UTC(2026, 7, 11, 12, 0, 0);
    assert.equal(parseRetryAfter('12', now), 12);
    assert.equal(parseRetryAfter(new Date(now + 9000).toUTCString(), now), 9);
    assert.equal(parseRetryAfter('n/a', now), null);
});

test('скасування перериває довге очікування ретраю одразу', async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const pending = withRetry(async () => {
        throw new HttpError(429, 'rate limit', 60);
    }, { tries: 3, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(pending, e => e && e.cancelled === true);
    assert.ok(Date.now() - started < 1000, 'скасування не має чекати Retry-After');
});

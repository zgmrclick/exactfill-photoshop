const assert = require('node:assert/strict');
const test = require('node:test');

const { buildReportUrl, safeDiagnostics } = require('../public-ui.js');
const appInfo = require('../app-info.js');

test('safe diagnostics contain useful metadata but no private content', () => {
    const diagnostics = safeDiagnostics();
    // версію беремо з app-info, інакше кожен bump ламає тест на порожньому місці
    assert.match(diagnostics, new RegExp(`ExactFill: ${appInfo.version.replace(/\./g, '\\.')}`));
    assert.match(diagnostics, /Provider:/);
    assert.match(diagnostics, /Network route:/, 'a "no connection" report is useless without the route');
    assert.doesNotMatch(diagnostics, /api.?key|prompt|document name|file path/i);
});

test('bug report URL is prefilled and explicitly documents excluded data', () => {
    const url = new URL(buildReportUrl('Mask edge', 'Visible seam after placement', true));
    assert.equal(url.origin + url.pathname,
        'https://github.com/zgmrclick/exactfill-photoshop/issues/new');
    assert.equal(url.searchParams.get('title'), '[Bug] Mask edge');
    const body = url.searchParams.get('body');
    assert.match(body, /Visible seam after placement/);
    assert.match(body, /Safe diagnostics/);
    assert.match(body, /did not include API keys, prompts, document names, paths, images, or usage history/);
});

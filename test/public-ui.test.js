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

test('URL звіту тримається в межах GitHub на будь-якому алфавіті', () => {
    /* ⚠️ РЕГРЕСІЯ, ЯКУ ТУТ ЗАКРИТО. Полю report-details дали maxlength=10000,
       щоб зняти тиху стелю UXP на ~256 символах, — і тим самим зняли випадковий
       запобіжник: URL створення issue поліз за 8192 B, GitHub відповідає 414,
       звіт не відкривається взагалі.

       ЧОМУ САМОГО maxlength НЕ ДОСИТЬ: у percent-encoding кириличний символ —
       6 байтів проти 1 у латиниці, емодзі — 12. Та сама межа В СИМВОЛАХ дає
       вшестеро-вдванадцятеро довший URL. Отже різати треба за байтами, і саме
       в місці збірки URL. */
    const LIMIT = 8192;
    for (const [name, ch] of [['латиниця','a'], ['кирилиця','я'], ['CJK','中'], ['емодзі','🙂']]) {
        const url = buildReportUrl(ch.repeat(110), ch.repeat(10000), true);
        assert.ok(url.length <= LIMIT,
            `${name}: URL ${url.length} B > ${LIMIT} B — GitHub відповість 414`);
        // усе, що влізло, мусить лишитись читабельним, а не обрізаним посеред %D0
        assert.doesNotThrow(() => decodeURIComponent(new URL(url).search),
            `${name}: percent-encoding розрізано посеред символу`);
    }
    // короткий звіт не чіпаємо взагалі
    const short = buildReportUrl('Seam', 'Visible seam after placement', true);
    assert.match(new URL(short).searchParams.get('body'), /Visible seam after placement$|Visible seam/);
});

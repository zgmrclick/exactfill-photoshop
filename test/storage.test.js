const assert = require('node:assert/strict');
const test = require('node:test');

function storage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: key => data.has(key) ? data.get(key) : null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
    };
}

test('пошкоджена історія не ламає панель і приймає новий запис', async () => {
    global.localStorage = storage({ nanobanana_prompt_history: '{"old":true}' });
    delete require.cache[require.resolve('../history.js')];
    const history = require('../history.js');
    await history.load();
    assert.deepEqual(history.getAll(), []);
    history.add({ prompt: 'test' });
    assert.equal(history.getAll().length, 1);
});

test('пошкоджені пресети відновлюються без runtime-помилки', async () => {
    global.localStorage = storage({ googleAiPresets: '42' });
    delete require.cache[require.resolve('../presets.js')];
    const presets = require('../presets.js');
    await presets.load();
    assert.ok(Array.isArray(presets.getAll()));
    presets.add('Новий', 'Текст');
    assert.ok(presets.getAll().some(p => p.name === 'Новий'));
});

test('кожен менеджер зі станом справді завантажується під час ініціалізації', () => {
    // ⚠️ ЧОМУ СТАТИЧНА ПЕРЕВІРКА, А НЕ ЮНІТ: тести вище викликають load() САМІ,
    // тому проходили б і тоді, коли панель його не викликає ніколи. Саме так і
    // сталося: `presetManager.load()` не було в main.js взагалі, пресети
    // стартували порожніми, а перший же add() перезаписував збережене.
    const fs = require('node:fs');
    const path = require('node:path');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    for (const [mod, varName] of [['presets.js', 'presetManager'], ['history.js', 'historyManager']]) {
        const source = fs.readFileSync(path.join(__dirname, '..', mod), 'utf8');
        if (!/\basync load\s*\(/.test(source)) continue;   // без load() перевіряти нічого
        assert.match(main, new RegExp(`await\\s+${varName}\\.load\\(\\)`),
            `${mod}: має load(), але main.js його не викликає — стан не відновиться`);
    }
});

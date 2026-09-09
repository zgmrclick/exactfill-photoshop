/* ============================================================================
 *  test/stubs/dom.js — мінімальний DOM + заглушки `uxp` і `photoshop`, щоб
 *  main.js можна було СПРАВДІ завантажити й запустити під node.
 *
 *  ⚠️ НАВІЩО ЦЕ ІСНУЄ: до цього файлу main.js (1271 рядок — увесь UI,
 *  оркестрація й запуск) жоден тест не завантажував. Його лише читали як
 *  ТЕКСТ у platform.test.js і storage.test.js. Тобто помилка в ініціалізації
 *  — забутий await, звертання до неіснуючої функції, зламаний require після
 *  рефактора — не ловилась нічим, окрім запуску Photoshop руками.
 *
 *  Дерево збирається з РЕАЛЬНОГО index.html: беремо кожен елемент, що має id,
 *  разом із його атрибутами. Тому стенд не може розійтися з розміткою —
 *  видалили елемент у HTML, і тест це побачить.
 *
 *  Це не браузер і не UXP. Тут немає ні розкладки, ні CSS, ні справжнього
 *  парсера селекторів. Мета одна: пройти шляхом ініціалізації й побачити, що
 *  саме опинилось у DOM.
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');

/* ── DOM ───────────────────────────────────────────────────────────────────── */

class ClassList {
    constructor(el) { this.el = el; this.items = new Set(); }
    add(...c) { for (const x of c) if (x) this.items.add(x); this.sync(); }
    remove(...c) { for (const x of c) this.items.delete(x); this.sync(); }
    contains(c) { return this.items.has(c); }
    toggle(c, force) {
        const on = force === undefined ? !this.items.has(c) : Boolean(force);
        if (on) this.items.add(c); else this.items.delete(c);
        this.sync();
        return on;
    }
    sync() { this.el.classText = [...this.items].join(' '); }
    toString() { return [...this.items].join(' '); }
}

/** Підтримуємо рівно два види селекторів: `.class` і `tag`. Більшого код не просить. */
function matches(el, sel) {
    const s = String(sel).trim();
    return s.startsWith('.') ? el.classList.contains(s.slice(1)) : el.tagName === s.toLowerCase();
}

class El {
    constructor(tag) {
        this.tagName = String(tag).toLowerCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.listeners = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.text = '';
        this.classText = '';
        this.classList = new ClassList(this);
        // за замовчуванням «елемент намалювався»: інакше ensureNumericControl
        // підміняв би геть усе, і тест перевіряв би лише запасний шлях
        this.offsetHeight = 12;
    }
    get className() { return this.classText; }
    set className(v) {
        this.classText = String(v || '');
        this.classList.items = new Set(this.classText.split(/\s+/).filter(Boolean));
    }
    get textContent() {
        return this.children.length ? this.children.map(c => c.textContent).join('') : this.text;
    }
    set textContent(v) { this.text = v == null ? '' : String(v); this.children = []; }
    get innerHTML() { return this.children.map(c => `<${c.tagName}>`).join(''); }
    set innerHTML(v) { if (!v) this.children = []; }
    get parentElement() { return this.parentNode; }
    get id() { return this.attributes.id || ''; }
    set id(v) { this.attributes.id = String(v); }

    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
    removeAttribute(n) { delete this.attributes[n]; }
    hasAttribute(n) { return n in this.attributes; }

    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(c); }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
        return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceWith(next) {
        const p = this.parentNode;
        if (!p) return;
        p.children[p.children.indexOf(this)] = next;
        next.parentNode = p;
        this.parentNode = null;
    }
    insertBefore(node, ref) {
        const i = ref ? this.children.indexOf(ref) : this.children.length;
        this.children.splice(i < 0 ? this.children.length : i, 0, node);
        node.parentNode = this;
        return node;
    }

    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        const l = this.listeners[type];
        if (l) this.listeners[type] = l.filter(f => f !== fn);
    }
    /** Синхронна відправка події — тест сам вирішує, коли її «натиснути». */
    fire(type, ev = {}) {
        for (const fn of (this.listeners[type] || []).slice()) fn({ target: this, preventDefault() {}, ...ev });
    }

    descendants() {
        const out = [];
        const walk = e => { for (const c of e.children) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelectorAll(sel) { return this.descendants().filter(e => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class Doc extends El {
    constructor() { super('#document'); }
    createElement(tag) { return new El(tag); }
    createTextNode(t) { const e = new El('#text'); e.textContent = t; return e; }
    /** Обхід дерева, а не мапа: fillPicker і ensureNumericControl ПІДМІНЯЮТЬ вузли, зберігаючи id. */
    getElementById(id) { return this.descendants().find(e => e.attributes.id === id) || null; }
    get documentElement() { return this; }
    get body() { return this; }
}

/* ── Дерево з реального index.html ─────────────────────────────────────────── */

const TAG_WITH_ID = /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\bid="([^"]+)"([^<>]*)>/g;

function buildFromHtml(html) {
    const doc = new Doc();
    let m;
    while ((m = TAG_WITH_ID.exec(html)) !== null) {
        const [, tag, before, id, after] = m;
        const el = doc.createElement(tag);
        el.setAttribute('id', id);
        for (const [, name, value] of `${before} ${after}`.matchAll(/([\w-]+)="([^"]*)"/g)) {
            if (name !== 'id') el.setAttribute(name, value);
        }
        if (el.hasAttribute('class')) el.className = el.getAttribute('class');
        if (tag === 'textarea' || tag.startsWith('sp-')) el.value = '';
        doc.appendChild(el);
    }
    return doc;
}

/* ── Заглушки хоста ────────────────────────────────────────────────────────── */

const photoshopStub = {
    app: { activeDocument: null, documents: [] },
    core: { executeAsModal: async fn => fn({}, {}) },
    action: {
        batchPlay: async () => [{}],
        addNotificationListener: () => { throw new Error('no notifications in the stub'); },
    },
};

const uxpStub = {
    storage: {
        formats: { utf8: 'utf8', binary: 'binary' },
        localFileSystem: {
            getTemporaryFolder: async () => { throw new Error('no filesystem in the stub'); },
            getFileForOpening: async () => null,
            createSessionToken: () => 'token',
        },
    },
    shell: { openExternal: async () => {} },
    host: { name: 'Photoshop', version: '27.5.0', uiLocale: 'uk' },
};

/**
 * Ставить глобалі й перехоплює require('photoshop') / require('uxp').
 * Повертає { doc, storage } — стан, який тест перевіряє після ініціалізації.
 */
function install({ locale = 'uk', storage = {} } = {}) {
    const doc = buildFromHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const store = new Map(Object.entries(storage));

    global.document = doc;
    global.localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k),
        clear: () => store.clear(),
        get length() { return store.size; },
        key: i => [...store.keys()][i] ?? null,
    };
    global.Blob = class Blob {
        constructor(parts = [], opts = {}) {
            this.type = opts.type || '';
            this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0);
        }
    };
    global.window = {
        document: doc,
        // ключа немає — це штатний стан першого запуску, і саме він мусить
        // проходити ініціалізацію без винятків
        aiAuth: {
            getKey: async () => { throw new Error('key not set'); },
            refreshAuthUI: async () => {},
        },
        addEventListener() {}, setTimeout, clearTimeout,
    };
    global.navigator = { language: locale };

    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'photoshop' || request === 'uxp') {
            return path.join(__dirname, request === 'photoshop' ? 'photoshop.js' : 'uxp.js');
        }
        return original.call(this, request, ...rest);
    };
    require.cache[path.join(__dirname, 'photoshop.js')] = { id: 'photoshop', filename: 'photoshop.js', loaded: true, exports: photoshopStub };
    require.cache[path.join(__dirname, 'uxp.js')] = { id: 'uxp', filename: 'uxp.js', loaded: true, exports: uxpStub };

    return { doc, store, photoshop: photoshopStub, uxp: uxpStub, restore: () => { Module._resolveFilename = original; } };
}

module.exports = { install, El, Doc, buildFromHtml };

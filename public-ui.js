/* Language, privacy, project support and safe GitHub bug reporting. */
const publicAppInfo = require('./app-info.js');
const publicI18n = require('./i18n.js');
const publicKeys = require('./storage-keys.js').LS;

function optionalRequire(name) {
    try { return require(name); } catch (e) { return null; }
}

const uxp = optionalRequire('uxp');
const os = optionalRequire('os');
const publicShell = uxp?.shell;

function storedSetting(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; }
    catch (e) { return fallback; }
}

async function openExternal(url, consent) {
    if (publicShell?.openExternal) return publicShell.openExternal(url, consent);
    if (typeof window !== 'undefined' && window.open) return window.open(url, '_blank');
    throw new Error(publicI18n.t('common.externalUnavailable'));
}

function safeDiagnostics() {
    const host = uxp?.host || {};
    return [
        `- ExactFill: ${publicAppInfo.version}`,
        `- Host: ${host.name || 'Photoshop'} ${host.version || 'unknown'}`,
        `- OS: ${os?.platform ? os.platform() : 'unknown'}`,
        `- UI locale: ${host.uiLocale || publicI18n.getLocale()}`,
        `- Provider: ${storedSetting(publicKeys.provider, 'unknown')}`,
        `- Model: ${storedSetting(publicKeys.model, 'unknown')}`,
        `- Quality: ${storedSetting(publicKeys.quality, 'medium')}`,
        // маршрут мережі — перше, що потрібно знати в звіті про «немає з'єднання»
        `- Network route: ${storedSetting(publicKeys.transport, 'auto')}`,
        `- Lossless input: ${storedSetting(publicKeys.lossless, 'default')}`,
        `- Live preview: ${storedSetting(publicKeys.preview, 'default')}`,
    ].join('\n');
}

function setReportStatus(text) {
    const el = document.getElementById('report-status');
    if (el) el.textContent = text || '';
}

/**
 * Стеля довжини URL створення issue. GitHub на довший відповідає 414 URI Too
 * Long, і звіт не відкривається взагалі — мовчки, з погляду користувача.
 */
const MAX_REPORT_URL = 7800;

/**
 * Обрізає рядок, не розриваючи сурогатну пару.
 * Без цього emoji на межі лишає самотній верхній сурогат, а encodeURIComponent
 * на ньому кидає URIError — тобто спроба вкластися в ліміт ламала б звіт
 * надійніше за сам ліміт.
 */
function sliceSafe(text, n) {
    let end = Math.min(n, text.length);
    if (end <= 0) return '';
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--;
    return text.slice(0, end);
}

function buildReportUrl(summary, details, includeDiagnostics = true) {
    const assemble = text => {
        const parts = [text || '_No additional details provided._'];
        if (includeDiagnostics) parts.push(`\n### Safe diagnostics\n${safeDiagnostics()}`);
        parts.push('\n> ExactFill did not include API keys, prompts, document names, paths, images, or usage history.');
        // encodeURIComponent віддає чистий ASCII, тому .length тут — це байти
        return `${publicAppInfo.issues}?title=${encodeURIComponent('[Bug] ' + sliceSafe(summary, 110))}` +
            `&body=${encodeURIComponent(parts.join('\n'))}`;
    };

    const text = details || '';
    const full = assemble(text);
    if (full.length <= MAX_REPORT_URL) return full;

    /* ⚠️ ЧОМУ РІЗАТИ ДОВОДИТЬСЯ ТУТ, А НЕ maxlength НА ПОЛІ: у percent-encoding
       латинська літера коштує 1 байт, кирилична — 6, емодзі — 12. Одна й та сама
       межа В СИМВОЛАХ дає URL, довший удванадцятеро, тож жодне статичне число в
       HTML ліміту не гарантує. Обрізане не зникає мовчки — на місці зрізу
       лишається помітка, і решту користувач вставляє вже у вікні GitHub. */
    const note = '\n\n' + publicI18n.t('report.truncated');
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (assemble(sliceSafe(text, mid) + note).length <= MAX_REPORT_URL) lo = mid;
        else hi = mid - 1;
    }
    return assemble(sliceSafe(text, lo) + note);
}

async function submitReport() {
    const summary = document.getElementById('report-summary')?.value?.trim();
    const details = document.getElementById('report-details')?.value?.trim();
    const include = document.getElementById('report-diagnostics')?.checked !== false;
    if (!summary) { setReportStatus(publicI18n.t('report.required')); return; }

    const url = buildReportUrl(summary, details, include);
    try {
        setReportStatus(publicI18n.t('report.opening'));
        await openExternal(url, publicI18n.t('report.consent'));
    } catch (e) {
        setReportStatus(publicI18n.t('report.openError', { error: e?.message || e }));
    }
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    const version = document.getElementById('app-version');
    if (version) version.textContent = `v${publicAppInfo.version}`;

    const language = document.getElementById('language-select');
    if (language) {
        language.value = publicI18n.getLocale();
        language.addEventListener('change', () => publicI18n.setLocale(language.value));
    }

    const support = document.getElementById('support-btn');
    if (support) {
        support.disabled = !publicAppInfo.supportUrl;
        support.addEventListener('click', async () => {
            if (!publicAppInfo.supportUrl) return;
            try { await openExternal(publicAppInfo.supportUrl, publicI18n.t('support.consent')); }
            catch (e) { setReportStatus(publicI18n.t('report.openError', { error: e?.message || e })); }
        });
    }

    const privacy = document.getElementById('privacy-btn');
    if (privacy) privacy.addEventListener('click', async () => {
        try { await openExternal(publicAppInfo.privacy, publicI18n.t('privacy.consent')); }
        catch (e) { setReportStatus(publicI18n.t('report.openError', { error: e?.message || e })); }
    });

    const report = document.getElementById('report-submit');
    if (report) report.addEventListener('click', submitReport);
});

if (typeof module !== 'undefined') module.exports = { safeDiagnostics, buildReportUrl, submitReport, MAX_REPORT_URL };

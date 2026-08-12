/* Language, privacy, project support and safe GitHub bug reporting. */
const publicAppInfo = require('./app-info.js');
const publicI18n = require('./i18n.js');

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
        `- Provider: ${storedSetting('ai_provider', 'unknown')}`,
        `- Model: ${storedSetting('ai_model', 'unknown')}`,
        `- Quality: ${storedSetting('ai_quality', 'medium')}`,
        `- Lossless input: ${storedSetting('ai_lossless', 'default')}`,
        `- Live preview: ${storedSetting('ai_live_preview', 'default')}`,
    ].join('\n');
}

function setReportStatus(text) {
    const el = document.getElementById('report-status');
    if (el) el.textContent = text || '';
}

function buildReportUrl(summary, details, includeDiagnostics = true) {
    const parts = [details || '_No additional details provided._'];
    if (includeDiagnostics) parts.push(`\n### Safe diagnostics\n${safeDiagnostics()}`);
    parts.push('\n> ExactFill did not include API keys, prompts, document names, paths, images, or usage history.');
    return `${publicAppInfo.issues}?title=${encodeURIComponent('[Bug] ' + summary.slice(0, 110))}` +
        `&body=${encodeURIComponent(parts.join('\n'))}`;
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

if (typeof module !== 'undefined') module.exports = { safeDiagnostics, buildReportUrl, submitReport };

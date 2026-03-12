// Smart Page Translator - Popup v2.1
'use strict';

// ========== 语言 / 引擎配置 ==========
const LANGUAGES = {
    'zh-CN': '简体中文', 'zh-TW': '繁体中文', 'en': 'English',
    'ja': '日本語', 'ko': '한국어', 'fr': 'Français',
    'de': 'Deutsch', 'es': 'Español', 'pt': 'Português',
    'ru': 'Русский', 'ar': 'العربية', 'it': 'Italiano',
    'th': 'ไทย', 'vi': 'Tiếng Việt', 'id': 'Bahasa Indonesia',
    'ms': 'Bahasa Melayu', 'hi': 'हिन्दी', 'tr': 'Türkçe',
    'pl': 'Polski', 'nl': 'Nederlands', 'sv': 'Svenska',
};

const LANG_DISPLAY = {
    zh: '中文', en: '英文', ja: '日文', ko: '韩文',
    fr: '法文', de: '德文', es: '西班牙文', ru: '俄文',
    ar: '阿拉伯文', th: '泰文', vi: '越南文', id: '印尼文',
    hi: '印地文', tr: '土耳其文', unknown: '未知',
};

// 仅保留两个可用引擎
const VALID_PROVIDERS = new Set(['viki', 'bing']);

const DEFAULTS = {
    autoTranslate: false,
    translatorProvider: 'viki',
    targetLanguage: 'zh-CN',
};

// ========== DOM 引用 ==========
const el = id => document.getElementById(id);
const dom = {
    statusIcon: el('statusIcon'),
    statusText: el('statusText'),
    detectedLang: el('detectedLang'),
    translateBtn: el('translateBtn'),
    restoreBtn: el('restoreBtn'),
    targetLang: el('targetLanguage'),
    provider: el('translatorProvider'),
    autoTranslate: el('autoTranslate'),
};

// ========== 状态 ==========
const STATUS = {
    idle:        { cls: '',           text: '等待操作' },
    detecting:   { cls: 'detecting', text: '检测语言...' },
    translating: { cls: 'translating', text: '翻译中...' },
    translated:  { cls: 'translated', text: '翻译完成' },
    restoring:   { cls: '',           text: '恢复中...' },
    error:       { cls: 'error',      text: '发生错误，请重试' },
};

function setStatus(key) {
    const s = STATUS[key] ?? STATUS.idle;
    dom.statusIcon.className = 'status-icon ' + s.cls;
    dom.statusText.textContent = s.text;
}

function setButtons({ translating = false, translated = false } = {}) {
    dom.translateBtn.disabled = translating || translated;
    dom.restoreBtn.disabled   = translating || !translated;
}

// ========== Tab / 注入 ==========
async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
}

async function ensureContentScript(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    } catch {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 150));
    }
}

// 确保 background service worker 已启动
async function ensureBackground() {
    try {
        await chrome.runtime.sendMessage({ action: 'ping' });
        return true;
    } catch (e) {
        console.warn('[Popup] Background not ready, waiting...');
        await new Promise(r => setTimeout(r, 1000));
        try {
            await chrome.runtime.sendMessage({ action: 'ping' });
            return true;
        } catch {
            return false;
        }
    }
}

async function sendToContent(action, data = {}) {
    const tab = await getActiveTab();
    if (!tab?.id) return null;
    
    // 先确保 background 可用
    const bgReady = await ensureBackground();
    if (!bgReady) {
        console.error('[Popup] Background service worker not available');
    }
    
    try {
        await ensureContentScript(tab.id);
        return await chrome.tabs.sendMessage(tab.id, { action, ...data });
    } catch (e) {
        console.warn('[Popup] sendToContent failed:', action, e.message);
        return null;
    }
}

// ========== 设置持久化 ==========
async function loadSettings() {
    const saved = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const cfg = { ...DEFAULTS, ...saved };

    // 兼容旧版本：如果存储了已删除的引擎，重置为默认值
    if (!VALID_PROVIDERS.has(cfg.translatorProvider)) {
        cfg.translatorProvider = DEFAULTS.translatorProvider;
    }

    dom.autoTranslate.checked = cfg.autoTranslate;
    dom.provider.value        = cfg.translatorProvider;
    dom.targetLang.value      = cfg.targetLanguage;
    return cfg;
}

function saveSettings() {
    const provider = VALID_PROVIDERS.has(dom.provider.value)
        ? dom.provider.value
        : DEFAULTS.translatorProvider;

    chrome.storage.local.set({
        autoTranslate:      dom.autoTranslate.checked,
        translatorProvider: provider,
        targetLanguage:     dom.targetLang.value,
    });
}

// ========== 操作 ==========
async function doTranslate() {
    setStatus('translating');
    setButtons({ translating: true });

    const res = await sendToContent('translate', {
        provider:       dom.provider.value,
        targetLanguage: dom.targetLang.value,
    });

    if (res?.ok === false) {
        setStatus('error');
        setButtons({ translated: false });
    } else {
        setStatus('translated');
        setButtons({ translated: true });
    }
}

async function doRestore() {
    setStatus('restoring');
    setButtons({ translating: true });
    await sendToContent('restore');
    setStatus('idle');
    setButtons({ translated: false });
}

// ========== 初始化 ==========
async function init() {
    // 填充语言下拉
    const frag = document.createDocumentFragment();
    Object.entries(LANGUAGES).forEach(([code, name]) => {
        frag.appendChild(new Option(name, code));
    });
    dom.targetLang.appendChild(frag);

    // 读取设置
    const cfg = await loadSettings();

    // 检测页面语言
    setStatus('detecting');
    const langRes = await sendToContent('detectLanguage');
    const lang = langRes?.language ?? 'unknown';
    dom.detectedLang.textContent = LANG_DISPLAY[lang] ?? lang.toUpperCase();

    // 查询当前翻译状态
    const status = await sendToContent('getStatus');
    if (status?.isTranslated) {
        setStatus('translated');
        setButtons({ translated: true });
        return;
    }

    // 自动翻译（非中文页面）
    if (cfg.autoTranslate && lang !== 'zh' && lang !== 'unknown') {
        await doTranslate();
    } else {
        setStatus('idle');
        setButtons({ translated: false });
    }
}

// ========== 事件绑定 ==========
dom.translateBtn.addEventListener('click', doTranslate);
dom.restoreBtn.addEventListener('click', doRestore);
[dom.autoTranslate, dom.provider, dom.targetLang].forEach(e =>
    e.addEventListener('change', saveSettings)
);

init();
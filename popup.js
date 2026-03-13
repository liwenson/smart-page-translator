'use strict';

// ========== DOM 引用 ==========
const el = id => document.getElementById(id);
const dom = {
    actionBtn: el('actionBtn'),
    targetLang: el('targetLanguage'),
    provider: el('translatorProvider'),
    statusText: el('statusText'), // 新增状态提示
};

// ========== 配置 ==========
const DEFAULTS = {
    targetLanguage: 'zh-CN',
    provider: 'edge',
};

// ========== 状态 ==========
let isTranslated = false;
let isTranslating = false;
let translateTimer = null;

// ========== UI 更新 ==========
function updateUI() {
    const btn = dom.actionBtn;
    const status = dom.statusText;

    // 更新按钮状态
    if (isTranslating) {
        btn.textContent = '翻译中...';
        btn.disabled = true;
        btn.className = 'btn btn-primary';
        status.textContent = '正在处理，请稍候';
    } else if (isTranslated) {
        btn.textContent = '恢复原文';
        btn.disabled = false;
        btn.className = 'btn btn-secondary';
        status.textContent = '已翻译为 ' + getLangName(dom.targetLang.value);
    } else {
        btn.textContent = '翻译此页面';
        btn.disabled = false;
        btn.className = 'btn btn-primary';
        status.textContent = ''; // 清空状态
    }
}

// 辅助：语言代码转中文名称
function getLangName(code) {
    const langMap = {
        'zh-CN': '中文(简体)',
        'zh-TW': '中文(繁體)',
        'en': '英语',
        'ja': '日语',
        'ko': '韩语',
        'fr': '法语',
        'de': '德语',
        'es': '西班牙语',
        'ru': '俄语',
        'pt': '葡萄牙语',
        'it': '意大利语',
    };
    return langMap[code] || code;
}

// ========== 通信 ==========
async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function ensureContentScript(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    } catch {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 100));
    }
}

async function ensureBackground() {
    try {
        await chrome.runtime.sendMessage({ action: 'ping' });
        return true;
    } catch {
        await new Promise(r => setTimeout(r, 500));
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

    if (!await ensureBackground()) return null;

    try {
        await ensureContentScript(tab.id);
        return await chrome.tabs.sendMessage(tab.id, { action, ...data });
    } catch {
        return null;
    }
}

// ========== 设置 ==========
async function loadSettings() {
    const saved = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const cfg = { ...DEFAULTS, ...saved };
    dom.targetLang.value = cfg.targetLanguage || 'zh-CN';
    dom.provider.value = cfg.provider || 'edge';
    return cfg;
}

function saveSettings() {
    chrome.storage.local.set({
        targetLanguage: dom.targetLang.value,
        provider: dom.provider.value,
    });
}

// ========== 操作 ==========
async function doTranslate() {
    const status = await sendToContent('getStatus');
    if (status?.isProcessing || status?.isTranslated) return;

    isTranslating = true;
    updateUI();

    const res = await sendToContent('translate', {
        targetLanguage: dom.targetLang.value,
        provider: dom.provider.value,
    });

    if (res?.ok === false) {
        dom.statusText.textContent = '翻译失败，请重试';
        isTranslating = false;
        updateUI();
    } else {
        startPolling();
    }
}

async function doRestore() {
    isTranslating = true;
    updateUI();

    await sendToContent('restore');

    isTranslated = false;
    isTranslating = false;
    updateUI();
}

function startPolling() {
    if (translateTimer) return;

    translateTimer = setInterval(async () => {
        const status = await sendToContent('getStatus');
        if (!status) return;

        if (status.isTranslated) {
            clearInterval(translateTimer);
            translateTimer = null;
            isTranslating = false;
            isTranslated = true;
            updateUI();
        } else if (!status.isProcessing) {
            clearInterval(translateTimer);
            translateTimer = null;
            isTranslating = false;
            dom.statusText.textContent = '翻译已停止';
            updateUI();
        }
    }, 300);
}

// ========== 初始化 ==========
async function init() {
    await loadSettings();
    const status = await sendToContent('getStatus');

    if (status?.isTranslated) {
        isTranslated = true;
    } else if (status?.isProcessing) {
        isTranslating = true;
        startPolling();
    }

    updateUI();
}

// ========== 事件 ==========
dom.actionBtn.addEventListener('click', () => {
    if (isTranslated) {
        doRestore();
    } else if (!isTranslating) {
        doTranslate();
    }
});

dom.targetLang.addEventListener('change', () => {
    saveSettings();
    if (isTranslated) updateUI(); // 翻译后切换语言，更新状态提示
});

dom.provider.addEventListener('change', saveSettings);

init();
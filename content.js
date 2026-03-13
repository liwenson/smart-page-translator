// Smart Page Translator - Content Script
(function () {
    'use strict';

    if (window.__sptLoaded) return;
    window.__sptLoaded = true;

    // ========== 配置 ==========
    const CONFIG = {
        BATCH_SIZE: 30,
        DEBOUNCE_MS: 600,
        MIN_TEXT_LEN: 2,
        MAX_TEXT_LEN: 3000,
        CACHE_MAX: 5000,
        EXCLUDED_TAGS: new Set([
            'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
            'BUTTON', 'SELECT', 'OPTION', 'CANVAS', 'AUDIO', 'VIDEO',
            'NOSCRIPT', 'IFRAME', 'SVG', 'PATH', 'LINK', 'META', 'HEAD',
        ]),
    };

    // ========== 状态 ==========
    const state = {
        translated: false,
        processing: false,
        targetLang: 'zh-CN',
        totalNodes: 0,
        translatedNodes: 0,
    };

    // ========== LRU 缓存 ==========
    class LRUCache {
        constructor(max) {
            this._max = max;
            this._map = new Map();
        }
        get(key) {
            if (!this._map.has(key)) return undefined;
            const val = this._map.get(key);
            this._map.delete(key);
            this._map.set(key, val);
            return val;
        }
        set(key, val) {
            if (this._map.has(key)) this._map.delete(key);
            else if (this._map.size >= this._max) this._map.delete(this._map.keys().next().value);
            this._map.set(key, val);
        }
        has(key) { return this._map.has(key); }
        clear() { this._map.clear(); }
        get size() { return this._map.size; }
    }

    const cache = new LRUCache(CONFIG.CACHE_MAX);
    const originalText = new WeakMap();
    const translatedNodes = new Set();

    // ========== FNV-1a 哈希 ==========
    function hash(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    // ========== 语言检测 ==========
    function detectPageLang() {
        const htmlLang = document.documentElement.lang?.trim();
        if (htmlLang) return htmlLang.split('-')[0].toLowerCase();

        const meta = document.querySelector(
            'meta[http-equiv="content-language"], meta[property="og:locale"], meta[name="language"]'
        );
        if (meta?.content) return meta.content.split(/[-_]/)[0].toLowerCase();

        return inferLangFromText(sampleText());
    }

    // Collect all text nodes for language detection
    function collectAllTextNodes(root, sampleLimit = Infinity) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const text = node.nodeValue?.trim();
                if (!text) return NodeFilter.FILTER_REJECT;
                if (isExcludedAncestor(node)) return NodeFilter.FILTER_REJECT;
                // Do not filter by target language here; used only for detection
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        let node;
        while ((node = walker.nextNode()) && nodes.length < sampleLimit) nodes.push(node);
        return nodes;
    }

    function sampleText() {
        return collectAllTextNodes(document.body, 30)
            .map(n => n.nodeValue?.trim()).filter(Boolean).join(' ');
    }

    function inferLangFromText(text) {
        if (!text || text.length < 10) return 'unknown';
        const scripts = [
            { lang: 'zh', re: /[\u4e00-\u9fa5]/g, threshold: 0.15 },
            { lang: 'ja', re: /[\u3040-\u30ff]/g, threshold: 0.05 },
            { lang: 'ko', re: /[\uac00-\ud7af]/g, threshold: 0.10 },
            { lang: 'ar', re: /[\u0600-\u06ff]/g, threshold: 0.10 },
            { lang: 'ru', re: /[\u0400-\u04ff]/g, threshold: 0.10 },
            { lang: 'th', re: /[\u0e00-\u0e7f]/g, threshold: 0.10 },
        ];
        for (const { lang, re, threshold } of scripts) {
            const m = text.match(re);
            if (m && m.length / text.length > threshold) return lang;
        }
        return 'en';
    }

    // ========== 节点过滤 ==========
    function isExcludedAncestor(node) {
        let el = node.parentElement;
        while (el) {
            if (CONFIG.EXCLUDED_TAGS.has(el.tagName)) return true;
            el = el.parentElement;
        }
        return false;
    }

    function isAlreadyInTargetLang(text) {
        if (!text) return false;

        const meaningfulRe = /[A-Za-z\u00C0-\u024F\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff\u0400-\u04ff\u0e00-\u0e7f]/g;
        const meaningfulCount = (text.match(meaningfulRe) || []).length;
        if (!meaningfulCount) return false;

        const target = (state.targetLang || '').toLowerCase();
        let targetRe;

        if (target.startsWith('zh')) targetRe = /[\u4e00-\u9fa5]/g;
        else if (target.startsWith('ja')) targetRe = /[\u3040-\u30ff]/g;
        else if (target.startsWith('ko')) targetRe = /[\uac00-\ud7af]/g;
        else if (target.startsWith('ar')) targetRe = /[\u0600-\u06ff]/g;
        else if (target.startsWith('ru')) targetRe = /[\u0400-\u04ff]/g;
        else if (target.startsWith('th')) targetRe = /[\u0e00-\u0e7f]/g;
        else targetRe = /[A-Za-z\u00C0-\u024F]/g;

        const targetCount = (text.match(targetRe) || []).length;
        return targetCount / meaningfulCount > 0.5;
    }

    function isValidText(text) {
        if (!text || text.length < CONFIG.MIN_TEXT_LEN || text.length > CONFIG.MAX_TEXT_LEN) return false;
        if (!/[a-zA-Z\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
        if (/^[\d\s\W]+$/.test(text)) return false;
        if (/^https?:\/\/\S+$/.test(text.trim())) return false;
        return true;
    }

    // Collect valid text nodes for translation
    function collectTextNodes(root, sampleLimit = Infinity) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const text = node.nodeValue?.trim();
                if (!isValidText(text)) return NodeFilter.FILTER_REJECT;
                if (isExcludedAncestor(node)) return NodeFilter.FILTER_REJECT;
                if (isAlreadyInTargetLang(text)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        let node;
        while ((node = walker.nextNode()) && nodes.length < sampleLimit) nodes.push(node);
        return nodes;
    }

    // ========== 翻译请求 ==========
    async function requestTranslation(texts, retryCount = 0) {
        const MAX_RETRIES = 3;
        
        try {
            return await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                    { action: 'translate', texts, targetLanguage: state.targetLang },
                    res => {
                        if (chrome.runtime.lastError) {
                            const error = chrome.runtime.lastError.message || 'Unknown error';
                            if (retryCount < MAX_RETRIES) {
                                setTimeout(() => {
                                    requestTranslation(texts, retryCount + 1).then(resolve).catch(reject);
                                }, 500 * (retryCount + 1));
                            } else {
                                reject(new Error('翻译服务不可用'));
                            }
                            return;
                        }
                        if (res?.success) {
                            resolve(res.translations);
                        } else {
                            reject(new Error(res?.error || 'Translation failed'));
                        }
                    }
                );
            });
        } catch (e) {
            throw e;
        }
    }

    async function translateBatch(texts) {
        const results = new Array(texts.length);
        const missIdx = [];
        const missTexts = [];

        // 缓存命中
        texts.forEach((text, i) => {
            const key = hash(text);
            const cached = cache.get(key);
            if (cached !== undefined) {
                results[i] = cached;
            } else {
                missIdx.push(i);
                missTexts.push(text);
            }
        });

        if (!missTexts.length) return results;

        // 请求翻译
        let translations;
        try {
            translations = await requestTranslation(missTexts);
        } catch (e) {
            translations = missTexts;
        }

        // 更新缓存
        translations.forEach((t, i) => {
            const key = hash(missTexts[i]);
            cache.set(key, t);
            results[missIdx[i]] = t;
        });

        return results;
    }

    // ========== 批量处理 ==========
    async function processNodes(nodes) {
        if (!nodes.length) return;
        
        state.totalNodes += nodes.length;
        const BATCH = CONFIG.BATCH_SIZE;

        for (let i = 0; i < nodes.length; i += BATCH) {
            const batch = nodes.slice(i, i + BATCH);
            const texts = batch.map(n => n.nodeValue.trim());

            let translated;
            try {
                translated = await translateBatch(texts);
            } catch (e) {
                continue;
            }

            batch.forEach((node, j) => {
                if (!originalText.has(node)) {
                    originalText.set(node, node.nodeValue);
                    translatedNodes.add(node);
                }
                node.nodeValue = translated[j] ?? node.nodeValue;
                state.translatedNodes++;
            });

            // Yield to main thread between batches
            if (i + BATCH < nodes.length) await new Promise(r => setTimeout(r, 30));
        }
    }

    // ========== DOM 监听 ==========
    let observer = null;
    let pendingNodes = [];
    let pendingSet = new Set();
    let debounceTimer = null;
    let scrollTimer = null;
    let periodicTimer = null;

    function scheduleProcess() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            if (!pendingNodes.length || state.processing) return;
            state.processing = true;
            try {
                const toProcess = pendingNodes.splice(0);
                // clear corresponding IDs from pendingSet
                toProcess.forEach(n => pendingSet.delete(n));
                await processNodes(toProcess);
            } finally {
                state.processing = false;
            }
        }, CONFIG.DEBOUNCE_MS);
    }

    // Collect pending translation nodes
    function collectPendingNodes() {
        const nodes = collectTextNodes(document.body);
        const untranslated = [];
        for (const n of nodes) {
            const orig = originalText.get(n);
            const isUntranslated = orig === undefined || orig === n.nodeValue;
            if (isUntranslated && !pendingSet.has(n) && !translatedNodes.has(n)) {
                untranslated.push(n);
            }
        }
        return untranslated;
    }

    // Trigger translation on scroll
    function onScroll() {
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            if (!state.translated) return;
            
            const nodes = collectPendingNodes();
            if (nodes.length > 0) {
                nodes.forEach(n => {
                    if (!pendingSet.has(n)) {
                        pendingNodes.push(n);
                        pendingSet.add(n);
                    }
                });
                if (!state.processing) scheduleProcess();
            }
        }, 200);
    }

    // Periodic check for lazy-loaded content
    function startPeriodicCheck() {
        if (periodicTimer) return;
        periodicTimer = setInterval(() => {
            if (!state.translated) return;
            
            const nodes = collectPendingNodes();
            if (nodes.length > 0) {
                nodes.forEach(n => {
                    if (!pendingSet.has(n)) {
                        pendingNodes.push(n);
                        pendingSet.add(n);
                    }
                });
                if (!state.processing) scheduleProcess();
            }
        }, 3000);
    }

    function startObserver() {
        if (observer) return;
        
        observer = new MutationObserver(mutations => {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const newNodes = collectTextNodes(node);
                        newNodes.forEach(n => {
                            if (!pendingSet.has(n) && !translatedNodes.has(n)) {
                                pendingNodes.push(n);
                                pendingSet.add(n);
                            }
                        });
                    }
                });
            });
            if (pendingNodes.length && !state.processing) scheduleProcess();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        
        window.addEventListener('scroll', onScroll, { passive: true });
        startPeriodicCheck();
    }

    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (scrollTimer) {
            clearTimeout(scrollTimer);
            scrollTimer = null;
        }
        if (periodicTimer) {
            clearInterval(periodicTimer);
            periodicTimer = null;
        }
        window.removeEventListener('scroll', onScroll);
    }

    // Main translation flow
    async function startTranslation() {
        if (state.translated || state.processing) {
            return;
        }
        state.processing = true;
        
        try {
            const nodes = collectTextNodes(document.body);
            if (!nodes.length) {
                return;
            }
            await processNodes(nodes);
            state.translated = true;
            startObserver();
        } finally {
            state.processing = false;
        }
    }

    // Restore original text
    function restorePage() {
        if (!state.translated) return;

        stopObserver();
        clearTimeout(debounceTimer);
        pendingNodes = [];
        pendingSet.clear();

        translatedNodes.forEach(node => {
            const orig = originalText.get(node);
            if (orig !== undefined) node.nodeValue = orig;
        });
        translatedNodes.clear();

        cache.clear();
        state.translated = false;
        state.processing = false;
        state.totalNodes = 0;
        state.translatedNodes = 0;
    }

    // ========== 消息处理 ==========
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        switch (msg.action) {
            case 'ping':
                sendResponse({ ok: true });
                break;

            case 'translate':
                if (msg.targetLanguage) state.targetLang = msg.targetLanguage;
                startTranslation()
                    .then(() => sendResponse({ ok: true }))
                    .catch(() => sendResponse({ ok: false }));
                return true;

            case 'restore':
                restorePage();
                sendResponse({ ok: true });
                break;

            case 'getStatus':
                sendResponse({
                    isTranslated: state.translated,
                    isProcessing: state.processing,
                    targetLanguage: state.targetLang,
                    progress: state.totalNodes > 0 ? 
                        Math.round((state.translatedNodes / state.totalNodes) * 100) : 0
                });
                break;

            case 'detectLanguage':
                sendResponse({ language: detectPageLang() });
                break;

            case 'setTargetLanguage':
                state.targetLang = msg.language;
                sendResponse({ ok: true });
                break;
        }
    });

    console.log('[SPT] Content script v4.1 loaded');
})();

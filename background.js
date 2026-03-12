// Smart Page Translator - Background Service Worker v3.2
'use strict';

(function () {
    'use strict';

    // ========== 配置 ==========
    const CONFIG = {
        MAX_CONCURRENT: 5,
        REQUEST_TIMEOUT: 10000,
        MAX_RETRIES: 2,
        CHUNK_SIZE: 50,
        DEFAULT_PROVIDER: 'viki',
        API_PRIORITY: ['viki', 'bing'],
        APIS: {
            viki: {
                name: 'Viki翻译',
                enabled: true,
                weight: 1.0,
                batch: false,
                langMap: { 'zh-CN': 'zh', 'zh-TW': 'zh', 'en': 'en', 'ja': 'ja', 'ko': 'ko' }
            },
            bing: {
                name: 'Bing',
                enabled: true,
                weight: 0.9,
                batch: true,
                langMap: { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'en': 'en' }
            },
        }
    };

    // ========== 工具函数 ==========
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function chunkArray(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    async function fetchWithTimeout(url, options = {}, timeout = CONFIG.REQUEST_TIMEOUT) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            return await fetch(url, { ...options, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async function withRetry(fn, retries = CONFIG.MAX_RETRIES) {
        let lastErr;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (e) {
                lastErr = e;
                if (i < retries) await sleep(500 * (i + 1));
            }
        }
        throw lastErr;
    }

    // ========== Semaphore 并发控制 ==========
    class Semaphore {
        constructor(max) { this._max = max; this._count = 0; this._queue = []; }
        acquire() {
            return new Promise(resolve => {
                if (this._count < this._max) { this._count++; resolve(); }
                else this._queue.push(resolve);
            });
        }
        release() {
            if (this._queue.length) this._queue.shift()();
            else this._count--;
        }
        async run(fn) {
            await this.acquire();
            try { return await fn(); } finally { this.release(); }
        }
    }
    const sem = new Semaphore(CONFIG.MAX_CONCURRENT);

    // ========== Bing 翻译 API (Edge Translate) ==========
    // 接口: POST https://edge.microsoft.com/translate/translatetext
    // 请求体: [{"Text": "..."}, ...]
    // 响应:  [{"translations": [{"text": "...", "to": "zh-Hans"}]}, ...]
    // 无需 Token，原生支持批量文本数组
    const BingAPI = {
        name: 'bing',
        endpoint: 'https://edge.microsoft.com/translate/translatetext',
        langMap: { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' },
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
            'Referer': 'https://cn.bing.com/',
            'Origin': 'https://cn.bing.com',
        },

        async translate(texts, targetLang) {
            const to = this.langMap[targetLang] ?? targetLang.split('-')[0];
            const results = [];

            for (const chunk of chunkArray(texts, CONFIG.CHUNK_SIZE)) {
                const translated = await withRetry(async () => {
                    const res = await fetchWithTimeout(
                        `${this.endpoint}?from=auto-detect&to=${encodeURIComponent(to)}&isEnterpriseClient=false`,
                        {
                            method: 'POST',
                            headers: this.headers,
                            body: JSON.stringify(chunk.map(t => ({ Text: t }))),
                        }
                    );
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    if (!Array.isArray(data)) throw new Error('Invalid response');
                    return data.map((item, i) =>
                        item?.translations?.[0]?.text ?? chunk[i]
                    );
                });
                results.push(...translated);
            }
            return results;
        }
    };

    // ========== Viki 翻译 API ==========
    // 接口: GET /v2/fanyi?text=xxx&from=auto&to=zh
    // 响应: { code: 200, data: { target: { text: "译文", type: "zh-CHS", ... } } }
    // 数据来源于有道翻译
    const VikiAPI = {
        name: 'viki',
        baseUrl: 'https://60s.viki.moe',
        async translate(texts, targetLang) {
            const results = [];
            for (const text of texts) {
                try {
                    const langTo = targetLang.startsWith('zh') ? 'zh' : targetLang.split('-')[0];
                    const url = `${this.baseUrl}/v2/fanyi?text=${encodeURIComponent(text)}&from=auto&to=${langTo}`;
                    const res = await fetchWithTimeout(url, {}, 15000);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    if (data?.code === 200 && data?.data?.target?.text) {
                        results.push(data.data.target.text);
                    } else {
                        console.warn('[Viki] Unexpected response:', JSON.stringify(data).slice(0, 100));
                        results.push(text);
                    }
                } catch (e) {
                    console.warn('[Viki] Failed:', text.slice(0, 20), e.message);
                    results.push(text);
                }
            }
            return results;
        }
    };

    // ========== 翻译调度器 ==========
    class TranslationScheduler {
        constructor() {
            this.apis = {
                viki: VikiAPI,
                bing: BingAPI,
            };
            this.stats = { attempts: {}, failures: {}, successes: {} };
        }

        recordAttempt(api) { this.stats.attempts[api] = (this.stats.attempts[api] || 0) + 1; }
        recordFailure(api) { this.stats.failures[api] = (this.stats.failures[api] || 0) + 1; }
        recordSuccess(api) { this.stats.successes[api] = (this.stats.successes[api] || 0) + 1; }

        async translate(texts, targetLang, preferredApi = CONFIG.DEFAULT_PROVIDER) {
            const validTexts = texts.filter(t => t?.trim());
            if (!validTexts.length) return texts;

            // 优先使用用户选择的 API，失败则按优先级降级
            const order = [
                preferredApi,
                ...CONFIG.API_PRIORITY.filter(a => a !== preferredApi)
            ].filter(a => this.apis[a]);

            let lastErr;
            for (const apiName of order) {
                const api = this.apis[apiName];
                try {
                    this.recordAttempt(apiName);
                    const results = await api.translate(validTexts, targetLang);
                    this.recordSuccess(apiName);
                    if (apiName !== preferredApi) {
                        console.info(`[Scheduler] Fell back to ${apiName}`);
                    }
                    return this.mergeResults(texts, results, validTexts);
                } catch (e) {
                    this.recordFailure(apiName);
                    lastErr = e;
                    console.warn(`[Scheduler] ${apiName} failed:`, e.message);
                }
            }

            console.error('[Scheduler] All APIs failed:', lastErr?.message);
            return texts;
        }

        mergeResults(originalTexts, translated, validTexts) {
            const results = [...originalTexts];
            let idx = 0;
            originalTexts.forEach((t, i) => {
                if (t?.trim()) results[i] = translated[idx++] ?? t;
            });
            return results;
        }
    }

    const scheduler = new TranslationScheduler();

    // ========== 消息处理 ==========
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        // ping 用于确认 service worker 是否可用
        if (msg.action === 'ping') {
            sendResponse({ ok: true, provider: CONFIG.DEFAULT_PROVIDER });
            return false;
        }

        if (msg.action === 'translate') {
            const { texts, provider = CONFIG.DEFAULT_PROVIDER, targetLanguage = 'zh-CN' } = msg;
            if (!Array.isArray(texts) || !texts.length) {
                sendResponse({ success: false, error: 'Invalid texts array' });
                return false;
            }

            scheduler.translate(texts, targetLanguage, provider)
                .then(translations => sendResponse({ success: true, translations }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            
            return true;
        }

        if (msg.action === 'getStats') {
            sendResponse(scheduler.stats);
            return false;
        }

        return false;
    });

    console.log('[BG] Translation service v3.2 loaded');
})();
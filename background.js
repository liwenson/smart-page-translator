// Smart Page Translator - Background Service Worker v5.1
// 支持Edge和Google翻译接口
'use strict';

(function () {
    'use strict';

    // ========== 配置 ==========
    const CONFIG = {
        REQUEST_TIMEOUT: 15000,
        CHUNK_SIZE: 50,
        DEFAULT_TARGET_LANG: 'zh-CN',
        DEFAULT_PROVIDER: 'edge', // 'edge' or 'google'
    };

    // ========== 工具函数 ==========
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function chunkArray(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    // ========== Edge 翻译 API ==========
    const EdgeAPI = {
        endpoint: 'https://edge.microsoft.com/translate/translatetext',

        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
            'Content-Type': 'application/json',
            'Referer': 'https://cn.bing.com/',
            'Origin': 'https://cn.bing.com'
        },

        // 语言映射
        toLangMap: {
            'zh-CN': 'zh-Hans',
            'zh-TW': 'zh-Hant',
        },

        /**
         * 构建请求 URL
         */
        buildUrl(fromLang, toLang) {
            const url = new URL(this.endpoint);
            if (fromLang && fromLang !== 'auto') {
                url.searchParams.set('from', fromLang);
            }
            url.searchParams.set('to', toLang);
            url.searchParams.set('isEnterpriseClient', 'false');
            return url.toString();
        },

        /**
         * 翻译文本列表
         * @param {string[]} texts - 待翻译文本
         * @param {string} targetLang - 目标语言
         * @param {string} [sourceLang='auto'] - 源语言
         * @returns {Promise<string[]>}
         */
        async translate(texts, targetLang, sourceLang = 'auto') {
            if (!texts.length) return [];

            const to = this.toLangMap[targetLang] ?? targetLang.split('-')[0];
            const results = [];

            for (const chunk of chunkArray(texts, CONFIG.CHUNK_SIZE)) {
                const url = this.buildUrl(sourceLang, to);

                try {
                    const response = await fetch(url.toString(), {
                        method: 'POST',
                        headers: this.headers,
                        body: JSON.stringify(chunk),
                        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const data = await response.json();
                    if (!Array.isArray(data)) {
                        throw new Error('Invalid response format');
                    }

                    for (const item of data) {
                        if (item.translations && item.translations.length > 0) {
                            results.push(item.translations[0].text);
                        } else {
                            results.push('');
                        }
                    }
                } catch (e) {
                    console.error('[EdgeAPI] Translation error:', e.message);
                    for (let i = 0; i < chunk.length; i++) {
                        results.push('');
                    }
                }
            }

            return results;
        }
    };

    // ========== Google 翻译 API (免费) ==========
    const GoogleAPI = {
        endpoint: 'https://translate.googleapis.com/translate_a/single',

        params: {
            client: 'gtx',
            sl: 'auto',
            tl: 'zh-CN',
            dt: 't',
        },

        /**
         * 翻译单个文本
         */
        async translateText(text, targetLang, sourceLang = 'auto') {
            const url = new URL(this.endpoint);
            url.searchParams.set('client', 'gtx');
            url.searchParams.set('sl', sourceLang);
            url.searchParams.set('tl', targetLang);
            url.searchParams.set('dt', 't');
            url.searchParams.set('q', text);

            try {
                const response = await fetch(url.toString(), {
                    signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();
                if (!data || !data[0]) {
                    throw new Error('Invalid response');
                }

                // 解析翻译结果
                let result = '';
                for (const item of data[0]) {
                    if (item[0]) {
                        result += item[0];
                    }
                }
                return result;
            } catch (e) {
                console.error('[GoogleAPI] Translation error:', e.message);
                return '';
            }
        },

        /**
         * 翻译文本列表
         * @param {string[]} texts - 待翻译文本
         * @param {string} targetLang - 目标语言
         * @param {string} [sourceLang='auto'] - 源语言
         * @returns {Promise<string[]>}
         */
        async translate(texts, targetLang, sourceLang = 'auto') {
            if (!texts.length) return [];

            const results = [];

            // Google API 每次只能翻译一个文本
            for (const text of texts) {
                const translated = await this.translateText(text, targetLang, sourceLang);
                results.push(translated);
                // 添加小延迟避免限速
                await sleep(50);
            }

            return results;
        }
    };

    // ========== 翻译引擎选择 ==========
    const API_PROVIDERS = {
        edge: EdgeAPI,
        google: GoogleAPI,
    };

    // ========== 消息处理 ==========
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'ping') {
            sendResponse({ ok: true });
            return false;
        }

        if (msg.action === 'translate') {
            const {
                texts,
                targetLanguage = CONFIG.DEFAULT_TARGET_LANG,
                sourceLanguage = 'auto',
                provider = CONFIG.DEFAULT_PROVIDER,
            } = msg;

            if (!Array.isArray(texts) || !texts.length) {
                sendResponse({ success: false, error: 'Invalid texts array' });
                return false;
            }

            // 过滤空文本，翻译后按原位置回填
            const validIndices = [];
            const validTexts = [];
            texts.forEach((t, i) => {
                if (t?.trim()) {
                    validIndices.push(i);
                    validTexts.push(t);
                }
            });

            // 选择翻译API
            const api = API_PROVIDERS[provider] || API_PROVIDERS.edge;

            api.translate(validTexts, targetLanguage, sourceLanguage)
                .then(translated => {
                    const translations = [...texts];
                    validIndices.forEach((origIdx, i) => {
                        translations[origIdx] = translated[i] ?? texts[origIdx];
                    });
                    sendResponse({ success: true, translations });
                })
                .catch(err => {
                    console.error('[BG] Translation failed:', err.message);
                    sendResponse({ success: false, error: err.message });
                });

            return true;
        }

        return false;
    });

    console.log('[BG] Translation service v5.1 loaded (Edge + Google)');
})();

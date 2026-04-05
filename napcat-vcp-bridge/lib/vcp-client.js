const http = require('http');
const https = require('https');

function sanitizeSegment(text) {
    if (!text) return '';
    let seg = text;
    seg = seg.replace(/<<<\[(?:TOOL_REQUEST|END_TOOL_REQUEST)\]>>>/g, '');
    seg = seg.replace(/「始」.*?「末」/g, '');
    seg = seg.replace(/\n{3,}/g, '\n\n');
    return seg.trim();
}

class VcpClient {
    constructor(options = {}) {
        this.vcpConfig = options.vcpConfig || {};
        this.proactiveConfig = options.proactiveConfig || {};
        this.log = options.log || (() => { });
        this._embeddingCache = new Map();
        this._embeddingCacheLimit = Math.max(32, Number(options.embeddingCacheLimit) || 256);
    }

    getEmbeddingCacheKey(text, model) {
        return `${String(model || '')}:${String(text || '')}`;
    }

    getCachedEmbedding(text, model) {
        const key = this.getEmbeddingCacheKey(text, model);
        if (!this._embeddingCache.has(key)) return null;
        const value = this._embeddingCache.get(key);
        this._embeddingCache.delete(key);
        this._embeddingCache.set(key, value);
        return value;
    }

    setCachedEmbedding(text, model, vector) {
        if (!Array.isArray(vector) || !vector.length) return;
        const key = this.getEmbeddingCacheKey(text, model);
        if (this._embeddingCache.has(key)) {
            this._embeddingCache.delete(key);
        }
        this._embeddingCache.set(key, vector);
        while (this._embeddingCache.size > this._embeddingCacheLimit) {
            const firstKey = this._embeddingCache.keys().next().value;
            this._embeddingCache.delete(firstKey);
        }
    }

    invalidateEmbeddingCache(modelPrefix = '') {
        if (!modelPrefix) {
            this._embeddingCache.clear();
            return;
        }

        const prefix = `${String(modelPrefix)}:`;
        for (const key of this._embeddingCache.keys()) {
            if (key.startsWith(prefix)) {
                this._embeddingCache.delete(key);
            }
        }
    }

    httpRequest(url, method, headers, body) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const isHttps = urlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method,
                headers
            };

            const req = httpModule.request(requestOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });

            req.on('error', reject);
            req.setTimeout(120000, () => {
                req.destroy();
                reject(new Error('HTTP 请求超时（120秒）'));
            });
            if (body) req.write(body);
            req.end();
        });
    }

    async callVCP(messages) {
        const body = JSON.stringify({
            model: this.vcpConfig.model,
            messages,
            stream: false
        });

        const res = await this.httpRequest(
            this.vcpConfig.apiUrl,
            'POST',
            {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.vcpConfig.apiKey}`,
                'Content-Length': Buffer.byteLength(body)
            },
            body
        );

        if (res.status !== 200) {
            throw new Error(`VCP 返回 HTTP ${res.status}: ${res.body.substring(0, 500)}`);
        }

        const json = JSON.parse(res.body);
        const reply = json.choices?.[0]?.message?.content;
        if (!reply) {
            throw new Error('VCP 响应格式异常：无 choices[0].message.content');
        }
        return reply;
    }

    getEmbeddingsUrl() {
        const urlObj = new URL(this.vcpConfig.apiUrl);
        if (urlObj.pathname.endsWith('/chat/completions')) {
            urlObj.pathname = urlObj.pathname.replace(/\/chat\/completions$/, '/embeddings');
        } else {
            urlObj.pathname = '/v1/embeddings';
        }
        urlObj.search = '';
        return urlObj.toString();
    }

    async getEmbeddings(input, model) {
        const normalizedInput = (Array.isArray(input) ? input : [input])
            .map((item) => String(item ?? '').trim());
        if (!normalizedInput.length) return [];

        const cached = new Array(normalizedInput.length).fill(null);
        const pendingInputs = [];
        const pendingIndexes = [];

        normalizedInput.forEach((text, index) => {
            const hit = this.getCachedEmbedding(text, model);
            if (hit) {
                cached[index] = hit;
                return;
            }
            pendingInputs.push(text);
            pendingIndexes.push(index);
        });

        if (!pendingInputs.length) {
            return cached;
        }

        const body = JSON.stringify({
            model,
            input: pendingInputs
        });

        const res = await this.httpRequest(
            this.getEmbeddingsUrl(),
            'POST',
            {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.vcpConfig.apiKey}`,
                'Content-Length': Buffer.byteLength(body)
            },
            body
        );

        if (res.status !== 200) {
            throw new Error(`Embeddings 返回 HTTP ${res.status}: ${res.body.substring(0, 500)}`);
        }

        const json = JSON.parse(res.body);
        const data = Array.isArray(json.data) ? json.data : [];
        const fetched = new Map();
        data.forEach((item, index) => {
            const inputIndex = Number.isInteger(item?.index) ? item.index : index;
            if (Array.isArray(item?.embedding) && item.embedding.length > 0) {
                fetched.set(inputIndex, item.embedding);
            }
        });

        pendingIndexes.forEach((originalIndex, requestIndex) => {
            const vector = fetched.get(requestIndex);
            if (!Array.isArray(vector) || !vector.length) {
                throw new Error(`Embeddings 响应缺少第 ${requestIndex} 条向量`);
            }
            cached[originalIndex] = vector;
            this.setCachedEmbedding(normalizedInput[originalIndex], model, vector);
        });

        return cached;
    }

    async getEmbedding(input, model) {
        const normalizedInput = String(input ?? '').trim();
        if (!normalizedInput) return null;

        const cached = this.getCachedEmbedding(normalizedInput, model);
        if (cached) return cached;

        const embeddings = await this.getEmbeddings([normalizedInput], model);
        return embeddings[0] || null;
    }

    callVCPStreaming(messages, onSegment) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(this.vcpConfig.apiUrl);
            const isHttps = urlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const body = JSON.stringify({
                model: this.vcpConfig.model,
                messages,
                stream: true
            });

            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.vcpConfig.apiKey}`,
                    Accept: 'text/event-stream',
                    'Content-Length': Buffer.byteLength(body)
                }
            };

            const req = httpModule.request(requestOptions, (res) => {
                if (res.statusCode !== 200) {
                    let errBody = '';
                    res.on('data', (chunk) => {
                        errBody += chunk;
                    });
                    res.on('end', () => reject(new Error(`VCP 返回 HTTP ${res.statusCode}: ${errBody.substring(0, 500)}`)));
                    return;
                }

                let sseBuffer = '';
                let fullContent = '';
                let pendingText = '';
                let insideToolBlock = false;

                const TOOL_START = '<<<[TOOL_REQUEST]>>>';
                const TOOL_END = '<<<[END_TOOL_REQUEST]>>>';

                let sendQueue = Promise.resolve();

                function flushSegment() {
                    const seg = sanitizeSegment(pendingText);
                    pendingText = '';
                    if (seg.length > 0 && onSegment) {
                        sendQueue = sendQueue.then(() => onSegment(seg)).catch((err) => {
                            this.log('ERROR', '[VCPStreaming] onSegment 回调失败:', err.message);
                        });
                    }
                }

                const flushSegmentBound = flushSegment.bind(this);

                function processContent(delta) {
                    if (!delta) return;
                    fullContent += delta;
                    pendingText += delta;

                    while (true) {
                        if (!insideToolBlock) {
                            const startIdx = pendingText.indexOf(TOOL_START);
                            if (startIdx !== -1) {
                                const beforeTool = pendingText.substring(0, startIdx);
                                pendingText = pendingText.substring(startIdx + TOOL_START.length);
                                insideToolBlock = true;

                                const savedPending = pendingText;
                                pendingText = beforeTool;
                                flushSegmentBound();
                                pendingText = savedPending;
                                continue;
                            }
                            break;
                        } else {
                            const endIdx = pendingText.indexOf(TOOL_END);
                            if (endIdx !== -1) {
                                pendingText = pendingText.substring(endIdx + TOOL_END.length);
                                insideToolBlock = false;
                                continue;
                            }
                            break;
                        }
                    }
                }

                res.on('data', (chunk) => {
                    sseBuffer += chunk.toString();
                    const lines = sseBuffer.split(/\r\n|\r|\n/);
                    sseBuffer = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;

                        if (trimmed.startsWith('data: ') || trimmed.startsWith('data:')) {
                            const jsonStr = trimmed.startsWith('data: ')
                                ? trimmed.substring(6).trim()
                                : trimmed.substring(5).trim();

                            if (jsonStr === '[DONE]') continue;
                            try {
                                const parsed = JSON.parse(jsonStr);
                                const delta = parsed.choices?.[0]?.delta?.content;
                                if (delta) processContent(delta);
                            } catch (_err) {
                                // Ignore invalid SSE payload.
                            }
                        }
                    }
                });

                res.on('end', () => {
                    if (sseBuffer.trim()) {
                        const trimmed = sseBuffer.trim();
                        if (trimmed.startsWith('data: ') || trimmed.startsWith('data:')) {
                            const jsonStr = trimmed.startsWith('data: ')
                                ? trimmed.substring(6).trim()
                                : trimmed.substring(5).trim();
                            if (jsonStr !== '[DONE]') {
                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const delta = parsed.choices?.[0]?.delta?.content;
                                    if (delta) processContent(delta);
                                } catch (_err) {
                                    // Ignore invalid SSE payload.
                                }
                            }
                        }
                    }

                    if (!insideToolBlock && pendingText.trim()) {
                        flushSegmentBound();
                    }

                    sendQueue
                        .then(() => {
                            if (!fullContent) reject(new Error('VCP 流式响应为空：未收到任何内容'));
                            else resolve(fullContent);
                        })
                        .catch(reject);
                });

                res.on('error', reject);
            });

            req.on('error', reject);
            req.setTimeout(180000, () => {
                req.destroy();
                reject(new Error('VCP 流式请求超时（180秒）'));
            });
            req.write(body);
            req.end();
        });
    }

    async checkRelevance(text) {
        return this.checkRelevanceWithOptions(text, {});
    }

    async checkRelevanceWithOptions(text, options = {}) {
        const gateUrl = options.gateUrl
            || this.proactiveConfig.relevanceGateUrl
            || `http://localhost:${process.env.VCP_PORT || 5890}/api/plugins/RelevanceGate/check`;

        const body = JSON.stringify({
            text,
            threshold: options.threshold ?? this.proactiveConfig.threshold ?? 0.45,
            k: options.k ?? this.proactiveConfig.searchK ?? 3,
            tag_boost: options.tagBoost ?? this.proactiveConfig.tagBoost ?? 0.5,
            diary_name: options.diaryName || ''
        });

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        };

        const relevanceToken = options.relevanceToken ?? this.proactiveConfig.relevanceToken;
        if (relevanceToken) {
            headers.Authorization = `Bearer ${relevanceToken}`;
        }

        try {
            const res = await this.httpRequest(gateUrl, 'POST', headers, body);
            if (res.status !== 200) {
                this.log('WARN', `RelevanceGate 返回 HTTP ${res.status}`);
                return { relevant: false, score: 0 };
            }
            return JSON.parse(res.body);
        } catch (err) {
            this.log('WARN', `RelevanceGate 调用失败: ${err.message}`);
            return { relevant: false, score: 0 };
        }
    }

    async getSemanticScore(eventText, userId, diaryName = '', options = {}) {
        const baseUrl = options.gateUrl
            || this.proactiveConfig?.vpe?.semanticQueryGateUrl
            || this.proactiveConfig?.semanticQueryGateUrl
            || `http://localhost:${process.env.VCP_PORT || 5890}/api/plugins/SemanticQueryGate`;

        const gateUrl = baseUrl.endsWith('/match') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/match`;
        const body = JSON.stringify({
            event_text: eventText,
            user_id: String(userId || ''),
            diary_name: diaryName || ''
        });
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        };
        const token = options.token
            || this.proactiveConfig?.vpe?.semanticQueryGateToken
            || this.proactiveConfig?.semanticQueryGateToken;
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        try {
            const res = await this.httpRequest(gateUrl, 'POST', headers, body);
            if (res.status !== 200) {
                this.log('WARN', `SemanticQueryGate 返回 HTTP ${res.status}`);
                return null;
            }
            const parsed = JSON.parse(res.body);
            const semanticScore = Number(parsed?.semantic_score);
            return Number.isFinite(semanticScore) ? semanticScore : null;
        } catch (err) {
            this.log('WARN', `SemanticQueryGate 调用失败: ${err.message}`);
            return null;
        }
    }
}

module.exports = {
    VcpClient,
    sanitizeSegment
};

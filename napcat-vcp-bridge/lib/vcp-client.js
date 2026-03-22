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
        if (!this.proactiveConfig.enable) return { relevant: false, score: 0 };

        const gateUrl = this.proactiveConfig.relevanceGateUrl
            || `http://localhost:${process.env.VCP_PORT || 5890}/api/plugins/RelevanceGate/check`;

        const body = JSON.stringify({
            text,
            threshold: this.proactiveConfig.threshold || 0.45,
            k: this.proactiveConfig.searchK || 3,
            tag_boost: this.proactiveConfig.tagBoost || 0.5
        });

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        };

        if (this.proactiveConfig.relevanceToken) {
            headers.Authorization = `Bearer ${this.proactiveConfig.relevanceToken}`;
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
}

module.exports = {
    VcpClient,
    sanitizeSegment
};

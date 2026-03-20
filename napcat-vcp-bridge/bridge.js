#!/usr/bin/env node
/**
 * NapCat ↔ VCPToolBox Bridge
 * 通过 WebSocket 连接 NapCat（OneBot 11），将 QQ 消息转发给 VCP AI 并回复
 *
 * v3.0: 新增情感感知 + 动态阈值 + 私聊主动发话（梦式调度）
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── 加载配置 ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
    console.error('[Bridge] 无法加载配置文件 config.json:', err.message);
    process.exit(1);
}

const { napcat: napcatConfig, vcp: vcpConfig, bot: botConfig } = config;
const proactiveConfig = botConfig.proactive || {};

// ─── 日志 ────────────────────────────────────────────────────────────────────

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, ...args) {
    if (LOG_LEVELS[level] >= CURRENT_LOG_LEVEL) {
        const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
        const prefix = `[${timestamp}] [${level}]`;
        if (level === 'ERROR') console.error(prefix, ...args);
        else if (level === 'WARN') console.warn(prefix, ...args);
        else console.log(prefix, ...args);
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── 上下文管理 ──────────────────────────────────────────────────────────────

class ContextManager {
    constructor(maxRounds, ttlMinutes) {
        this.maxRounds = maxRounds;
        this.ttlMs = ttlMinutes * 60 * 1000;
        /** @type {Map<string, {messages: Array, lastAccess: number}>} */
        this.contexts = new Map();
        setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }

    getKey(userId, groupId) {
        if (botConfig.context.perUser) {
            return groupId ? `g${groupId}_u${userId}` : `u${userId}`;
        }
        return groupId ? `g${groupId}` : `u${userId}`;
    }

    getMessages(key) {
        const ctx = this.contexts.get(key);
        if (!ctx) return [];
        if (Date.now() - ctx.lastAccess > this.ttlMs) {
            this.contexts.delete(key);
            return [];
        }
        ctx.lastAccess = Date.now();
        return ctx.messages;
    }

    addRound(key, userMessage, assistantMessage) {
        let ctx = this.contexts.get(key);
        if (!ctx) {
            ctx = { messages: [], lastAccess: Date.now() };
            this.contexts.set(key, ctx);
        }
        ctx.messages.push(
            { role: 'user', content: userMessage },
            { role: 'assistant', content: assistantMessage }
        );
        while (ctx.messages.length > this.maxRounds * 2) {
            ctx.messages.shift();
            ctx.messages.shift();
        }
        ctx.lastAccess = Date.now();
    }

    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, ctx] of this.contexts) {
            if (now - ctx.lastAccess > this.ttlMs) {
                this.contexts.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) log('DEBUG', `清理了 ${cleaned} 个过期上下文`);
    }

    clear(key) {
        this.contexts.delete(key);
    }
}

const contextManager = new ContextManager(
    botConfig.context.maxRounds,
    botConfig.context.ttlMinutes
);

// ─── 群消息缓冲区（主动发言用）───────────────────────────────────────────────

class GroupMessageBuffer {
    constructor() {
        /** @type {Map<string, { messages: Array, lastCheck: number, lastSpeak: number }>} */
        this.buffers = new Map();
    }

    /**
     * 推送一条群消息到缓冲区
     * @returns {string|null} 如果需要触发判定，返回合并后的文本；否则返回 null
     */
    push(groupId, senderName, text) {
        if (!proactiveConfig.enable) return null;

        let buf = this.buffers.get(groupId);
        if (!buf) {
            buf = { messages: [], lastCheck: 0, lastSpeak: 0 };
            this.buffers.set(groupId, buf);
        }

        buf.messages.push({ sender: senderName, text, time: Date.now() });

        // 保留最近 N 条
        const maxBuffer = proactiveConfig.bufferSize || 10;
        while (buf.messages.length > maxBuffer) {
            buf.messages.shift();
        }

        // 检查是否到了判定时机
        const now = Date.now();
        const checkInterval = (proactiveConfig.checkIntervalMessages || 5);
        const cooldownMs = (proactiveConfig.cooldownSeconds || 300) * 1000;
        const minIntervalMs = (proactiveConfig.minCheckIntervalSeconds || 30) * 1000;

        // 冷却中
        if (now - buf.lastSpeak < cooldownMs) return null;

        // 消息数量不够
        if (buf.messages.length < checkInterval) return null;

        // 判定间隔太短
        if (now - buf.lastCheck < minIntervalMs) return null;

        // 触发判定
        buf.lastCheck = now;

        // 合并最近消息为一段文本
        const combined = buf.messages
            .map(m => `${m.sender}: ${m.text}`)
            .join('\n');

        return combined;
    }

    /** 标记已主动发言 */
    markSpoken(groupId) {
        const buf = this.buffers.get(groupId);
        if (buf) {
            buf.lastSpeak = Date.now();
            buf.messages = []; // 发言后清空缓冲
        }
    }

    /** 检查群是否在启用列表中 */
    isGroupEnabled(groupId) {
        if (!proactiveConfig.enable) return false;
        const groups = proactiveConfig.groups;
        if (!groups || groups.length === 0) return true; // 未配置 = 全部启用
        return groups.includes(Number(groupId)) || groups.includes(String(groupId));
    }
}

const groupBuffer = new GroupMessageBuffer();

// ─── 情绪分析器 ─────────────────────────────────────────────────────────────

class SentimentAnalyzer {
    constructor() {
        // 积极关键词 (+1)
        this.positiveWords = [
            '谢谢', '感谢', '哈哈', '不错', '厉害', '有趣', '好的', '可以',
            '太好了', '棒', '赞', '牛', '喜欢', '开心', '😄', '😊', '❤️',
            '👍', '🎉', '嗯嗯', '确实', '学到了', '帮大忙', '辛苦了',
            '真棒', '优秀', '完美', '好厉害', '没问题'
        ];
        // 消极关键词 (-2，权重更高)
        this.negativeWords = [
            '闭嘴', '滚', '无聊', '烦', '别说了', '垃圾', '讨厌', '废物',
            '没用', '差劲', '傻', '笨', '蠢', '恶心', '滚蛋', '去死',
            '白痴', '弱智', '屏蔽', '拉黑', '再见', '不想聊', '吵死了',
            '闭嘴吧', '能不能安静', '别烦我'
        ];
    }

    /**
     * 分析文本情绪，返回分值
     * @returns {number} 正=积极, 负=消极, 0=中性
     */
    analyze(text) {
        if (!text) return 0;
        const lower = text.toLowerCase();
        let score = 0;

        for (const word of this.positiveWords) {
            if (lower.includes(word)) {
                score += 1;
                break; // 每条消息最多计一次积极
            }
        }

        for (const word of this.negativeWords) {
            if (lower.includes(word)) {
                score -= 2;
                break; // 每条消息最多计一次消极
            }
        }

        return score;
    }
}

const sentimentAnalyzer = new SentimentAnalyzer();

// ─── 亲和度管理 ─────────────────────────────────────────────────────────────

const AFFINITY_FILE = path.join(__dirname, 'affinity_data.json');

class AffinityManager {
    constructor() {
        /** @type {Map<string, {affinity: number, lastMessageTime: number, lastProactiveTime: number, messageCount: number, nickname: string, dailyProactiveCount: number, dailyResetDate: string}>} */
        this.users = new Map();
        this._load();

        // 自然恢复定时器：每小时 affinity 向 50 靠拢 +1
        this._recoveryTimer = setInterval(() => this._naturalRecovery(), 60 * 60 * 1000);
        if (this._recoveryTimer.unref) this._recoveryTimer.unref();
    }

    _load() {
        try {
            if (fs.existsSync(AFFINITY_FILE)) {
                const data = JSON.parse(fs.readFileSync(AFFINITY_FILE, 'utf-8'));
                if (data && typeof data === 'object') {
                    for (const [uid, info] of Object.entries(data)) {
                        this.users.set(uid, info);
                    }
                }
                log('INFO', `[亲和度] 已加载 ${this.users.size} 个用户的亲和度数据`);
            }
        } catch (err) {
            log('WARN', `[亲和度] 加载 affinity_data.json 失败: ${err.message}`);
        }
    }

    _save() {
        try {
            const obj = {};
            for (const [uid, info] of this.users) {
                obj[uid] = info;
            }
            fs.writeFileSync(AFFINITY_FILE, JSON.stringify(obj, null, 2), 'utf-8');
        } catch (err) {
            log('ERROR', `[亲和度] 持久化失败: ${err.message}`);
        }
    }

    _getOrCreate(userId, nickname = '') {
        if (!this.users.has(userId)) {
            this.users.set(userId, {
                affinity: 50,
                lastMessageTime: 0,
                lastProactiveTime: 0,
                messageCount: 0,
                nickname: nickname,
                dailyProactiveCount: 0,
                dailyResetDate: new Date().toISOString().slice(0, 10)
            });
        }
        const user = this.users.get(userId);
        if (nickname && nickname !== user.nickname) {
            user.nickname = nickname;
        }
        return user;
    }

    /**
     * 处理用户消息，更新亲和度
     */
    onMessage(userId, text, nickname = '') {
        const user = this._getOrCreate(userId, nickname);
        user.lastMessageTime = Date.now();
        user.messageCount++;

        // 用户主动来聊 → 微量加分
        user.affinity = Math.min(100, user.affinity + 0.5);

        // 情绪分析
        const sentimentScore = sentimentAnalyzer.analyze(text);
        if (sentimentScore !== 0) {
            user.affinity = Math.max(0, Math.min(100, user.affinity + sentimentScore));
            log('DEBUG', `[亲和度] ${nickname}(${userId}) 情绪${sentimentScore > 0 ? '积极' : '消极'} (${sentimentScore > 0 ? '+' : ''}${sentimentScore})，当前亲和度: ${user.affinity.toFixed(1)}`);
        }

        this._save();
    }

    /**
     * 获取用户亲和度
     */
    getAffinity(userId) {
        return this.users.get(userId)?.affinity ?? 50;
    }

    /**
     * 根据亲和度计算主动发话概率
     */
    getProactiveProbability(userId) {
        const affinity = this.getAffinity(userId);
        if (affinity >= 80) return 0.7;
        if (affinity >= 50) return 0.4;
        if (affinity >= 20) return 0.1;
        return 0; // 沉默区
    }

    /**
     * 根据亲和度动态调整群聊相关度阈值
     * 亲和度高 → 阈值低（更容易触发发言）
     */
    getDynamicThreshold(userId, baseThreshold) {
        const affinity = this.getAffinity(userId);
        // affinity 50 → 不调整; 100 → -0.1; 0 → +0.1
        const adjustment = (50 - affinity) / 500;
        return Math.max(0.1, Math.min(0.9, baseThreshold + adjustment));
    }

    /**
     * 标记已对某用户主动发话
     */
    markProactive(userId) {
        const user = this._getOrCreate(userId);
        user.lastProactiveTime = Date.now();

        // 每日计数
        const today = new Date().toISOString().slice(0, 10);
        if (user.dailyResetDate !== today) {
            user.dailyProactiveCount = 0;
            user.dailyResetDate = today;
        }
        user.dailyProactiveCount++;

        this._save();
    }

    /**
     * 检查今日是否还能主动发话
     */
    canProactiveToday(userId, maxDaily) {
        const user = this.users.get(userId);
        if (!user) return true;
        const today = new Date().toISOString().slice(0, 10);
        if (user.dailyResetDate !== today) return true;
        return user.dailyProactiveCount < maxDaily;
    }

    /**
     * 自然恢复：每小时亲和度向 50 靠拢 +1
     */
    _naturalRecovery() {
        let changed = false;
        for (const [uid, user] of this.users) {
            if (user.affinity < 50) {
                user.affinity = Math.min(50, user.affinity + 1);
                changed = true;
            }
        }
        if (changed) {
            this._save();
            log('DEBUG', '[亲和度] 自然恢复已执行');
        }
    }

    /**
     * 获取所有适合主动发话的用户（白名单过滤）
     */
    getEligibleUsers(whitelist) {
        const result = [];
        for (const uid of whitelist) {
            const uidStr = String(uid);
            const user = this.users.get(uidStr);
            if (user) {
                result.push({ userId: uidStr, ...user });
            }
        }
        return result;
    }

    shutdown() {
        if (this._recoveryTimer) clearInterval(this._recoveryTimer);
        this._save();
    }
}

const affinityManager = new AffinityManager();

// ─── 私聊主动发话调度器（梦式调度）─────────────────────────────────────────

class PrivateProactiveScheduler {
    constructor() {
        this._timer = null;
        this._inProgress = false;
    }

    start() {
        const privateConfig = botConfig.proactive?.private;
        if (!privateConfig?.enable) {
            log('INFO', '[主动私聊] 未启用');
            return;
        }

        const intervalMs = (privateConfig.checkIntervalMinutes || 30) * 60 * 1000;

        this._timer = setInterval(() => {
            this._check().catch(err => {
                log('ERROR', '[主动私聊] 调度器错误:', err.message);
            });
        }, intervalMs);

        if (this._timer.unref) this._timer.unref();

        log('INFO', `[主动私聊] ⏰ 调度器已启动。` +
            `每 ${privateConfig.checkIntervalMinutes || 30} 分钟检查，` +
            `时间窗口 ${privateConfig.timeWindowStart || 8}:00-${privateConfig.timeWindowEnd || 22}:00，` +
            `白名单: [${(privateConfig.whitelist || []).join(', ')}]`);
    }

    async _check() {
        if (this._inProgress) return;
        const privateConfig = botConfig.proactive?.private;
        if (!privateConfig?.enable) return;

        const now = new Date();
        const currentHour = now.getHours();

        // 时间窗口检查
        const windowStart = privateConfig.timeWindowStart ?? 8;
        const windowEnd = privateConfig.timeWindowEnd ?? 22;
        let inWindow = false;
        if (windowStart <= windowEnd) {
            inWindow = currentHour >= windowStart && currentHour < windowEnd;
        } else {
            inWindow = currentHour >= windowStart || currentHour < windowEnd;
        }

        if (!inWindow) {
            log('DEBUG', `[主动私聊] 不在时间窗口 (当前: ${currentHour}:00，窗口: ${windowStart}:00-${windowEnd}:00)`);
            return;
        }

        const whitelist = privateConfig.whitelist || [];
        if (whitelist.length === 0) {
            log('DEBUG', '[主动私聊] 白名单为空，跳过');
            return;
        }

        const cooldownMs = (privateConfig.cooldownHours || 4) * 60 * 60 * 1000;
        const maxDaily = privateConfig.maxDailyMessages || 2;
        const nowMs = Date.now();

        this._inProgress = true;

        try {
            for (const uid of whitelist) {
                const userId = String(uid);
                const user = affinityManager._getOrCreate(userId);

                // 亲和度检查
                if (user.affinity < 20) {
                    log('DEBUG', `[主动私聊] ${user.nickname || userId} 亲和度过低 (${user.affinity.toFixed(1)})，跳过`);
                    continue;
                }

                // 冷却检查
                const lastContact = Math.max(user.lastProactiveTime, user.lastMessageTime);
                if (nowMs - lastContact < cooldownMs) {
                    log('DEBUG', `[主动私聊] ${user.nickname || userId} 冷却中，跳过`);
                    continue;
                }

                // 每日上限
                if (!affinityManager.canProactiveToday(userId, maxDaily)) {
                    log('DEBUG', `[主动私聊] ${user.nickname || userId} 已达今日上限，跳过`);
                    continue;
                }

                // 概率掷骰子
                const probability = affinityManager.getProactiveProbability(userId);
                const roll = Math.random();
                if (roll >= probability) {
                    log('DEBUG', `[主动私聊] ${user.nickname || userId} 掷骰子未命中 (${roll.toFixed(3)} >= ${probability})`);
                    continue;
                }

                log('INFO', `[主动私聊] ${user.nickname || userId} 掷骰子命中! 检查话题...`);

                // 调 RelevanceGate 检查有没有话题可聊
                const contextKey = `u${userId}`;
                const history = contextManager.getMessages(contextKey);
                const topicText = history.length > 0
                    ? history.slice(-4).map(m => m.content).join('\n')
                    : `与用户${user.nickname || userId}的日常对话`;

                const relevance = await checkRelevance(topicText);

                if (!relevance.relevant && relevance.score < 0.2) {
                    log('DEBUG', `[主动私聊] 未找到相关话题 (score: ${relevance.score})，跳过`);
                    continue;
                }

                // 调 VCP 生成主动问候
                const systemPrompt = privateConfig.systemPrompt || vcpConfig.systemPrompt;
                const topHints = relevance.topResults?.map(r => r.preview).filter(Boolean).join('\n') || '';

                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...history.slice(-4),
                    {
                        role: 'user',
                        content: `[系统指令] 你想主动找用户${user.nickname || '对方'}聊天。` +
                            (topHints ? `你最近想到了一些相关的事情：\n${topHints}\n` : '') +
                            `请自然地发起一个话题或问候，不要提及"系统指令"这个词。`
                    }
                ];

                try {
                    let segIdx = 0;
                    await callVCPStreaming(messages, async (segment) => {
                        const truncated = truncateReply(segment);
                        if (segIdx > 0) await sleep(500);
                        await callOneBot('send_private_msg', {
                            user_id: Number(userId),
                            message: [{ type: 'text', data: { text: truncated } }]
                        });
                        segIdx++;
                    });

                    affinityManager.markProactive(userId);
                    log('INFO', `[主动私聊] ✅ 已主动发消息给 ${user.nickname || userId}（亲和度: ${user.affinity.toFixed(1)}）`);
                } catch (err) {
                    log('ERROR', `[主动私聊] 发送给 ${userId} 失败:`, err.message);
                }

                // 用户之间间隔 10 秒
                await sleep(10000);
            }
        } finally {
            this._inProgress = false;
        }
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }
}

const privateScheduler = new PrivateProactiveScheduler();

// ─── VCP API 调用 ────────────────────────────────────────────────────────────

function httpRequest(url, method, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers
        };

        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
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

/**
 * 调用 VCP 的 /v1/chat/completions 接口（非流式，保留用于不需要分段的场景）
 */
async function callVCP(messages) {
    const body = JSON.stringify({
        model: vcpConfig.model,
        messages,
        stream: false
    });

    const res = await httpRequest(vcpConfig.apiUrl, 'POST', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vcpConfig.apiKey}`,
        'Content-Length': Buffer.byteLength(body)
    }, body);

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

/**
 * 清理单个文字段（移除残留标记、内部分隔符、合并空行）
 */
function sanitizeSegment(text) {
    if (!text) return '';
    let seg = text;
    // 清理残留的不完整工具调用标记
    seg = seg.replace(/<<<\[(?:TOOL_REQUEST|END_TOOL_REQUEST)\]>>>/g, '');
    // 清理 VCP 内部分隔符标记
    seg = seg.replace(/「始」.*?「末」/g, '');
    // 合并多余空行
    seg = seg.replace(/\n{3,}/g, '\n\n');
    // 去掉首尾空白
    seg = seg.trim();
    return seg;
}

/**
 * 流式调用 VCP 的 /v1/chat/completions 接口
 * 实时解析 SSE 流，遇到工具调用分隔时立即通过 onSegment 回调发送已累积文字
 *
 * @param {Array} messages - 消息数组
 * @param {(segment: string) => Promise<void>} onSegment - 当一段可发送文字就绪时的回调
 * @returns {Promise<string>} 完整的原始回复文本（含工具调用块），用于写入上下文
 */
function callVCPStreaming(messages, onSegment) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(vcpConfig.apiUrl);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const body = JSON.stringify({
            model: vcpConfig.model,
            messages,
            stream: true
        });

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${vcpConfig.apiKey}`,
                'Accept': 'text/event-stream',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = httpModule.request(options, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => reject(new Error(`VCP 返回 HTTP ${res.statusCode}: ${errBody.substring(0, 500)}`)));
                return;
            }

            let sseBuffer = '';       // SSE 行缓冲
            let fullContent = '';     // 完整回复（含工具块），用于上下文
            let pendingText = '';     // 当前待发送的纯文字累积
            let insideToolBlock = false;  // 是否在工具调用块内

            // 工具调用标记
            const TOOL_START = '<<<[TOOL_REQUEST]>>>';
            const TOOL_END = '<<<[END_TOOL_REQUEST]>>>';

            // 待完成的 segment 发送队列（串行化）
            let sendQueue = Promise.resolve();

            function flushSegment() {
                const seg = sanitizeSegment(pendingText);
                pendingText = '';
                if (seg.length > 0 && onSegment) {
                    // 将发送操作加入队列，保证顺序
                    sendQueue = sendQueue.then(() => onSegment(seg)).catch(err => {
                        log('ERROR', '[VCPStreaming] onSegment 回调失败:', err.message);
                    });
                }
            }

            function processContent(delta) {
                if (!delta) return;
                fullContent += delta;

                // 逐字符处理，使用状态机检测标记
                pendingText += delta;

                // 循环检测标记（一个 delta 中可能包含多个标记）
                while (true) {
                    if (!insideToolBlock) {
                        // 寻找 TOOL_START
                        const startIdx = pendingText.indexOf(TOOL_START);
                        if (startIdx !== -1) {
                            // 工具调用开始：发送标记前的文字
                            const beforeTool = pendingText.substring(0, startIdx);
                            pendingText = pendingText.substring(startIdx + TOOL_START.length);
                            insideToolBlock = true;

                            // 暂存 beforeTool 并 flush
                            const savedPending = pendingText;
                            pendingText = beforeTool;
                            flushSegment();
                            pendingText = savedPending;
                            continue; // 继续检查是否还有 END 标记
                        }

                        // 没有完整的 TOOL_START，但可能正在累积中
                        // 检查 pendingText 末尾是否可能是标记的前缀
                        // 保留最后 (TOOL_START.length - 1) 个字符作为缓冲
                        break;
                    } else {
                        // 在工具块内，寻找 TOOL_END
                        const endIdx = pendingText.indexOf(TOOL_END);
                        if (endIdx !== -1) {
                            // 工具调用结束，丢弃工具块内容
                            pendingText = pendingText.substring(endIdx + TOOL_END.length);
                            insideToolBlock = false;
                            continue; // 继续检查后续内容
                        }
                        // TOOL_END 还没到，继续等待
                        break;
                    }
                }
            }

            res.on('data', (chunk) => {
                sseBuffer += chunk.toString();

                // 按行解析 SSE
                let lines = sseBuffer.split(/\r\n|\r|\n/);
                sseBuffer = lines.pop(); // 最后一行可能不完整

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(':')) continue; // 空行或注释

                    if (trimmed.startsWith('data: ') || trimmed.startsWith('data:')) {
                        const jsonStr = trimmed.startsWith('data: ')
                            ? trimmed.substring(6).trim()
                            : trimmed.substring(5).trim();

                        if (jsonStr === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(jsonStr);
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) {
                                processContent(delta);
                            }
                        } catch (e) {
                            // JSON 解析失败，跳过
                        }
                    }
                }
            });

            res.on('end', () => {
                // 处理 sseBuffer 中残余的数据
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
                            } catch (e) { }
                        }
                    }
                }

                // Flush 最后残余的文字段（不在工具块内的）
                if (!insideToolBlock && pendingText.trim()) {
                    flushSegment();
                }

                // 等待所有发送完成后 resolve
                sendQueue.then(() => {
                    if (!fullContent) {
                        reject(new Error('VCP 流式响应为空：未收到任何内容'));
                    } else {
                        resolve(fullContent);
                    }
                }).catch(reject);
            });

            res.on('error', (err) => {
                reject(err);
            });
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

/**
 * 调用 RelevanceGate 相关度检查接口
 */
async function checkRelevance(text) {
    if (!proactiveConfig.enable) return { relevant: false, score: 0 };

    const gateUrl = proactiveConfig.relevanceGateUrl ||
        `http://localhost:${process.env.VCP_PORT || 5890}/api/plugins/RelevanceGate/check`;

    const body = JSON.stringify({
        text,
        threshold: proactiveConfig.threshold || 0.45,
        k: proactiveConfig.searchK || 3,
        tag_boost: proactiveConfig.tagBoost || 0.5
    });

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    };

    // 如果配置了 token
    if (proactiveConfig.relevanceToken) {
        headers['Authorization'] = `Bearer ${proactiveConfig.relevanceToken}`;
    }

    try {
        const res = await httpRequest(gateUrl, 'POST', headers, body);
        if (res.status !== 200) {
            log('WARN', `RelevanceGate 返回 HTTP ${res.status}`);
            return { relevant: false, score: 0 };
        }
        return JSON.parse(res.body);
    } catch (err) {
        log('WARN', `RelevanceGate 调用失败: ${err.message}`);
        return { relevant: false, score: 0 };
    }
}

// ─── 消息处理 ────────────────────────────────────────────────────────────────

function extractText(message) {
    if (typeof message === 'string') {
        return message.replace(/\[CQ:[^\]]+\]/g, '').trim();
    }
    if (Array.isArray(message)) {
        return message
            .filter(seg => seg.type === 'text')
            .map(seg => seg.data?.text || '')
            .join('')
            .trim();
    }
    return String(message).trim();
}

function isAtBot(message, selfId) {
    if (typeof message === 'string') {
        return message.includes(`[CQ:at,qq=${selfId}]`);
    }
    if (Array.isArray(message)) {
        return message.some(seg => seg.type === 'at' && String(seg.data?.qq) === String(selfId));
    }
    return false;
}

function cleanText(text, selfId) {
    let cleaned = text.replace(new RegExp(`@${selfId}\\s*`, 'g'), '').trim();
    const prefix = botConfig.triggerMode.prefix;
    if (prefix && cleaned.startsWith(prefix)) {
        cleaned = cleaned.substring(prefix.length).trim();
    }
    return cleaned;
}

function shouldTrigger(event, selfId) {
    const isGroup = event.message_type === 'group';
    const isPrivate = event.message_type === 'private';
    const rawText = extractText(event.message);
    const prefix = botConfig.triggerMode.prefix;

    if (!rawText && !isAtBot(event.message, selfId)) {
        return { shouldRespond: false, cleanedText: '' };
    }

    if (isPrivate) {
        if (botConfig.triggerMode.private === 'all') {
            return { shouldRespond: true, cleanedText: cleanText(rawText, selfId) };
        }
        return { shouldRespond: false, cleanedText: '' };
    }

    if (isGroup) {
        const mode = botConfig.triggerMode.group;
        if (mode === 'all') {
            return { shouldRespond: true, cleanedText: cleanText(rawText, selfId) };
        }
        if (mode === 'atOrPrefix') {
            const atBot = isAtBot(event.message, selfId);
            const hasPrefix = prefix && rawText.startsWith(prefix);
            if (atBot || hasPrefix) {
                return { shouldRespond: true, cleanedText: cleanText(rawText, selfId) };
            }
        }
        if (mode === 'at') {
            if (isAtBot(event.message, selfId)) {
                return { shouldRespond: true, cleanedText: cleanText(rawText, selfId) };
            }
        }
        if (mode === 'prefix') {
            if (prefix && rawText.startsWith(prefix)) {
                return { shouldRespond: true, cleanedText: cleanText(rawText, selfId) };
            }
        }
        return { shouldRespond: false, cleanedText: '' };
    }

    return { shouldRespond: false, cleanedText: '' };
}

/**
 * 清洗 VCP 回复中的内部标记，并按工具调用块拆分成多段
 * 工具调用前后的文字会拆成独立的消息段，避免拼在一起不连贯
 *
 * @returns {string[]} 拆分后的非空消息段数组
 */
function sanitizeReply(text) {
    if (!text) return [];

    // 1. 用工具调用块作为分隔符，拆分成多个片段
    const segments = text.split(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g);

    const result = [];
    for (let seg of segments) {
        // 2. 清理残留的不完整工具调用标记
        seg = seg.replace(/<<<\[(?:TOOL_REQUEST|END_TOOL_REQUEST)\]>>>/g, '');

        // 3. 清理 VCP 内部分隔符标记
        seg = seg.replace(/「始」.*?「末」/g, '');

        // 4. 合并多余空行
        seg = seg.replace(/\n{3,}/g, '\n\n');

        // 5. 去掉首尾空白
        seg = seg.trim();

        // 6. 只保留有实质内容的段
        if (seg.length > 0) {
            result.push(seg);
        }
    }

    return result;
}

function truncateReply(text) {
    const maxLen = botConfig.maxReplyLength || 3000;
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '\n...(回复过长已截断)';
}

// ─── OneBot WebSocket 通信 ────────────────────────────────────────────────────

let ws = null;
let selfId = null;
let reconnectTimer = null;
let actionEchoCounter = 0;
const pendingActions = new Map();

function callOneBot(action, params = {}) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket 未连接'));
            return;
        }
        const echo = `bridge_${++actionEchoCounter}`;
        const timer = setTimeout(() => {
            pendingActions.delete(echo);
            reject(new Error(`OneBot action "${action}" 超时`));
        }, 30000);

        pendingActions.set(echo, { resolve, reject, timer });
        ws.send(JSON.stringify({ action, params, echo }));
    });
}

async function sendReply(event, text) {
    const params = {
        message: [{ type: 'text', data: { text } }]
    };
    if (event.message_type === 'group') {
        params.group_id = event.group_id;
        params.message.unshift({
            type: 'reply',
            data: { id: String(event.message_id) }
        });
        return callOneBot('send_group_msg', params);
    } else {
        params.user_id = event.user_id;
        return callOneBot('send_private_msg', params);
    }
}

/** 主动发送群消息（不引用） */
async function sendGroupMessage(groupId, text) {
    return callOneBot('send_group_msg', {
        group_id: groupId,
        message: [{ type: 'text', data: { text } }]
    });
}

// ─── 被动响应处理 ────────────────────────────────────────────────────────────

async function handleDirectMessage(event) {
    const { shouldRespond, cleanedText } = shouldTrigger(event, selfId);
    if (!shouldRespond || !cleanedText) return;

    const userId = event.user_id;
    const groupId = event.group_id;
    const senderName = event.sender?.nickname || event.sender?.card || String(userId);
    const contextKey = contextManager.getKey(userId, groupId);

    log('INFO', `收到消息 [${event.message_type}] ${senderName}(${userId}): ${cleanedText.substring(0, 100)}`);

    // 更新亲和度
    affinityManager.onMessage(String(userId), cleanedText, senderName);

    // 特殊命令
    if (cleanedText === '/clear' || cleanedText === '清除记忆') {
        contextManager.clear(contextKey);
        try { await sendReply(event, '✅ 对话记忆已清除'); } catch (err) { log('ERROR', '发送清除确认失败:', err.message); }
        return;
    }

    const historyMessages = contextManager.getMessages(contextKey);
    const messages = [
        { role: 'system', content: vcpConfig.systemPrompt },
        ...historyMessages,
        { role: 'user', content: cleanedText }
    ];

    try {
        log('DEBUG', `调用 VCP（流式），上下文 ${contextKey}，历史${historyMessages.length / 2}轮`);

        let segmentIndex = 0;
        let hasContent = false;

        const fullReply = await callVCPStreaming(messages, async (segment) => {
            hasContent = true;
            const truncated = truncateReply(segment);
            if (segmentIndex === 0) {
                // 第一段带引用
                await sendReply(event, truncated);
            } else {
                // 后续段：稍作延迟后独立发送
                await sleep(500);
                if (event.message_type === 'group') {
                    await sendGroupMessage(event.group_id, truncated);
                } else {
                    await callOneBot('send_private_msg', {
                        user_id: event.user_id,
                        message: [{ type: 'text', data: { text: truncated } }]
                    });
                }
            }
            log('INFO', `回复 ${senderName}(${userId}) [段${segmentIndex + 1}]: ${truncated.substring(0, 100)}`);
            segmentIndex++;
        });

        // 使用完整回复（含工具调用块）写入上下文，保证后续对话完整性
        contextManager.addRound(contextKey, cleanedText, fullReply);

        if (!hasContent) {
            log('WARN', 'VCP 流式回复清洗后为空，跳过发送');
        }
    } catch (err) {
        log('ERROR', `处理消息失败:`, err.message);
        try { await sendReply(event, `⚠️ AI 处理失败：${err.message.substring(0, 200)}`); } catch (sendErr) { log('ERROR', '发送错误提示失败:', sendErr.message); }
    }
}

// ─── 主动发言处理 ────────────────────────────────────────────────────────────

async function handleProactiveCheck(event) {
    if (!proactiveConfig.enable) return;
    if (event.message_type !== 'group') return;

    const groupId = event.group_id;
    if (!groupBuffer.isGroupEnabled(groupId)) return;

    const rawText = extractText(event.message);
    if (!rawText || rawText.length < 2) return;

    const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);

    // 群消息也更新发言者亲和度
    affinityManager.onMessage(String(event.user_id), rawText, senderName);

    // 推送到缓冲区，检查是否需要触发判定
    const combinedText = groupBuffer.push(String(groupId), senderName, rawText);
    if (!combinedText) return;

    log('DEBUG', `[主动发言] 群 ${groupId} 触发相关度判定（${combinedText.length} 字符）`);

    try {
        // 调用 RelevanceGate 判定相关度
        const result = await checkRelevance(combinedText);

        log('INFO', `[主动发言] 群 ${groupId} 相关度: ${result.score} (阈值: ${result.threshold}), 判定: ${result.relevant ? '发言' : '静默'}`);

        if (!result.relevant) return;

        // 相关度足够高，调用 VCP 生成回复
        const systemPrompt = proactiveConfig.systemPrompt || vcpConfig.systemPrompt;
        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user', content:
                    `以下是一段QQ群聊记录，你觉得你可以参与讨论。请自然地加入对话，不要显得突兀：\n\n${combinedText}`
            }
        ];

        let proactiveHasContent = false;
        let proactiveSegIdx = 0;
        await callVCPStreaming(messages, async (segment) => {
            proactiveHasContent = true;
            const truncated = truncateReply(segment);
            if (proactiveSegIdx > 0) await sleep(500);
            await sendGroupMessage(groupId, truncated);
            log('INFO', `[主动发言] 在群 ${groupId} 发言 [段${proactiveSegIdx + 1}]: ${truncated.substring(0, 100)}`);
            proactiveSegIdx++;
        });

        if (!proactiveHasContent) {
            log('WARN', '[主动发言] VCP 流式回复清洗后为空，跳过发送');
            return;
        }
        groupBuffer.markSpoken(String(groupId));

        // 记录到该群的相关度标签（可选日志）
        if (result.tagBoostInfo?.matchedTags?.length > 0) {
            log('DEBUG', `[主动发言] 匹配标签: ${result.tagBoostInfo.matchedTags.join(', ')}`);
        }
    } catch (err) {
        log('ERROR', `[主动发言] 群 ${groupId} 处理失败:`, err.message);
    }
}

// ─── 消息分发 ────────────────────────────────────────────────────────────────

async function handleMessage(event) {
    // 先检查是否是直接触发的消息（@bot / 前缀 / 私聊）
    const { shouldRespond } = shouldTrigger(event, selfId);

    if (shouldRespond) {
        // 直接响应模式
        await handleDirectMessage(event);
    } else if (event.message_type === 'group') {
        // 群消息旁听模式：不触发直接回复，但送入主动发言判定
        await handleProactiveCheck(event);
    }
}

// ─── WebSocket 连接管理 ──────────────────────────────────────────────────────

function connect() {
    if (ws) {
        ws.removeAllListeners();
        ws.close();
    }

    const wsUrl = napcatConfig.token
        ? `${napcatConfig.wsUrl}?access_token=${napcatConfig.token}`
        : napcatConfig.wsUrl;

    log('INFO', `正在连接 NapCat WebSocket: ${napcatConfig.wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        log('INFO', '✅ 已连接到 NapCat WebSocket');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        callOneBot('get_login_info').then(res => {
            selfId = String(res.data?.user_id || '');
            log('INFO', `Bot QQ号: ${selfId}, 昵称: ${res.data?.nickname || '未知'}`);
        }).catch(err => {
            log('WARN', '获取登录信息失败:', err.message);
        });
    });

    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        // 处理 API 响应
        if (data.echo) {
            const pending = pendingActions.get(data.echo);
            if (pending) {
                clearTimeout(pending.timer);
                pendingActions.delete(data.echo);
                if (data.status === 'ok' || data.retcode === 0) {
                    pending.resolve(data);
                } else {
                    pending.reject(new Error(`OneBot error: ${data.wording || data.msg || JSON.stringify(data)}`));
                }
            }
            return;
        }

        // 处理消息事件
        if (data.post_type === 'message') {
            if (String(data.user_id) === selfId) return;
            handleMessage(data).catch(err => {
                log('ERROR', '处理消息异常:', err);
            });
        }

        if (data.post_type === 'meta_event' && data.meta_event_type === 'heartbeat') {
            log('DEBUG', '收到心跳');
        }
    });

    ws.on('close', (code, reason) => {
        log('WARN', `WebSocket 断开连接 (code=${code}, reason=${reason || '无'})`);
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        log('ERROR', 'WebSocket 错误:', err.message);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    const interval = napcatConfig.reconnectInterval || 5000;
    log('INFO', `将在 ${interval / 1000} 秒后重新连接...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, interval);
}

// ─── 启动 ────────────────────────────────────────────────────────────────────

function printBanner() {
    const proactiveStatus = proactiveConfig.enable
        ? `开启 (阈值: ${proactiveConfig.threshold || 0.45})`
        : '关闭';
    const privateStatus = botConfig.proactive?.private?.enable
        ? `开启 (白名单: ${(botConfig.proactive.private.whitelist || []).length}人)`
        : '关闭';
    console.log(`
╔══════════════════════════════════════════╗
║     NapCat ↔ VCPToolBox Bridge v3.0     ║
╠══════════════════════════════════════════╣
║  NapCat WS : ${napcatConfig.wsUrl.padEnd(27)}║
║  VCP API   : ${vcpConfig.apiUrl.substring(0, 27).padEnd(27)}║
║  VCP Model : ${vcpConfig.model.padEnd(27)}║
║  私聊触发   : ${botConfig.triggerMode.private.padEnd(26)}║
║  群聊触发   : ${botConfig.triggerMode.group.padEnd(26)}║
║  上下文轮数 : ${String(botConfig.context.maxRounds).padEnd(26)}║
║  群聊主动   : ${proactiveStatus.padEnd(26)}║
║  私聊主动   : ${privateStatus.padEnd(26)}║
║  亲和度用户 : ${String(affinityManager.users.size).padEnd(26)}║
╚══════════════════════════════════════════╝
    `);
}

printBanner();
connect();
privateScheduler.start();

process.on('SIGINT', () => {
    log('INFO', '收到 SIGINT，正在关闭...');
    privateScheduler.stop();
    affinityManager.shutdown();
    if (ws) ws.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', '收到 SIGTERM，正在关闭...');
    privateScheduler.stop();
    affinityManager.shutdown();
    if (ws) ws.close();
    process.exit(0);
});

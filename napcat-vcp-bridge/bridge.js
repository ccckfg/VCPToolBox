#!/usr/bin/env node
/**
 * NapCat ↔ VCPToolBox Bridge
 * v3.0: 情感感知 + 动态阈值 + 私聊主动发话（梦式调度）
 */

const path = require('path');
const WebSocket = require('ws');

const { loadConfig } = require('./lib/config');
const { log, sleep } = require('./lib/logger');
const { ContextManager } = require('./lib/context-manager');
const { GroupMessageBuffer } = require('./lib/group-message-buffer');
const { SentimentAnalyzer } = require('./lib/sentiment-analyzer');
const { AffinityManager } = require('./lib/affinity-manager');
const { VcpClient } = require('./lib/vcp-client');
const { extractText, shouldTrigger, truncateReply, buildUserContent } = require('./lib/message-utils');
const { FriendBook } = require('./lib/friend-book');
const { createWebhookServer } = require('./lib/webhook-server');
const { PrivateProactiveScheduler } = require('./lib/private-proactive-scheduler');

let appConfig;
try {
    appConfig = loadConfig();
} catch (err) {
    console.error('[Bridge]', err.message);
    process.exit(1);
}

const { napcatConfig, vcpConfig, botConfig, proactiveConfig, webhookConfig } = appConfig;

const contextManager = new ContextManager({
    maxRounds: botConfig.context?.maxRounds || 8,
    ttlMinutes: botConfig.context?.ttlMinutes || 60,
    perUser: !!botConfig.context?.perUser,
    log
});

const groupBuffer = new GroupMessageBuffer(proactiveConfig);
const sentimentAnalyzer = new SentimentAnalyzer();
const affinityManager = new AffinityManager({
    filePath: path.join(__dirname, 'affinity_data.json'),
    sentimentAnalyzer,
    log
});
const vcpClient = new VcpClient({
    vcpConfig,
    proactiveConfig,
    log
});

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
    const params = { message: [{ type: 'text', data: { text } }] };
    if (event.message_type === 'group') {
        params.group_id = event.group_id;
        params.message.unshift({ type: 'reply', data: { id: String(event.message_id) } });
        return callOneBot('send_group_msg', params);
    }
    params.user_id = event.user_id;
    return callOneBot('send_private_msg', params);
}

async function sendGroupMessage(groupId, text) {
    return callOneBot('send_group_msg', {
        group_id: groupId,
        message: [{ type: 'text', data: { text } }]
    });
}

const friendBook = new FriendBook({
    callOneBot,
    log
});

const { startWebhookServer, stopWebhookServer } = createWebhookServer({
    webhookConfig,
    friendBook,
    callOneBot,
    log
});

const privateScheduler = new PrivateProactiveScheduler({
    botConfig,
    vcpConfig,
    contextManager,
    affinityManager,
    vcpClient,
    callOneBot,
    truncateReply: (text) => truncateReply(text, botConfig.maxReplyLength || 3000),
    sleep,
    log
});

async function handleDirectMessage(event) {
    const { shouldRespond, cleanedText } = shouldTrigger(event, selfId, botConfig.triggerMode);
    if (!shouldRespond || !cleanedText) return;

    const userId = event.user_id;
    const groupId = event.group_id;
    const senderName = event.sender?.nickname || event.sender?.card || String(userId);
    const contextKey = contextManager.getKey(userId, groupId);

    log('INFO', `收到消息 [${event.message_type}] ${senderName}(${userId}): ${cleanedText.substring(0, 100)}`);
    affinityManager.onMessage(String(userId), cleanedText, senderName);

    if (cleanedText === '/clear' || cleanedText === '清除记忆') {
        contextManager.clear(contextKey);
        try {
            await sendReply(event, '✅ 对话记忆已清除');
        } catch (err) {
            log('ERROR', '发送清除确认失败:', err.message);
        }
        return;
    }

    const historyMessages = contextManager.getMessages(contextKey);
    const messages = [
        { role: 'system', content: vcpConfig.systemPrompt },
        ...historyMessages,
        { role: 'user', content: buildUserContent(event, cleanedText) }
    ];

    try {
        log('DEBUG', `调用 VCP（流式），上下文 ${contextKey}，历史${historyMessages.length / 2}轮`);

        let segmentIndex = 0;
        let hasContent = false;
        const fullReply = await vcpClient.callVCPStreaming(messages, async (segment) => {
            hasContent = true;
            const truncated = truncateReply(segment, botConfig.maxReplyLength || 3000);

            if (segmentIndex === 0) {
                await sendReply(event, truncated);
            } else {
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

        contextManager.addRound(contextKey, cleanedText, fullReply);

        if (!hasContent) {
            log('WARN', 'VCP 流式回复清洗后为空，跳过发送');
        }
    } catch (err) {
        log('ERROR', '处理消息失败:', err.message);
        try {
            await sendReply(event, `⚠️ AI 处理失败：${err.message.substring(0, 200)}`);
        } catch (sendErr) {
            log('ERROR', '发送错误提示失败:', sendErr.message);
        }
    }
}

async function handleProactiveCheck(event) {
    if (!proactiveConfig.enable) return;
    if (event.message_type !== 'group') return;

    const groupId = event.group_id;
    if (!groupBuffer.isGroupEnabled(groupId)) return;

    const rawText = extractText(event.message);
    if (!rawText || rawText.length < 2) return;

    const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    affinityManager.onMessage(String(event.user_id), rawText, senderName);

    const combinedText = groupBuffer.push(String(groupId), senderName, rawText);
    if (!combinedText) return;

    log('DEBUG', `[主动发言] 群 ${groupId} 触发相关度判定（${combinedText.length} 字符）`);

    try {
        const result = await vcpClient.checkRelevance(combinedText);
        log('INFO', `[主动发言] 群 ${groupId} 相关度: ${result.score} (阈值: ${result.threshold}), 判定: ${result.relevant ? '发言' : '静默'}`);
        if (!result.relevant) return;

        const systemPrompt = proactiveConfig.systemPrompt || vcpConfig.systemPrompt;
        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: `以下是一段QQ群聊记录，你觉得你可以参与讨论。请自然地加入对话，不要显得突兀：\n\n${combinedText}`
            }
        ];

        let proactiveHasContent = false;
        let proactiveSegIdx = 0;
        await vcpClient.callVCPStreaming(messages, async (segment) => {
            proactiveHasContent = true;
            const truncated = truncateReply(segment, botConfig.maxReplyLength || 3000);
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

        if (result.tagBoostInfo?.matchedTags?.length > 0) {
            log('DEBUG', `[主动发言] 匹配标签: ${result.tagBoostInfo.matchedTags.join(', ')}`);
        }
    } catch (err) {
        log('ERROR', `[主动发言] 群 ${groupId} 处理失败:`, err.message);
    }
}

async function handleMessage(event) {
    const { shouldRespond } = shouldTrigger(event, selfId, botConfig.triggerMode);
    if (shouldRespond) {
        await handleDirectMessage(event);
    } else if (event.message_type === 'group') {
        await handleProactiveCheck(event);
    }
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

        callOneBot('get_login_info')
            .then((res) => {
                selfId = String(res.data?.user_id || '');
                log('INFO', `Bot QQ号: ${selfId}, 昵称: ${res.data?.nickname || '未知'}`);
                return friendBook.refresh();
            })
            .then(() => {
                friendBook.startAutoRefresh();
                startWebhookServer();
            })
            .catch((err) => {
                log('WARN', '连接初始化失败:', err.message);
            });
    });

    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch (_err) {
            return;
        }

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

        if (data.post_type === 'message') {
            if (String(data.user_id) === selfId) return;
            handleMessage(data).catch((err) => {
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
║  NapCat WS : ${String(napcatConfig.wsUrl || '').padEnd(27)}║
║  VCP API   : ${String(vcpConfig.apiUrl || '').substring(0, 27).padEnd(27)}║
║  VCP Model : ${String(vcpConfig.model || '').padEnd(27)}║
║  私聊触发   : ${String(botConfig.triggerMode?.private || 'all').padEnd(26)}║
║  群聊触发   : ${String(botConfig.triggerMode?.group || 'atOrPrefix').padEnd(26)}║
║  上下文轮数 : ${String(botConfig.context?.maxRounds || 8).padEnd(26)}║
║  群聊主动   : ${proactiveStatus.padEnd(26)}║
║  私聊主动   : ${privateStatus.padEnd(26)}║
║  Webhook    : ${(webhookConfig.enable ? `开启 (端口: ${webhookConfig.port || 3005})` : '关闭').padEnd(26)}║
║  亲和度用户 : ${String(affinityManager.users.size).padEnd(26)}║
╚══════════════════════════════════════════╝
    `);
}

function shutdown(signal) {
    log('INFO', `收到 ${signal}，正在关闭...`);
    privateScheduler.stop();
    contextManager.shutdown();
    affinityManager.shutdown();
    stopWebhookServer();
    if (ws) ws.close();
    process.exit(0);
}

printBanner();
connect();
privateScheduler.start();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

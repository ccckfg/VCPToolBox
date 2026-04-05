#!/usr/bin/env node
/**
 * NapCat ↔ VCPToolBox Bridge
 * v3.1: VPE 私聊/群聊主动发言桥接入口
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
const { shouldTrigger, truncateReply } = require('./lib/message-utils');
const { FriendBook } = require('./lib/friend-book');
const { createWebhookServer } = require('./lib/webhook-server');
const { PrivateProactiveScheduler } = require('./lib/private-proactive-scheduler');
const { createOneBotSender } = require('./lib/onebot-sender');
const { createProactiveBootstrap } = require('./lib/proactive-bootstrap');
const { createPrivateMessageHandler } = require('./lib/private-message-handler');
const { createGroupMessageHandler } = require('./lib/group-message-handler');
const { VpeStateStore } = require('./lib/vpe/state-store');
const { VpeEngine } = require('./lib/vpe/engine');

let appConfig;
try {
    appConfig = loadConfig();
} catch (err) {
    console.error('[Bridge]', err.message);
    process.exit(1);
}

const { napcatConfig, vcpConfig, botConfig, proactiveConfig, webhookConfig } = appConfig;
const privateProactiveConfig = botConfig.proactive?.private || {};
const privateProactiveStrategy = ['legacy', 'vpe'].includes(String(privateProactiveConfig.strategy || '').toLowerCase())
    ? String(privateProactiveConfig.strategy || '').toLowerCase()
    : 'legacy';
const vpePrivateConfig = privateProactiveConfig.vpe || {};
const defaultEmbeddingModel = String(vpePrivateConfig.embeddingModel || process.env.WhitelistEmbeddingModel || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)[0] || '';
const rawContextScope = String(botConfig.context?.scope || '').trim();
const contextScopeByLegacy = botConfig.context?.perUser === false ? 'group_shared' : 'per_user';
const contextScope = ['per_user', 'group_shared', 'global_shared'].includes(rawContextScope)
    ? rawContextScope
    : contextScopeByLegacy;

const contextManager = new ContextManager({
    maxRounds: botConfig.context?.maxRounds || 8,
    ttlMinutes: botConfig.context?.ttlMinutes || 60,
    scope: contextScope,
    log
});

const groupBuffer = new GroupMessageBuffer(proactiveConfig);
const vcpClient = new VcpClient({
    vcpConfig,
    proactiveConfig,
    log
});
const stateStore = new VpeStateStore({
    filePath: path.join(__dirname, 'vpe_state.json'),
    legacyFilePath: path.join(__dirname, 'affinity_data.json'),
    log
});
const sentimentAnalyzer = new SentimentAnalyzer({
    vcpClient,
    embeddingModel: defaultEmbeddingModel,
    anchorsPath: path.join(__dirname, 'data', 'emotion_anchors.json'),
    log
});
sentimentAnalyzer.initialize().catch((err) => {
    log('WARN', `[情绪] 初始化失败，继续使用词典模式: ${err.message}`);
});
const affinityManager = new AffinityManager({
    stateStore,
    sentimentAnalyzer,
    log
});

let ws = null;
let selfId = null;
let reconnectTimer = null;

const sender = createOneBotSender({ log });
const friendBook = new FriendBook({
    callOneBot: sender.callOneBot,
    log
});
const { startWebhookServer, stopWebhookServer } = createWebhookServer({
    webhookConfig,
    friendBook,
    callOneBot: sender.callOneBot,
    log
});

const privateScheduler = new PrivateProactiveScheduler({
    botConfig,
    vcpConfig,
    contextManager,
    affinityManager,
    vcpClient,
    callOneBot: sender.callOneBot,
    truncateReply: (text) => truncateReply(text, botConfig.maxReplyLength || 3000),
    sleep,
    log
});
const vpeEngine = new VpeEngine({
    botConfig,
    proactiveConfig,
    privateConfig: privateProactiveConfig,
    vpeConfig: {
        ...proactiveConfig.vpe,
        ...vpePrivateConfig,
        embeddingModel: defaultEmbeddingModel
    },
    vcpConfig,
    projectRoot: __dirname,
    friendBook,
    affinityManager,
    stateStore,
    vcpClient,
    groupBuffer,
    sendPrivateMessage: sender.sendPrivateMessage,
    sendGroupMessage: sender.sendGroupMessage,
    truncateReply: (text) => truncateReply(text, botConfig.maxReplyLength || 3000),
    sleep,
    log
});
const proactiveBootstrap = createProactiveBootstrap({
    affinityManager,
    privateScheduler,
    privateStrategy: privateProactiveStrategy,
    vpeEngine
});
const privateMessageHandler = createPrivateMessageHandler({
    botConfig,
    vcpConfig,
    contextManager,
    affinityManager,
    vcpClient,
    sender,
    sleep,
    log,
    truncateReply: (text) => truncateReply(text, botConfig.maxReplyLength || 3000)
});
const groupMessageHandler = createGroupMessageHandler({
    proactiveConfig,
    botConfig,
    vcpConfig,
    groupBuffer,
    affinityManager,
    vcpClient,
    vpeEngine,
    sender,
    sleep,
    log,
    truncateReply: (text) => truncateReply(text, botConfig.maxReplyLength || 3000)
});

async function handleMessage(event) {
    if (event.message_type === 'private') {
        await proactiveBootstrap.trackPrivateIncoming(event);
    }

    const { shouldRespond, cleanedText } = shouldTrigger(event, selfId, botConfig.triggerMode);
    if (event.message_type === 'group') {
        await groupMessageHandler.handleGroupMessage(event, {
            allowLegacyProactive: !shouldRespond
        });
    }

    if (shouldRespond) {
        await privateMessageHandler.handleDirectMessage(event, cleanedText);
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
    sender.setSocket(ws);

    ws.on('open', () => {
        log('INFO', '✅ 已连接到 NapCat WebSocket');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        sender.callOneBot('get_login_info')
            .then((res) => {
                selfId = String(res.data?.user_id || '');
                log('INFO', `Bot QQ号: ${selfId}, 昵称: ${res.data?.nickname || '未知'}`);
                return friendBook.refresh();
            })
            .then(() => {
                friendBook.startAutoRefresh();
                startWebhookServer();
                proactiveBootstrap.startPrivateProactiveEngine();
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

        if (sender.handleEcho(data)) return;

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
        ? `开启 (${privateProactiveStrategy}, ${(botConfig.proactive.private.whitelist || []).length}人)`
        : '关闭';
    const contextScopeLabelMap = {
        per_user: '按用户',
        group_shared: '按群共享(私聊按用户)',
        global_shared: '全局共享'
    };
    const contextScopeLabel = contextScopeLabelMap[contextScope] || contextScope;
    console.log(`
╔══════════════════════════════════════════╗
║     NapCat ↔ VCPToolBox Bridge v3.1     ║
╠══════════════════════════════════════════╣
║  NapCat WS : ${String(napcatConfig.wsUrl || '').padEnd(27)}║
║  VCP API   : ${String(vcpConfig.apiUrl || '').substring(0, 27).padEnd(27)}║
║  VCP Model : ${String(vcpConfig.model || '').padEnd(27)}║
║  私聊触发   : ${String(botConfig.triggerMode?.private || 'all').padEnd(26)}║
║  群聊触发   : ${String(botConfig.triggerMode?.group || 'atOrPrefix').padEnd(26)}║
║  上下文轮数 : ${String(botConfig.context?.maxRounds || 8).padEnd(26)}║
║  上下文作用域 : ${String(contextScopeLabel).padEnd(24)}║
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
    vpeEngine.stop();
    contextManager.shutdown();
    affinityManager.shutdown();
    friendBook.stop();
    stopWebhookServer();
    sender.shutdown();
    if (ws) ws.close();
    process.exit(0);
}

printBanner();
connect();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

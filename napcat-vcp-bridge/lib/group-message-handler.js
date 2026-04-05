const { extractText } = require('./message-utils');

function createGroupMessageHandler(options = {}) {
    const proactiveConfig = options.proactiveConfig || {};
    const botConfig = options.botConfig || {};
    const vcpConfig = options.vcpConfig || {};
    const groupBuffer = options.groupBuffer;
    const affinityManager = options.affinityManager;
    const vcpClient = options.vcpClient;
    const vpeEngine = options.vpeEngine;
    const sender = options.sender;
    const sleep = options.sleep || (async () => {});
    const log = options.log || (() => {});
    const truncateReply = options.truncateReply || ((text) => text);

    async function handleGroupMessage(event, runtimeOptions = {}) {
        const groupId = String(event.group_id);
        const rawText = extractText(event.message);
        if (!rawText || rawText.length < 1) return;

        const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
        await affinityManager.onMessage(String(event.user_id), rawText, senderName, { isPrivate: false });

        const legacyGroupEnabled = groupBuffer.isGroupEnabled(groupId);
        const vpeGroupEnabled = groupBuffer.isVpeGroupEnabled(groupId);
        if (!legacyGroupEnabled && !vpeGroupEnabled) return;

        const combinedText = groupBuffer.push(groupId, senderName, rawText);
        if (vpeGroupEnabled && vpeEngine?.recordGroupMessage) {
            vpeEngine.recordGroupMessage(groupId, senderName, rawText, Date.now());
        }

        if (runtimeOptions.allowLegacyProactive === false) return;
        if (!proactiveConfig.enable || !legacyGroupEnabled) return;
        if (!combinedText || rawText.length < 2) return;

        log('DEBUG', `[主动发言] 群 ${groupId} 触发相关度判定（${combinedText.length} 字符）`);

        try {
            const result = await vcpClient.checkRelevance(combinedText);
            log('INFO', `[主动发言] 群 ${groupId} 相关度: ${result.score} (阈值: ${result.threshold}), 判定: ${result.relevant ? '发言' : '静默'}`);
            if (!result.relevant) return;

            const systemPrompt = proactiveConfig.systemPrompt || vcpConfig.systemPrompt;
            const identityClarification = `\n\n[身份隔离指令] 你正在群 ${groupId} 中主动发言。不要将你与私聊用户之间的私人记忆（如提醒、日程、任务、约定）带入群聊。`;
            const messages = [
                { role: 'system', content: systemPrompt + identityClarification },
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
                await sender.sendGroupMessage(groupId, truncated);
                log('INFO', `[主动发言] 在群 ${groupId} 发言 [段${proactiveSegIdx + 1}]: ${truncated.substring(0, 100)}`);
                proactiveSegIdx += 1;
            });

            if (!proactiveHasContent) {
                log('WARN', '[主动发言] VCP 流式回复清洗后为空，跳过发送');
                return;
            }

            groupBuffer.markSpoken(groupId);

            if (result.tagBoostInfo?.matchedTags?.length > 0) {
                log('DEBUG', `[主动发言] 匹配标签: ${result.tagBoostInfo.matchedTags.join(', ')}`);
            }
        } catch (err) {
            log('ERROR', `[主动发言] 群 ${groupId} 处理失败:`, err.message);
        }
    }

    return {
        handleGroupMessage
    };
}

module.exports = {
    createGroupMessageHandler
};

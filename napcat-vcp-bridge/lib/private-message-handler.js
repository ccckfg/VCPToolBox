const { buildUserContent } = require('./message-utils');

function createPrivateMessageHandler(options = {}) {
    const botConfig = options.botConfig || {};
    const contextManager = options.contextManager;
    const affinityManager = options.affinityManager;
    const vcpClient = options.vcpClient;
    const sender = options.sender;
    const sleep = options.sleep || (async () => {});
    const log = options.log || (() => {});
    const truncateReply = options.truncateReply || ((text) => text);

    async function handleDirectMessage(event, cleanedText) {
        if (!cleanedText) return;

        const userId = event.user_id;
        const groupId = event.group_id;
        const senderName = event.sender?.nickname || event.sender?.card || String(userId);
        const contextKey = contextManager.getKey(userId, groupId);

        log('INFO', `收到消息 [${event.message_type}] ${senderName}(${userId}): ${cleanedText.substring(0, 100)}`);

        if (cleanedText === '/clear' || cleanedText === '清除记忆') {
            contextManager.clear(contextKey);
            affinityManager.clearPrivateHistory(String(userId));
            try {
                await sender.sendReply(event, '✅ 对话记忆已清除');
            } catch (err) {
                log('ERROR', '发送清除确认失败:', err.message);
            }
            return;
        }

        const historyMessages = contextManager.getMessages(contextKey);
        const currentUserContent = buildUserContent(event, cleanedText);
        const identityClarification = `\n\n[身份隔离指令] 你当前正在与 ${senderName}(QQ:${userId}) 对话。对话历史中可能包含你与其他用户的聊天记忆，请注意区分。不要将其他用户交代你的事情（如提醒、日程、任务、约定）错误地传达给当前用户。只回应与 ${senderName} 相关的内容。`;
        const messages = [
            { role: 'system', content: options.vcpConfig.systemPrompt + identityClarification },
            ...historyMessages,
            { role: 'user', content: currentUserContent }
        ];

        try {
            log('DEBUG', `调用 VCP（流式），上下文 ${contextKey}，历史${historyMessages.length / 2}轮`);

            let segmentIndex = 0;
            let hasContent = false;
            const visibleSegments = [];
            const fullReply = await vcpClient.callVCPStreaming(messages, async (segment) => {
                hasContent = true;
                const truncated = truncateReply(segment, botConfig.maxReplyLength || 3000);
                visibleSegments.push(truncated);

                if (segmentIndex === 0) {
                    await sender.sendReply(event, truncated);
                } else {
                    await sleep(500);
                    if (event.message_type === 'group') {
                        await sender.sendGroupMessage(event.group_id, truncated);
                    } else {
                        await sender.sendPrivateMessage(event.user_id, truncated);
                    }
                }

                log('INFO', `回复 ${senderName}(${userId}) [段${segmentIndex + 1}]: ${truncated.substring(0, 100)}`);
                segmentIndex += 1;
            });

            contextManager.addRound(contextKey, currentUserContent, fullReply);
            if (visibleSegments.length > 0) {
                affinityManager.recordPrivateHistory(String(userId), 'assistant', visibleSegments.join('\n'), Date.now());
            }

            if (!hasContent) {
                log('WARN', 'VCP 流式回复清洗后为空，跳过发送');
            }
        } catch (err) {
            log('ERROR', '处理消息失败:', err.message);
            try {
                await sender.sendReply(event, `⚠️ AI 处理失败：${err.message.substring(0, 200)}`);
            } catch (sendErr) {
                log('ERROR', '发送错误提示失败:', sendErr.message);
            }
        }
    }

    return {
        handleDirectMessage
    };
}

module.exports = {
    createPrivateMessageHandler
};

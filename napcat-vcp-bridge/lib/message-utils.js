function extractText(message) {
    if (typeof message === 'string') {
        return message.replace(/\[CQ:[^\]]+\]/g, '').trim();
    }
    if (Array.isArray(message)) {
        return message
            .filter((seg) => seg.type === 'text')
            .map((seg) => seg.data?.text || '')
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
        return message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === String(selfId));
    }
    return false;
}

function cleanText(text, selfId, prefix) {
    let cleaned = text.replace(new RegExp(`@${selfId}\\s*`, 'g'), '').trim();
    if (prefix && cleaned.startsWith(prefix)) {
        cleaned = cleaned.substring(prefix.length).trim();
    }
    return cleaned;
}

function shouldTrigger(event, selfId, triggerMode) {
    const isGroup = event.message_type === 'group';
    const isPrivate = event.message_type === 'private';
    const rawText = extractText(event.message);
    const prefix = triggerMode.prefix;

    if (!rawText && !isAtBot(event.message, selfId)) {
        return { shouldRespond: false, cleanedText: '' };
    }

    if (isPrivate) {
        if (triggerMode.private === 'all') {
            return { shouldRespond: true, cleanedText: cleanText(rawText, selfId, prefix) };
        }
        return { shouldRespond: false, cleanedText: '' };
    }

    if (isGroup) {
        const mode = triggerMode.group;
        if (mode === 'all') {
            return { shouldRespond: true, cleanedText: cleanText(rawText, selfId, prefix) };
        }
        if (mode === 'atOrPrefix') {
            const atBot = isAtBot(event.message, selfId);
            const hasPrefix = prefix && rawText.startsWith(prefix);
            if (atBot || hasPrefix) {
                return { shouldRespond: true, cleanedText: cleanText(rawText, selfId, prefix) };
            }
        }
        if (mode === 'at') {
            if (isAtBot(event.message, selfId)) {
                return { shouldRespond: true, cleanedText: cleanText(rawText, selfId, prefix) };
            }
        }
        if (mode === 'prefix') {
            if (prefix && rawText.startsWith(prefix)) {
                return { shouldRespond: true, cleanedText: cleanText(rawText, selfId, prefix) };
            }
        }
        return { shouldRespond: false, cleanedText: '' };
    }

    return { shouldRespond: false, cleanedText: '' };
}

function truncateReply(text, maxReplyLength = 3000) {
    if (text.length <= maxReplyLength) return text;
    return `${text.substring(0, maxReplyLength)}\n...(回复过长已截断)`;
}

function buildUserContent(event, text) {
    const userId = String(event.user_id ?? '');
    const nickname = event.sender?.nickname || '';
    const card = event.sender?.card || '';
    const senderName = card || nickname || userId;
    const identityParts = [];
    if (card) identityParts.push(`群名片:${card}`);
    if (nickname && nickname !== card) identityParts.push(`昵称:${nickname}`);
    const identitySuffix = identityParts.length > 0 ? ` | 身份:${identityParts.join(' / ')}` : '';

    if (event.message_type === 'group') {
        return `[群聊 | 群号:${event.group_id} | 发言者:${senderName} | QQ:${userId}${identitySuffix}] ${text}`;
    }
    return `[私聊 | 对方:${senderName} | QQ:${userId}${identitySuffix}] ${text}`;
}

module.exports = {
    extractText,
    shouldTrigger,
    truncateReply,
    buildUserContent
};

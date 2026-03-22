class GroupMessageBuffer {
    constructor(proactiveConfig = {}) {
        this.proactiveConfig = proactiveConfig;
        /** @type {Map<string, { messages: Array, lastCheck: number, lastSpeak: number }>} */
        this.buffers = new Map();
    }

    /**
     * 推送一条群消息到缓冲区
     * @returns {string|null} 如果需要触发判定，返回合并后的文本；否则返回 null
     */
    push(groupId, senderName, text) {
        if (!this.proactiveConfig.enable) return null;

        let buf = this.buffers.get(groupId);
        if (!buf) {
            buf = { messages: [], lastCheck: 0, lastSpeak: 0 };
            this.buffers.set(groupId, buf);
        }

        buf.messages.push({ sender: senderName, text, time: Date.now() });

        const maxBuffer = this.proactiveConfig.bufferSize || 10;
        while (buf.messages.length > maxBuffer) {
            buf.messages.shift();
        }

        const now = Date.now();
        const checkInterval = this.proactiveConfig.checkIntervalMessages || 5;
        const cooldownMs = (this.proactiveConfig.cooldownSeconds || 300) * 1000;
        const minIntervalMs = (this.proactiveConfig.minCheckIntervalSeconds || 30) * 1000;

        if (now - buf.lastSpeak < cooldownMs) return null;
        if (buf.messages.length < checkInterval) return null;
        if (now - buf.lastCheck < minIntervalMs) return null;

        buf.lastCheck = now;
        return buf.messages.map((m) => `${m.sender}: ${m.text}`).join('\n');
    }

    markSpoken(groupId) {
        const buf = this.buffers.get(groupId);
        if (buf) {
            buf.lastSpeak = Date.now();
            buf.messages = [];
        }
    }

    isGroupEnabled(groupId) {
        if (!this.proactiveConfig.enable) return false;
        const groups = this.proactiveConfig.groups;
        if (!groups || groups.length === 0) return true;
        return groups.includes(Number(groupId)) || groups.includes(String(groupId));
    }
}

module.exports = {
    GroupMessageBuffer
};

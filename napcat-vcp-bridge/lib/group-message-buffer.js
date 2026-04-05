class GroupMessageBuffer {
    constructor(proactiveConfig = {}) {
        this.proactiveConfig = proactiveConfig;
        /** @type {Map<string, { messages: Array, timestamps: Array<number>, lastCheck: number, lastSpeak: number }>} */
        this.buffers = new Map();
    }

    isTrackingEnabled() {
        return !!this.proactiveConfig.enable || this.getVpeGroups().length > 0;
    }

    getLegacyGroups() {
        return Array.isArray(this.proactiveConfig.groups) ? this.proactiveConfig.groups : [];
    }

    getVpeGroups() {
        return Array.isArray(this.proactiveConfig?.vpe?.groups) ? this.proactiveConfig.vpe.groups : [];
    }

    _getOrCreateBuffer(groupId) {
        const key = String(groupId);
        let buf = this.buffers.get(key);
        if (!buf) {
            buf = { messages: [], timestamps: [], lastCheck: 0, lastSpeak: 0 };
            this.buffers.set(key, buf);
        }
        return buf;
    }

    _trimTimestamps(buf, now = Date.now()) {
        const windowMs = 10 * 60 * 1000;
        while (buf.timestamps.length && now - buf.timestamps[0] > windowMs) {
            buf.timestamps.shift();
        }
        const hardLimit = 5000;
        while (buf.timestamps.length > hardLimit) {
            buf.timestamps.shift();
        }
    }

    /**
     * 推送一条群消息到缓冲区
     * @returns {string|null} 如果需要触发判定，返回合并后的文本；否则返回 null
     */
    push(groupId, senderName, text) {
        if (!this.isTrackingEnabled()) return null;

        const buf = this._getOrCreateBuffer(groupId);
        const now = Date.now();
        buf.messages.push({ sender: senderName, text, time: now });
        buf.timestamps.push(now);
        this._trimTimestamps(buf, now);

        const maxBuffer = this.proactiveConfig.bufferSize || 10;
        while (buf.messages.length > maxBuffer) {
            buf.messages.shift();
        }

        const checkInterval = this.proactiveConfig.checkIntervalMessages || 5;
        const cooldownMs = (this.proactiveConfig.cooldownSeconds || 300) * 1000;
        const minIntervalMs = (this.proactiveConfig.minCheckIntervalSeconds || 30) * 1000;

        if (now - buf.lastSpeak < cooldownMs) return null;
        if (buf.messages.length < checkInterval) return null;
        if (now - buf.lastCheck < minIntervalMs) return null;

        buf.lastCheck = now;
        return this.getContextText(groupId, maxBuffer);
    }

    markSpoken(groupId) {
        const buf = this.buffers.get(String(groupId));
        if (buf) {
            buf.lastSpeak = Date.now();
            buf.messages = [];
        }
    }

    getContextText(groupId, maxMessages = 20) {
        const buf = this.buffers.get(String(groupId));
        if (!buf) return '';
        return buf.messages
            .slice(-Math.max(0, maxMessages))
            .map((m) => `${m.sender}: ${m.text}`)
            .join('\n');
    }

    getRecentMsgCount(groupId) {
        const buf = this.buffers.get(String(groupId));
        if (!buf) return 0;
        this._trimTimestamps(buf);
        return buf.timestamps.length;
    }

    isGroupEnabled(groupId) {
        if (!this.proactiveConfig.enable) return false;
        const groups = this.getLegacyGroups();
        if (!groups || groups.length === 0) return true;
        return groups.includes(Number(groupId)) || groups.includes(String(groupId));
    }

    isVpeGroupEnabled(groupId) {
        const groups = this.getVpeGroups();
        if (!groups.length) return false;
        return groups.includes(Number(groupId)) || groups.includes(String(groupId));
    }
}

module.exports = {
    GroupMessageBuffer
};

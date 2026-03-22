class ContextManager {
    constructor(options = {}) {
        this.maxRounds = options.maxRounds || 10;
        this.ttlMs = (options.ttlMinutes || 60) * 60 * 1000;
        this.perUser = !!options.perUser;
        this.log = options.log || (() => { });
        /** @type {Map<string, {messages: Array, lastAccess: number}>} */
        this.contexts = new Map();

        this._cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    getKey(userId, groupId) {
        if (this.perUser) {
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
        if (cleaned > 0) this.log('DEBUG', `清理了 ${cleaned} 个过期上下文`);
    }

    clear(key) {
        this.contexts.delete(key);
    }

    shutdown() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }
}

module.exports = {
    ContextManager
};

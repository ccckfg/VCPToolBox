const fs = require('fs');

class AffinityManager {
    constructor(options = {}) {
        this.filePath = options.filePath;
        this.sentimentAnalyzer = options.sentimentAnalyzer;
        this.log = options.log || (() => { });
        /** @type {Map<string, {affinity: number, lastMessageTime: number, lastProactiveTime: number, messageCount: number, nickname: string, dailyProactiveCount: number, dailyResetDate: string}>} */
        this.users = new Map();
        this._load();

        this._recoveryTimer = setInterval(() => this._naturalRecovery(), 60 * 60 * 1000);
        if (this._recoveryTimer.unref) this._recoveryTimer.unref();
    }

    _load() {
        try {
            if (this.filePath && fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (data && typeof data === 'object') {
                    for (const [uid, info] of Object.entries(data)) {
                        this.users.set(uid, info);
                    }
                }
                this.log('INFO', `[亲和度] 已加载 ${this.users.size} 个用户的亲和度数据`);
            }
        } catch (err) {
            this.log('WARN', `[亲和度] 加载失败: ${err.message}`);
        }
    }

    _save() {
        if (!this.filePath) return;
        try {
            const obj = {};
            for (const [uid, info] of this.users) {
                obj[uid] = info;
            }
            fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
        } catch (err) {
            this.log('ERROR', `[亲和度] 持久化失败: ${err.message}`);
        }
    }

    _getOrCreate(userId, nickname = '') {
        if (!this.users.has(userId)) {
            this.users.set(userId, {
                affinity: 50,
                lastMessageTime: 0,
                lastProactiveTime: 0,
                messageCount: 0,
                nickname,
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

    onMessage(userId, text, nickname = '') {
        const user = this._getOrCreate(userId, nickname);
        user.lastMessageTime = Date.now();
        user.messageCount++;
        user.affinity = Math.min(100, user.affinity + 0.5);

        const sentimentScore = this.sentimentAnalyzer ? this.sentimentAnalyzer.analyze(text) : 0;
        if (sentimentScore !== 0) {
            user.affinity = Math.max(0, Math.min(100, user.affinity + sentimentScore));
            this.log(
                'DEBUG',
                `[亲和度] ${nickname}(${userId}) 情绪${sentimentScore > 0 ? '积极' : '消极'} (${sentimentScore > 0 ? '+' : ''}${sentimentScore})，当前亲和度: ${user.affinity.toFixed(1)}`
            );
        }

        this._save();
    }

    getAffinity(userId) {
        return this.users.get(userId)?.affinity ?? 50;
    }

    getProactiveProbability(userId) {
        const affinity = this.getAffinity(userId);
        if (affinity >= 80) return 0.7;
        if (affinity >= 50) return 0.4;
        if (affinity >= 20) return 0.1;
        return 0;
    }

    getDynamicThreshold(userId, baseThreshold) {
        const affinity = this.getAffinity(userId);
        const adjustment = (50 - affinity) / 500;
        return Math.max(0.1, Math.min(0.9, baseThreshold + adjustment));
    }

    markProactive(userId) {
        const user = this._getOrCreate(userId);
        user.lastProactiveTime = Date.now();

        const today = new Date().toISOString().slice(0, 10);
        if (user.dailyResetDate !== today) {
            user.dailyProactiveCount = 0;
            user.dailyResetDate = today;
        }
        user.dailyProactiveCount++;

        this._save();
    }

    canProactiveToday(userId, maxDaily) {
        const user = this.users.get(userId);
        if (!user) return true;
        const today = new Date().toISOString().slice(0, 10);
        if (user.dailyResetDate !== today) return true;
        return user.dailyProactiveCount < maxDaily;
    }

    _naturalRecovery() {
        let changed = false;
        for (const user of this.users.values()) {
            if (user.affinity < 50) {
                user.affinity = Math.min(50, user.affinity + 1);
                changed = true;
            }
        }
        if (changed) {
            this._save();
            this.log('DEBUG', '[亲和度] 自然恢复已执行');
        }
    }

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

module.exports = {
    AffinityManager
};

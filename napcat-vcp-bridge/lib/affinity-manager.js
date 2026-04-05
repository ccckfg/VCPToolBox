const {
    AFFINITY_DECAY_LAMBDA,
    BASE_AFFINITY,
    FATIGUE_DECAY_GAMMA,
    GHOSTING_WINDOW_MS
} = require('./vpe/constants');
const { clamp, toLocalDateString } = require('./vpe/utils');

class AffinityManager {
    constructor(options = {}) {
        this.stateStore = options.stateStore;
        this.sentimentAnalyzer = options.sentimentAnalyzer;
        this.log = options.log || (() => {});
        this.users = new Map();

        for (const { userId, ...user } of this.stateStore.getAllUsers()) {
            this.users.set(userId, user);
        }

        this._maintenanceTimer = setInterval(() => {
            this.sweepGhostingPenalties();
            this.stateStore.maybeRunGc();
            this._refreshUserMap();
        }, 10 * 60 * 1000);
        if (this._maintenanceTimer.unref) this._maintenanceTimer.unref();
    }

    _refreshUserMap() {
        this.users.clear();
        for (const { userId, ...user } of this.stateStore.getAllUsers()) {
            this.users.set(userId, user);
        }
    }

    _getOrCreate(userId, nickname = '') {
        const user = this.stateStore.getUser(userId, nickname);
        this._attachLegacyAliases(user);
        this.users.set(String(userId), user);
        return user;
    }

    _attachLegacyAliases(user) {
        if (!user || user.__legacyAliasesAttached) return;

        Object.defineProperties(user, {
            lastProactiveTime: {
                get() {
                    return this.lastProactiveMs;
                },
                enumerable: false,
                configurable: true
            },
            lastMessageTime: {
                get() {
                    return this.lastMsgMs;
                },
                enumerable: false,
                configurable: true
            },
            __legacyAliasesAttached: {
                value: true,
                enumerable: false,
                configurable: true
            }
        });
    }

    _applyDecay(user, now = Date.now()) {
        const anchor = Number(user.lastCalcTime) || Number(user.lastMsgMs) || now;
        const deltaHours = (now - anchor) / (60 * 60 * 1000);
        if (deltaHours <= 0.5) return;

        user.affinity = BASE_AFFINITY + ((user.affinity - BASE_AFFINITY) * Math.exp(-AFFINITY_DECAY_LAMBDA * deltaHours));
        user.lastCalcTime = now;
    }

    getDecayedFatigue(user, now = Date.now()) {
        if (!user?.lastProactiveMs || !user?.fatigue) return 0;
        const deltaHours = Math.max(0, (now - user.lastProactiveMs) / (60 * 60 * 1000));
        return user.fatigue * Math.exp(-FATIGUE_DECAY_GAMMA * deltaHours);
    }

    async onMessage(userId, text, nickname = '', options = {}) {
        const user = this._getOrCreate(userId, nickname);
        const now = Date.now();

        this._applyDecay(user, now);

        if (options.isPrivate && user.pendingReplySince && now - user.pendingReplySince <= GHOSTING_WINDOW_MS) {
            this.onIceBreak(userId, now, false);
        }

        const sentimentScore = this.sentimentAnalyzer ? await this.sentimentAnalyzer.analyze(text) : 0;
        const softCap = Math.max(0.1, 1 - (user.affinity / 100));
        const delta = (0.5 + sentimentScore) * softCap;

        user.affinity = clamp(user.affinity + delta, 0, 100);
        user.lastMsgMs = now;
        user.lastCalcTime = now;
        user.messageCount = Number(user.messageCount) + 1;

        this.stateStore.save();
        this.users.set(String(userId), user);

        this.log(
            'DEBUG',
            `[亲和度] ${nickname || user.nickname || userId}(${userId}) 情绪分=${sentimentScore.toFixed(3)} 变化=${delta.toFixed(3)} 当前=${user.affinity.toFixed(2)}`
        );

        return user;
    }

    onIceBreak(userId, now = Date.now(), persist = true) {
        const user = this._getOrCreate(userId);
        this._applyDecay(user, now);
        user.affinity = clamp(user.affinity + 2.0, 0, 100);
        user.fatigue = 0;
        user.pendingReplySince = 0;
        user.lastCalcTime = now;
        if (persist) this.stateStore.save();
        this.log('INFO', `[亲和度] ${user.nickname || userId} 在主动发话后回应，已触发破冰奖励`);
        return user;
    }

    onProactiveSent(userId, category = 'schedule', now = Date.now()) {
        const user = this._getOrCreate(userId);
        this._applyDecay(user, now);
        const currentFatigue = this.getDecayedFatigue(user, now);
        user.fatigue = currentFatigue + 0.30;
        user.lastProactiveMs = now;
        user.pendingReplySince = now;

        const today = toLocalDateString(new Date(now));
        if (user.dailyResetDate !== today) {
            user.dailyResetDate = today;
            user.dailyProactiveCount = 0;
        }
        user.dailyProactiveCount = Number(user.dailyProactiveCount) + 1;

        user.ucb = user.ucb || { total: 0, cats: {} };
        user.ucb.total = Number(user.ucb.total) + 1;
        user.ucb.cats = user.ucb.cats || {};
        user.ucb.cats[category] = Number(user.ucb.cats[category] || 0) + 1;

        user.lastCalcTime = now;
        this.stateStore.save();
        return user;
    }

    sweepGhostingPenalties(now = Date.now()) {
        let changed = false;
        for (const { userId, ...snapshot } of this.stateStore.getAllUsers()) {
            const user = this.stateStore.getUser(userId);
            if (!user.pendingReplySince || now - user.pendingReplySince < GHOSTING_WINDOW_MS) {
                continue;
            }

            this._applyDecay(user, now);
            const penalty = 1 + (0.04 * Math.max(0, user.affinity - BASE_AFFINITY));
            user.affinity = clamp(user.affinity - penalty, 0, 100);
            user.pendingReplySince = 0;
            user.lastCalcTime = now;
            changed = true;
            this.log('INFO', `[亲和度] ${user.nickname || userId} 超时未回复主动发话，扣除 ${penalty.toFixed(2)} 亲和度`);
        }

        if (changed) {
            this.stateStore.save();
            this._refreshUserMap();
        }
    }

    getAffinity(userId) {
        return this._getOrCreate(userId).affinity ?? BASE_AFFINITY;
    }

    getUserState(userId, nickname = '') {
        return this._getOrCreate(userId, nickname);
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
        return this.onProactiveSent(userId, 'legacy');
    }

    canProactiveToday(userId, maxDaily, now = Date.now()) {
        const user = this._getOrCreate(userId);
        const today = toLocalDateString(new Date(now));
        if (user.dailyResetDate !== today) {
            user.dailyResetDate = today;
            user.dailyProactiveCount = 0;
            this.stateStore.save();
            return true;
        }
        return Number(user.dailyProactiveCount) < maxDaily;
    }

    recordPrivateHistory(userId, role, content, timestamp = Date.now()) {
        this.stateStore.recordPrivateHistory(userId, role, content, timestamp);
        this._refreshUserMap();
    }

    getPrivateHistory(userId, maxMessages = 4) {
        return this.stateStore.getPrivateHistory(userId, maxMessages);
    }

    clearPrivateHistory(userId) {
        this.stateStore.clearPrivateHistory(userId);
        this._refreshUserMap();
    }

    getEligibleUsers(whitelist) {
        return this.stateStore.getUsersByIds(whitelist);
    }

    shutdown() {
        if (this._maintenanceTimer) clearInterval(this._maintenanceTimer);
        this.stateStore.save();
    }
}

module.exports = {
    AffinityManager
};

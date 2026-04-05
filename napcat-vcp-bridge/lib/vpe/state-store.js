const fs = require('fs');
const path = require('path');

const {
    BASE_AFFINITY,
    GC,
    MAX_HISTORY_MESSAGES,
    STATE_SCHEMA_VERSION
} = require('./constants');
const { clamp, toLocalDateString } = require('./utils');

function createDefaultUser(nickname = '') {
    return {
        affinity: BASE_AFFINITY,
        nickname,
        lastMsgMs: 0,
        lastCalcTime: 0,
        lastProactiveMs: 0,
        fatigue: 0,
        pendingReplySince: 0,
        dailyProactiveCount: 0,
        dailyResetDate: toLocalDateString(),
        messageCount: 0,
        ucb: { total: 0, cats: {} },
        privateHistory: []
    };
}

function createDefaultGroup() {
    return {
        lastMsgMs: 0,
        lastProactiveMs: 0,
        fatigue: 0,
        recentMsgCount: 0,
        ucb: { total: 0, cats: {} }
    };
}

function createDefaultState() {
    return {
        _meta: {
            schemaVersion: STATE_SCHEMA_VERSION,
            lastGcMs: 0,
            migratedFromLegacy: false
        },
        users: {},
        groups: {},
        events_fsm: {},
        pendingQueue: []
    };
}

class VpeStateStore {
    constructor(options = {}) {
        this.filePath = options.filePath;
        this.legacyFilePath = options.legacyFilePath;
        this.log = options.log || (() => {});
        this.state = createDefaultState();
        this._saveTimer = null;
        this._saveDelayMs = Math.max(0, Number(options.saveDelayMs) || 250);
        this._load();
    }

    _load() {
        const loaded = this._tryReadJson(this.filePath);
        if (loaded) {
            this.state = this._normalizeState(loaded);
            this.log('INFO', `[VPE] 已加载状态文件: ${this.filePath}`);
            return;
        }

        const legacy = this._tryReadJson(this.legacyFilePath);
        if (legacy) {
            this.state = this._migrateLegacyState(legacy);
            this.save();
            this.log('INFO', `[VPE] 已从旧亲和度文件迁移状态: ${path.basename(this.legacyFilePath)}`);
            return;
        }

        this.state = createDefaultState();
    }

    _tryReadJson(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (error) {
            this.log('WARN', `[VPE] 读取状态文件失败 ${filePath}: ${error.message}`);
            return null;
        }
    }

    _migrateLegacyState(legacy) {
        const migrated = createDefaultState();
        migrated._meta.migratedFromLegacy = true;

        for (const [userId, info] of Object.entries(legacy || {})) {
            const user = createDefaultUser(info.nickname || '');
            user.affinity = clamp(Number(info.affinity) || BASE_AFFINITY, 0, 100);
            user.nickname = info.nickname || '';
            user.lastMsgMs = Number(info.lastMessageTime) || 0;
            user.lastCalcTime = user.lastMsgMs;
            user.lastProactiveMs = Number(info.lastProactiveTime) || 0;
            user.dailyProactiveCount = Number(info.dailyProactiveCount) || 0;
            user.dailyResetDate = info.dailyResetDate || toLocalDateString();
            user.messageCount = Number(info.messageCount) || 0;
            migrated.users[userId] = user;
        }

        return migrated;
    }

    _normalizeState(raw) {
        const normalized = createDefaultState();
        normalized._meta = {
            ...normalized._meta,
            ...(raw._meta || {}),
            schemaVersion: STATE_SCHEMA_VERSION
        };

        for (const [userId, info] of Object.entries(raw.users || {})) {
            const user = createDefaultUser(info.nickname || '');
            normalized.users[userId] = {
                ...user,
                ...info,
                affinity: clamp(Number(info.affinity) || BASE_AFFINITY, 0, 100),
                fatigue: Math.max(0, Number(info.fatigue) || 0),
                dailyResetDate: info.dailyResetDate || toLocalDateString(),
                ucb: {
                    total: Number(info?.ucb?.total) || 0,
                    cats: { ...(info?.ucb?.cats || {}) }
                },
                privateHistory: Array.isArray(info.privateHistory)
                    ? info.privateHistory.slice(-MAX_HISTORY_MESSAGES)
                    : []
            };
        }

        for (const [groupId, info] of Object.entries(raw.groups || {})) {
            const group = createDefaultGroup();
            normalized.groups[groupId] = {
                ...group,
                ...info,
                fatigue: Math.max(0, Number(info.fatigue) || 0),
                recentMsgCount: Math.max(0, Number(info.recentMsgCount) || 0),
                ucb: {
                    total: Number(info?.ucb?.total) || 0,
                    cats: { ...(info?.ucb?.cats || {}) }
                }
            };
        }
        normalized.events_fsm = { ...(raw.events_fsm || {}) };
        normalized.pendingQueue = Array.isArray(raw.pendingQueue) ? raw.pendingQueue : [];
        return normalized;
    }

    save() {
        if (!this.filePath) return;
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
        } catch (error) {
            this.log('ERROR', `[VPE] 写入状态失败: ${error.message}`);
        }
    }

    scheduleSave(delayMs = this._saveDelayMs) {
        if (!this.filePath) return;
        if (delayMs <= 0) {
            this.save();
            return;
        }

        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
        }

        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.save();
        }, delayMs);
        if (this._saveTimer.unref) this._saveTimer.unref();
    }

    getState() {
        return this.state;
    }

    getUser(userId, nickname = '') {
        const uid = String(userId);
        if (!this.state.users[uid]) {
            this.state.users[uid] = createDefaultUser(nickname);
        }
        const user = this.state.users[uid];
        if (nickname && nickname !== user.nickname) {
            user.nickname = nickname;
        }
        return user;
    }

    getUsersByIds(userIds = []) {
        return userIds.map((userId) => ({ userId: String(userId), ...this.getUser(userId) }));
    }

    getAllUsers() {
        return Object.entries(this.state.users).map(([userId, user]) => ({ userId, ...user }));
    }

    getGroup(groupId) {
        const gid = String(groupId);
        if (!this.state.groups[gid]) {
            this.state.groups[gid] = createDefaultGroup();
        }
        return this.state.groups[gid];
    }

    getAllGroups() {
        return Object.entries(this.state.groups).map(([groupId, group]) => ({ groupId, ...group }));
    }

    updateGroup(groupId, updater, persist = true) {
        const group = this.getGroup(groupId);
        if (typeof updater === 'function') {
            updater(group);
        } else if (updater && typeof updater === 'object') {
            Object.assign(group, updater);
        }

        if (persist) {
            this.scheduleSave();
        }
        return group;
    }

    recordPrivateHistory(userId, role, content, timestamp = Date.now()) {
        if (!content) return;
        const user = this.getUser(userId);
        user.privateHistory.push({
            role,
            content,
            ts: timestamp
        });
        while (user.privateHistory.length > MAX_HISTORY_MESSAGES) {
            user.privateHistory.shift();
        }
        this.scheduleSave();
    }

    getPrivateHistory(userId, maxMessages = 4) {
        const user = this.getUser(userId);
        const limit = Math.max(0, maxMessages);
        if (!limit) return [];

        const recent = user.privateHistory.slice(-(limit + 2));
        while (recent.length && recent[0].role !== 'user') {
            recent.shift();
        }
        return recent.slice(-limit);
    }

    clearPrivateHistory(userId) {
        const user = this.getUser(userId);
        user.privateHistory = [];
        this.scheduleSave();
    }

    clearUserPendingReply(userId) {
        const user = this.getUser(userId);
        user.pendingReplySince = 0;
        this.save();
    }

    getEventState(fingerprint) {
        return this.state.events_fsm[fingerprint] || null;
    }

    setEventState(fingerprint, value) {
        if (!value) delete this.state.events_fsm[fingerprint];
        else this.state.events_fsm[fingerprint] = value;
        this.save();
    }

    getPendingQueue() {
        return Array.isArray(this.state.pendingQueue) ? this.state.pendingQueue : [];
    }

    setPendingQueue(queue) {
        this.state.pendingQueue = Array.isArray(queue) ? queue : [];
        this.save();
    }

    maybeRunGc(now = Date.now()) {
        const lastGcMs = Number(this.state._meta.lastGcMs) || 0;
        if (lastGcMs && now - lastGcMs < 24 * 60 * 60 * 1000) return;

        let changed = false;

        for (const [userId, user] of Object.entries(this.state.users)) {
            const lastTouched = Math.max(user.lastMsgMs || 0, user.lastProactiveMs || 0);
            const isDormant = now - lastTouched > GC.userRetentionMs;
            const nearBaseline = Math.abs((user.affinity || BASE_AFFINITY) - BASE_AFFINITY) < 2;
            const noPending = !user.pendingReplySince;
            if (isDormant && nearBaseline && noPending) {
                delete this.state.users[userId];
                changed = true;
            }
        }

        for (const [groupId, group] of Object.entries(this.state.groups)) {
            const lastTouched = Math.max(group.lastMsgMs || 0, group.lastProactiveMs || 0);
            if (lastTouched && now - lastTouched > GC.groupRetentionMs) {
                delete this.state.groups[groupId];
                changed = true;
            }
        }

        for (const [fingerprint, eventState] of Object.entries(this.state.events_fsm)) {
            const lastTriggerMs = Number(eventState.lastTriggerMs) || 0;
            if (lastTriggerMs && now - lastTriggerMs > GC.eventRetentionMs) {
                delete this.state.events_fsm[fingerprint];
                changed = true;
            }
        }

        this.state._meta.lastGcMs = now;
        this.save();
    }
}

module.exports = {
    VpeStateStore,
    createDefaultGroup,
    createDefaultState,
    createDefaultUser
};

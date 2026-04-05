const { QUEUE } = require('./constants');
const { HOUR_MS } = require('./utils');

class AgingQueue {
    constructor(options = {}) {
        this.stateStore = options.stateStore;
        this.log = options.log || (() => {});
    }

    _readQueue() {
        return this.stateStore.getPendingQueue().slice();
    }

    _writeQueue(queue) {
        this.stateStore.setPendingQueue(queue);
    }

    upsert(item) {
        const queue = this._readQueue();
        const index = queue.findIndex((entry) => entry.queueKey === item.queueKey);
        if (index >= 0) {
            queue[index] = {
                ...queue[index],
                ...item,
                enqueuedAtMs: queue[index].enqueuedAtMs || item.enqueuedAtMs || Date.now()
            };
        } else {
            queue.push({
                ...item,
                enqueuedAtMs: item.enqueuedAtMs || Date.now()
            });
        }
        this._writeQueue(queue);
    }

    prune(now = Date.now()) {
        const filtered = this._readQueue().filter((item) => {
            const waitHours = (now - (item.enqueuedAtMs || now)) / HOUR_MS;
            if (waitHours > QUEUE.maxAgeHours) return false;
            if (item.expiresAtMs && now > item.expiresAtMs) return false;
            return true;
        });
        this._writeQueue(filtered);
        return filtered;
    }

    _rankCandidates(filtered, now = Date.now()) {
        return filtered
            .map((item) => {
                const waitHours = Math.max(0, (now - (item.enqueuedAtMs || now)) / HOUR_MS);
                const agingMultiplier = Math.min(
                    QUEUE.agingMaxMultiplier,
                    1 + (QUEUE.agingStepPerHour * waitHours)
                );
                return {
                    ...item,
                    waitHours,
                    agingMultiplier,
                    urgencyScore: item.finalScore * agingMultiplier
                };
            })
            .sort((a, b) => b.urgencyScore - a.urgencyScore);
    }

    getCandidatesForUser(userId, now = Date.now()) {
        const filtered = this.prune(now).filter((item) => String(item.targetUserId) === String(userId));
        return this._rankCandidates(filtered, now);
    }

    getCandidatesForGroup(groupId, now = Date.now()) {
        const filtered = this.prune(now).filter((item) => {
            if (item.scope !== 'public') return false;
            if (!item.targetGroupId) return true;
            return String(item.targetGroupId) === String(groupId);
        });
        return this._rankCandidates(filtered, now);
    }

    chooseForUser(userId, threshold, now = Date.now(), rankedCandidates = null) {
        const ranked = Array.isArray(rankedCandidates) ? rankedCandidates : this.getCandidatesForUser(userId, now);
        if (!ranked.length) return { selected: [], topScore: 0 };

        const topOne = ranked[0];
        if (topOne.urgencyScore < threshold) {
            return { selected: [], topScore: topOne.urgencyScore };
        }

        const selected = [topOne];
        const topTwo = ranked[1];
        if (
            topTwo &&
            topTwo.urgencyScore >= topOne.urgencyScore * 0.85 &&
            topTwo.category !== topOne.category
        ) {
            selected.push(topTwo);
        }

        return {
            selected,
            topScore: topOne.urgencyScore
        };
    }

    markDelivered(items) {
        if (!items?.length) return;
        const keys = new Set(items.map((item) => item.queueKey));
        const nextQueue = this._readQueue().filter((item) => !keys.has(item.queueKey));
        this._writeQueue(nextQueue);
    }
}

module.exports = {
    AgingQueue
};

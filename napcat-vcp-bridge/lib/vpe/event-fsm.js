const crypto = require('crypto');

const { SCHEDULE_STAGES } = require('./constants');
const { HOUR_MS } = require('./utils');

class EventFsm {
    constructor(options = {}) {
        this.stateStore = options.stateStore;
        this.log = options.log || (() => {});
    }

    buildFingerprint(event) {
        const routingKey = event.targetUserId || event.targetGroupId || event.scope || 'global';
        const occurrenceDate = event.occurrenceDate || event.publishedDate || '';
        const payload = `${event.category}|${event.sourceId}|${routingKey}|${occurrenceDate}`;
        return crypto.createHash('md5').update(payload).digest('hex');
    }

    getStageConfig(event) {
        if (event.category === 'schedule') return SCHEDULE_STAGES;
        return [];
    }

    scan(events, now = Date.now()) {
        const candidates = [];

        for (const event of events) {
            const stages = this.getStageConfig(event);
            const fingerprint = this.buildFingerprint(event);
            if (!stages.length) {
                const expiresAfterHours = Number(event.expiresAfterHours) || 0;
                const publishedAtMs = Number(event.publishedAtMs) || now;
                const state = this.stateStore.getEventState(fingerprint) || { stageIdx: 0, lastTriggerMs: 0 };
                if (state.lastTriggerMs && (!expiresAfterHours || now - state.lastTriggerMs < expiresAfterHours * HOUR_MS)) {
                    continue;
                }
                candidates.push({
                    ...event,
                    fingerprint,
                    queueKey: `${fingerprint}:live`,
                    stageIdx: 0,
                    stage: null,
                    hoursToTarget: 0,
                    expiresAtMs: expiresAfterHours > 0 ? publishedAtMs + (expiresAfterHours * HOUR_MS) : 0
                });
                continue;
            }

            const state = this.stateStore.getEventState(fingerprint) || { stageIdx: 0, lastTriggerMs: 0 };
            let stageIdx = Number(state.stageIdx) || 0;
            const hoursToTarget = (event.targetTimeMs - now) / HOUR_MS;

            while (stageIdx < stages.length && hoursToTarget <= stages[stageIdx].lateBoundHours) {
                stageIdx += 1;
            }

            if (stageIdx >= stages.length) {
                if (state.stageIdx !== stageIdx) {
                    this.stateStore.setEventState(fingerprint, {
                        ...state,
                        stageIdx
                    });
                }
                continue;
            }

            const stage = stages[stageIdx];
            const inWindow = hoursToTarget <= stage.earlyBoundHours && hoursToTarget > stage.lateBoundHours;
            if (!inWindow) {
                if (state.stageIdx !== stageIdx) {
                    this.stateStore.setEventState(fingerprint, {
                        ...state,
                        stageIdx
                    });
                }
                continue;
            }

            candidates.push({
                ...event,
                fingerprint,
                queueKey: `${fingerprint}:${stageIdx}`,
                stageIdx,
                stage,
                hoursToTarget,
                expiresAtMs: event.targetTimeMs - (stage.lateBoundHours * HOUR_MS)
            });
        }

        return candidates;
    }

    markTriggered(candidate, now = Date.now()) {
        const previous = this.stateStore.getEventState(candidate.fingerprint) || { stageIdx: 0, lastTriggerMs: 0 };
        this.stateStore.setEventState(candidate.fingerprint, {
            ...previous,
            stageIdx: candidate.stageIdx + 1,
            lastTriggerMs: now
        });
        this.log('INFO', `[VPE] 事件阶段已推进: ${candidate.queueKey} -> ${candidate.stageIdx + 1}`);
    }
}

module.exports = {
    EventFsm
};

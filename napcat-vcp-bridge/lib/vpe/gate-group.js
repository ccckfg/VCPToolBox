const { GROUP_GATE } = require('./constants');
const { clamp } = require('./utils');

class GroupGate {
    calcActivityPenalty(recentMsgCount) {
        const activity = Math.max(0, Number(recentMsgCount) || 0);
        if (activity < GROUP_GATE.idleThreshold) {
            return GROUP_GATE.quietActivityPenalty;
        }
        if (activity <= GROUP_GATE.burstThreshold) {
            return 0;
        }
        return GROUP_GATE.burstPenaltyStep * (activity - GROUP_GATE.burstThreshold);
    }

    calcThreshold(groupState, fatigueNow) {
        const activityPenalty = this.calcActivityPenalty(groupState?.recentMsgCount);
        const threshold = GROUP_GATE.baseThreshold + (fatigueNow || 0) + activityPenalty;
        return clamp(threshold, GROUP_GATE.minThreshold, GROUP_GATE.maxThreshold);
    }
}

module.exports = {
    GroupGate
};

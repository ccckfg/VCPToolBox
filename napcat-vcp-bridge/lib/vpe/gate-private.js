const { PRIVATE_GATE } = require('./constants');
const { clamp } = require('./utils');

class PrivateGate {
    constructor(options = {}) {
        this.log = options.log || (() => {});
    }

    calcThreshold(userState, category, fatigueNow, now = new Date()) {
        const affinity = Number(userState?.affinity) || 50;
        const affTerm = PRIVATE_GATE.affinityAlpha * ((affinity - 50) / 50);
        const total = Number(userState?.ucb?.total) || 0;
        const catCount = Number(userState?.ucb?.cats?.[category]) || 0;
        const ucbTerm = PRIVATE_GATE.ucbBeta * Math.sqrt(Math.log(total + 2) / (catCount + 1));

        const hour = now.getHours();
        const inQuietHours = hour >= PRIVATE_GATE.quietHoursStart && hour < PRIVATE_GATE.quietHoursEnd;
        const quietTerm = inQuietHours ? PRIVATE_GATE.quietHoursResistance : 0;

        const threshold = PRIVATE_GATE.baseThreshold - affTerm + fatigueNow - ucbTerm + quietTerm;
        return clamp(threshold, PRIVATE_GATE.minThreshold, PRIVATE_GATE.maxThreshold);
    }
}

module.exports = {
    PrivateGate
};

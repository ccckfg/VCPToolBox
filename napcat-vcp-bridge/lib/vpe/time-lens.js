const { HOUR_MS } = require('./utils');

class TimeLens {
    calcScheduleWeight(candidate) {
        const { hoursToTarget, stage } = candidate;
        if (hoursToTarget < 0) return 0;
        const sigma = stage?.sigmaHours || 1;
        const offset = stage?.peakOffsetHours || 0;
        const delta = hoursToTarget - offset;
        const exponent = -((delta * delta) / (2 * sigma * sigma));
        return Math.exp(exponent);
    }

    calcDecayWeight(candidate, now = Date.now()) {
        const publishedAtMs = Number(candidate?.publishedAtMs) || 0;
        if (!publishedAtMs) return 1;

        const expiresAfterHours = Math.max(1, Number(candidate?.expiresAfterHours) || 6);
        const elapsedHours = Math.max(0, (now - publishedAtMs) / HOUR_MS);
        const sigma = expiresAfterHours / 2;
        return Math.exp(-((elapsedHours * elapsedHours) / (2 * sigma * sigma)));
    }

    calcFinalScore(candidate, semanticScore, now = Date.now()) {
        const isDecayType = candidate?.category === 'weather' || candidate?.category === 'news';
        const timeWeight = isDecayType
            ? this.calcDecayWeight(candidate, now)
            : this.calcScheduleWeight(candidate);
        const intrinsicScore = candidate.stage?.intrinsicScore || candidate.intrinsicScore || 0;
        const finalScore = Math.max(semanticScore, intrinsicScore) * timeWeight;
        return {
            timeWeight,
            intrinsicScore,
            semanticScore,
            finalScore
        };
    }
}

module.exports = {
    TimeLens
};

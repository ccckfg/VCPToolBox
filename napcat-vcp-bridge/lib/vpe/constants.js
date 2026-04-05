const { HOUR_MS } = require('./utils');

const STATE_SCHEMA_VERSION = 2;
const BASE_AFFINITY = 50;
const MAX_HISTORY_MESSAGES = 8;
const GHOSTING_WINDOW_MS = 60 * 60 * 1000;
const AFFINITY_DECAY_LAMBDA = Math.log(2) / (7 * 24);
const FATIGUE_DECAY_GAMMA = Math.log(2) / 2;

const PRIVATE_GATE = {
    baseThreshold: 0.65,
    affinityAlpha: 0.15,
    fatigueStep: 0.30,
    fatigueGamma: FATIGUE_DECAY_GAMMA,
    ucbBeta: 0.08,
    quietHoursResistance: 0.40,
    quietHoursStart: 1,
    quietHoursEnd: 7,
    minThreshold: 0.35,
    maxThreshold: 1.20
};

const GROUP_GATE = {
    baseThreshold: 0.75,
    minThreshold: 0.40,
    maxThreshold: 1.30,
    quietActivityPenalty: 0.15,
    burstPenaltyStep: 0.05,
    burstThreshold: 20,
    idleThreshold: 2,
    recentWindowMs: 10 * 60 * 1000,
    maxTimestampSamples: 5000
};

const SCHEDULE_STAGES = [
    {
        stageIdx: 0,
        key: 'schedule_stage_0',
        label: '提前24小时预热',
        earlyBoundHours: 28,
        lateBoundHours: 12,
        intrinsicScore: 0.45,
        peakOffsetHours: 24,
        sigmaHours: 6
    },
    {
        stageIdx: 1,
        key: 'schedule_stage_1',
        label: '提前2小时冲刺',
        earlyBoundHours: 4,
        lateBoundHours: 0.5,
        intrinsicScore: 0.65,
        peakOffsetHours: 2,
        sigmaHours: 0.9
    },
    {
        stageIdx: 2,
        key: 'schedule_stage_2',
        label: '准点提醒',
        earlyBoundHours: 0.5,
        lateBoundHours: -0.5,
        intrinsicScore: 0.85,
        peakOffsetHours: 0,
        sigmaHours: 0.22
    }
];

const DEFAULT_VPE_CONFIG = {
    tickMinutes: 10,
    dryRun: true,
    embeddingModel: '',
    legacyScheduleTargetUserId: '',
    diaryMap: {}
};

const LEGACY_COMPATIBLE_PRIVATE_DEFAULTS = {
    strategy: 'legacy',
    vpe: DEFAULT_VPE_CONFIG
};

const QUEUE = {
    maxAgeHours: 24,
    agingStepPerHour: 0.05,
    agingMaxMultiplier: 1.5
};

const GC = {
    userRetentionMs: 30 * 24 * HOUR_MS,
    groupRetentionMs: 15 * 24 * HOUR_MS,
    eventRetentionMs: 7 * 24 * HOUR_MS
};

module.exports = {
    AFFINITY_DECAY_LAMBDA,
    BASE_AFFINITY,
    DEFAULT_VPE_CONFIG,
    FATIGUE_DECAY_GAMMA,
    GC,
    GHOSTING_WINDOW_MS,
    GROUP_GATE,
    LEGACY_COMPATIBLE_PRIVATE_DEFAULTS,
    MAX_HISTORY_MESSAGES,
    PRIVATE_GATE,
    QUEUE,
    SCHEDULE_STAGES,
    STATE_SCHEMA_VERSION
};

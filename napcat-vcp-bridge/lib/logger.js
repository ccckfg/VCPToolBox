const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, ...args) {
    if (LOG_LEVELS[level] >= CURRENT_LOG_LEVEL) {
        const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
        const prefix = `[${timestamp}] [${level}]`;
        if (level === 'ERROR') console.error(prefix, ...args);
        else if (level === 'WARN') console.warn(prefix, ...args);
        else console.log(prefix, ...args);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
    LOG_LEVELS,
    CURRENT_LOG_LEVEL,
    log,
    sleep
};

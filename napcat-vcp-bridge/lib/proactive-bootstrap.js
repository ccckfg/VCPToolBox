const { extractText } = require('./message-utils');

function createProactiveBootstrap(options = {}) {
    const affinityManager = options.affinityManager;
    const privateScheduler = options.privateScheduler;
    const privateStrategy = options.privateStrategy || 'legacy';
    const vpeEngine = options.vpeEngine;

    let privateEngineStarted = false;

    function startPrivateProactiveEngine() {
        if (privateEngineStarted) return;
        privateEngineStarted = true;

        const hasGroupVpe = typeof vpeEngine?.getEnabledGroupIds === 'function'
            && vpeEngine.getEnabledGroupIds().length > 0;

        if (privateStrategy === 'vpe') {
            vpeEngine.start();
            return;
        }

        privateScheduler.start();
        if (hasGroupVpe) {
            vpeEngine.start({ groupsOnly: true });
        }
    }

    async function trackPrivateIncoming(event) {
        const rawText = extractText(event.message);
        if (!rawText) return;

        const userId = String(event.user_id);
        const senderName = event.sender?.nickname || event.sender?.card || userId;
        await affinityManager.onMessage(userId, rawText, senderName, { isPrivate: true });

        if (rawText !== '/clear' && rawText !== '清除记忆') {
            affinityManager.recordPrivateHistory(userId, 'user', rawText, Date.now());
        }
    }

    return {
        startPrivateProactiveEngine,
        trackPrivateIncoming
    };
}

module.exports = {
    createProactiveBootstrap
};

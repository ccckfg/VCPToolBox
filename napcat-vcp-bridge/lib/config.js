const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        const { napcat = {}, vcp = {}, bot = {} } = config;
        const proactiveConfig = bot.proactive || {};
        const webhookConfig = bot.webhook || {};
        return {
            config,
            napcatConfig: napcat,
            vcpConfig: vcp,
            botConfig: bot,
            proactiveConfig,
            webhookConfig
        };
    } catch (err) {
        throw new Error(`无法加载配置文件 config.json: ${err.message}`);
    }
}

module.exports = {
    CONFIG_PATH,
    loadConfig
};

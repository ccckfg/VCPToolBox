class PrivateProactiveScheduler {
    constructor(options = {}) {
        this.botConfig = options.botConfig || {};
        this.vcpConfig = options.vcpConfig || {};
        this.contextManager = options.contextManager;
        this.affinityManager = options.affinityManager;
        this.vcpClient = options.vcpClient;
        this.callOneBot = options.callOneBot;
        this.truncateReply = options.truncateReply;
        this.sleep = options.sleep;
        this.log = options.log || (() => { });
        this._timer = null;
        this._inProgress = false;
    }

    start() {
        const privateConfig = this.botConfig.proactive?.private;
        if (!privateConfig?.enable) {
            this.log('INFO', '[主动私聊] 未启用');
            return;
        }

        const intervalMs = (privateConfig.checkIntervalMinutes || 30) * 60 * 1000;
        this._timer = setInterval(() => {
            this._check().catch((err) => {
                this.log('ERROR', '[主动私聊] 调度器错误:', err.message);
            });
        }, intervalMs);
        if (this._timer.unref) this._timer.unref();

        this.log(
            'INFO',
            `[主动私聊] ⏰ 调度器已启动。每 ${privateConfig.checkIntervalMinutes || 30} 分钟检查，` +
            `时间窗口 ${privateConfig.timeWindowStart || 8}:00-${privateConfig.timeWindowEnd || 22}:00，` +
            `白名单: [${(privateConfig.whitelist || []).join(', ')}]`
        );
    }

    async _check() {
        if (this._inProgress) return;
        const privateConfig = this.botConfig.proactive?.private;
        if (!privateConfig?.enable) return;

        const now = new Date();
        const currentHour = now.getHours();
        const windowStart = privateConfig.timeWindowStart ?? 8;
        const windowEnd = privateConfig.timeWindowEnd ?? 22;

        let inWindow = false;
        if (windowStart <= windowEnd) {
            inWindow = currentHour >= windowStart && currentHour < windowEnd;
        } else {
            inWindow = currentHour >= windowStart || currentHour < windowEnd;
        }

        if (!inWindow) {
            this.log('DEBUG', `[主动私聊] 不在时间窗口 (当前: ${currentHour}:00，窗口: ${windowStart}:00-${windowEnd}:00)`);
            return;
        }

        const whitelist = privateConfig.whitelist || [];
        if (whitelist.length === 0) {
            this.log('DEBUG', '[主动私聊] 白名单为空，跳过');
            return;
        }

        const cooldownMs = (privateConfig.cooldownHours || 4) * 60 * 60 * 1000;
        const maxDaily = privateConfig.maxDailyMessages || 2;
        const nowMs = Date.now();

        this._inProgress = true;
        try {
            for (const uid of whitelist) {
                const userId = String(uid);
                const user = this.affinityManager._getOrCreate(userId);

                if (user.affinity < 20) {
                    this.log('DEBUG', `[主动私聊] ${user.nickname || userId} 亲和度过低 (${user.affinity.toFixed(1)})，跳过`);
                    continue;
                }

                const lastContact = Math.max(user.lastProactiveTime, user.lastMessageTime);
                if (nowMs - lastContact < cooldownMs) {
                    this.log('DEBUG', `[主动私聊] ${user.nickname || userId} 冷却中，跳过`);
                    continue;
                }

                if (!this.affinityManager.canProactiveToday(userId, maxDaily)) {
                    this.log('DEBUG', `[主动私聊] ${user.nickname || userId} 已达今日上限，跳过`);
                    continue;
                }

                const probability = this.affinityManager.getProactiveProbability(userId);
                const roll = Math.random();
                if (roll >= probability) {
                    this.log('DEBUG', `[主动私聊] ${user.nickname || userId} 掷骰子未命中 (${roll.toFixed(3)} >= ${probability})`);
                    continue;
                }

                this.log('INFO', `[主动私聊] ${user.nickname || userId} 掷骰子命中! 生成问候...`);

                const contextKey = `u${userId}`;
                const history = this.contextManager.getMessages(contextKey);
                const systemPrompt = privateConfig.systemPrompt || this.vcpConfig.systemPrompt;
                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...history.slice(-4),
                    {
                        role: 'user',
                        content: `[系统指令] 你想主动找用户${user.nickname || '对方'}聊天。请自然地发起一个话题或问候，不要提及"系统指令"这个词。`
                    }
                ];

                try {
                    let segIdx = 0;
                    await this.vcpClient.callVCPStreaming(messages, async (segment) => {
                        const truncated = this.truncateReply(segment);
                        if (segIdx > 0) await this.sleep(500);
                        await this.callOneBot('send_private_msg', {
                            user_id: Number(userId),
                            message: [{ type: 'text', data: { text: truncated } }]
                        });
                        segIdx++;
                    });

                    this.affinityManager.markProactive(userId);
                    this.log('INFO', `[主动私聊] ✅ 已主动发消息给 ${user.nickname || userId}（亲和度: ${user.affinity.toFixed(1)}）`);
                } catch (err) {
                    this.log('ERROR', `[主动私聊] 发送给 ${userId} 失败:`, err.message);
                }

                await this.sleep(10000);
            }
        } finally {
            this._inProgress = false;
        }
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }
}

module.exports = {
    PrivateProactiveScheduler
};

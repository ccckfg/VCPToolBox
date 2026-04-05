const { AgingQueue } = require('./aging-queue');
const { EventFsm } = require('./event-fsm');
const { EventSensor } = require('./event-sensor');
const { GroupGate } = require('./gate-group');
const { PrivateGate } = require('./gate-private');
const { PromptBuilder } = require('./prompt-builder');
const { TimeLens } = require('./time-lens');
const { FATIGUE_DECAY_GAMMA } = require('./constants');
const { clamp, cosineSimilarity } = require('./utils');

class VpeEngine {
    constructor(options = {}) {
        this.botConfig = options.botConfig || {};
        this.proactiveConfig = options.proactiveConfig || {};
        this.privateConfig = options.privateConfig || {};
        this.vpeConfig = options.vpeConfig || {};
        this.vcpConfig = options.vcpConfig || {};
        this.projectRoot = options.projectRoot;
        this.friendBook = options.friendBook;
        this.affinityManager = options.affinityManager;
        this.stateStore = options.stateStore;
        this.vcpClient = options.vcpClient;
        this.groupBuffer = options.groupBuffer || null;
        this.log = options.log || (() => {});
        this.sleep = options.sleep || (async () => {});
        this.sendPrivateMessage = options.sendPrivateMessage;
        this.sendGroupMessage = options.sendGroupMessage;
        this.truncateReply = options.truncateReply || ((text) => text);
        this.embeddingModel = this.vpeConfig.embeddingModel || '';

        this.sensor = new EventSensor({
            projectRoot: this.projectRoot,
            friendBook: this.friendBook,
            privateConfig: this.privateConfig,
            publicConfig: this.proactiveConfig,
            sensorConfig: this.proactiveConfig?.vpe || {},
            log: this.log
        });
        this.eventFsm = new EventFsm({
            stateStore: this.stateStore,
            log: this.log
        });
        this.timeLens = new TimeLens();
        this.agingQueue = new AgingQueue({
            stateStore: this.stateStore,
            log: this.log
        });
        this.privateGate = new PrivateGate({
            log: this.log
        });
        this.groupGate = new GroupGate({
            log: this.log
        });
        this.promptBuilder = new PromptBuilder();

        this._timer = null;
        this._inProgress = false;
        this._groupsOnly = false;
    }

    start(options = {}) {
        this._groupsOnly = options.groupsOnly === true;
        const privateEnabled = !!this.privateConfig?.enable && !this._groupsOnly;
        const groupEnabled = this.getEnabledGroupIds().length > 0;
        if (!privateEnabled && !groupEnabled) {
            this.log('INFO', '[VPE] 私聊与群聊主动发言均未启用');
            return;
        }

        const tickMinutes = Number(this.vpeConfig.tickMinutes) || 10;
        this._timer = setInterval(() => {
            this.tick('interval').catch((error) => {
                this.log('ERROR', `[VPE] 周期执行失败: ${error.message}`);
            });
        }, tickMinutes * 60 * 1000);
        if (this._timer.unref) this._timer.unref();

        this.log(
            'INFO',
            `[VPE] 已启动主动引擎，周期 ${tickMinutes} 分钟，private=${privateEnabled} group=${groupEnabled} dryRun=${this.isDryRun()}`
        );
        this.tick('startup').catch((error) => {
            this.log('ERROR', `[VPE] 启动首轮执行失败: ${error.message}`);
        });
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    isDryRun() {
        return this.vpeConfig.dryRun !== false;
    }

    getEnabledGroupIds() {
        const groups = this.proactiveConfig?.vpe?.groups;
        if (!Array.isArray(groups)) return [];
        return groups.map((groupId) => String(groupId)).filter(Boolean);
    }

    isInTimeWindow(date = new Date()) {
        const start = this.privateConfig.timeWindowStart ?? 8;
        const end = this.privateConfig.timeWindowEnd ?? 24;
        const hour = date.getHours();

        if (start <= end) {
            return hour >= start && hour < end;
        }
        return hour >= start || hour < end;
    }

    getDecayedFatigue(state, now = Date.now()) {
        if (!state?.lastProactiveMs || !state?.fatigue) return 0;
        const deltaHours = Math.max(0, (now - state.lastProactiveMs) / (60 * 60 * 1000));
        return state.fatigue * Math.exp(-FATIGUE_DECAY_GAMMA * deltaHours);
    }

    recordGroupMessage(groupId, senderName, text, timestamp = Date.now()) {
        if (!groupId) return;
        const recentMsgCount = this.groupBuffer?.getRecentMsgCount(groupId) || 0;
        this.stateStore.updateGroup(groupId, (group) => {
            group.lastMsgMs = timestamp;
            group.recentMsgCount = recentMsgCount;
        });
        this.log('DEBUG', `[VPE] 更新群状态 group=${groupId} sender=${senderName} recentMsgCount=${recentMsgCount}`);
    }

    async tick(reason = 'manual') {
        if (this._inProgress) return;
        this._inProgress = true;

        try {
            const now = Date.now();
            this.log('DEBUG', `[VPE] Tick 开始: ${reason}`);

            this.affinityManager.sweepGhostingPenalties(now);
            this.stateStore.maybeRunGc(now);

            const rawEvents = await this.sensor.collectEventsAsync();
            this.log('DEBUG', `[VPE] 感知到 ${rawEvents.length} 条原始事件`);

            const stageEvents = this.eventFsm.scan(rawEvents, now);
            for (const candidate of stageEvents) {
                const semanticScore = candidate.scope === 'private'
                    ? await this.calculateSemanticScore(candidate)
                    : 0;
                const scoreInfo = this.timeLens.calcFinalScore(candidate, semanticScore, now);
                this.agingQueue.upsert({
                    ...candidate,
                    ...scoreInfo
                });
            }

            const nowDate = new Date(now);
            if (!this._groupsOnly && this.privateConfig?.enable && this.isInTimeWindow(nowDate)) {
                await this.handlePrivateProactive(now, nowDate);
            } else if (!this._groupsOnly && this.privateConfig?.enable) {
                this.log('DEBUG', '[VPE] 当前不在私聊主动时间窗口，跳过私聊发送仲裁');
            }

            const groupIds = this.getEnabledGroupIds();
            for (const groupId of groupIds) {
                await this.handleGroupProactive(groupId, now);
            }
        } finally {
            this._inProgress = false;
        }
    }

    async handlePrivateProactive(now, nowDate) {
        const whitelist = (this.privateConfig.whitelist || []).map(String);
        for (const userId of whitelist) {
            const userState = this.affinityManager.getUserState(userId);
            const maxDaily = Number(this.privateConfig.maxDailyMessages) || 2;
            if (!this.affinityManager.canProactiveToday(userId, maxDaily, now)) {
                this.log('DEBUG', `[VPE] 用户 ${userId} 已达到当日主动上限`);
                continue;
            }

            const fatigueNow = this.affinityManager.getDecayedFatigue(userState, now);
            const rankedCandidates = this.agingQueue.getCandidatesForUser(userId, now);
            if (!rankedCandidates.length) {
                continue;
            }

            const leadCategory = rankedCandidates[0]?.category || 'schedule';
            const threshold = this.privateGate.calcThreshold(userState, leadCategory, fatigueNow, nowDate);
            const { selected, topScore } = this.agingQueue.chooseForUser(userId, threshold, now, rankedCandidates);

            if (!selected.length) {
                if (topScore > 0) {
                    this.log('DEBUG', `[VPE] 用户 ${userId} 顶部分数 ${topScore.toFixed(3)} 未突破阈值 ${threshold.toFixed(3)}`);
                }
                continue;
            }

            await this.handleSelectedEvents(userId, selected, threshold, topScore || selected[0].urgencyScore);
        }
    }

    async calculateSemanticScore(candidate) {
        if (!candidate?.targetUserId || !this.embeddingModel) return 0;

        const diaryName = this.vpeConfig?.diaryMap?.[String(candidate.targetUserId)] || '';
        const remoteScore = await this.vcpClient.getSemanticScore(candidate.text, candidate.targetUserId, diaryName);
        if (remoteScore !== null) {
            return clamp(remoteScore, 0, 1);
        }

        return this.calculateLocalSemanticScore(candidate);
    }

    async calculateLocalSemanticScore(candidate) {
        if (!this.embeddingModel) return 0;

        const history = this.affinityManager
            .getPrivateHistory(candidate.targetUserId, 6)
            .map((item) => item.content)
            .filter(Boolean);

        if (!history.length) return 0;

        try {
            const eventEmbedding = await this.vcpClient.getEmbedding(candidate.text, this.embeddingModel);
            const historyEmbeddings = await this.vcpClient.getEmbeddings(history, this.embeddingModel);
            if (!Array.isArray(eventEmbedding) || !eventEmbedding.length || !Array.isArray(historyEmbeddings) || !historyEmbeddings.length) {
                return 0;
            }

            const similarities = historyEmbeddings
                .filter((historyEmbedding) => Array.isArray(historyEmbedding) && historyEmbedding.length)
                .map((historyEmbedding) => clamp(cosineSimilarity(eventEmbedding, historyEmbedding), 0, 1))
                .sort((a, b) => b - a);

            const top1 = similarities[0] || 0;
            const top2 = similarities[1] || 0;
            return clamp(top1 + (0.2 * top2), 0, 1);
        } catch (error) {
            this.log('WARN', `[VPE] 本地语义分计算失败，已回退为固有分: ${error.message}`);
            return 0;
        }
    }

    async calculateGroupSemanticScore(candidate, contextText, now = Date.now()) {
        let semanticScore = 0;
        if (this.embeddingModel && contextText) {
            try {
                const contextEmbedding = await this.vcpClient.getEmbedding(contextText, this.embeddingModel);
                const eventEmbedding = await this.vcpClient.getEmbedding(candidate.text, this.embeddingModel);
                if (Array.isArray(contextEmbedding) && contextEmbedding.length && Array.isArray(eventEmbedding) && eventEmbedding.length) {
                    semanticScore = clamp(cosineSimilarity(eventEmbedding, contextEmbedding), 0, 1);
                }
            } catch (error) {
                this.log('WARN', `[VPE] 群聊语义分计算失败，已回退为固有分: ${error.message}`);
            }
        }

        const timeWeight = Number(candidate.timeWeight) || this.timeLens.calcFinalScore(candidate, 0, now).timeWeight;
        const intrinsicScore = Number(candidate.intrinsicScore) || 0;
        const finalScore = Math.max(intrinsicScore, semanticScore) * timeWeight;
        return {
            ...candidate,
            semanticScore,
            timeWeight,
            finalScore,
            urgencyScore: finalScore * (candidate.agingMultiplier || 1)
        };
    }

    async fetchReverseMemory(userId, eventText) {
        try {
            const diaryName = this.vpeConfig?.diaryMap?.[String(userId)] || '';
            const result = await this.vcpClient.checkRelevanceWithOptions(eventText, {
                threshold: 0,
                k: 1,
                tagBoost: 0,
                diaryName
            });
            const topScore = Number(result?.score) || 0;
            const preview = result?.topResults?.[0]?.preview?.trim() || '';
            if (topScore < 0.65 || !preview) return '';
            return preview;
        } catch (error) {
            this.log('WARN', `[VPE] 倒置RAG 检索失败: ${error.message}`);
            return '';
        }
    }

    async handleSelectedEvents(userId, selected, threshold, topScore) {
        const userState = this.affinityManager.getUserState(userId);
        const memoryPreview = await this.fetchReverseMemory(userId, selected.map((item) => item.text).join('\n'));
        const history = this.affinityManager.getPrivateHistory(userId, 4).map((item) => ({
            role: item.role,
            content: item.content
        }));
        const prompt = this.promptBuilder.build({
            systemPrompt: this.vcpConfig.systemPrompt,
            history,
            events: selected,
            memoryPreview,
            affinity: userState.affinity
        });

        this.log(
            'INFO',
            `[VPE] 准备主动发言 user=${userId} score=${topScore.toFixed(3)} threshold=${threshold.toFixed(3)} events=${selected.map((item) => item.queueKey).join(', ')} dryRun=${this.isDryRun()}`
        );

        if (this.isDryRun()) {
            this.log('DEBUG', `[VPE] DryRun Prompt 预览: ${JSON.stringify(prompt.slice(-2), null, 2)}`);
            return;
        }

        let segmentIndex = 0;
        const visibleSegments = [];
        const fullReply = await this.vcpClient.callVCPStreaming(prompt, async (segment) => {
            const truncated = this.truncateReply(segment);
            visibleSegments.push(truncated);
            if (segmentIndex > 0) {
                await this.sleep(500);
            }
            await this.sendPrivateMessage(userId, truncated);
            segmentIndex += 1;
        });

        if (!fullReply) {
            throw new Error('主动发言生成内容为空');
        }

        this.affinityManager.onProactiveSent(userId, selected[0]?.category || 'schedule');
        this.affinityManager.recordPrivateHistory(
            userId,
            'assistant',
            visibleSegments.length > 0 ? visibleSegments.join('\n') : fullReply,
            Date.now()
        );
        this.agingQueue.markDelivered(selected);
        selected.forEach((item) => this.eventFsm.markTriggered(item));
        this.log('INFO', `[VPE] 已向 ${userState.nickname || userId} 主动发言`);
        await this.sleep(1000);
    }

    async handleGroupProactive(groupId, now = Date.now()) {
        if (!this.sendGroupMessage || !this.groupBuffer) return;

        const contextText = this.groupBuffer.getContextText(groupId, 20);
        if (!contextText) return;

        const groupState = this.stateStore.getGroup(groupId);
        groupState.recentMsgCount = this.groupBuffer.getRecentMsgCount(groupId);
        const fatigueNow = this.getDecayedFatigue(groupState, now);
        const threshold = this.groupGate.calcThreshold(groupState, fatigueNow);
        const baseCandidates = this.agingQueue.getCandidatesForGroup(groupId, now);
        if (!baseCandidates.length) return;

        const rankedCandidates = [];
        for (const candidate of baseCandidates) {
            rankedCandidates.push(await this.calculateGroupSemanticScore(candidate, contextText, now));
        }
        rankedCandidates.sort((a, b) => b.urgencyScore - a.urgencyScore);

        const { selected, topScore } = this.agingQueue.chooseForUser(groupId, threshold, now, rankedCandidates);
        if (!selected.length) {
            if (topScore > 0) {
                this.log('DEBUG', `[VPE] 群 ${groupId} 顶部分数 ${topScore.toFixed(3)} 未突破阈值 ${threshold.toFixed(3)}`);
            }
            return;
        }

        const prompt = this.promptBuilder.buildGroup({
            systemPrompt: this.proactiveConfig.systemPrompt || this.vcpConfig.systemPrompt,
            contextText,
            events: selected
        });

        this.log(
            'INFO',
            `[VPE] 群聊主动仲裁 group=${groupId} score=${(topScore || selected[0].urgencyScore).toFixed(3)} threshold=${threshold.toFixed(3)} events=${selected.map((item) => item.queueKey).join(', ')} dryRun=${this.isDryRun()}`
        );

        if (this.isDryRun()) {
            this.log('DEBUG', `[VPE] Group DryRun Prompt 预览: ${JSON.stringify(prompt, null, 2)}`);
            return;
        }

        let segmentIndex = 0;
        const fullReply = await this.vcpClient.callVCPStreaming(prompt, async (segment) => {
            const truncated = this.truncateReply(segment);
            if (!truncated) return;
            if (segmentIndex > 0) {
                await this.sleep(500);
            }
            await this.sendGroupMessage(groupId, truncated);
            segmentIndex += 1;
        });

        if (!fullReply) {
            throw new Error('群聊主动发言生成内容为空');
        }

        this.stateStore.updateGroup(groupId, (group) => {
            const currentFatigue = this.getDecayedFatigue(group, now);
            const leadCategory = selected[0]?.category || 'public';
            group.fatigue = currentFatigue + 0.30;
            group.lastProactiveMs = now;
            group.recentMsgCount = this.groupBuffer.getRecentMsgCount(groupId);
            group.ucb = group.ucb || { total: 0, cats: {} };
            group.ucb.total = Number(group.ucb.total) + 1;
            group.ucb.cats = group.ucb.cats || {};
            group.ucb.cats[leadCategory] = Number(group.ucb.cats[leadCategory] || 0) + 1;
        });
        this.groupBuffer.markSpoken(groupId);
        this.agingQueue.markDelivered(selected);
        selected.forEach((item) => this.eventFsm.markTriggered(item, now));
        this.log('INFO', `[VPE] 已在群 ${groupId} 主动发言`);
        await this.sleep(1000);
    }
}

module.exports = {
    VpeEngine
};

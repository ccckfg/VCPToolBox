/**
 * SemanticQueryGate — 白皮书附录B VPE 语义网关
 *
 * 设计原则：不重新发明轮子。
 * VCP 的 RAGDiaryPlugin 已内置完整的语义组系统（SemanticGroupManager），
 * 包含用户定义的词元组、预计算的组向量、关键词激活检测和自学习更新。
 *
 * 本插件只做一件事：将 SemanticGroupManager 的能力通过 HTTP API 暴露给
 * 外部的 VPE Bridge，使 Bridge 可以获取事件文本与用户语义组的匹配分数。
 *
 * 数据流：
 *   Bridge POST /match { event_text }
 *     → 向量化 event_text
 *     → 与 SemanticGroupManager 中所有预计算组向量求余弦
 *     → 返回 { scores: [{group, score}...], semantic_score }
 *
 * ⚠️ 已知限制：
 * 语义组是全局的（由管理面板统一管理），不按用户/日记本分组。
 * 不同用户对同一事件会得到相同的语义分。如需按用户个性化，
 * 需扩展 SemanticGroupManager 本身支持 per-diary 语义组。
 */

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}

class SemanticQueryGate {
    constructor() {
        this.name = 'SemanticQueryGate';
        this.token = '';
        /** @type {import('../RAGDiaryPlugin/SemanticGroupManager')|null} */
        this.semanticGroupManager = null;
        this.getSingleEmbedding = null;
    }

    /**
     * @param {object} config - 插件配置
     * @param {object} dependencies - VCP 注入的依赖
     *   - dependencies.ragPlugin: RAGDiaryPlugin 实例（持有 semanticGroups）
     *   - dependencies.getSingleEmbedding: 向量化函数
     */
    initialize(config, dependencies) {
        this.token = config.SEMANTIC_QUERY_GATE_TOKEN || process.env.SEMANTIC_QUERY_GATE_TOKEN || '';
        this.getSingleEmbedding = dependencies.getSingleEmbedding || null;

        // 核心：获取 RAGDiaryPlugin 的 SemanticGroupManager 实例
        const ragPlugin = dependencies.ragPlugin || null;
        this.semanticGroupManager = ragPlugin?.semanticGroups || null;

        if (!this.semanticGroupManager) {
            console.warn('[SemanticQueryGate] 未获取到 RAGDiaryPlugin.semanticGroups，语义组匹配将不可用。');
            console.warn('[SemanticQueryGate] 请确保 RAGDiaryPlugin 已加载，且依赖注入包含 ragPlugin。');
        }
        if (!this.getSingleEmbedding) {
            console.warn('[SemanticQueryGate] 未获取到 getSingleEmbedding，向量化将不可用。');
        }

        const groupCount = this.semanticGroupManager
            ? Object.keys(this.semanticGroupManager.groups || {}).length
            : 0;
        console.log(`[SemanticQueryGate] 初始化完成，语义组数=${groupCount}，向量化=${!!this.getSingleEmbedding}`);
    }

    registerApiRoutes(router) {
        const auth = (req, res, next) => {
            if (!this.token) return next();
            const header = req.headers['authorization'];
            const provided = header?.startsWith('Bearer ') ? header.slice(7) : req.query?.token;
            return provided === this.token ? next() : res.status(401).json({ error: 'Unauthorized' });
        };

        router.post('/match', auth, async (req, res) => {
            try {
                if (!this.getSingleEmbedding) {
                    return res.status(503).json({ error: '向量化函数未注入' });
                }
                const { event_text, user_id = '' } = req.body || {};
                if (!event_text?.trim()) {
                    return res.status(400).json({ error: '缺少 event_text 参数' });
                }
                const result = await this._match(event_text.trim(), String(user_id));
                return res.json(result);
            } catch (err) {
                const status = err.statusCode || 500;
                console.error(`[SemanticQueryGate] match 失败 (${status}):`, err.message);
                return res.status(status).json({ error: err.message, hint: err.hint || undefined });
            }
        });

        router.get('/health', (req, res) => {
            const sgm = this.semanticGroupManager;
            const groupNames = sgm ? Object.keys(sgm.groups || {}) : [];
            const cachedCount = sgm ? sgm.groupVectorCache.size : 0;
            res.json({
                status: 'ok',
                embeddingReady: !!this.getSingleEmbedding,
                semanticGroupsReady: !!sgm,
                groupCount: groupNames.length,
                cachedVectorCount: cachedCount,
                groupNames
            });
        });

        console.log('[SemanticQueryGate] 路由已注册: POST /match, GET /health');
    }

    /**
     * 核心匹配逻辑：
     * 1. 向量化事件文本
     * 2. 获取 SemanticGroupManager 中所有已预计算的组向量
     * 3. 逐组计算余弦相似度
     * 4. 降序排列，Soft-Maximum 聚合 S_sem = S_1st + 0.2 × S_2nd
     */
    async _match(eventText, userId) {
        const eventVector = await this.getSingleEmbedding(eventText);
        if (!eventVector) {
            throw new Error('事件文本向量化失败');
        }

        // 如果 SemanticGroupManager 不可用或无组，抛出错误让路由层返回 503
        // 这会让 Bridge 走本地 Soft-Maximum fallback，而非拿到 score=0 短路
        const sgm = this.semanticGroupManager;
        if (!sgm || !sgm.groupVectorCache || sgm.groupVectorCache.size === 0) {
            const err = new Error('语义组未就绪');
            err.statusCode = 503;
            err.hint = '语义组为空或缓存未构建，请通过管理面板的"语义组编辑器"添加词元组';
            throw err;
        }

        // 计算事件向量与每个组向量的余弦相似度
        const scored = [];
        for (const [groupName, groupVector] of sgm.groupVectorCache) {
            const sim = cosineSimilarity(eventVector, groupVector);
            const groupData = sgm.groups[groupName] || {};
            scored.push({
                group: groupName,
                score: Math.max(0, sim),
                weight: groupData.weight || 1.0,
                wordCount: (groupData.words?.length || 0) + (groupData.auto_learned?.length || 0)
            });
        }

        scored.sort((a, b) => b.score - a.score);

        // Soft-Maximum 聚合（白皮书公式）
        const top1 = scored[0]?.score || 0;
        const top2 = scored[1]?.score || 0;
        const semanticScore = Math.min(1, top1 + 0.2 * top2);

        // 只读关键词匹配（不调用 detectAndActivateGroups 以避免污染激活统计）
        const keywordHits = [];
        for (const [groupName, groupData] of Object.entries(sgm.groups)) {
            const allWords = [...(groupData.words || []), ...(groupData.auto_learned || [])];
            const matched = allWords.filter(w => eventText.toLowerCase().includes(w.toLowerCase()));
            if (matched.length > 0) keywordHits.push(groupName);
        }

        return {
            user_id: userId,
            scores: scored.slice(0, 6).map(s => ({
                group: s.group,
                score: Math.round(s.score * 10000) / 10000,
                weight: s.weight
            })),
            semantic_score: Math.round(semanticScore * 10000) / 10000,
            keyword_activated: keywordHits,
            source: 'semantic_group_manager'
        };
    }
}

module.exports = new SemanticQueryGate();

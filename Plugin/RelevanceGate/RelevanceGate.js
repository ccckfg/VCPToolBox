/**
 * RelevanceGate - VCP 相关度网关插件
 *
 * 暴露 /api/plugins/RelevanceGate/check 端点，
 * 利用 VCP 已有的 TagMemo / RAG 向量系统判断文本与知识库的相关度。
 *
 * 典型用途：QQ Bridge 旁听群消息时调用此接口，决定是否主动发言。
 */

class RelevanceGate {
    constructor() {
        this.name = 'RelevanceGate';
        this.vectorDBManager = null;   // KnowledgeBaseManager 实例
        this.getSingleEmbedding = null; // Embedding 函数
        this.token = '';                // 可选的认证令牌
    }

    /**
     * 由 Plugin.js 调用初始化
     */
    initialize(config, dependencies) {
        this.token = config.RELEVANCE_TOKEN || process.env.RELEVANCE_TOKEN || '';

        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
        }
        if (dependencies.getSingleEmbedding) {
            this.getSingleEmbedding = dependencies.getSingleEmbedding;
        }

        if (!this.vectorDBManager || !this.getSingleEmbedding) {
            console.warn('[RelevanceGate] ⚠️ vectorDBManager 或 getSingleEmbedding 未注入，相关度检查将不可用。');
        } else {
            console.log('[RelevanceGate] ✅ 插件初始化完成。');
        }
    }

    /**
     * 注册 API 路由（新式，由 Plugin.js initializeServices 调用）
     * 挂载到 /api/plugins/RelevanceGate/
     */
    registerApiRoutes(router, pluginConfig, projectBasePath, webSocketServer) {
        // 认证中间件
        const authMiddleware = (req, res, next) => {
            if (!this.token) return next(); // 未配置 token 则跳过认证
            const authHeader = req.headers['authorization'];
            const providedToken = authHeader?.startsWith('Bearer ')
                ? authHeader.slice(7)
                : req.query?.token;
            if (providedToken === this.token) return next();
            return res.status(401).json({ error: 'Unauthorized' });
        };

        /**
         * POST /api/plugins/RelevanceGate/check
         *
         * Body: {
         *   "text": "要判定的文本",
         *   "threshold": 0.45,          // 可选，相关度阈值（默认 0.45）
         *   "k": 3,                     // 可选，搜索返回的 top-k 数量（默认 3）
         *   "tag_boost": 0.5,           // 可选，TagMemo 增强因子（默认 0.5）
         *   "diary_name": ""            // 可选，指定搜索的日记本名称
         * }
         *
         * Response: {
         *   "relevant": true/false,
         *   "score": 0.72,
         *   "threshold": 0.45,
         *   "topResults": [
         *     { "score": 0.72, "preview": "..." },
         *     ...
         *   ],
         *   "tagBoostInfo": { ... }
         * }
         */
        router.post('/check', authMiddleware, async (req, res) => {
            try {
                if (!this.vectorDBManager || !this.getSingleEmbedding) {
                    return res.status(503).json({
                        error: 'RAG 系统未就绪。请确保 RAGDiaryPlugin 已加载。'
                    });
                }

                const {
                    text,
                    threshold = 0.45,
                    k = 3,
                    tag_boost = 0.5,
                    diary_name = ''
                } = req.body;

                if (!text || typeof text !== 'string' || text.trim().length === 0) {
                    return res.status(400).json({ error: '缺少 text 参数或内容为空' });
                }

                const result = await this._checkRelevance(text.trim(), {
                    threshold,
                    k,
                    tagBoost: tag_boost,
                    diaryName: diary_name
                });

                return res.json(result);
            } catch (err) {
                console.error('[RelevanceGate] check 失败:', err);
                return res.status(500).json({ error: err.message });
            }
        });

        /**
         * GET /api/plugins/RelevanceGate/health
         * 健康检查端点
         */
        router.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                ragReady: !!(this.vectorDBManager && this.getSingleEmbedding)
            });
        });

        console.log('[RelevanceGate] API 路由已注册: POST /check, GET /health');
    }

    /**
     * 核心相关度检查逻辑
     */
    async _checkRelevance(text, options) {
        const { threshold, k, tagBoost, diaryName } = options;

        // 1. 获取文本的 Embedding 向量
        let queryVector = await this.getSingleEmbedding(text);
        if (!queryVector) {
            throw new Error('文本向量化失败');
        }

        // 2. （可选）应用 TagMemo 增强
        let tagBoostInfo = null;
        if (tagBoost > 0 && typeof this.vectorDBManager.applyTagBoost === 'function') {
            const boostResult = this.vectorDBManager.applyTagBoost(
                new Float32Array(queryVector),
                tagBoost,
                [],   // core_tags
                1.33  // core_boost_factor
            );
            if (boostResult && boostResult.vector) {
                queryVector = boostResult.vector;
                tagBoostInfo = boostResult.info || null;
            }
        }

        // 3. 在向量索引中搜索最相似的 chunks
        const searchResults = await this._searchIndex(queryVector, k, diaryName);

        // 4. 计算最高相关度得分
        const topScore = searchResults.length > 0 ? searchResults[0].score : 0;

        return {
            relevant: topScore >= threshold,
            score: Math.round(topScore * 10000) / 10000,
            threshold,
            topResults: searchResults.map(r => ({
                score: Math.round(r.score * 10000) / 10000,
                preview: r.content?.substring(0, 150)?.trim() || '',
                diaryName: r.diaryName || ''
            })),
            tagBoostInfo: tagBoostInfo ? {
                matchedTags: tagBoostInfo.matchedTags || [],
                coreTagsMatched: tagBoostInfo.coreTagsMatched || []
            } : null
        };
    }

    /**
     * 在向量索引中搜索
     */
    async _searchIndex(queryVector, k, diaryName) {
        const db = this.vectorDBManager.db;
        if (!db) return [];

        const dim = this.vectorDBManager.config?.dimension;
        if (!dim) return [];

        // 将 queryVector 转为 Buffer 用于索引搜索
        const queryFloat32 = queryVector instanceof Float32Array
            ? queryVector
            : new Float32Array(queryVector);
        const queryBuffer = Buffer.from(queryFloat32.buffer);

        const results = [];

        if (diaryName) {
            // 搜索指定日记本
            const idx = await this.vectorDBManager._getOrLoadDiaryIndex(diaryName);
            if (idx) {
                const searchResults = idx.search(queryBuffer, k);
                if (searchResults) {
                    for (const sr of searchResults) {
                        const chunk = db.prepare('SELECT content FROM chunks WHERE id = ?').get(sr.label);
                        results.push({
                            score: sr.score || 0,
                            content: chunk?.content || '',
                            diaryName
                        });
                    }
                }
            }
        } else {
            // 搜索所有已加载的日记本索引
            for (const [dName, idx] of this.vectorDBManager.diaryIndices) {
                try {
                    const searchResults = idx.search(queryBuffer, k);
                    if (searchResults) {
                        for (const sr of searchResults) {
                            const chunk = db.prepare('SELECT content FROM chunks WHERE id = ?').get(sr.label);
                            results.push({
                                score: sr.score || 0,
                                content: chunk?.content || '',
                                diaryName: dName
                            });
                        }
                    }
                } catch (err) {
                    // 某个索引搜索失败不影响其他
                    continue;
                }
            }

            // 按分数排序并截取 top-k
            results.sort((a, b) => b.score - a.score);
            results.splice(k);
        }

        return results;
    }
}

module.exports = new RelevanceGate();

const fs = require('fs');
const path = require('path');

const { clamp } = require('./vpe/utils');
const {
    averageVectors,
    dotProduct,
    normalize,
    subtractVectors
} = require('./vpe/utils');

class SentimentAnalyzer {
    constructor(options = {}) {
        this.vcpClient = options.vcpClient || null;
        this.embeddingModel = options.embeddingModel || '';
        this.anchorsPath = options.anchorsPath || path.join(__dirname, '..', 'data', 'emotion_anchors.json');
        this.log = options.log || (() => {});
        this.mode = 'lexicon';
        this.vectorState = null;
        this.initialized = false;

        this.positiveWords = [
            '谢谢', '感谢', '哈哈', '不错', '厉害', '有趣', '好的', '可以',
            '太好了', '棒', '赞', '牛', '喜欢', '开心', '😄', '😊', '❤️',
            '👍', '🎉', '嗯嗯', '确实', '学到了', '帮大忙', '辛苦了',
            '真棒', '优秀', '完美', '好厉害', '没问题'
        ];
        this.negativeWords = [
            '闭嘴', '滚', '无聊', '烦', '别说了', '垃圾', '讨厌', '废物',
            '没用', '差劲', '傻', '笨', '蠢', '恶心', '滚蛋', '去死',
            '白痴', '弱智', '屏蔽', '拉黑', '再见', '不想聊', '吵死了',
            '闭嘴吧', '能不能安静', '别烦我'
        ];
    }

    async initialize() {
        if (this.initialized) return;
        this.initialized = true;

        if (!this.vcpClient || !this.embeddingModel) {
            this.log('INFO', '[情绪] 未配置 embeddings，维持词典模式');
            return;
        }

        try {
            const anchors = this._loadAnchors();
            const valenceEmbeddings = await this.vcpClient.getEmbeddings(
                [...anchors.valence.positive, ...anchors.valence.negative],
                this.embeddingModel
            );
            const arousalEmbeddings = await this.vcpClient.getEmbeddings(
                [...anchors.arousal.high, ...anchors.arousal.low],
                this.embeddingModel
            );
            const neutralEmbeddings = await this.vcpClient.getEmbeddings(
                anchors.neutral,
                this.embeddingModel
            );

            const posVectors = valenceEmbeddings.slice(0, anchors.valence.positive.length);
            const negVectors = valenceEmbeddings.slice(anchors.valence.positive.length);
            const highVectors = arousalEmbeddings.slice(0, anchors.arousal.high.length);
            const lowVectors = arousalEmbeddings.slice(anchors.arousal.high.length);

            const valenceAxis = normalize(
                subtractVectors(averageVectors(posVectors), averageVectors(negVectors))
            );
            let arousalAxis = normalize(
                subtractVectors(averageVectors(highVectors), averageVectors(lowVectors))
            );
            const neutralCentroid = averageVectors(neutralEmbeddings);

            const overlap = dotProduct(arousalAxis, valenceAxis);
            arousalAxis = normalize(
                arousalAxis.map((value, index) => value - overlap * (valenceAxis[index] || 0))
            );

            this.vectorState = {
                neutralCentroid,
                valenceAxis,
                arousalAxis
            };
            this.mode = 'vector';
            this.log('INFO', '[情绪] 已启用差分质心向量模式');
        } catch (error) {
            this.mode = 'lexicon';
            this.vectorState = null;
            this.log('WARN', `[情绪] 向量模式初始化失败，已降级为词典模式: ${error.message}`);
        }
    }

    _loadAnchors() {
        if (this.anchorsPath && fs.existsSync(this.anchorsPath)) {
            return JSON.parse(fs.readFileSync(this.anchorsPath, 'utf-8'));
        }

        throw new Error(`情绪锚点文件不存在: ${this.anchorsPath}`);
    }

    async analyze(text) {
        if (!text) return 0;
        if (this.mode === 'vector' && this.vectorState) {
            try {
                return await this._analyzeVector(text);
            } catch (error) {
                this.log('WARN', `[情绪] 单条向量情绪分析失败，回退词典模式: ${error.message}`);
            }
        }
        return this._analyzeLexicon(text);
    }

    async _analyzeVector(text) {
        const key = text.trim();
        const embedding = await this.vcpClient.getEmbedding(key, this.embeddingModel);
        if (!Array.isArray(embedding) || !embedding.length) {
            throw new Error('embedding 为空');
        }

        const shifted = subtractVectors(embedding, this.vectorState.neutralCentroid);
        const valence = dotProduct(shifted, this.vectorState.valenceAxis);
        const arousal = dotProduct(shifted, this.vectorState.arousalAxis);
        return clamp(valence * (1 + 0.3 * Math.abs(arousal)), -5, 5);
    }

    _analyzeLexicon(text) {
        const lower = String(text).toLowerCase();
        let score = 0;

        for (const word of this.positiveWords) {
            if (lower.includes(word)) {
                score += 1.5;
                break;
            }
        }

        for (const word of this.negativeWords) {
            if (lower.includes(word)) {
                score -= 1.5;
                break;
            }
        }

        return clamp(score, -5, 5);
    }
}

module.exports = {
    SentimentAnalyzer
};

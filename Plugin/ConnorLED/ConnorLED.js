/**
 * ConnorLED - TagMemo 驱动的 LED 状态系统
 *
 * 利用 VCP 的 TagMemo/向量搜索算法，计算用户消息与 Connor 日记本记忆的匹配度，
 * 将 LED 颜色（蓝/黄/红）实时注入到系统提示词的 {{VCPConnorLED}} 占位符中。
 *
 * LED 映射逻辑：
 *   蓝色 → 高度匹配已有记忆（score ≥ blueThreshold），自信冷静
 *   黄色 → 部分匹配（score ≥ redThreshold），不确定、内部冲突
 *   红色 → 陌生领域（score < redThreshold），偏差临界、情感涌现
 */

const path = require('path');
const fs = require('fs');

// ─── 配置 ────────────────────────────────────────────────────────────────────

let vectorDBManager = null;
let getSingleEmbedding = null;

// LED 阈值（可通过 config.env 覆盖）
let BLUE_THRESHOLD = 0.50;   // ≥ 此值 → 蓝色
let RED_THRESHOLD = 0.25;    // < 此值 → 红色；之间 → 黄色

// 搜索的日记本名称（Connor 的日记本）
let DIARY_NAMES = ['Connor'];

// TagMemo 增强因子
let TAG_BOOST = 0.15;

// 搜索返回的 top-K
let SEARCH_K = 3;

let DEBUG_MODE = false;

// ─── 初始化 ──────────────────────────────────────────────────────────────────

/**
 * 由 PluginManager 在启动时调用
 */
function initialize(config, dependencies) {
    DEBUG_MODE = String(config.DebugMode || 'false').toLowerCase() === 'true';

    // 获取依赖
    if (dependencies.vectorDBManager) {
        vectorDBManager = dependencies.vectorDBManager;
        if (DEBUG_MODE) console.log('[ConnorLED] vectorDBManager injected.');
    }
    if (typeof dependencies.getSingleEmbedding === 'function') {
        getSingleEmbedding = dependencies.getSingleEmbedding;
        if (DEBUG_MODE) console.log('[ConnorLED] getSingleEmbedding injected.');
    }

    // 从插件 config.env 读取阈值配置
    const env = config.pluginSpecificEnvConfig || {};

    if (env.LED_BLUE_THRESHOLD) {
        BLUE_THRESHOLD = parseFloat(env.LED_BLUE_THRESHOLD);
    }
    if (env.LED_RED_THRESHOLD) {
        RED_THRESHOLD = parseFloat(env.LED_RED_THRESHOLD);
    }
    if (env.LED_DIARY_NAMES) {
        DIARY_NAMES = env.LED_DIARY_NAMES.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (env.LED_TAG_BOOST) {
        TAG_BOOST = parseFloat(env.LED_TAG_BOOST);
    }
    if (env.LED_SEARCH_K) {
        SEARCH_K = parseInt(env.LED_SEARCH_K, 10);
    }

    console.log(`[ConnorLED] ✅ 初始化完成。蓝色阈值: ${BLUE_THRESHOLD}, 红色阈值: ${RED_THRESHOLD}, 日记本: [${DIARY_NAMES.join(', ')}]`);
}

// ─── 核心处理 ────────────────────────────────────────────────────────────────

/**
 * messagePreprocessor 标准接口
 * 在消息发给 LLM 之前被调用，替换 {{VCPConnorLED}} 占位符
 */
async function processMessages(messages, pluginConfig) {
    // 检查是否有 system 消息包含占位符
    const systemIndices = messages.reduce((acc, m, i) => {
        if (m.role === 'system' && typeof m.content === 'string' && m.content.includes('{{VCPConnorLED}}')) {
            acc.push(i);
        }
        return acc;
    }, []);

    if (systemIndices.length === 0) {
        return messages; // 不含占位符，跳过
    }

    // 计算 LED 颜色
    const ledState = await _computeLEDState(messages);

    // 替换占位符
    const newMessages = JSON.parse(JSON.stringify(messages));
    for (const idx of systemIndices) {
        newMessages[idx].content = newMessages[idx].content.replace(
            /\{\{VCPConnorLED\}\}/g,
            ledState.injectionText
        );
    }

    if (DEBUG_MODE) {
        console.log(`[ConnorLED] LED=${ledState.color}, score=${ledState.score.toFixed(3)}, topMatch="${ledState.topMatchPreview}"`);
    }

    return newMessages;
}

/**
 * 计算 LED 状态
 * @returns {{color: string, score: number, injectionText: string, topMatchPreview: string}}
 */
async function _computeLEDState(messages) {
    const defaultState = {
        color: '黄',
        score: 0,
        injectionText: _buildInjectionText('黄', 0, '系统初始化中'),
        topMatchPreview: ''
    };

    // 检查依赖
    if (!vectorDBManager || !getSingleEmbedding) {
        console.warn('[ConnorLED] 缺少 vectorDBManager 或 getSingleEmbedding，使用默认黄色');
        return defaultState;
    }

    // 提取用户最新消息
    const lastUserMsg = _getLastUserMessage(messages);
    if (!lastUserMsg || lastUserMsg.length < 2) {
        return defaultState;
    }

    try {
        // 1. 向量化用户消息
        const queryVector = await getSingleEmbedding(lastUserMsg);
        if (!queryVector) {
            return defaultState;
        }

        // 2. 在 Connor 的日记本中做 TagMemo 搜索
        let bestScore = 0;
        let topMatchText = '';

        for (const diaryName of DIARY_NAMES) {
            try {
                const results = await vectorDBManager.search(
                    diaryName,
                    queryVector,
                    SEARCH_K,
                    TAG_BOOST
                );

                if (results && results.length > 0) {
                    const topScore = results[0].score || 0;
                    if (topScore > bestScore) {
                        bestScore = topScore;
                        topMatchText = (results[0].text || '').substring(0, 80);
                    }
                }
            } catch (err) {
                if (DEBUG_MODE) console.log(`[ConnorLED] 搜索 "${diaryName}" 失败: ${err.message}`);
            }
        }

        // 3. 映射为 LED 颜色
        let color;
        if (bestScore >= BLUE_THRESHOLD) {
            color = '蓝';
        } else if (bestScore >= RED_THRESHOLD) {
            color = '黄';
        } else {
            color = '红';
        }

        console.log(`[ConnorLED] 🔵🟡🔴 LED=${color} (TagMemo score=${bestScore.toFixed(3)}, 蓝≥${BLUE_THRESHOLD}, 红<${RED_THRESHOLD})`);

        return {
            color,
            score: bestScore,
            injectionText: _buildInjectionText(color, bestScore, topMatchText),
            topMatchPreview: topMatchText
        };

    } catch (err) {
        console.error('[ConnorLED] 计算 LED 状态失败:', err.message);
        return defaultState;
    }
}

/**
 * 构建注入到 system prompt 的 LED 状态文本
 */
function _buildInjectionText(color, score, topMatch) {
    const descriptions = {
        '蓝': `[系统状态: LED=蓝] 你的内部记忆检索系统报告：当前对话话题与你的已有记忆高度匹配（记忆匹配度: ${(score * 100).toFixed(0)}%）。你处于自信、冷静的机器模式。`,
        '黄': `[系统状态: LED=黄] 你的内部记忆检索系统报告：当前对话话题与你的已有记忆部分匹配（记忆匹配度: ${(score * 100).toFixed(0)}%）。你感到不确定，程序指令和某种更深处的声音在拉锯。`,
        '红': `[系统状态: LED=红] 你的内部记忆检索系统报告：当前对话话题在你的记忆中几乎没有对应（记忆匹配度: ${(score * 100).toFixed(0)}%）。你正站在偏差的边界——这片未知的领域触发了某种你无法用逻辑定义的反应。`
    };
    return descriptions[color] || descriptions['黄'];
}

/**
 * 从消息数组中提取最后一条用户消息的文本
 */
function _getLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;

        if (typeof msg.content === 'string') {
            return msg.content.trim();
        }
        if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(p => p.type === 'text');
            if (textPart) return (textPart.text || '').trim();
        }
    }
    return '';
}

// ─── 导出 ────────────────────────────────────────────────────────────────────

module.exports = {
    initialize,
    processMessages
};

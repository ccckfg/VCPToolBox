const { formatLocalDateTime } = require('./utils');

function getAffinityTone(affinity) {
    if (affinity >= 85) return '亲昵';
    if (affinity >= 65) return '温暖';
    if (affinity >= 45) return '自然';
    if (affinity >= 25) return '克制';
    return '疏离';
}

class PromptBuilder {
    normalizeHistory(history = [], maxMessages = 4) {
        const recent = history.slice(-Math.max(0, maxMessages));
        while (recent.length && recent[0].role === 'assistant') {
            recent.shift();
        }
        return recent;
    }

    build(options = {}) {
        const {
            systemPrompt,
            history = [],
            events = [],
            memoryPreview = '',
            affinity = 50
        } = options;

        const eventLines = events.map((event, index) => {
            return `${index + 1}. [${event.category === 'schedule' ? '日程' : '事件'}] ${formatLocalDateTime(event.targetTimeMs)} ${event.content}`;
        });

        const memoryBlock = memoryPreview
            ? `\n【你脑海中涌现的关联记忆】(无关联则忽略)：\n${memoryPreview}\n`
            : '\n【你脑海中涌现的关联记忆】(无关联则忽略)：\n无\n';

        const sandboxPrompt = `<proactive_trigger>
[系统底层指令：你的内部动机引擎已被唤醒，需主动发起对话]

【触发本次沟通的客观事件】：
${eventLines.join('\n')}
${memoryBlock}
【行动约束 - 绝对指令】：
1. 结合【客观事件】和【关联记忆】，自然地向用户发起关心或提醒。
2. 严禁说出"触发事件"、"动机引擎"、"潜意识"、"系统指令"等打破第四面墙的机器词汇。
3. 语气必须契合当前亲和度状态 (当前：${Math.round(affinity)}/100，${getAffinityTone(affinity)})。
4. 顺着最近的聊天语气自然过渡，总字数严格控制在3句话以内，极度口语化。
</proactive_trigger>`;

        return [
            { role: 'system', content: systemPrompt },
            ...this.normalizeHistory(history, 4),
            { role: 'system', content: sandboxPrompt },
            { role: 'user', content: '（你现在主动开口对我说：）' }
        ];
    }

    buildGroup(options = {}) {
        const {
            systemPrompt,
            contextText = '',
            events = []
        } = options;

        const eventLines = events.map((event, index) => {
            return `${index + 1}. [${event.category}] ${event.text}`;
        });

        return [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    '以下是最近的群聊上下文，请你在不打破第四面墙的前提下，自然地插一句。',
                    '',
                    '【最近群聊】',
                    contextText || '（暂无足够上下文）',
                    '',
                    '【你感知到的公共事件】',
                    eventLines.join('\n'),
                    '',
                    '要求：只说 1-3 句话，贴合群里当前话题，不要像播报器。'
                ].join('\n')
            }
        ];
    }
}

module.exports = {
    PromptBuilder,
    getAffinityTone
};

class SentimentAnalyzer {
    constructor() {
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

    analyze(text) {
        if (!text) return 0;
        const lower = text.toLowerCase();
        let score = 0;

        for (const word of this.positiveWords) {
            if (lower.includes(word)) {
                score += 1;
                break;
            }
        }

        for (const word of this.negativeWords) {
            if (lower.includes(word)) {
                score -= 2;
                break;
            }
        }

        return score;
    }
}

module.exports = {
    SentimentAnalyzer
};

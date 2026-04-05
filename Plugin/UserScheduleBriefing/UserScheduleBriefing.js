const fs = require('fs').promises;
const path = require('path');

// 读取 UserSchedule 插件的数据文件
const SCHEDULE_FILE = path.join(__dirname, '..', 'UserSchedule', 'user_schedules.json');

async function readSchedules() {
    try {
        const data = await fs.readFile(SCHEDULE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeSchedules(schedules) {
    await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
}

function buildBriefing(schedules) {
    if (schedules.length === 0) {
        return '目前没有任何用户的待办日程。';
    }

    const lines = schedules.map(s =>
        `- ${s.time} | 归属用户: ${s.target_user} | 内容: ${s.content}`
    );

    return [
        `当前待办日程共 ${schedules.length} 条：`,
        ...lines,
        '',
        '[防混淆指令] 以上日程各有归属用户。你只能在与对应的归属用户沟通时才提及其日程。',
        '严禁将某位用户的日程提醒发送给其他不相关的用户！'
    ].join('\n');
}

async function main() {
    try {
        let schedules = await readSchedules();
        const now = new Date();

        // 1. 清理过期日程
        const before = schedules.length;
        schedules = schedules.filter(s => {
            const t = new Date(s.time);
            if (isNaN(t.getTime())) return true; // 无法解析则保留
            return t > now;
        });

        if (schedules.length !== before) {
            await writeSchedules(schedules);
        }

        // 2. 输出播报内容
        console.log(buildBriefing(schedules));
    } catch (error) {
        console.error(`[UserScheduleBriefing] Error: ${error.message}`);
    }
}

main();

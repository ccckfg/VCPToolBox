const fs = require('fs').promises;
const path = require('path');

const SCHEDULE_FILE = path.join(__dirname, 'user_schedules.json');

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

function handleAddSchedule(request, schedules) {
    if (!request.target_user) {
        return {
            status: 'error',
            error: '缺少 target_user 参数。必须指明日程归属的目标用户（昵称、备注或QQ号），以防提醒错人。'
        };
    }
    if (!request.time || !/^\d{4}-\d{1,2}-\d{1,2}/.test(request.time)) {
        return {
            status: 'error',
            error: `无效的时间格式: ${request.time}。请使用 YYYY-MM-DD HH:mm 格式。`
        };
    }
    if (!request.content) {
        return { status: 'error', error: '缺少 content 参数（日程内容）。' };
    }

    const newSchedule = {
        id: Date.now().toString(),
        target_user: request.target_user,
        time: request.time,
        content: request.content
    };
    schedules.push(newSchedule);
    schedules.sort((a, b) => new Date(a.time) - new Date(b.time));

    return {
        schedules,
        response: {
            status: 'success',
            result: `日程已添加。归属用户: ${newSchedule.target_user}，时间: ${newSchedule.time}，内容: ${newSchedule.content}（ID: ${newSchedule.id}）`
        }
    };
}

function handleDeleteSchedule(request, schedules) {
    if (!request.id) {
        return { status: 'error', error: '缺少 id 参数。' };
    }
    const initialLength = schedules.length;
    const filtered = schedules.filter(s => s.id !== request.id);
    if (filtered.length === initialLength) {
        return { status: 'error', error: `未找到 ID 为 ${request.id} 的日程。` };
    }
    return {
        schedules: filtered,
        response: { status: 'success', result: `日程 ${request.id} 已删除。` }
    };
}

function handleListSchedules(schedules) {
    if (schedules.length === 0) {
        return { status: 'success', result: '当前没有日程。' };
    }
    const list = schedules
        .map(s => `[${s.id}] ${s.time} | 归属: ${s.target_user} | 内容: ${s.content}`)
        .join('\n');
    return { status: 'success', result: `当前日程列表：\n${list}` };
}

async function handleRequest(request) {
    let schedules = await readSchedules();

    switch (request.command) {
        case 'AddSchedule': {
            const result = handleAddSchedule(request, schedules);
            if (result.status === 'error') return result;
            await writeSchedules(result.schedules);
            return result.response;
        }
        case 'DeleteSchedule': {
            const result = handleDeleteSchedule(request, schedules);
            if (result.status === 'error') return result;
            await writeSchedules(result.schedules);
            return result.response;
        }
        case 'ListSchedules':
            return handleListSchedules(schedules);
        default:
            return { status: 'error', error: `未知命令: ${request.command}` };
    }
}

async function main() {
    let inputData = '';
    process.stdin.on('data', (chunk) => { inputData += chunk; });
    process.stdin.on('end', async () => {
        try {
            if (!inputData.trim()) {
                console.log(JSON.stringify({ status: 'error', error: '无输入数据' }));
                process.exit(0);
            }
            const request = JSON.parse(inputData);
            const response = await handleRequest(request);
            console.log(JSON.stringify(response));
        } catch (e) {
            console.log(JSON.stringify({ status: 'error', error: `解析输入失败: ${e.message}` }));
        }
        process.exit(0);
    });
}

main();

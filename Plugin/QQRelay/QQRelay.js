// QQRelay.js - VCP 同步插件
// 通过 napcat-vcp-bridge 的 Webhook 向 QQ 好友发送即时或定时消息
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const dotenv = require('dotenv');

// 加载插件本地配置
const pluginConfigPath = path.join(__dirname, 'config.env');
let BRIDGE_WEBHOOK_URL = 'http://localhost:3005';
let BRIDGE_TOKEN = '';

try {
    const envContent = require('fs').readFileSync(pluginConfigPath, 'utf-8');
    const envConfig = dotenv.parse(envContent);
    BRIDGE_WEBHOOK_URL = envConfig.BRIDGE_WEBHOOK_URL || BRIDGE_WEBHOOK_URL;
    BRIDGE_TOKEN = envConfig.BRIDGE_TOKEN || '';
} catch (e) {
    // config.env 不存在，使用默认值
}

const TIMED_CONTACTS_DIR = path.join(__dirname, '..', '..', 'VCPTimedContacts');

// ─── HTTP 请求工具 ──────────────────────────────────────────────────────────

function httpRequest(url, method, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers
        };

        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Bridge Webhook 请求超时'));
        });
        if (body) req.write(body);
        req.end();
    });
}

// ─── 命令处理 ────────────────────────────────────────────────────────────────

async function sendMessage(target, message) {
    if (!target) return { status: 'error', error: '缺少 target 参数（好友昵称或QQ号）' };
    if (!message) return { status: 'error', error: '缺少 message 参数（消息内容）' };

    const url = `${BRIDGE_WEBHOOK_URL}/send`;
    const payload = JSON.stringify({ target, message });

    try {
        const res = await httpRequest(url, 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${BRIDGE_TOKEN}`,
            'Content-Length': Buffer.byteLength(payload)
        }, payload);

        if (res.status === 200 && res.body?.status === 'success') {
            return {
                status: 'success',
                result: `消息已成功发送给 ${res.body.resolvedName || target}（QQ: ${res.body.userId || '未知'}）`
            };
        } else {
            return {
                status: 'error',
                error: `发送失败: ${res.body?.error || res.body || `HTTP ${res.status}`}`
            };
        }
    } catch (err) {
        return { status: 'error', error: `无法连接 Bridge Webhook: ${err.message}` };
    }
}

async function scheduleMessage(target, message, scheduleTime) {
    if (!target) return { status: 'error', error: '缺少 target 参数' };
    if (!message) return { status: 'error', error: '缺少 message 参数' };
    if (!scheduleTime) return { status: 'error', error: '缺少 schedule_time 参数' };

    // 解析时间
    const targetDate = new Date(scheduleTime.replace(/[/\\.]/g, '-'));
    if (isNaN(targetDate.getTime())) {
        return { status: 'error', error: `无效的时间格式: ${scheduleTime}。请使用 YYYY-MM-DD HH:mm 格式。` };
    }
    if (targetDate.getTime() <= Date.now()) {
        return { status: 'error', error: `不能设置过去的时间: ${scheduleTime}` };
    }

    // 构建定时任务文件
    const taskId = `qqrelay-${targetDate.getTime()}-${Math.random().toString(36).slice(2, 8)}`;

    // 格式化为带时区偏移的本地时间（TaskScheduler 需要）
    const tzOffset = -targetDate.getTimezoneOffset();
    const tzSign = tzOffset >= 0 ? '+' : '-';
    const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
    const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, '0');
    const localISOString = targetDate.getFullYear()
        + '-' + String(targetDate.getMonth() + 1).padStart(2, '0')
        + '-' + String(targetDate.getDate()).padStart(2, '0')
        + 'T' + String(targetDate.getHours()).padStart(2, '0')
        + ':' + String(targetDate.getMinutes()).padStart(2, '0')
        + ':' + String(targetDate.getSeconds()).padStart(2, '0')
        + tzSign + tzHours + ':' + tzMinutes;

    const taskData = {
        taskId,
        scheduledLocalTime: localISOString,
        tool_call: {
            tool_name: 'QQRelay',
            arguments: {
                command: 'SendMessage',
                target,
                message
            }
        },
        requestor: 'Plugin: QQRelay'
    };

    try {
        await fs.mkdir(TIMED_CONTACTS_DIR, { recursive: true });
        const taskFilePath = path.join(TIMED_CONTACTS_DIR, `${taskId}.json`);
        await fs.writeFile(taskFilePath, JSON.stringify(taskData, null, 2));

        // 格式化友好时间
        const friendlyTime = `${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月${targetDate.getDate()}日 `
            + `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;

        return {
            status: 'success',
            result: `定时消息已创建。将在 ${friendlyTime} 自动发送给 ${target}。（任务ID: ${taskId}）`
        };
    } catch (err) {
        return { status: 'error', error: `创建定时任务失败: ${err.message}` };
    }
}

async function listFriends() {
    const url = `${BRIDGE_WEBHOOK_URL}/friends`;

    try {
        const res = await httpRequest(url, 'GET', {
            'Authorization': `Bearer ${BRIDGE_TOKEN}`
        });

        if (res.status === 200 && res.body?.status === 'success') {
            const friends = res.body.friends || [];
            if (friends.length === 0) {
                return { status: 'success', result: '当前好友列表为空。' };
            }

            const list = friends.map(f => {
                let entry = f.nickname || String(f.user_id);
                if (f.remark && f.remark !== f.nickname) entry += `（备注: ${f.remark}）`;
                return entry;
            }).join('、');

            return {
                status: 'success',
                result: `当前QQ好友列表（共 ${friends.length} 人）:\n${list}`
            };
        } else {
            return {
                status: 'error',
                error: `获取好友列表失败: ${res.body?.error || `HTTP ${res.status}`}`
            };
        }
    } catch (err) {
        return { status: 'error', error: `无法连接 Bridge Webhook: ${err.message}` };
    }
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

async function main() {
    let inputData = '';
    process.stdin.on('data', chunk => { inputData += chunk; });
    process.stdin.on('end', async () => {
        try {
            if (!inputData.trim()) {
                console.log(JSON.stringify({ status: 'error', error: '无输入数据' }));
                process.exit(0);
            }

            const request = JSON.parse(inputData);
            const { command } = request;
            let response;

            switch (command) {
                case 'SendMessage':
                    response = await sendMessage(request.target, request.message);
                    break;
                case 'ScheduleMessage':
                    response = await scheduleMessage(request.target, request.message, request.schedule_time);
                    break;
                case 'ListFriends':
                    response = await listFriends();
                    break;
                default:
                    response = { status: 'error', error: `未知命令: ${command}` };
            }

            console.log(JSON.stringify(response));
        } catch (e) {
            console.log(JSON.stringify({ status: 'error', error: `解析输入失败: ${e.message}` }));
        }
        process.exit(0);
    });
}

main();

const WebSocket = require('ws');

function createOneBotSender(options = {}) {
    const log = options.log || (() => {});
    let ws = null;
    let actionEchoCounter = 0;
    const pendingActions = new Map();

    function setSocket(socket) {
        ws = socket;
    }

    function handleEcho(data) {
        if (!data?.echo) return false;
        const pending = pendingActions.get(data.echo);
        if (!pending) return false;

        clearTimeout(pending.timer);
        pendingActions.delete(data.echo);
        if (data.status === 'ok' || data.retcode === 0) {
            pending.resolve(data);
        } else {
            pending.reject(new Error(`OneBot error: ${data.wording || data.msg || JSON.stringify(data)}`));
        }
        return true;
    }

    function callOneBot(action, params = {}) {
        return new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket 未连接'));
                return;
            }

            const echo = `bridge_${++actionEchoCounter}`;
            const timer = setTimeout(() => {
                pendingActions.delete(echo);
                reject(new Error(`OneBot action "${action}" 超时`));
            }, 30000);
            if (timer.unref) timer.unref();

            pendingActions.set(echo, { resolve, reject, timer });
            ws.send(JSON.stringify({ action, params, echo }));
        });
    }

    async function sendReply(event, text) {
        const params = { message: [{ type: 'text', data: { text } }] };
        if (event.message_type === 'group') {
            params.group_id = event.group_id;
            params.message.unshift({ type: 'reply', data: { id: String(event.message_id) } });
            return callOneBot('send_group_msg', params);
        }
        params.user_id = event.user_id;
        return callOneBot('send_private_msg', params);
    }

    async function sendGroupMessage(groupId, text) {
        return callOneBot('send_group_msg', {
            group_id: groupId,
            message: [{ type: 'text', data: { text } }]
        });
    }

    async function sendPrivateMessage(userId, text) {
        return callOneBot('send_private_msg', {
            user_id: Number(userId),
            message: [{ type: 'text', data: { text } }]
        });
    }

    function shutdown() {
        for (const [echo, pending] of pendingActions.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Bridge 正在关闭'));
            pendingActions.delete(echo);
        }
        log('DEBUG', '[OneBot] 已清理待处理请求');
    }

    return {
        callOneBot,
        handleEcho,
        sendGroupMessage,
        sendPrivateMessage,
        sendReply,
        setSocket,
        shutdown
    };
}

module.exports = {
    createOneBotSender
};

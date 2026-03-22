const http = require('http');

function createWebhookServer(options = {}) {
    const webhookConfig = options.webhookConfig || {};
    const friendBook = options.friendBook;
    const callOneBot = options.callOneBot;
    const log = options.log || (() => { });

    let webhookServer = null;

    function startWebhookServer() {
        if (!webhookConfig.enable) {
            log('INFO', '[Webhook] 未启用 Webhook 服务器');
            return;
        }

        const port = webhookConfig.port || 3005;
        const token = webhookConfig.token || '';

        webhookServer = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (token) {
                const authHeader = req.headers.authorization || '';
                if (authHeader !== `Bearer ${token}`) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', error: 'Unauthorized' }));
                    return;
                }
            }

            try {
                if (req.method === 'GET' && req.url === '/friends') {
                    const friends = friendBook.toList();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success', friends }));
                    return;
                }

                if (req.method === 'POST' && req.url === '/send') {
                    let body = '';
                    for await (const chunk of req) body += chunk;

                    const { target, message } = JSON.parse(body);
                    if (!target || !message) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', error: '缺少 target 或 message 参数' }));
                        return;
                    }

                    const userId = friendBook.resolve(target);
                    if (!userId) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', error: `未找到好友 "${target}"，请确认昵称或备注是否正确` }));
                        return;
                    }

                    const friendInfo = friendBook.getInfo(userId);
                    const resolvedName = friendInfo?.remark || friendInfo?.nickname || target;

                    await callOneBot('send_private_msg', {
                        user_id: Number(userId),
                        message: [{ type: 'text', data: { text: message } }]
                    });

                    log('INFO', `[Webhook] ✉️ 已代发消息给 ${resolvedName}(${userId}): ${message.substring(0, 100)}`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success', userId: Number(userId), resolvedName }));
                    return;
                }

                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', error: 'Not Found' }));
            } catch (err) {
                log('ERROR', '[Webhook] 处理请求失败:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', error: err.message }));
            }
        });

        webhookServer.listen(port, () => {
            log('INFO', `[Webhook] ✅ HTTP Webhook 服务器已启动，端口: ${port}`);
        });

        webhookServer.on('error', (err) => {
            log('ERROR', '[Webhook] 服务器启动失败:', err.message);
        });
    }

    function stopWebhookServer() {
        if (webhookServer) {
            webhookServer.close();
            webhookServer = null;
            log('INFO', '[Webhook] HTTP 服务器已关闭');
        }
        friendBook.stop();
    }

    return {
        startWebhookServer,
        stopWebhookServer
    };
}

module.exports = {
    createWebhookServer
};

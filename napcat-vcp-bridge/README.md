# NapCat ↔ VCPToolBox Bridge

将 QQ 消息通过 [NapCat](https://napneko.github.io/) 桥接到 [VCPToolBox](https://github.com/user/VCPToolBox)，让 QQ 用户与 AI 对话。支持**被动回复**、**群聊主动发言**、**私聊主动发话**和**跨用户 QQ 消息代发**。

## 架构

```
QQ 用户 ◄──NTQQ──► NapCat ◄──WebSocket──► Bridge ──HTTP(SSE)──► VCPToolBox
                                             │
                              ┌──────────────┼──────────────────┐
                              │              │                  │
                        群聊主动发言     私聊主动发话        Webhook 服务器
                       (RelevanceGate)  (梦式调度器)       (QQRelay 插件调用)
                              │              │                  │
                        ┌─────┴─────┐  ┌─────┴─────┐   ┌───────┴───────┐
                        │ 旁听缓冲  │  │ 亲和度管理 │   │ FriendBook    │
                        │ 相关度判定 │  │ 情绪分析   │   │ 好友名→QQ号   │
                        │ 动态阈值  │  │ 概率掷骰子 │   │ 即时/定时消息  │
                        └───────────┘  └───────────┘   └───────────────┘
```

## 快速开始

### 前提条件

- **NapCat** 已安装并登录 QQ
- **VCPToolBox** 已运行（默认端口 5890）
- **Node.js** >= 16

### 1. 配置 NapCat

在 NapCat 的 `config/onebot11_你的QQ号.json` 中启用 **WebSocket 服务端**：

```json
{
  "network": {
    "websocketServers": [
      {
        "name": "bridge",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "",
        "enableForcePushEvent": true,
        "debug": false,
        "heartInterval": 30000
      }
    ]
  }
}
```

### 2. 配置 Bridge

编辑 `config.json`，至少修改 `vcp.apiKey` 和 `vcp.model`。

### 3. 启动

```bash
cd napcat-vcp-bridge
npm install
npm start
```

---

## 核心功能

### 一、被动响应

用户主动发消息给 Bot 时，Bridge 将消息转发给 VCP 获取 AI 回复。

| 场景 | 触发方式 |
|------|----------|
| 私聊 | 直接发消息 |
| 群聊 | `@机器人 你好` 或 `/ai 你好` |
| 清除记忆 | 发送 `/clear` 或 `清除记忆` |

**流式分段发送**：AI 回复通过 SSE 实时接收，遇到工具调用块 `<<<[TOOL_REQUEST]>>>` 时自动切割为多段，逐段发送到 QQ，避免长时间等待。

**场景感知**：每条消息发给 VCP 前自动注入对话上下文。AI 收到的内容类似：
- 私聊：`[私聊 | 对方:小明] 你好`
- 群聊：`[群聊 | 群号:123456 | 发言者:小明] 你好`

### 二、群聊主动发言

> 需要 VCP 的 RelevanceGate 插件

Bot 旁听群消息，利用 VCP 的 RAG/TagMemo 知识库判断话题相关度。当相关度超阈值时主动加入讨论。

**原理**：
1. 群消息进入 `GroupMessageBuffer` 缓冲区
2. 累积到指定条数后，合并文本发送给 RelevanceGate API
3. RelevanceGate 用向量相似度 + 标签匹配计算相关分数
4. 分数 > 阈值（亲和度动态调整） → 调用 VCP 生成回复 → 发到群里

### 三、私聊主动发话（梦式调度）

Bot 定时检查是否要主动找用户聊天（类似 VCP 的 AgentDream 机制）：

1. **时间窗口** — 只在合适时段发话（默认 8:00-22:00）
2. **亲和度门槛** — 态度好的用户更容易被找（< 20 完全沉默）
3. **概率掷骰** — 加入随机性，不机械化
4. **冷却 + 每日上限** — 不会过度打扰

### 四、跨用户 QQ 消息代发

> 需要 VCP 的 QQRelay 插件

AI 可以通过标准 VCP 工具调用向 QQ 好友发消息，支持**即时**和**定时**两种模式。

**原理**：
1. AI 在对话中调用 `QQRelay` 插件（SendMessage / ScheduleMessage）
2. 插件通过 HTTP 请求 Bridge 的 Webhook 服务器（`/send` 端点）
3. Bridge 使用 `FriendBook` 将好友昵称解析为 QQ 号
4. Bridge 通过 OneBot API 发送私信

**定时消息**：插件将任务写入 `VCPTimedContacts/` 目录，VCP 的 TaskScheduler 到点自动触发。

```
用户: "帮我给小明发消息说你好"
→ AI 工具调用: QQRelay(SendMessage, target:"小明", message:"你好")
→ QQRelay POST → Bridge /send
→ FriendBook: "小明" → QQ号 12345
→ OneBot: send_private_msg → QQ 送达
```

### 五、情感感知系统

每条用户消息自动分析情绪（关键词匹配），动态调整对该用户的亲和度：

| 情绪 | 效果 |
|------|------|
| 积极（谢谢/哈哈/厉害...） | 亲和度 +1 |
| 消极（闭嘴/滚/无聊...） | 亲和度 -2 |
| 主动来聊 | 亲和度 +0.5 |
| 自然恢复 | 每小时向 50 靠拢 +1 |

亲和度影响主动发话概率：**80+** 热情(70%) / **50-79** 正常(40%) / **20-49** 冷淡(10%) / **< 20** 完全沉默

---

## 项目结构

```
napcat-vcp-bridge/
├── bridge.js                         # 主入口：连接管理、消息路由、生命周期
├── config.json                       # 配置文件
├── lib/
│   ├── config.js                     # 配置加载
│   ├── logger.js                     # 日志 + sleep 工具
│   ├── context-manager.js            # 对话上下文管理（含自动过期清理）
│   ├── message-utils.js              # 消息提取、触发判定、场景感知
│   ├── vcp-client.js                 # VCP API 调用（流式 SSE + 非流式）
│   ├── group-message-buffer.js       # 群消息缓冲 + 触发时机判定
│   ├── sentiment-analyzer.js         # 中文情绪关键词分析
│   ├── affinity-manager.js           # 用户亲和度系统（持久化）
│   ├── private-proactive-scheduler.js # 私聊主动发话调度器
│   ├── friend-book.js                # QQ 好友通讯录（昵称→QQ号解析）
│   └── webhook-server.js             # HTTP Webhook（供 QQRelay 插件调用）
└── affinity_data.json                # 亲和度持久化数据（自动生成）
```

---

## 配置说明

### 基本连接 (`napcat`, `vcp`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `napcat.wsUrl` | `ws://localhost:3001` | NapCat WebSocket 地址 |
| `napcat.token` | `""` | WebSocket 鉴权 Token |
| `vcp.apiUrl` | `http://localhost:5890/v1/chat/completions` | VCP API 地址 |
| `vcp.apiKey` | — | VCP Key（对应 `config.env` 中的 `Key`） |
| `vcp.model` | — | 模型名称或 Agent 名称 |
| `vcp.systemPrompt` | `"{{Connor}}"` | 系统提示词（支持 VCP 变量占位符） |

### 触发与上下文 (`bot`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `triggerMode.private` | `"all"` | 私聊触发模式：`all` / `prefix` |
| `triggerMode.group` | `"atOrPrefix"` | 群聊触发模式：`all` / `at` / `prefix` / `atOrPrefix` |
| `triggerMode.prefix` | `"/ai"` | 前缀触发关键字 |
| `context.maxRounds` | `20` | 最大上下文轮数 |
| `context.ttlMinutes` | `60` | 上下文过期时间 |
| `context.perUser` | `true` | 群聊中是否按用户隔离上下文 |
| `maxReplyLength` | `3000` | 单段回复最大字符数 |

### 群聊主动发言 (`bot.proactive`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enable` | `false` | 是否启用 |
| `groups` | `[]` | 启用的群号列表，空 = 全部 |
| `threshold` | `0.45` | 相关度阈值（被亲和度动态调整） |
| `cooldownSeconds` | `300` | 发言后冷却时间 |
| `bufferSize` | `10` | 群消息缓冲区大小 |
| `checkIntervalMessages` | `5` | 每累积 N 条消息触发判定 |

### 私聊主动发话 (`bot.proactive.private`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enable` | `false` | 是否启用 |
| `whitelist` | `[]` | 允许主动私聊的 QQ 号列表 |
| `checkIntervalMinutes` | `30` | 调度器检查间隔 |
| `timeWindowStart` | `8` | 允许发话的起始小时 |
| `timeWindowEnd` | `22` | 结束小时 |
| `cooldownHours` | `4` | 同一用户的对话间隔 |
| `maxDailyMessages` | `2` | 每天最多主动发话次数 |

### Webhook 服务器 (`bot.webhook`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enable` | `true` | 是否启用 HTTP Webhook |
| `port` | `3005` | 监听端口 |
| `token` | — | Bearer Token 鉴权（需与 QQRelay 插件一致） |

### 环境变量

| 变量 | 说明 |
|------|------|
| `LOG_LEVEL` | 日志级别：`DEBUG` / `INFO` / `WARN` / `ERROR` |

---

## 配合 VCP 插件

| 插件 | 用途 |
|------|------|
| **RelevanceGate** | 群聊主动发言的相关度判定 |
| **QQRelay** | AI 跨用户发消息 + 定时消息 |
| **ScheduleManager** | AI 管理日程 |
| **TaskScheduler** | 定时任务自动执行 |

### QQRelay 插件配置

确保 `Plugin/QQRelay/config.env` 中的 Token 与 Bridge 的 `webhook.token` 一致：

```env
BRIDGE_WEBHOOK_URL=http://localhost:3005
BRIDGE_TOKEN=your_bridge_token_here
```

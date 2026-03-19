# NapCat ↔ VCPToolBox Bridge

将 QQ 消息通过 [NapCat](https://napneko.github.io/) 桥接到 [VCPToolBox](https://github.com/user/VCPToolBox)，让 QQ 用户与 AI 对话。

## 架构

```
QQ 用户 ◄──NTQQ──► NapCat ◄──WebSocket──► Bridge ──HTTP──► VCPToolBox
                                              │
                                    ┌─────────┴──────────┐
                                    │                    │
                              群聊主动发言          私聊主动发话
                              (RelevanceGate)    (梦式调度器)
                                    │                    │
                              ┌─────┴─────┐       ┌─────┴─────┐
                              │ 旁听缓冲  │       │ 亲和度管理 │
                              │ 相关度判定 │       │ 情绪分析   │
                              │ 动态阈值  │       │ 概率掷骰子 │
                              └───────────┘       └───────────┘
```

## 快速开始

### 1. 前提条件

- **NapCat** 已安装并登录 QQ
- **VCPToolBox** 已运行（默认端口 5890）
- **Node.js** >= 16

### 2. 配置 NapCat

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

### 3. 配置 Bridge

编辑 `config.json`，至少修改 `vcp.apiKey` 和 `vcp.model`。

### 4. 启动

```bash
cd napcat-vcp-bridge
npm install
npm start
```

## 功能

### 被动响应

| 场景 | 触发方式 |
|------|----------|
| 私聊 | 直接发消息 |
| 群聊 | `@机器人 你好` 或 `/ai 你好` |
| 清除记忆 | 发送 `/clear` 或 `清除记忆` |

### 群聊主动发言（需要 RelevanceGate 插件）

Bot 旁听群消息，利用 VCP 的 RAG/TagMemo 算法判断话题相关度。超阈值时主动加入讨论。

### 私聊主动发话（梦式调度）

Bot 会像 AgentDream 做梦一样，定时检查是否要主动找用户聊天：
1. **时间窗口** — 只在合适的时段发话（默认 8:00-22:00）
2. **亲和度门槛** — 态度好的用户更容易被找
3. **概率掷骰** — 加入随机性，不机械化
4. **RelevanceGate** — 检索知识库找到有话题可聊才开口
5. **冷却 + 每日上限** — 不会过度打扰

### 情感感知系统

每条用户消息自动分析情绪（关键词匹配），动态调整对该用户的亲和度：

| 情绪 | 效果 |
|------|------|
| 积极（谢谢/哈哈/厉害...） | 亲和度 +1 |
| 消极（闭嘴/滚/无聊...） | 亲和度 -2 |
| 主动来聊 | 亲和度 +0.5 |
| 自然恢复 | 每小时向 50 靠拢 +1 |

亲和度影响主动发话概率：80+ 热情 / 50-79 正常 / 20-49 冷淡 / <20 完全沉默

## 配置说明

### 私聊主动发话 (`bot.proactive.private`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enable` | `false` | 是否启用 |
| `whitelist` | `[]` | 允许主动私聊的 QQ 号列表 |
| `checkIntervalMinutes` | `30` | 每多少分钟检查一次 |
| `timeWindowStart` | `8` | 允许发话的起始小时 |
| `timeWindowEnd` | `22` | 允许发话的结束小时 |
| `cooldownHours` | `4` | 与同一用户的对话间隔 |
| `maxDailyMessages` | `2` | 每天最多主动发话次数 |
| `systemPrompt` | (见配置) | 主动发话时的系统提示词 |

### 群聊主动发言 (`bot.proactive`)

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enable` | `false` | 是否启用 |
| `groups` | `[]` | 启用的群号列表，空=全部 |
| `threshold` | `0.45` | 相关度阈值（会被亲和度动态调整） |
| `cooldownSeconds` | `300` | 发言冷却时间 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `LOG_LEVEL` | 日志级别：`DEBUG` / `INFO` / `WARN` / `ERROR` |

## 持久化文件

| 文件 | 说明 |
|------|------|
| `affinity_data.json` | 用户亲和度数据（自动生成） |

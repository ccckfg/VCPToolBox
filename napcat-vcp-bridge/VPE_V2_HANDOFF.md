# VPE v2 工程推进 Handoff 文档

## 文档元信息

- 撰写时间：2026-04-04
- 上作者：Claude Sonnet（本次 session）
- 基准提交：`2b2147b`（my-config 分支）
- 前置文档：`VPE_V1_HANDOFF_STATUS.md`
- 本文目标：在 VPE v1 已完成私聊主动发言 MVP 的基础上，向白皮书完整覆盖继续推进

---

## 当前基线状态（本文起点）

## 2026-04-04 实施进度更新（Codex）

### 本轮已落地

- Stage 1:
  - `VcpClient` 已统一 embeddings LRU 缓存，并新增 `getSemanticScore()`。
  - `bridge.js` 已按职责拆分为 `onebot-sender`、`proactive-bootstrap`、`private-message-handler`、`group-message-handler`。
- Stage 2:
  - `GroupMessageBuffer` 已支持群语境文本读取与 10 分钟滑窗计数。
  - 新增 `lib/vpe/gate-group.js`，并把群聊倒 U 型门控接入 `VpeEngine.tick()`。
  - `VpeEngine` 已支持 `scope='public'` 事件的群聊主动仲裁，且与私聊事件严格隔离。
- Stage 3:
  - 已新增 `Plugin/SemanticQueryGate/`，Bridge 侧优先调用 SQG，失败后回退本地 Soft-Maximum。
  - `Plugin.js` 已补依赖注入。
- Stage 4:
  - 已新增 `Plugin/SensorAggregator/`，可聚合 `DailyHot` 与 `WeatherReporter` 缓存为公共事件。
  - `EventSensor` 已支持 `collectEventsAsync()` 拉取外部事件。
  - `TimeLens` 已支持天气/热点使用衰减型时间透镜。

### 本轮验证已完成

- `node --check` 通过：
  - `napcat-vcp-bridge/bridge.js`
  - `napcat-vcp-bridge/lib/*.js`
  - `napcat-vcp-bridge/lib/vpe/*.js`
  - `Plugin/SemanticQueryGate/SemanticQueryGate.js`
  - `Plugin/SensorAggregator/SensorAggregator.js`
- 轻量烟雾测试通过：
  - group VPE dry-run 仲裁链路可跑通
  - `SensorAggregator` 能从现有缓存生成 weather/news 公共事件
  - `SemanticQueryGate` 的 Soft-Maximum 聚合结果正确

### 仍需联调/验收

- 尚未做真实 VCP 服务内的插件注册后联调。
- 尚未做 NapCat 在线群聊/私聊实发验证。
- `SemanticQueryGate` 当前先用“Top-K chunk + Soft-Maximum”近似语义组，后续若要更贴近白皮书，可继续补用户语义组聚类。

### ✅ 已完成且 dryRun 验证通过的链路

- 感知层：`EventSensor` → `UserSchedule` 日程读取，用户归属解析
- 状态层：`EventFsm` 多阶触发 + 指纹去重 + 快进跳过 + `AffinityManager` 全套
- 仲裁层：`TimeLens` 高斯时间透镜 + `AgingQueue` 老化防饿死 + 异构意图合并
- 门控层：`PrivateGate` 私聊门控公式（亲和度红利 + 疲劳 EMA + UCB + 作息阻力）
- 执行层：`PromptBuilder` 沙盒注入 + 倒置 RAG（RelevanceGate）

### ❌ 尚未实现的白皮书模块

按优先级排列：

| 优先级 | 模块 | 位置 | 影响 |
|--------|------|------|------|
| **P1** | embeddings 缓存统一 | bridge 层 | 工程债务，影响性能 |
| **P1** | `bridge.js` 拆分 | `napcat-vcp-bridge/` | 违反 300 行规则 |
| **P2** | 群聊倒 U 型门控 + 群语境向量 | Bridge 群聊路径 | 白皮书模块四后半段 |
| **P3** | `SemanticQueryGate` VCP 插件 | `Plugin/` | 替换 MVP $S_{sem}$ 替代实现 |
| **P3** | `SensorAggregator` VCP 插件 | `Plugin/` | 统一外部事件源拉取 |
| **P4** | 衰变型时间透镜 | `lib/vpe/time-lens.js` | 天气/热点类事件支持 |
| **P4** | 天气/热点事件接入 | `lib/vpe/event-sensor.js` | 扩展感知层 |

---

## 推进路线图

### Stage 1 — 工程债务收口（P1，前置条件）

> **必须先做。** 两项工程债务会在后续所有模块开发中持续积累。

#### Task 1.1：统一 embeddings 缓存

**问题**：`lib/vpe/engine.js` 和 `lib/sentiment-analyzer.js` 各自维护独立的 embedding 缓存（`Map`），相同文本会被重复向量化，浪费 API 调用。

**方案**：将缓存提升到 `VcpClient` 层，engine 和 sentiment-analyzer 共用同一个缓存实例。

**改动文件**：
- `lib/vcp-client.js` — 新增 `_embeddingCache = new Map()` 作为实例属性；`getEmbedding()` 和 `getEmbeddings()` 先查缓存再发请求；`invalidateEmbeddingCache()` 方法供热更新使用
- `lib/vpe/engine.js` — 删除 `this._embeddingCache = new Map()` 和 `getCachedEmbedding()` 方法，改为直接调用 `this.vcpClient.getEmbedding(text, model)`
- `lib/sentiment-analyzer.js` — 读取轴向量时若 `vcpClient` 有缓存直接复用，不需新增本地缓存

**代码接口**（在 `vcp-client.js` 中新增）：
```js
// 带 LRU 驱逐的通用 embedding 缓存
_embeddingCache = new Map();  // key: `${model}:${text}`

getCachedEmbedding(text, model) {
    const key = `${model || ''}:${text}`;
    if (this._embeddingCache.has(key)) return this._embeddingCache.get(key);
    return null;
}

setCachedEmbedding(text, model, vector) {
    const key = `${model || ''}:${text}`;
    this._embeddingCache.set(key, vector);
    if (this._embeddingCache.size > 256) {  // 容量上限 256 条
        const firstKey = this._embeddingCache.keys().next().value;
        this._embeddingCache.delete(firstKey);
    }
}
```

> **注意**：`sentiment-analyzer.js` 的轴向量（Valence / Arousal / Neutral 质心）体积大且固定，使用普通对象属性存储即可，不必放入 LRU。

---

#### Task 1.2：bridge.js 拆分

**问题**：`bridge.js` 当前 485 行（17,880 字节），违反项目 300 行单文件上限。

**目标目录结构**：
```
napcat-vcp-bridge/
  bridge.js                          # 主入口，仅保留启动编排和信号处理 (~80行)
  lib/
    private-message-handler.js       # 私聊消息处理逻辑 (~80行)
    group-message-handler.js         # 群聊消息处理逻辑 (~80行)
    proactive-bootstrap.js           # VPE/legacy 私聊主动引擎启动编排 (~50行)
    onebot-sender.js                 # callOneBot / sendReply / sendGroupMessage / sendPrivateMessage (~60行)
```

**拆分原则**：

| 文件 | 职责 | 来自 `bridge.js` 哪些函数 |
|------|------|--------------------------|
| `bridge.js` | 模块加载、配置初始化、`connect()`、`printBanner()`、`shutdown()`、Signal 注册 | 第1-87行 + 第437-485行 |
| `lib/onebot-sender.js` | `callOneBot()`、`sendReply()`、`sendGroupMessage()`、`sendPrivateMessage()` | 第88-129行 |
| `lib/proactive-bootstrap.js` | `startPrivateProactiveEngine()`、`trackPrivateIncoming()` | 第173-194行 |
| `lib/private-message-handler.js` | `handleDirectMessage()` | 第196-273行 |
| `lib/group-message-handler.js` | `handleProactiveCheck()` | 第275-332行 |

> **实施顺序**：先提取 `onebot-sender.js`（被其他三个依赖），最后整理 `bridge.js` 主入口。每提取一个文件后立即用 `node --check` 验证语法。

---

### Stage 2 — 群聊主动发言重构（P2）

> 在 Stage 1 完成后进行，利用拆后的 `group-message-handler.js` 作为扩展点。

#### Task 2.1：群聊滑动语境向量化

**白皮书定义**：将群内最近 20 条消息拼接，调用 Embedding 端点向量化，与事件向量求余弦相似度作为 $Score_{semantic}$。

**改动文件**：`lib/group-message-buffer.js`

当前 `GroupMessageBuffer` 只维护文本滑窗供 `checkRelevance` 使用，需新增：

```js
// 返回最近 N 条消息拼接文本（供群聊语境向量化）
getContextText(groupId, maxMessages = 20) {
    const buf = this._buffers.get(String(groupId)) || [];
    return buf.slice(-maxMessages).map(m => `${m.sender}: ${m.text}`).join('\n');
}
```

调用链：`handleProactiveCheck` → `groupBuffer.getContextText(groupId)` → `vcpClient.getEmbedding(text, model)` → 存入 `groupContextCache.set(groupId, embedding)`

---

#### Task 2.2：群聊倒 U 型活跃度门控

**新建文件**：`lib/vpe/gate-group.js`

**白皮书公式**：

```
Gate_activity = 
  +0.15    if M < 2        // 死群，防诈尸
   0.0     if 2 <= M <= 20 // 舒适插嘴区
  +0.05 * (M - 20)  if M > 20  // 热聊，苛刻惩罚

T_group = 0.75 + P_fatigue * exp(-γ * Δt) + Gate_activity
T_group ∈ [0.40, 1.30]（群聊基准比私聊高 0.1）
```

**状态字段**（已在 `vpe_state.json` 的 `groups` 节点中）：
```json
"groups": {
  "87654321": {
    "lastMsgMs": 1718000000000,
    "fatigue": 0.25,
    "lastProactiveMs": 1718002000000,
    "ucb": { "total": 42, "cats": { "news": 30, "weather": 12 } },
    "recentMsgCount": 8       // 新增：最近10分钟消息计数（滑窗）
  }
}
```

**实施要点**：
- `recentMsgCount` 由 `group-message-handler.js` 在每条群消息到来时更新
- 滑窗统计：维护 `_groupMsgTimestamps: Map<groupId, number[]>`，每次更新时裁剪 10 分钟之前的时间戳
- 群聊引擎不需要独立的 `setInterval`，复用 VpeEngine 的 tick 心跳即可（在 tick 中增加群聊发言仲裁分支）

**新建 gate-group.js 接口**：
```js
class GroupGate {
    calcThreshold(groupState, fatigue, now = new Date()) {
        const activity = groupState?.recentMsgCount || 0;
        let actTerm;
        if (activity < 2)       actTerm = 0.15;
        else if (activity <= 20) actTerm = 0.0;
        else                    actTerm = 0.05 * (activity - 20);

        const threshold = 0.75 + fatigue + actTerm;
        return clamp(threshold, 0.40, 1.30);
    }
}
```

---

#### Task 2.3：将群聊发言仲裁接入 VpeEngine.tick()

在 `lib/vpe/engine.js` 的 `tick()` 方法结尾，增加群聊发言仲裁逻辑：

```js
// tick() 末尾追加
const enabledGroups = proactiveConfig.groups || [];
if (enabledGroups.length && this.groupGate) {
    for (const groupId of enabledGroups) {
        await this.handleGroupProactive(groupId, now);
    }
}
```

新增方法 `handleGroupProactive(groupId, now)`：
1. 从 `stateStore` 读取群状态
2. 计算 `groupContextEmbedding`（从 `groupContextCache` 读，没有则跳过）
3. 遍历 `pendingQueue` 中 `scope='public'` 的事件，计算与群语境的余弦相似度
4. 调用 `GroupGate.calcThreshold()` 得到阈值
5. 突破则执行 `sendGroupMessage()` + 更新群 `fatigue`

> **事件路由隔离**：`scope='private'` 的事件（个人日程）**绝对禁止**进入群聊仲裁路径。

---

### Stage 3 — SemanticQueryGate VCP 插件（P3）

> 替换 V1 中的 MVP $S_{sem}$ 实现。当前 V1 用"事件向量 vs 最近私聊历史逐条相似度 + Soft-Maximum"代替，功能可用但不符合白皮书定义。

#### Task 3.1：VCP 侧新建 SemanticQueryGate 插件

**插件目录**：`Plugin/SemanticQueryGate/`

**白皮书定义**：接受事件文本，返回该用户各语义兴趣组的匹配分数（降序列表）。

**plugin-manifest.json**：
```json
{
  "name": "SemanticQueryGate",
  "type": "service",
  "version": "1.0.0",
  "port": 6006,
  "description": "为 VPE 提供事件与用户语义兴趣组的匹配分数",
  "endpoints": [
    {
      "path": "/match",
      "method": "POST",
      "description": "返回事件文本与用户语义组的匹配分数"
    }
  ]
}
```

**请求格式**：
```json
{
  "event_text": "明天高数考试",
  "user_id": "1413161276",
  "diary_name": ""
}
```

**响应格式**：
```json
{
  "scores": [
    { "group": "学习压力", "score": 0.82 },
    { "group": "日常生活", "score": 0.41 }
  ],
  "semantic_score": 0.902
}
```

> `semantic_score = scores[0].score + 0.2 * scores[1].score`（Soft-Maximum 聚合）

**实现建议**：
- 语义组从用户的 DailyNote 日记本自动聚类（如 K-Means 对日记段落向量），或手动在用户配置中预定义
- 初版可以简化为：对 `diary_name` 下的 Top-K 日记段落做 embedding，与事件向量求余弦，返回 Top-2 的结果

#### Task 3.2：Bridge 侧接入 SemanticQueryGate

修改 `lib/vpe/engine.js` 中的 `calculateSemanticScore()`，在 embeddings 可用时，优先调用 VCP 侧的 SemanticQueryGate，降级顺序如下：

```
优先级1：POST /api/plugins/SemanticQueryGate/match → semantic_score
优先级2: 本地 Soft-Maximum（当前 V1 实现，保留作兜底）
优先级3：直接返回 0（embeddings 不可用时）
```

新增 `vcp-client.js` 方法：
```js
async getSemanticScore(eventText, userId, diaryName = '') {
    const url = `${this.sqgBaseUrl}/match`;  // sqgBaseUrl 从 config 读取
    try {
        const res = await this.httpRequest(url, 'POST', headers, body);
        return JSON.parse(res.body).semantic_score || 0;
    } catch {
        return null;  // null 表示降级
    }
}
```

---

### Stage 4 — SensorAggregator 与外部事件接入（P4）

> 最后阶段，扩展感知层。在 Stage 1-3 完成后进行。

#### Task 4.1：SensorAggregator VCP 插件

**插件目录**：`Plugin/SensorAggregator/`

**白皮书定义**：统一聚合日程、天气、热点新闻数据，供 Bridge 定时拉取，解耦感知层与数据源。

**plugin-manifest.json**：
```json
{
  "name": "SensorAggregator",
  "type": "service",
  "version": "1.0.0",
  "port": 6007,
  "description": "聚合多种事件源供 VPE Bridge 拉取"
}
```

**GET /events 响应格式**：
```json
{
  "events": [
    {
      "id": "weather_20260404_rain",
      "category": "weather",
      "scope": "public",
      "source": "sensor_aggregator",
      "text": "今日大雨，气温骤降 8°C，最低 12°C",
      "intrinsicScore": 0.72,
      "expiresAfterHours": 6,
      "metadata": { "city": "Shanghai", "severity": "moderate" }
    },
    {
      "id": "news_zhihu_001",
      "category": "news",
      "scope": "public",
      "source": "sensor_aggregator",
      "text": "某热搜话题...",
      "intrinsicScore": 0.55,
      "expiresAfterHours": 2
    }
  ],
  "fetchedAt": 1743780000000
}
```

**内部数据源聚合**：可复用 VCPToolBox 已有的 `DailyHot` 插件（56+热点源）作为新闻数据来源。

#### Task 4.2：衰变型时间透镜

修改 `lib/vpe/time-lens.js`，新增 `calcDecayWeight(event)` 方法：

**白皮书公式**：自发布起权重为 1.0，随后向右侧呈半边高斯衰减。

```js
calcDecayWeight(event) {
    const { publishedAtMs, expiresAfterHours = 6 } = event;
    if (!publishedAtMs) return 1.0;
    const elapsedHours = Math.max(0, (Date.now() - publishedAtMs) / HOUR_MS);
    const sigma = expiresAfterHours / 2;  // 半衰期 = expiresAfterHours / 2
    return Math.exp(-(elapsedHours * elapsedHours) / (2 * sigma * sigma));
}

calcFinalScore(candidate, semanticScore) {
    const isDecayType = candidate.category === 'weather' || candidate.category === 'news';
    const timeWeight = isDecayType
        ? this.calcDecayWeight(candidate)
        : this.calcScheduleWeight(candidate);
    // ... 其余不变
}
```

#### Task 4.3：EventSensor 扩展拉取 SensorAggregator

修改 `lib/vpe/event-sensor.js` 的 `collectEvents()`，新增 HTTP 拉取分支：

```js
// 现有：读本地文件
const userSchedules = this._readJson(this.userSchedulePath);

// 新增：从 SensorAggregator 拉公共事件（若配置了 sensorUrl）
async collectEventsAsync() {
    const localEvents = this.collectEvents();  // 保持同步路径
    if (!this.sensorUrl) return localEvents;
    try {
        const res = await fetchWithTimeout(this.sensorUrl + '/events', 5000);
        const external = JSON.parse(res).events || [];
        return localEvents.concat(external.map(this._normalizeExternalEvent));
    } catch {
        return localEvents;  // SensorAggregator 不可用时静默降级
    }
}
```

> 需要将 `engine.js` 中的 `this.sensor.collectEvents()` 改为 `await this.sensor.collectEventsAsync()`。

---

## 各阶段完成后的验证方法

### Stage 1 验证
```bash
# 所有文件静态检查
node --check napcat-vcp-bridge/bridge.js
node --check napcat-vcp-bridge/lib/*.js
node --check napcat-vcp-bridge/lib/vpe/*.js

# 重跑 dryRun 验证脚本（复原 test-vpe-tick.js）
node test-vpe-tick.js
# 预期：链路日志不变，仅内部缓存路径更短
```

### Stage 2 验证
```bash
# 新增群聊 mock 测试（需构造虚拟群消息滑窗）
# 预期日志中出现：[VPE] 群聊主动仲裁 group=xxx score=x.xxx threshold=x.xxx
```

### Stage 3 验证
```bash
# VCP 侧：curl 测试 SemanticQueryGate
curl -X POST http://localhost:6006/match \
  -H "Content-Type: application/json" \
  -d '{"event_text":"明天高数考试","user_id":"1413161276"}'
# 预期：{"scores":[...],"semantic_score":0.8x}

# Bridge 侧：dryRun tick 中应看到 semanticScore > 0（不再是固有分兜底）
```

### Stage 4 验证
```bash
# VCP 侧：curl 测试 SensorAggregator
curl http://localhost:6007/events
# 预期：返回包含天气/热点事件的 JSON 列表

# Bridge 侧：dryRun tick 看到感知到 > 1 条原始事件（含天气/新闻）
```

---

## 已知风险与注意事项

### 风险 1：bridge.js 拆分顺序依赖
拆分时按依赖顺序由底层到顶层提取：`onebot-sender.js` → `proactive-bootstrap.js` → `private-message-handler.js` → `group-message-handler.js` → `bridge.js`。每步均需静态检查，不要一次性重写。

### 风险 2：EventSensor 从同步改异步
Task 4.3 需要将 `collectEvents()` 改为 `collectEventsAsync()`，会级联修改 `engine.js` 的 `tick()` 方法（已有 `async`，`await` 即可）。注意 `engine.js` 中原来的 `rawEvents = this.sensor.collectEvents()` 一行。

### 风险 3：群聊门控的 recentMsgCount 统计窗口
10 分钟滑窗统计需要维护每个群的消息时间戳数组。如果 Bridge 长时间运行，数组不清理会内存泄漏。建议设置单群上限 5000 条时间戳（10分钟 = 最多 600 条，5000 条足以覆盖任何情况）。

### 风险 4：SemanticQueryGate 的语义组冷启动
如果用户没有足够的 DailyNote 历史，语义组聚类会失败或质量差。初版应提供硬编码默认语义组列表作为兜底（如："学习/工作"、"日常生活"、"情感互动"、"兴趣娱乐"），直到日记本积累足够数据。

### 风险 5：SensorAggregator 与 DailyHot 集成
`DailyHot` 插件目前返回热搜条目列表，SensorAggregator 需要对其格式化（提取标题、估算 intrinsicScore、设置 expiresAfterHours）。建议先用模拟数据（hardcode 几条假天气）验证管线，再接真实 DailyHot 数据。

---

## 文件改动清单（按推进顺序）

### Stage 1
- `lib/vcp-client.js`：新增 embedding 本地缓存方法
- `lib/vpe/engine.js`：删除 `_embeddingCache`，调用 `vcpClient` 缓存接口
- `lib/sentiment-analyzer.js`：复用 `vcpClient` 缓存（可选）
- `lib/onebot-sender.js`：**[新建]** 从 bridge.js 提取
- `lib/proactive-bootstrap.js`：**[新建]** 从 bridge.js 提取
- `lib/private-message-handler.js`：**[新建]** 从 bridge.js 提取
- `lib/group-message-handler.js`：**[新建]** 从 bridge.js 提取（当前群聊主动逻辑）
- `bridge.js`：精简至主入口

### Stage 2
- `lib/group-message-buffer.js`：新增 `getContextText()` 和滑窗消息计数
- `lib/vpe/gate-group.js`：**[新建]** 群聊倒 U 型门控
- `lib/vpe/engine.js`：在 `tick()` 末尾注入群聊仲裁
- `lib/group-message-handler.js`：更新 `recentMsgCount`、缓存群语境 embedding
- `lib/vpe/constants.js`：新增群聊门控参数常量
- `config.json`：新增群聊主动 VPE 相关配置节（`bot.proactive.vpe.groups`）

### Stage 3
- `Plugin/SemanticQueryGate/plugin-manifest.json`：**[新建]**
- `Plugin/SemanticQueryGate/server.js`：**[新建]** HTTP 服务入口
- `Plugin/SemanticQueryGate/lib/matcher.js`：**[新建]** 语义匹配逻辑
- `lib/vcp-client.js`：新增 `getSemanticScore()` 方法
- `lib/vpe/engine.js`：`calculateSemanticScore()` 中增加 SQG 优先调用

### Stage 4
- `Plugin/SensorAggregator/plugin-manifest.json`：**[新建]**
- `Plugin/SensorAggregator/server.js`：**[新建]** 聚合服务
- `lib/vpe/time-lens.js`：新增 `calcDecayWeight()` 方法
- `lib/vpe/event-sensor.js`：新增 `collectEventsAsync()` 方法
- `lib/vpe/engine.js`：`tick()` 中改为 `await sensor.collectEventsAsync()`

---

## 接手建议

1. **从 Task 1.1 开始**（embedding 缓存统一），这件事改动小但立竿见影，热身同时为后续减少 API 浪费。
2. **Task 1.2（bridge.js 拆分）** 是最重的工程工作，建议单独一个 session 完成，边拆边验证，不要一次性改完。
3. Stage 2 的群聊模块**需要群聊测试环境**，可以先 mock 群消息时间戳数组，门控计算本身是纯数学。
4. Stage 3 和 4 的 VCP 插件开发需要参考 `Plugin/RelevanceGate/` 和 `Plugin/DailyHot/` 的实现模式。

---

*本文档由 AI 辅助撰写，以本文描述和最新代码为准；`review_v1.md` 已部分过时，不应再作为参考文档使用。*

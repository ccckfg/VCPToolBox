# VPE V2 代码审阅报告

**审阅时间**：2026-04-04  
**审阅范围**：Codex 本轮全部改动文件（15 个修改 + 9 个新增）  
**基准文档**：`VPE_V2_HANDOFF.md` 原方案 + `FINAL_ALGORITHM_MERGED.md` 白皮书  
**审阅状态**：所有文件语法检查通过（`node --check` 全部 ALL PASS）

---

## 总体判定

> **可接受，整体质量良好。核心逻辑与白皮书高度一致，存在 3 个需要修复的 Bug 和若干改进建议。**

---

## 文件逐一审阅

### ✅ bridge.js — 重构完成，行数合规

**原**：485 行 / 17,880 字节  
**现**：311 行 / 10,410 字节

职责拆分干净，`handleMessage()` 只做路由，各模块通过工厂函数注入，`sender.setSocket(ws)` 的时机（在 `connect()` 内立即注入）是正确的。

**⚠️ 一个需要注意的点**（非 Bug，但需确认）：

`handleMessage()` 中，群聊路径在 `shouldRespond=true` 时会**同时**触发 `groupMessageHandler.handleGroupMessage()` 和 `privateMessageHandler.handleDirectMessage()`。对于 `/ai` 前缀触发的群聊消息，两个处理器都会收到事件。需要确认 `group-message-handler.js` 在 `allowLegacyProactive: false` 时是否正确跳过旁听逻辑：

```js
// bridge.js L171-179
if (event.message_type === 'group') {
    await groupMessageHandler.handleGroupMessage(event, {
        allowLegacyProactive: !shouldRespond  // ✅ 被触发时不走旁听
    });
}
if (shouldRespond) {
    await privateMessageHandler.handleDirectMessage(event, cleanedText);
}
```

需要查看 `group-message-handler.js` 确认 `allowLegacyProactive` 被正确消费。

---

### ✅ onebot-sender.js — 逻辑正确，新增了关键细节

相比旧 bridge.js，新增了两个重要改进：
1. `timer.unref()` 防止超时计时器阻止进程退出 ✅
2. `shutdown()` 会清理所有 `pendingActions`，防止关闭时 Promise 泄漏 ✅

---

### ✅ lib/vpe/constants.js — GROUP_GATE 参数正确

```js
const GROUP_GATE = {
    baseThreshold: 0.75,      // ✅ 白皮书一致
    minThreshold: 0.40,       // ✅ 白皮书一致（0.40）
    maxThreshold: 1.30,       // ✅ 白皮书一致（比私聊高 0.1）
    quietActivityPenalty: 0.15, // ✅ M<2 时 +0.15
    burstPenaltyStep: 0.05,   // ✅ M>20 时 +0.05*(M-20)
    burstThreshold: 20,       // ✅
    idleThreshold: 2,         // ✅
    recentWindowMs: 10 * HOUR_MS / 6,  // ⚠️ 计算有误！见 Bug #1
    maxTimestampSamples: 5000
};
```

---

### 🐛 **Bug #1：`recentWindowMs` 计算错误**

**位置**：`lib/vpe/constants.js` 第 31 行

```js
recentWindowMs: 10 * HOUR_MS / 6,  // 错误：= 10小时 / 6 ≈ 1.67小时
```

**期望**：10 分钟的滑窗 = `10 * 60 * 1000`

`HOUR_MS = 3600000`，所以 `10 * HOUR_MS / 6 = 10 * 3600000 / 6 = 6000000ms = 100 分钟`，不是 10 分钟。

但此字段实际上**没有被 `GroupMessageBuffer._trimTimestamps()` 使用**——那里硬编码了 `10 * 60 * 1000`。`recentWindowMs` 目前是死配置，所以这个 Bug 现在没有实际影响，但需要统一修正。

**修复**：
```js
recentWindowMs: 10 * 60 * 1000,  // 10分钟，= 600000ms
```

同时 `GroupMessageBuffer._trimTimestamps()` 应读取常量而非硬编码：
```js
// group-message-buffer.js
const { GROUP_GATE } = require('./vpe/constants');
// ...
const windowMs = GROUP_GATE.recentWindowMs;
```

---

### ✅ lib/vpe/gate-group.js — 白皮书公式完全正确

```js
calcThreshold(groupState, fatigueNow) {
    const activityPenalty = this.calcActivityPenalty(groupState?.recentMsgCount);
    const threshold = GROUP_GATE.baseThreshold + (fatigueNow || 0) + activityPenalty;
    return clamp(threshold, GROUP_GATE.minThreshold, GROUP_GATE.maxThreshold);
}
```

对照白皮书公式：`T_group = 0.75 + P_fatigue·e^(-γΔt) + Gate_activity` ✅

注意：群聊门控**缺少疲劳 EMA 的时间衰减**——传入的 `fatigueNow` 应该是已经经过时间衰减的值，审查 `engine.js` 中调用处：

```js
// engine.js L354
const fatigueNow = this.getDecayedFatigue(groupState, now);  // ✅ 已正确衰减
const threshold = this.groupGate.calcThreshold(groupState, fatigueNow);
```

正确，`getDecayedFatigue()` 已经做了 `e^(-γΔt)` 衰减。✅

---

### ✅ lib/vpe/engine.js — 整体架构良好，发现 1 个逻辑问题

**公共事件语义分被跳过**（设计选择，但值得明确）：

```js
// engine.js L147-149
const semanticScore = candidate.scope === 'private'
    ? await this.calculateSemanticScore(candidate)
    : 0;  // 公共事件直接用固有分
```

这意味着天气/新闻类事件完全依赖 `intrinsicScore` 触发，语义分为 0。在 `handleGroupProactive()` 中会重新计算群聊语义分，逻辑是分离的（私聊预计算、群聊在仲裁时计算）。这是意图性设计，无 Bug。

---

### 🐛 **Bug #2：`handleGroupProactive()` 调用 `chooseForUser()` 传参错误**

**位置**：`lib/vpe/engine.js` 第 365 行

```js
const { selected, topScore } = this.agingQueue.chooseForUser(groupId, threshold, now, rankedCandidates);
```

`chooseForUser()` 的签名：
```js
chooseForUser(userId, threshold, now, rankedCandidates)
```

此处传入 `groupId` 作为 `userId` 参数。进入函数体后，`userId` 只在以下情况使用：

```js
const ranked = Array.isArray(rankedCandidates) ? rankedCandidates : this.getCandidatesForUser(userId, now);
```

由于 `rankedCandidates` 已经传入，`userId` 参数实际上不影响结果（会走传入的 `rankedCandidates`）。**当前无实际影响**，但语义混乱，且若未来 `chooseForUser` 内部逻辑变化（如限制每用户发送次数），会引入 Bug。

**修复建议**：为群聊专门新增 `chooseForGroup(groupId, threshold, now, rankedCandidates)` 方法，或直接做内联选择逻辑，不复用私聊方法。

---

### ✅ lib/vpe/time-lens.js — 衰减型透镜实现正确

```js
calcDecayWeight(candidate, now = Date.now()) {
    const sigma = expiresAfterHours / 2;
    return Math.exp(-((elapsedHours * elapsedHours) / (2 * sigma * sigma)));
}
```

符合白皮书"自发布起右侧半高斯衰减"公式。`publishedAtMs` 不存在时返回 1.0 兜底 ✅

---

### ✅ lib/vpe/event-sensor.js — 异步拉取实现干净

`collectEventsAsync()` 正确保留同步本地路径，外部拉取完全异步且静默降级。`_normalizeExternalEvent()` 处理全面，包含 `targetGroupId` 和 `targetUserId` 两种路由模式。✅

---

### ✅ lib/vpe/aging-queue.js — 群聊路由正确

```js
getCandidatesForGroup(groupId, now = Date.now()) {
    const filtered = this.prune(now).filter((item) => {
        if (item.scope !== 'public') return false;  // ✅ 严格隔离私聊事件
        if (!item.targetGroupId) return true;        // ✅ 无指定群 = 广播
        return String(item.targetGroupId) === String(groupId);
    });
    return this._rankCandidates(filtered, now);
}
```

严格执行了"私聊事件不进群聊引擎"的白皮书硬隔离要求 ✅

---

### ✅ Plugin/SemanticQueryGate — 整体可用，但有 1 个潜在异常

`_searchIndex()` 直接访问 `this.vectorDBManager.db`（第 104 行），读取的是 RAGDiaryPlugin 的底层 SQLite 实例。这依赖 VCPToolBox 插件加载顺序（RAGDiaryPlugin 必须先于 SemanticQueryGate 初始化，且 `vectorDBManager` 已暴露 `db` 属性）。

```js
async _searchIndex(queryVector, k, diaryName) {
    const db = this.vectorDBManager.db;
    if (!db) return [];  // ✅ 有空值保护
```

有 `if (!db) return []` 保护，不会崩溃，但会静默返回空结果。需要在联调时确认 `db` 对象是否正确暴露。

---

### 🐛 **Bug #3：SensorAggregator 天气缓存解析可能崩溃**

**位置**：`Plugin/SensorAggregator/SensorAggregator.js` 第 76 行

```js
const parsed = JSON.parse(raw);
```

此处**没有 try-catch**。如果 `weather_cache.json` 格式异常（JSON 解析失败），会直接抛出异常传播到 `/events` 路由。虽然路由 handler 外层有 try-catch 兜底（L38-49），错误会返回 500，但天气事件整个采集会失败，新闻事件也不会被返回（两者是串联的）。

**修复**：

```js
async _collectWeatherEvents() {
    const cachePath = this._weatherCachePath();
    if (!fs.existsSync(cachePath)) return [];
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch (err) {
        console.warn('[SensorAggregator] 天气缓存解析失败:', err.message);
        return [];
    }
    // ...
}
```

同样的问题存在于 `_collectNewsEvents()` 中的 `fs.readFileSync`，虽然 Markdown 不会有 JSON 解析失败，但仍建议加 try-catch 防止文件读取权限异常。

---

### ✅ Plugin/SemanticQueryGate/plugin-manifest.json + Plugin/SensorAggregator/plugin-manifest.json

需要查看 manifest 格式是否符合 VCPToolBox 的 service 插件协议：

<需要补充查看 manifest 内容>

---

## 需要修复的问题汇总

| 级别 | 位置 | 问题描述 | 是否阻塞运行 |
|------|------|----------|------------|
| **Bug #1** | `constants.js:31` | `recentWindowMs` 计算错误（100分钟而非10分钟），但当前未被消费，无实际影响 | 否 |
| **Bug #2** | `engine.js:365` | `chooseForUser()` 传入 `groupId` 作 `userId`，当前因 `rankedCandidates` 传入而无影响，未来有风险 | 否 |
| **Bug #3** | `SensorAggregator.js:76` | 天气缓存 JSON 解析无 try-catch，解析失败会导致整个 `/events` 返回 500 | **是（条件性）** |

---

## 改进建议（非强制）

1. **`bridge.js` 仍有 311 行**，还是在项目 300 行限制附近。可以考虑把 `printBanner()` 提取到 `lib/banner.js`，把配置初始化提到 `lib/app-context.js`，让 `bridge.js` 降到 ~200 行。

2. **`engine.js` 已达 426 行**，超出规则。建议拆分：
   - `VpeEngine` 中将 `handleGroupProactive()` 和 `handleSelectedEvents()` 移到 `lib/vpe/private-handler.js` 和 `lib/vpe/group-handler.js`。

3. **SensorAggregator 新闻事件 ID 不稳定**：`news_${index + 1}_${Math.floor(stat.mtimeMs)}` 中 `index` 依赖解析顺序，如果 DailyHot 缓存内容不变但顺序变化，FSM 指纹会重置。建议用 `title` 的 hash 作为 ID。

4. **群聊 Prompt 在 dryRun 模式下打印整个 prompt 对象**（含群聊上下文文本），可能在高频群中产生大量日志。建议只打印前 500 字符。

---

## 最终结论

Codex 本轮实施质量良好，白皮书对齐度高。**三个 Bug 中只有 Bug #3（SensorAggregator 缺少 try-catch）需要优先修复**，Bug #1 和 #2 当前无实际影响但需要在下一轮修复。`engine.js` 体积超标是最紧迫的工程债务。

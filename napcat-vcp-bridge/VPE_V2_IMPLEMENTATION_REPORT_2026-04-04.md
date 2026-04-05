# VPE V2 实施报告

## 文档信息

- 项目：`napcat-vcp-bridge`
- 报告时间：`2026-04-04`
- 执行者：Codex
- 参考文档：
  - `napcat-vcp-bridge/VPE_V2_HANDOFF.md`
  - `napcat-vcp-bridge/Proactivity_research/FINAL_ALGORITHM_MERGED.md`

---

## 1. 本次工作目标

本轮目标是基于既有 VPE v1 私聊主动发言能力，继续按 V2 推进计划把以下 4 类能力接入工程：

1. 收口工程债务：
   - 统一 embeddings 缓存
   - 拆分 `bridge.js`
2. 扩展群聊主动发言：
   - 群语境滑窗
   - 倒 U 型活跃度门控
   - 公共事件群聊仲裁
3. 接入 `SemanticQueryGate`
4. 接入 `SensorAggregator` 与衰减型时间透镜

---

## 2. 本次已完成内容

### 2.1 Bridge 结构重构

原先单体 `bridge.js` 已拆分为主入口 + 4 个职责模块：

- `napcat-vcp-bridge/bridge.js`
- `napcat-vcp-bridge/lib/onebot-sender.js`
- `napcat-vcp-bridge/lib/proactive-bootstrap.js`
- `napcat-vcp-bridge/lib/private-message-handler.js`
- `napcat-vcp-bridge/lib/group-message-handler.js`

当前职责分布：

- `bridge.js`：
  - 配置初始化
  - WebSocket 连接与重连
  - 启动编排
  - 消息分发
  - Banner / Shutdown
- `onebot-sender.js`：
  - `callOneBot`
  - `sendReply`
  - `sendGroupMessage`
  - `sendPrivateMessage`
  - `echo` 处理
- `proactive-bootstrap.js`：
  - 私聊主动引擎启动编排
  - 私聊入站追踪
- `private-message-handler.js`：
  - 私聊 / 被触发对话处理
- `group-message-handler.js`：
  - 群消息滑窗累积
  - 旧群聊主动链路兼容
  - 新 VPE 群状态更新入口

### 2.2 Embedding 缓存统一

已将 embedding 缓存统一收口到：

- `napcat-vcp-bridge/lib/vcp-client.js`

新增能力：

- 通用 embedding LRU 缓存
- `getCachedEmbedding()`
- `setCachedEmbedding()`
- `invalidateEmbeddingCache()`

调整结果：

- `lib/vpe/engine.js` 不再维护本地 embedding 缓存
- `lib/sentiment-analyzer.js` 不再维护独立 embedding 缓存
- 私聊语义分、情绪向量分析、后续群语境 embedding 共享同一缓存

### 2.3 群聊 VPE 主动发言链路

本轮已把群聊主动发言从“旧 RelevanceGate 群旁听”扩展为“VPE 群仲裁链路”。

已完成模块：

- `napcat-vcp-bridge/lib/group-message-buffer.js`
  - 新增 `getContextText()`
  - 新增 `getRecentMsgCount()`
  - 新增 `isVpeGroupEnabled()`
  - 新增 10 分钟消息时间戳滑窗
- `napcat-vcp-bridge/lib/vpe/gate-group.js`
  - 实现白皮书倒 U 型活跃度门控
- `napcat-vcp-bridge/lib/vpe/engine.js`
  - 新增 `recordGroupMessage()`
  - 新增 `handleGroupProactive()`
  - 在 `tick()` 中接入群聊主动仲裁

当前群聊主动链路行为：

1. 群消息到来时进入滑窗缓冲
2. 更新 `recentMsgCount`
3. VPE tick 拉取公共事件
4. 仅允许 `scope='public'` 的事件进入群聊仲裁
5. 用群最近聊天上下文生成群语境文本
6. 计算群阈值：
   - 基准阈值
   - fatigue
   - 倒 U 型活跃度惩罚
7. 突破后组装群聊 prompt 并执行发言

### 2.4 事件感知扩展

已扩展：

- `napcat-vcp-bridge/lib/vpe/event-sensor.js`

新增能力：

- 保留原本本地 `UserSchedule` / `ScheduleManager` 感知
- 新增 `collectEventsAsync()`
- 支持按配置拉取 `SensorAggregator` 的 `/events`
- 支持外部事件标准化

这样当前事件源已经变成：

1. 本地私聊日程
2. 兼容旧 `ScheduleManager`
3. 外部公共事件（天气 / 热点）

### 2.5 衰减型时间透镜

已在：

- `napcat-vcp-bridge/lib/vpe/time-lens.js`

新增：

- `calcDecayWeight()`

当前时间透镜行为：

- `schedule` 类事件：继续用高斯时间窗
- `weather` / `news` 类事件：改用发布后的半高斯衰减

### 2.6 SemanticQueryGate 插件

已新增插件目录：

- `Plugin/SemanticQueryGate/`

新增文件：

- `Plugin/SemanticQueryGate/plugin-manifest.json`
- `Plugin/SemanticQueryGate/SemanticQueryGate.js`

已完成能力：

- `POST /api/plugins/SemanticQueryGate/match`
- `GET /api/plugins/SemanticQueryGate/health`
- 基于向量检索结果返回：
  - `scores`
  - `semantic_score`

当前实现策略：

- 使用 Top-K chunk 检索结果
- 用 `top1 + 0.2 * top2` 作为 Soft-Maximum 聚合
- 属于白皮书语义组能力的“工程可用近似版”

同时已完成：

- `Plugin.js` 中对 `SemanticQueryGate` 的 `vectorDBManager` / `getSingleEmbedding` 依赖注入
- `napcat-vcp-bridge/lib/vcp-client.js` 中新增 `getSemanticScore()`
- `napcat-vcp-bridge/lib/vpe/engine.js` 中私聊语义分优先走 SQG，失败后回退本地 Soft-Maximum

### 2.7 SensorAggregator 插件

已新增插件目录：

- `Plugin/SensorAggregator/`

新增文件：

- `Plugin/SensorAggregator/plugin-manifest.json`
- `Plugin/SensorAggregator/SensorAggregator.js`

已完成能力：

- `GET /api/plugins/SensorAggregator/events`
- `GET /api/plugins/SensorAggregator/health`

当前聚合来源：

- `Plugin/WeatherReporter/weather_cache.json`
- `Plugin/DailyHot/dailyhot_cache.md`

当前可产出事件：

- `weather`
- `news`

### 2.8 Prompt 层扩展

已在：

- `napcat-vcp-bridge/lib/vpe/prompt-builder.js`

新增：

- `buildGroup()`

用于群聊主动发言场景，将：

- 最近群聊上下文
- 当前公共事件
- 群聊语气约束

组装成群聊主动 prompt。

### 2.9 配置扩展

已更新：

- `napcat-vcp-bridge/config.json`

新增配置区：

```json
"vpe": {
  "groups": [],
  "semanticQueryGateUrl": "http://localhost:5890/api/plugins/SemanticQueryGate",
  "semanticQueryGateToken": "",
  "sensorUrl": "http://localhost:5890/api/plugins/SensorAggregator",
  "sensorToken": ""
}
```

这部分默认仍是保守配置，不会自动改变现有群聊行为，除非显式填入群号并启用对应环境。

### 2.10 文档同步

已更新：

- `napcat-vcp-bridge/VPE_V2_HANDOFF.md`

补充了：

- 本轮已完成项
- 当前验证情况
- 仍待联调事项

---

## 3. 本次改动文件清单

### 新增文件

- `napcat-vcp-bridge/lib/onebot-sender.js`
- `napcat-vcp-bridge/lib/proactive-bootstrap.js`
- `napcat-vcp-bridge/lib/private-message-handler.js`
- `napcat-vcp-bridge/lib/group-message-handler.js`
- `napcat-vcp-bridge/lib/vpe/gate-group.js`
- `Plugin/SemanticQueryGate/plugin-manifest.json`
- `Plugin/SemanticQueryGate/SemanticQueryGate.js`
- `Plugin/SensorAggregator/plugin-manifest.json`
- `Plugin/SensorAggregator/SensorAggregator.js`
- `napcat-vcp-bridge/VPE_V2_IMPLEMENTATION_REPORT_2026-04-04.md`

### 修改文件

- `napcat-vcp-bridge/bridge.js`
- `napcat-vcp-bridge/config.json`
- `napcat-vcp-bridge/lib/group-message-buffer.js`
- `napcat-vcp-bridge/lib/sentiment-analyzer.js`
- `napcat-vcp-bridge/lib/vcp-client.js`
- `napcat-vcp-bridge/lib/vpe/constants.js`
- `napcat-vcp-bridge/lib/vpe/state-store.js`
- `napcat-vcp-bridge/lib/vpe/event-sensor.js`
- `napcat-vcp-bridge/lib/vpe/event-fsm.js`
- `napcat-vcp-bridge/lib/vpe/time-lens.js`
- `napcat-vcp-bridge/lib/vpe/aging-queue.js`
- `napcat-vcp-bridge/lib/vpe/prompt-builder.js`
- `napcat-vcp-bridge/lib/vpe/engine.js`
- `Plugin.js`
- `napcat-vcp-bridge/VPE_V2_HANDOFF.md`

### 本轮未改动但工作区本来就脏的文件

以下文件在进入本轮前已经存在未提交状态，本轮未作为主要改动目标：

- `napcat-vcp-bridge/lib/context-manager.js`
- `napcat-vcp-bridge/lib/message-utils.js`
- `napcat-vcp-bridge/lib/private-proactive-scheduler.js`
- 以及部分文档 / 数据目录

---

## 4. 验证情况

### 4.1 静态检查

已通过 `node --check`：

- `napcat-vcp-bridge/bridge.js`
- `napcat-vcp-bridge/lib/onebot-sender.js`
- `napcat-vcp-bridge/lib/proactive-bootstrap.js`
- `napcat-vcp-bridge/lib/private-message-handler.js`
- `napcat-vcp-bridge/lib/group-message-handler.js`
- `napcat-vcp-bridge/lib/vcp-client.js`
- `napcat-vcp-bridge/lib/sentiment-analyzer.js`
- `napcat-vcp-bridge/lib/group-message-buffer.js`
- `napcat-vcp-bridge/lib/vpe/engine.js`
- `napcat-vcp-bridge/lib/vpe/event-sensor.js`
- `napcat-vcp-bridge/lib/vpe/event-fsm.js`
- `napcat-vcp-bridge/lib/vpe/time-lens.js`
- `napcat-vcp-bridge/lib/vpe/aging-queue.js`
- `napcat-vcp-bridge/lib/vpe/gate-group.js`
- `Plugin/SemanticQueryGate/SemanticQueryGate.js`
- `Plugin/SensorAggregator/SensorAggregator.js`
- `Plugin.js`

### 4.2 烟雾测试

本轮完成了 3 组轻量烟雾测试：

1. 群聊 VPE 仲裁测试
   - 手动构造群消息滑窗
   - 写入一条 `scope='public'` 公共事件
   - 验证 `handleGroupProactive()` 会进入群聊仲裁日志
   - 结果：通过

2. SensorAggregator 事件生成测试
   - 读取本地 `WeatherReporter` 缓存
   - 读取本地 `DailyHot` 缓存
   - 成功产出：
     - `1` 条天气事件
     - `2` 条热点事件
   - 结果：通过

3. SemanticQueryGate Soft-Maximum 测试
   - 在 mock `vectorDBManager` 条件下执行 `_match()`
   - 返回 `semantic_score = 0.9`
   - 结果：通过

---

## 5. 当前实现状态判断

### 已达到

- V2 计划中的主要工程骨架已经搭好
- 私聊 VPE 主链路继续保留
- 群聊 VPE 新链路已进入代码层
- SQG / Sensor 两个插件已具备可启动的 service-plugin 形态
- 时间透镜、事件感知、门控、Prompt 四层已经支持公共事件

### 还未达到

- 还未完成真实 NapCat 在线联调
- 还未完成真实 VCP 插件加载验证
- 还未验证 bridge 与 VCP 在同一运行环境下的全链路实发
- `SemanticQueryGate` 还不是“真正语义组聚类版”，而是工程近似版

---

## 6. 已知限制与风险

### 6.1 SemanticQueryGate 仍是近似实现

当前 SQG 仍是：

- 事件文本 embedding
- Top-K chunk 检索
- Soft-Maximum 聚合

优点是工程上可用，缺点是还没有真正把“用户兴趣语义组”显式建模出来。

### 6.2 SensorAggregator 目前依赖缓存文件

当前 SA 聚合的是已有缓存：

- `DailyHot` cache
- `WeatherReporter` cache

这意味着：

- 如果缓存未更新，事件会陈旧
- 需要下一步确认生产环境缓存刷新是否稳定

### 6.3 群聊主动发言尚未完成真实场景验证

代码层已接好，但仍需验证：

- 群语境与群阈值是否过严/过松
- 公共事件是否会造成突兀插话
- `dryRun=false` 后是否有实际行为偏差

---

## 7. 推荐下一步

建议按这个顺序继续：

1. 在 VCP 进程内确认 `SemanticQueryGate` 与 `SensorAggregator` 已被插件系统正确加载
2. 用 HTTP 直接测试：
   - `POST /api/plugins/SemanticQueryGate/match`
   - `GET /api/plugins/SensorAggregator/events`
3. 在 `napcat-vcp-bridge/config.json` 中填写：
   - `bot.proactive.vpe.groups`
   - 如果需要，填写 `semanticQueryGateUrl` 与 `sensorUrl`
4. 保持 `dryRun=true` 进行一次真实 QQ 联调
5. 确认日志正常后，再考虑开启真实发送

---

## 8. 结论

本轮不是只做了“局部补丁”，而是把 V2 计划里的核心骨架整体推进到了可联调状态：

- 工程结构已重构
- 群聊主动发言已具备代码闭环
- SQG / Sensor 插件已落地
- 时间透镜与事件感知已扩展到公共事件

距离“可上线”还差最后一段真实环境联调，但从代码实现层面看，V2 已经从“设计计划”进入“可验证工程阶段”。

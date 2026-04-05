# VPE v1 私聊主动发言引擎交接状态日志

## 文档元信息
- 记录时间：2026-04-02
- 工作目录：`C:\Users\Lenovo\Desktop\Project N\VCPToolBox`
- 子项目：`napcat-vcp-bridge`
- 当前分支：`my-config`
- 记录时 HEAD：`2b2147b`
- 本次目标：实现 VPE v1 的私聊主动发言 MVP，并保留旧版私聊主动调度器作为兼容模式

## 当前结论
- VPE v1 的核心代码已经落地。
- 代码当前可通过静态语法检查，并完成了轻量级运行时实例化验证。
- `review_v1.md` 中标出的高优先级问题已经完成一轮修复，默认 `legacy` 模式的兼容性风险已收口。
- 默认配置仍然是安全模式：
  - `bot.proactive.private.strategy = "legacy"`
  - `bot.proactive.private.vpe.dryRun = true`
- 这意味着当前仓库状态下，不会自动切到新引擎，也不会直接真实向用户发私聊。

## 本次已完成内容

### 1. 主入口集成
- 在 `bridge.js` 中加入私聊主动模式切换。
- 现在支持两种私聊主动策略：
  - `legacy`：继续使用旧的 `private-proactive-scheduler`
  - `vpe`：启用新的 VPE 引擎
- 私聊消息流新增了 VPE 所需钩子：
  - 收到私聊消息时更新亲和度
  - 写入独立私聊历史缓冲
  - 命中“主动发话后 60 分钟内回复”时触发破冰奖励
- 启动完成后会按策略自动启动旧调度器或新引擎

### 2. 状态底座与迁移
- 新增 `vpe_state.json` 状态模型，对应代码在 `lib/vpe/state-store.js`
- 首次加载时支持从旧 `affinity_data.json` 自动迁移用户状态
- 状态树已包含：
  - `users`
  - `groups`
  - `events_fsm`
  - `pendingQueue`
  - `_meta`
- 已将 `napcat-vcp-bridge/vpe_state.json` 加入 `.gitignore`

### 3. 亲和度系统重写
- 重写 `lib/affinity-manager.js`
- 已实现：
  - Soft Cap 涨分
  - 牛顿冷却式衰减
  - 幽灵惩罚
  - 破冰奖励
  - 疲劳 EMA
  - 本地时区日切的每日主动次数限制
  - 私聊历史持久化接口
  - legacy 字段兼容别名（`lastProactiveTime` / `lastMessageTime`）

### 4. 情绪打分系统升级
- 重写 `lib/sentiment-analyzer.js`
- 新增 `data/emotion_anchors.json`
- 已实现：
  - 差分质心双轴情绪投影
  - 中性质心校准
  - Arousal 轴正交化
  - embeddings 不可用时自动回退到词典模式
  - 词典模式负面分收敛到 `-1.5`

### 5. VCP 客户端扩展
- 扩展 `lib/vcp-client.js`
- 已新增：
  - `getEmbeddingsUrl()`
  - `getEmbeddings(input, model)`
  - `getEmbedding(input, model)`
  - `checkRelevanceWithOptions(text, options)`
- 倒置 RAG 已支持：
  - `diary_name`
  - 自定义 `k`
  - 自定义 `threshold`

### 6. 新增 VPE 核心模块
- `lib/vpe/constants.js`
- `lib/vpe/utils.js`
- `lib/vpe/state-store.js`
- `lib/vpe/event-sensor.js`
- `lib/vpe/event-fsm.js`
- `lib/vpe/time-lens.js`
- `lib/vpe/aging-queue.js`
- `lib/vpe/gate-private.js`
- `lib/vpe/prompt-builder.js`
- `lib/vpe/engine.js`

### 7. 事件源与安全路由
- 私聊事件源已按方案接入：
  - 主路径：`Plugin/UserSchedule/user_schedules.json`
  - 兼容路径：`Plugin/ScheduleManager/schedules.json`
- `UserSchedule.target_user` 解析顺序已固定：
  - QQ 号精确匹配
  - remark 精确匹配
  - nickname 精确匹配
- 无法解析归属用户时只记日志，不会猜测目标用户
- 旧 `ScheduleManager` 只有在以下场景才会启用：
  - 显式配置 `legacyScheduleTargetUserId`
  - 白名单用户恰好只有 1 人

### 8. 私聊主动 Prompt
- 主动发言 Prompt 已改为独立私聊历史缓冲，不再复用 `ContextManager` 的共享上下文
- 已实现的 Prompt 结构包含：
  - 原系统提示词
  - 最近最多 2 轮私聊历史
  - `<proactive_trigger>` 沙盒块
  - 强引导结尾
- 倒置 RAG 使用 `RelevanceGate /check`
- 当前策略：
  - `k = 1`
  - `threshold = 0`
  - top1 分数 `< 0.65` 则不注入记忆
  - 若配置 `diaryMap` 则带 `diary_name`
  - 否则全局检索
- 历史裁切已增加 user-first 对齐，避免 prompt 以 assistant 历史开头

### 9. Review 修复回合（针对 `review_v1.md`）
- 已修复：
  - `legacy` 调度器新旧字段名不兼容
  - 时间透镜缺少“过期熔断”
  - UCB category 硬编码为 `schedule`
  - `state-store.js` GC 重复分支写盘
  - 词典模式负面分过重
  - Prompt 历史可能半轮切割
  - 私聊历史每次写盘改为 debounce 保存
- 已部分朝白皮书收敛：
  - 私聊语义分不再使用“历史质心余弦”
  - 改为“事件向量 vs 最近历史逐条相似度”的 `top1 + 0.2 * top2` Soft-Maximum 聚合
- 仍未处理：
  - `engine.js` 与 `sentiment-analyzer.js` 的 embeddings 缓存仍然是两套
  - `bridge.js` 体积仍偏大，尚未继续拆分
  - 衰变型事件（天气/新闻）的时间透镜尚未实现，因为当前 MVP 还未接这些事件源

## 当前配置状态
- `napcat-vcp-bridge/config.json` 已新增：
  - `bot.proactive.private.strategy`
  - `bot.proactive.private.vpe.tickMinutes`
  - `bot.proactive.private.vpe.dryRun`
  - `bot.proactive.private.vpe.embeddingModel`
  - `bot.proactive.private.vpe.legacyScheduleTargetUserId`
  - `bot.proactive.private.vpe.diaryMap`
- 当前默认值：
  - `strategy = "legacy"`
  - `tickMinutes = 10`
  - `dryRun = true`
  - `embeddingModel = ""`
- 运行时若 `embeddingModel` 为空，会自动尝试读取 `process.env.WhitelistEmbeddingModel` 的第一个模型名

## 已完成验证

### 1. 静态语法检查
已执行并通过：
- `node --check napcat-vcp-bridge/bridge.js`
- `node --check napcat-vcp-bridge/lib/affinity-manager.js`
- `node --check napcat-vcp-bridge/lib/sentiment-analyzer.js`
- `node --check napcat-vcp-bridge/lib/vcp-client.js`
- `node --check napcat-vcp-bridge/lib/private-proactive-scheduler.js`
- `node --check napcat-vcp-bridge/lib/vpe/*.js`

### 2. 轻量运行时实例化验证
已验证以下链路能正常构造：
- 配置加载
- `VpeStateStore` 初始化
- 旧 `affinity_data.json` 迁移
- `AffinityManager` 初始化
- `VpeEngine` 初始化

### 3. 轻量行为验证
已通过 Node 脚本验证：
- 正向消息会提升亲和度
- 超时未回复会触发幽灵惩罚
- Schedule 事件能命中 Stage 0 窗口
- 老化队列能在超过阈值时选出事件
- legacy 字段别名兼容有效
- 时间透镜在目标时间后会硬归零
- Prompt 历史不会以 assistant 开头
- Soft-Maximum 语义分逻辑可正常返回聚合结果

## 当前未完成项
- 未做真实 NapCat 联机发送验证
- 未做真实 VCP embeddings 联机验证
- 未做真实 `RelevanceGate` 倒置 RAG 联机验证
- 未做真实 `UserSchedule -> VPE -> send_private_msg` 端到端闭环
- 群聊主动发言未重构
- 天气/热点未接入
- `SemanticQueryGate` 未实现
- `SensorAggregator` 未实现
- embeddings 缓存尚未统一到 `vcp-client.js`
- `bridge.js` 尚未做进一步拆分
- 衰变型事件时间透镜尚未实现

## 当前已知风险

### 1. 工作区本身是脏的
在本次实现开始前，以下内容已经处于未提交状态，不应误判为本次改动引入：
- `napcat-vcp-bridge/lib/context-manager.js`
- `napcat-vcp-bridge/lib/message-utils.js`
- `Plugin/UserSchedule/`
- `Plugin/UserScheduleBriefing/`
- `napcat-vcp-bridge/Proactivity_research/`

### 2. embeddings 实际联机尚未验证
- 虽然代码路径已接通，但尚未对当前 VCP 服务进行真实请求验证
- 如果 embeddings 模型名、API Key 或白名单配置不匹配，会自动降级到词典情绪模式

### 3. 倒置 RAG 目前默认允许全局检索
- 若未配置 `diaryMap`，会走全库检索
- 功能上可用，但不一定满足后续“按用户强隔离日记本”的要求

### 4. Dry Run 模式下不会推进真正发送闭环
- `dryRun=true` 仅记录日志，不会发私聊
- 因为不发送，所以这时也不会完成真实“用户回复后破冰”的完整线上验证

### 5. `$S_sem` 仍是 MVP 级替代实现
- 当前私聊语义分已经改为 Soft-Maximum 聚合，但数据源仍来自“最近私聊历史 embeddings”
- 这比最初的历史质心实现更稳，但仍不等价于白皮书中的 `SemanticQueryGate`
- 如果后续要追求白皮书一致性，仍应引入真正的“用户语义组匹配分数”接口

## 建议的接手顺序

### 第一阶段：只观察日志
- 将 `strategy` 改为 `vpe`
- 保持 `dryRun = true`
- 准备一条 `UserSchedule` 测试日程
- 观察日志是否出现：
  - 事件感知
  - FSM 命中
  - 时间透镜得分
  - 队列入队
  - 门控突破或未突破
  - Prompt 预览

### 第二阶段：做一次真实闭环
- 确认 embeddings 正常
- 确认 RelevanceGate 正常
- 将 `dryRun = false`
- 用白名单中的测试 QQ 做一条真实日程提醒
- 验证是否：
  - 成功主动发出私聊
  - 写入 `pendingReplySince`
  - 回复后触发破冰奖励
  - 超时后触发幽灵惩罚

### 第三阶段：收口配置
- 如果后续要严格做按用户记忆隔离：
  - 补 `diaryMap`
  - 明确 QQ 用户到日记本名的映射约定
- 如果仍需兼容旧 `ScheduleManager`：
  - 显式配置 `legacyScheduleTargetUserId`

### 第四阶段：继续做工程收尾
- 如需继续优化代码质量，优先级建议如下：
  - 统一 embeddings 缓存
  - 拆分 `bridge.js`
  - 为天气/新闻补充衰变型时间透镜
  - 若进入 v2，再补 `SemanticQueryGate` / `SensorAggregator`

## 本次实际新增/修改文件

### 本次明确改动
- `.gitignore`
- `napcat-vcp-bridge/bridge.js`
- `napcat-vcp-bridge/config.json`
- `napcat-vcp-bridge/lib/affinity-manager.js`
- `napcat-vcp-bridge/lib/private-proactive-scheduler.js`
- `napcat-vcp-bridge/lib/sentiment-analyzer.js`
- `napcat-vcp-bridge/lib/vcp-client.js`
- `napcat-vcp-bridge/data/emotion_anchors.json`
- `napcat-vcp-bridge/lib/vpe/constants.js`
- `napcat-vcp-bridge/lib/vpe/utils.js`
- `napcat-vcp-bridge/lib/vpe/state-store.js`
- `napcat-vcp-bridge/lib/vpe/event-sensor.js`
- `napcat-vcp-bridge/lib/vpe/event-fsm.js`
- `napcat-vcp-bridge/lib/vpe/time-lens.js`
- `napcat-vcp-bridge/lib/vpe/aging-queue.js`
- `napcat-vcp-bridge/lib/vpe/gate-private.js`
- `napcat-vcp-bridge/lib/vpe/prompt-builder.js`
- `napcat-vcp-bridge/lib/vpe/engine.js`

### 记录但非本次新增
- `napcat-vcp-bridge/lib/context-manager.js`
- `napcat-vcp-bridge/lib/message-utils.js`
- `Plugin/UserSchedule/`
- `Plugin/UserScheduleBriefing/`
- `napcat-vcp-bridge/Proactivity_research/`

## 交接备注
- 当前代码已经进入“可联调”状态，但还不应直接视为“已生产验证完成”
- 如果下一位接手人要继续推进，最优先的不是再改算法，而是做一轮真实联机观测
- 只有完成真实 `dryRun=false` 闭环后，这一版才能从“实现完成”升级为“功能验收完成”
- `review_v1.md` 已经不再完全反映当前代码状态；继续排查时应以本文件和最新代码为准

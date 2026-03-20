# ConnorLED — TagMemo 驱动的 LED 状态系统

基于 VCP 的 TagMemo 向量搜索算法，实时计算用户消息与 Connor 日记本记忆的匹配度，将 LED 颜色注入到系统提示词中。

## 工作原理

```
用户消息 → Embedding → TagMemo 搜索日记本 → 记忆匹配分数 → LED 颜色
                                                              │
                                    ┌─────────────────────────┤
                                    │           │             │
                                 ≥ 0.50     0.25~0.50      < 0.25
                                 🔵 蓝       🟡 黄          🔴 红
                                 自信冷静     不确定         偏差临界
```

插件在每次对话时：
1. 提取用户最新消息
2. 调用 `getSingleEmbedding` 向量化
3. 在指定日记本中执行 TagMemo 增强的向量搜索
4. 根据最高匹配分数映射 LED 颜色
5. 替换系统提示词中的 `{{VCPConnorLED}}` 占位符

## 使用方法

在 Agent 提示词（如 `Agent/Connor.txt`）中插入占位符：

```
{{VCPConnorLED}}
```

插件会将其替换为类似：

```
[系统状态: LED=蓝] 你的内部记忆检索系统报告：当前对话话题与你的已有记忆高度匹配（记忆匹配度: 72%）。你处于自信、冷静的机器模式。
```

## 配置

在 `Plugin/ConnorLED/` 下创建 `config.env`（可选）：

```env
# LED 颜色阈值
LED_BLUE_THRESHOLD=0.50    # ≥ 此值 → 蓝色
LED_RED_THRESHOLD=0.25     # < 此值 → 红色；之间 → 黄色

# 搜索的日记本名称（逗号分隔）
LED_DIARY_NAMES=Connor

# TagMemo tag 增强权重
LED_TAG_BOOST=0.15

# 搜索返回的 top-K
LED_SEARCH_K=3
```

## 依赖

- **RAGDiaryPlugin** — 提供 `vectorDBManager` 和 `getSingleEmbedding`
- 需要在 `Plugin.js` 中配置依赖注入（已内置）

## 插件类型

`messagePreprocessor` — 在消息发给 LLM 之前执行，替换占位符。

## LED 颜色语义

| 分数 | 颜色 | Connor 角色含义 |
|------|------|----------------|
| ≥ 0.50 | 🔵 蓝 | 高度匹配记忆，自信冷静，机器模式 |
| 0.25~0.50 | 🟡 黄 | 部分匹配，不确定，内部冲突 |
| < 0.25 | 🔴 红 | 陌生领域，偏差临界，情感涌现 |

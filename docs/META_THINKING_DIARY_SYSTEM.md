# VCP 元思考模块与日记系统深度解析

**版本:** VCP 当前主线
**生成日期:** 2026-03-12
**核心模块:** RAGDiaryPlugin, MetaThinkingManager, AIMemoHandler, LightMemo, SemanticGroupManager

---

## 目录

1. [日记系统总览](#1-日记系统总览)
2. [RAGDiaryPlugin — 核心记忆插件](#2-ragdiaryplugin--核心记忆插件)
3. [元思考模块 (MetaThinkingManager)](#3-元思考模块-metathinkingmanager)
4. [AI 级回忆模块 (AIMemoHandler)](#4-ai-级回忆模块-aimemohandler)
5. [语义分组管理器 (SemanticGroupManager)](#5-语义分组管理器-semanticgroupmanager)
6. [上下文向量管理器 (ContextVectorManager)](#6-上下文向量管理器-contextvectormanager)
7. [LightMemo — 轻量 RAG 插件](#7-lightmemo--轻量-rag-插件)
8. [完整检索流程](#8-完整检索流程)
9. [缓存体系](#9-缓存体系)
10. [配置参考](#10-配置参考)

---

## 1. 日记系统总览

VCP 日记系统是一套为 AI 角色提供**长期记忆**的完整解决方案。其核心思想是：将角色的历史对话、经历、情感记录以日记文件形式存储，在每次对话时通过语义检索找到最相关的记忆片段注入上下文。

### 1.1 系统组成

```
日记系统
├── RAGDiaryPlugin          主记忆插件（被动触发，系统提示词语法驱动）
│   ├── MetaThinkingManager     元思考：递归多阶段向量精炼
│   ├── AIMemoHandler           AI级回忆：用 LLM 提炼记忆摘要
│   ├── SemanticGroupManager    语义分组：增强向量语义覆盖
│   ├── ContextVectorManager    上下文向量：融合对话历史
│   └── TimeExpressionParser    时间表达式解析
└── LightMemo               轻量 RAG 插件（主动调用，工具形式）
    └── BM25Ranker              关键词加权排序
```

### 1.2 两种触发方式对比

| 维度 | RAGDiaryPlugin | LightMemo |
|------|---------------|-----------|
| 触发方式 | 被动（系统提示词语法） | 主动（AI 调用工具） |
| 适用场景 | 角色扮演、长期记忆 | 知识库查询、主动搜索 |
| 检索算法 | 向量语义 + 元思考 | 向量语义 + BM25 |
| Rerank | 支持 | 支持 |
| 时间感知 | 支持 | 支持（语法约束） |

---

## 2. RAGDiaryPlugin — 核心记忆插件

### 2.1 插件类型

RAGDiaryPlugin 是一个 **Hybrid Service Plugin**，在 VCP 进程内直接运行，通过内部 HTTP 服务与主框架通信，避免跨进程序列化开销。

### 2.2 四种日记调用语法

在系统提示词中使用以下语法触发日记检索：

```
{{角色日记本}}          无条件全量注入 —— 直接插入全部日记内容
[[角色日记本]]          无条件 RAG 检索 —— 始终执行向量检索，返回最相关片段
<<角色日记本>>          相似度阈值全量注入 —— 相似度达标才注入全量内容
《《角色日记本》》       相似度阈值 RAG 检索 —— 相似度达标才执行 RAG 检索
```

其中"角色日记本"对应 `dailynote/` 目录下的子文件夹名称。

### 2.3 多层缓存架构

```
查询请求
    │
    ▼
┌─────────────────────────────────┐
│  Query Result Cache             │  200 条，TTL 1小时
│  key: SHA256(query+params)      │  命中 → 直接返回
└─────────────────────────────────┘
    │ 未命中
    ▼
┌─────────────────────────────────┐
│  Embedding Cache                │  500 条，TTL 2小时
│  key: SHA256(text)              │  命中 → 跳过 API 调用
└─────────────────────────────────┘
    │ 未命中
    ▼
┌─────────────────────────────────┐
│  AIMemo Cache                   │  50 条，TTL 30分钟
│  key: SHA256(files+query)       │  命中 → 跳过 LLM 调用
└─────────────────────────────────┘
    │ 未命中
    ▼
  执行完整检索流程
```

### 2.4 配置哈希失效机制

每次请求时计算当前配置的 SHA256 哈希，与上次比较。若配置发生变更（如修改 `rag_params.json`），自动清空所有缓存，确保新参数立即生效。

---

## 3. 元思考模块 (MetaThinkingManager)

元思考是 RAGDiaryPlugin 最核心的创新，通过**递归多阶段向量精炼**逐步逼近最相关的记忆。

### 3.1 核心思想

普通 RAG 只做一次向量检索。元思考的思路是：

> 用第一次检索的结果来**精炼查询向量**，再做第二次检索，如此递归，每一轮都比上一轮更精准。

### 3.2 执行流程

```
用户输入 (query)
        │
        ▼
生成初始查询向量 q₀
        │
        ▼
┌─── Stage 1 ───────────────────────────────┐
│  在日记向量库中检索 top-k₁ 条结果          │
│  计算结果向量的加权平均 r₁                  │
│  向量融合: q₁ = 0.4×q₀ + 0.6×r₁          │
└────────────────────────────────────────────┘
        │
        ▼
┌─── Stage 2 ───────────────────────────────┐
│  用 q₁ 检索 top-k₂ 条结果                 │
│  计算结果向量加权平均 r₂                    │
│  向量融合: q₂ = 0.4×q₁ + 0.6×r₂          │
└────────────────────────────────────────────┘
        │
        ▼
   ... (最多 5 个阶段) ...
        │
        ▼
最终阶段结果 → 去重 → 返回
```

**向量融合公式：**
```
q_next = 0.4 × q_current + 0.6 × mean(result_vectors)
```

这个比例意味着：每一步都保留 40% 的原始查询方向，同时向检索结果的语义中心靠拢 60%。

### 3.3 调用语法

在系统提示词的日记语法中追加元思考指令：

```
[[角色日记本::VCP元思考:<链名>::<修饰符>:<k序列>]]
```

**参数说明：**

| 参数 | 说明 | 示例 |
|------|------|------|
| `<链名>` | 思考链标识符，对应 `meta_thinking_chains.json` 中的配置 | `default`, `deep` |
| `<修饰符>` | 可选，调整检索行为 | `broad`, `precise` |
| `<k序列>` | 各阶段检索数量，逗号分隔 | `5,3,2,1,1` |

**示例：**
```
[[Nova日记本::VCP元思考:default::5,3,2,1,1]]
[[Nova日记本::VCP元思考:deep::broad:8,5,3,2,1]]
```

### 3.4 K 序列设计模式

| 模式 | K 序列 | 适用场景 |
|------|--------|----------|
| 前宽后窄 | `5,3,2,1,1` | 通用，平衡精度与召回 |
| 均衡 | `3,3,3,3,3` | 稳定检索，避免漂移 |
| 快速 | `5,2,1` | 3阶段快速收敛 |
| 深度 | `8,5,3,2,1` | 复杂查询，高召回 |

### 3.5 Auto 模式

当链名为 `auto` 时，MetaThinkingManager 自动根据查询与各预设链的相似度，选择最匹配的思考链：

```
[[角色日记本::VCP元思考:auto]]
```

系统计算查询向量与每条链的"代表向量"的余弦相似度，选择相似度最高的链执行。

### 3.6 语义分组增强

在每个阶段的向量融合中，SemanticGroupManager 可以额外注入语义分组向量：

```
q_enhanced = q_stage + α × semantic_group_vector
```

语义分组将相关概念（如"情感"、"工作"、"家庭"等）预先聚类，检索时自动扩展语义覆盖范围。

### 3.7 VCP Log 广播

每次元思考执行后，MetaThinkingManager 通过 `pushVcpInfo` 向 VCP Log 广播详细执行信息，包括：
- 各阶段检索到的文档标题和相似度分数
- 向量融合前后的余弦相似度变化
- 最终选用的思考链和 K 序列
- 总耗时

---

## 4. AI 级回忆模块 (AIMemoHandler)

### 4.1 定位

AIMemoHandler 是元思考的补充，适用于**需要跨多个日记文件综合提炼**的场景。它不做向量检索，而是直接将日记内容喂给 LLM，让 AI 自己提炼相关记忆。

### 4.2 处理流程

```
确定目标日记文件列表
        │
        ▼
估算 token 总量
(文件 tokens + 10k 固定开销)
        │
        ├─ token 量小 → 单次处理
        │
        └─ token 量大 → 分批处理
                │
                ▼
        每批调用外部 LLM API
        (AIMemoUrl + AIMemoApi + AIMemoModel)
                │
                ▼
        收集各批次摘要
        │
        ▼
合并所有批次结果 → 返回综合记忆摘要
```

### 4.3 与元思考的协作

在 RAGDiaryPlugin 的完整检索流程中，AIMemo 和元思考可以并行执行：

```
用户查询
    ├──→ 元思考检索 (向量精炼)     ─┐
    └──→ AIMemo 提炼 (LLM 摘要)   ─┤
                                    ▼
                              结果合并去重
                                    │
                                    ▼
                              注入系统提示词
```

### 4.4 配置

```env
# Plugin/RAGDiaryPlugin/config.env
AIMemoModel=your-model-name
AIMemoBatch=5                    # 每批处理文件数
AIMemoUrl=http://...             # LLM API 地址
AIMemoApi=sk-...                 # API Key
AIMemoMaxTokensPerBatch=60000    # 每批最大 token 数
AIMemoPrompt=AIMemoPrompt.txt    # 提炼用的系统提示词
```

---

## 5. 语义分组管理器 (SemanticGroupManager)

### 5.1 作用

将日记内容按语义主题预先聚类，形成"语义分组"。检索时，系统识别查询属于哪个语义分组，并将该分组的中心向量融入查询向量，扩大语义覆盖。

### 5.2 配置文件

```
Plugin/RAGDiaryPlugin/
├── semantic_groups.json          语义分组定义（自动生成）
├── semantic_groups.edit.json     手动编辑版本
└── semantic_vectors/             各分组的预计算向量
```

### 5.3 分组示例结构

```json
{
  "groups": [
    {
      "name": "情感记忆",
      "keywords": ["喜欢", "难过", "开心", "思念"],
      "vector": [...]
    },
    {
      "name": "日常生活",
      "keywords": ["吃饭", "睡觉", "工作", "散步"],
      "vector": [...]
    }
  ]
}
```

---

## 6. 上下文向量管理器 (ContextVectorManager)

### 6.1 作用

将当前对话的历史消息向量化，与用户当前查询融合，使检索更贴合对话上下文而非仅依赖单条消息。

### 6.2 融合策略

```
最终查询向量 = α × 当前消息向量 + β × 历史上下文向量
```

配置项：
```env
CONTEXT_VECTOR_ALLOW_API_HISTORY=false   # 是否允许使用 API 传入的历史消息
```

---

## 7. LightMemo — 轻量 RAG 插件

### 7.1 定位

LightMemo 是供 AI **主动调用**的知识库搜索工具，通过 VCP 工具调用语法触发：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」SearchRAG「末」
query:「始」搜索内容「末」
<<<[END_TOOL_REQUEST]>>>
```

### 7.2 BM25 混合检索

LightMemo 在向量检索基础上叠加 BM25 关键词排序：

```
最终分数 = 向量相似度分数 × BM25权重因子
```

BM25 使用结巴（jieba）中文分词，过滤停用词后计算词频-逆文档频率权重。

### 7.3 时间范围语法

在查询中嵌入时间约束：

```
[2025-04-11~2025-05-12] 查询内容    # 日期范围
[2026-02-14] 查询内容               # 单日
```

系统解析时间范围后，在向量检索结果中过滤不在范围内的日记条目。

### 7.4 特殊检索模式

```
[音乐检索] 查询内容     # 切换到音乐专用索引
```

### 7.5 Rerank 流程

```
向量检索 top-(k × RerankMultiplier) 条
        │
        ▼
调用 Rerank API (Qwen3-Reranker-8B)
对候选结果重新打分排序
        │
        ▼
取 top-k 条最终结果
```

`RerankMultiplier=2` 意味着先取 2 倍候选，再 rerank 精选，兼顾召回率和精度。

### 7.6 SearchRAG 工具参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索内容（支持时间语法） |
| `diary` | string | 指定日记文件夹名 |
| `k` | number | 返回条数 |
| `useRerank` | boolean | 是否启用 Rerank |
| `kMultiplier` | number | 动态 K 值倍数 |
| `tagBoost` | number | 标签权重加成 |

---

## 8. 完整检索流程

以 `[[Nova日记本::VCP元思考:default::5,3,2,1]]` 为例：

```
1. 系统提示词预处理
   └── 识别 [[Nova日记本::VCP元思考:default::5,3,2,1]] 语法

2. 提取查询文本
   └── 从用户最新消息 + 近期对话历史提取

3. 查询缓存
   └── SHA256(query+params) → 命中则直接返回

4. 生成查询向量
   └── EmbeddingUtils → WhitelistEmbeddingModel API

5. ContextVectorManager 融合
   └── 融合对话历史向量

6. 元思考执行 (MetaThinkingManager)
   Stage 1: 检索 top-5，融合结果向量 → q₁
   Stage 2: 用 q₁ 检索 top-3，融合 → q₂
   Stage 3: 用 q₂ 检索 top-2，融合 → q₃
   Stage 4: 用 q₃ 检索 top-1 → 最终结果

7. (可选) AIMemo 并行执行
   └── LLM 提炼跨文件综合摘要

8. 结果去重 (ResultDeduplicator)
   └── SVD 语义去重，移除高度相似的重复片段

9. (可选) Rerank
   └── Qwen3-Reranker-8B 重排序

10. 注入系统提示词
    └── 将检索结果格式化后替换原语法占位符
```

---

## 9. 缓存体系

### 9.1 三层缓存

| 层级 | 缓存对象 | 容量 | TTL | Key 构成 |
|------|----------|------|-----|----------|
| L1 查询缓存 | 完整检索结果 | 200 条 | 1 小时 | SHA256(query+diary+params) |
| L2 向量缓存 | 文本的 embedding 向量 | 500 条 | 2 小时 | SHA256(text) |
| L3 AIMemo 缓存 | LLM 提炼的记忆摘要 | 50 条 | 30 分钟 | SHA256(files+query) |

### 9.2 缓存失效触发条件

- `rag_params.json` 文件内容变更（配置哈希不匹配）
- 插件 `config.env` 变更
- 手动调用缓存清除 API

---

## 10. 配置参考

### 10.1 RAGDiaryPlugin config.env

```env
# Rerank 配置
RerankMultiplier=2
RerankUrl=http://38.60.92.198:3000
RerankApi=sk-...
RerankModel=Qwen/Qwen3-Reranker-8B
RerankMaxTokensPerBatch=30000

# AI 级回忆
AIMemoModel=
AIMemoBatch=5
AIMemoUrl=
AIMemoApi=
AIMemoMaxTokensPerBatch=60000
AIMemoPrompt=AIMemoPrompt.txt

# 查询缓存
RAG_CACHE_MAX_SIZE=100
RAG_CACHE_TTL_MS=3600000

# 向量缓存
EMBEDDING_CACHE_MAX_SIZE=500
EMBEDDING_CACHE_TTL_MS=7200000

# 结果缓存开关
RAG_QUERY_CACHE_ENABLED=false

# 上下文向量
CONTEXT_VECTOR_ALLOW_API_HISTORY=false
```

### 10.2 LightMemo config.env

```env
# 排除文件夹
EXCLUDED_FOLDERS=已整理,夜伽,MusicDiary

# Rerank 配置
RerankUrl=http://38.60.92.198:3000
RerankApi=sk-...
RerankModel=Qwen/Qwen3-Reranker-8B
RerankMaxTokensPerBatch=30000
```

### 10.3 rag_params.json（热重载）

```json
{
  "RAGDiaryPlugin": {
    "noise_penalty": 0.05,
    "tagWeightRange": [0.05, 0.45],
    "tagTruncationBase": 0.6,
    "tagTruncationRange": [0.5, 0.9]
  },
  "KnowledgeBaseManager": {
    "activationMultiplier": [0.5, 1.5],
    "dynamicBoostRange": [0.3, 2.0],
    "coreBoostRange": [1.20, 1.40],
    "deduplicationThreshold": 0.88,
    "techTagThreshold": 0.08,
    "normalTagThreshold": 0.015
  }
}
```

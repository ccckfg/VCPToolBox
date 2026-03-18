# VCPToolBox 主框架深度解析

**版本:** VCP 当前主线
**生成日期:** 2026-03-12
**核心文件:** server.js, Plugin.js, KnowledgeBaseManager.js, EmbeddingUtils.js

---

## 目录

1. [框架定位与设计哲学](#1-框架定位与设计哲学)
2. [核心架构层次](#2-核心架构层次)
3. [server.js — 请求入口与生命周期](#3-serverjs--请求入口与生命周期)
4. [Plugin.js — 插件引擎](#4-pluginjs--插件引擎)
5. [KnowledgeBaseManager — 向量知识库](#5-knowledgebasemanager--向量知识库)
6. [EmbeddingUtils — 向量化工具层](#6-embeddingutils--向量化工具层)
7. [消息预处理管道](#7-消息预处理管道)
8. [配置系统](#8-配置系统)
9. [安全机制](#9-安全机制)

---

## 1. 框架定位与设计哲学

VCPToolBox 是一个 **AI 中间层代理服务**，核心职责是在客户端（VCPChat、SillyTavern 等）与上游 LLM API 之间插入一层能力增强层。

### 1.1 核心设计原则

- **扁平化结构**：所有核心模块直接位于根目录，无 `src/` 分层，降低路径复杂度
- **插件驱动**：功能通过插件扩展，主框架保持精简
- **热重载优先**：配置变更无需重启，通过 chokidar 文件监听实现运行时热更新
- **依赖注入**：VectorDBManager、pushVcpInfo 等核心能力通过注入方式传递给插件，避免循环依赖
- **OpenAI 兼容**：对外暴露标准 `/v1/chat/completions` 接口，对内透明增强

### 1.2 系统边界

```
客户端 (VCPChat / SillyTavern)
        │  OpenAI 兼容 API
        ▼
  VCPToolBox (:6005)          ← 本文档描述的范围
  ├── 消息预处理（插件注入）
  ├── 变量替换（{{Var}}）
  ├── 工具调用循环（VCP Loop）
  └── 流式/非流式转发
        │
        ▼
  上游 LLM API (API_URL)
```

---

## 2. 核心架构层次

```
┌──────────────────────────────────────────────────────────┐
│                     客户端请求层                           │
│        HTTP POST /v1/chat/completions                     │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│                  server.js 入口层                          │
│  Express + 鉴权中间件 + IP 黑名单 + 角色分割器             │
└──────────────────────────────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
┌─────────────────┐ ┌──────────┐ ┌──────────────────────┐
│   Plugin.js     │ │ routes/  │ │  WebSocketServer.js  │
│  插件生命周期    │ │ API路由  │ │  分布式插件通信        │
└─────────────────┘ └──────────┘ └──────────────────────┘
        │
   ┌────┴────────────────────────────┐
   │         插件生态                 │
   ├── RAGDiaryPlugin (日记记忆)      │
   ├── LightMemo (轻量RAG)           │
   ├── UserAuth (用户鉴权)            │
   └── 其他 Plugin/*/                │
        └────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│              KnowledgeBaseManager                         │
│  Vexus-Lite (Rust) + SQLite + HNSW 向量索引               │
└──────────────────────────────────────────────────────────┘
```

---

## 3. server.js — 请求入口与生命周期

### 3.1 启动初始化顺序

1. 加载 `config.env` 环境变量
2. 初始化 Express 应用，配置全局连接池（maxSockets: 10000）
3. 初始化 `KnowledgeBaseManager`（向量库扫描）
4. 初始化 `WebSocketServer`（分布式通信）
5. 初始化 `PluginManager`（加载所有插件）
6. 注册路由（`/v1/*`, `/admin/*`, `/images/*` 等）
7. 启动 HTTP 监听（PORT，默认 6005）

### 3.2 请求处理主流程

```
POST /v1/chat/completions
        │
        ├─ 1. 鉴权验证 (Authorization: Bearer Key)
        ├─ 2. IP 黑名单检查
        ├─ 3. 角色分割器处理 (RoleDivider)
        ├─ 4. 插件预处理管道 (preprocessors 按优先级排序)
        │      ├── 变量替换 {{VarXxx}}
        │      ├── RAGDiaryPlugin 日记注入
        │      └── 其他插件预处理
        ├─ 5. 模型路由 (ModelRedirect / Whitelist)
        ├─ 6. 转发至上游 LLM API
        ├─ 7. VCP 工具调用循环 (MaxVCPLoop)
        │      └── 解析 <<<[TOOL_REQUEST]>>> 并执行工具
        └─ 8. 流式/非流式响应返回客户端
```

### 3.3 VCP 工具调用循环

VCP 的核心能力之一是**工具调用循环**，允许 AI 在单次对话中多轮调用工具：

```
AI 输出包含 <<<[TOOL_REQUEST]>>>
        │
        ▼
解析 tool_name + 参数
        │
        ▼
执行对应插件工具
        │
        ▼
将工具结果注入消息，重新请求 LLM
        │
        ▼
循环直到无工具调用 或 达到 MaxVCPLoop 上限
```

配置参数：
- `MaxVCPLoopStream=5` — 流式模式最大循环次数
- `MaxVCPLoopNonStream=5` — 非流式模式最大循环次数

### 3.4 角色分割器 (RoleDivider)

用于在多角色对话中自动插入分隔标记，防止角色混淆：

| 配置项 | 说明 |
|--------|------|
| `EnableRoleDivider` | 总开关 |
| `RoleDividerSystem/Assistant/User` | 各角色是否插入分隔符 |
| `RoleDividerScanSystem/Assistant/User` | 各角色是否扫描清理 |
| `RoleDividerIgnoreList` | 忽略特定内容的分隔 |

---

## 4. Plugin.js — 插件引擎

### 4.1 插件类型

VCP 支持两种插件运行模式：

| 类型 | 说明 | 通信方式 |
|------|------|----------|
| **Static Plugin** | 独立子进程，长期运行 | stdin/stdout JSON |
| **Hybrid Service Plugin** | 内嵌 HTTP 服务，直接协议通信 | HTTP 内部调用 |

### 4.2 插件加载流程

```
Plugin/ 目录扫描
        │
        ▼
读取 plugin-manifest.json
        │
        ├─ 解析插件类型、命令、配置项
        ├─ 加载 config.env（插件私有配置）
        ├─ 类型强制转换（string → number/boolean）
        └─ 注册为 preprocessor 或 tool
```

### 4.3 plugin-manifest.json 结构

```json
{
  "name": "插件名",
  "version": "1.0.0",
  "type": "hybrid-service",
  "entry": "PluginFile.js",
  "preprocessor": true,
  "preprocessorOrder": 10,
  "tools": [
    {
      "name": "tool_name",
      "description": "工具描述",
      "parameters": { ... }
    }
  ],
  "config": [
    {
      "key": "CONFIG_KEY",
      "type": "string",
      "default": "value"
    }
  ]
}
```

### 4.4 依赖注入机制

插件初始化时，Plugin.js 注入两个核心依赖：

- **`vectorDBManager`**：KnowledgeBaseManager 实例，插件可直接调用向量检索
- **`pushVcpInfo`**：向 VCP Log 广播调试信息的函数

```javascript
// 插件接收注入示例
plugin.init({ vectorDBManager, pushVcpInfo });
```

### 4.5 预处理器排序

多个插件的预处理器按 `preprocessorOrder` 升序执行，数值越小越先执行。这决定了消息被哪个插件先处理，对于有依赖关系的插件（如先注入日记再做变量替换）至关重要。

---

## 5. KnowledgeBaseManager — 向量知识库

### 5.1 多索引架构

```
KnowledgeBaseManager
├── diaryIndices (Map)          每个日记文件夹独立索引
│   ├── "角色A日记本" → VexusIndex (HNSW)
│   ├── "角色B日记本" → VexusIndex (HNSW)
│   └── ...
├── tagIndex                    全局标签索引 (50k 容量)
└── SQLite DB                   元数据持久化
    ├── diary_chunks            文本块 + 向量 ID 映射
    ├── tag_entries             标签条目
    └── file_metadata           文件修改时间追踪
```

### 5.2 索引生命周期

- **懒加载**：索引在首次查询时才加载到内存
- **空闲 TTL**：2 小时无访问自动卸载（`KNOWLEDGEBASE_INDEX_IDLE_TTL_MS`）
- **LRU 淘汰**：内存压力下优先淘汰最久未访问的索引
- **增量同步**：文件变更 < 阈值时增量更新，否则全量重建

### 5.3 向量引擎

底层使用 **Vexus-Lite**（Rust N-API 绑定），基于 HNSW 算法：
- 向量维度：由 `VECTORDB_DIMENSION` 配置（当前 3072，对应 gemini-embedding-001）
- 搜索算法：HNSW（Hierarchical Navigable Small World）
- 相似度度量：余弦相似度

---

## 6. EmbeddingUtils — 向量化工具层

### 6.1 批处理策略

```
输入文本列表
        │
        ▼
按 token 数分批（max 8000 tokens/批，max 100 条/批）
        │
        ▼
并发请求（默认 5 个并发，WhitelistEmbeddingModelList）
        │
        ├─ 429 限流 → 指数退避重试
        ├─ 网络错误 → ApiRetries 次重试
        └─ 成功 → 收集向量结果
        │
        ▼
返回向量数组（与输入文本一一对应）
```

### 6.2 关键配置

| 配置项 | 说明 |
|--------|------|
| `WhitelistEmbeddingModel` | 指定 embedding 模型 |
| `WhitelistEmbeddingModelMaxToken` | 单批最大 token 数 |
| `WhitelistEmbeddingModelList` | 并发批次数 |
| `VECTORDB_DIMENSION` | 向量维度，需与模型匹配 |

---

## 7. 消息预处理管道

### 7.1 变量替换系统

VCP 支持在系统提示词中使用 `{{变量名}}` 语法，在请求时动态替换：

| 变量类型 | 示例 | 说明 |
|----------|------|------|
| 内置变量 | `{{Date}}`, `{{Time}}` | 当前日期时间 |
| 自定义变量 | `{{VarCity}}` | config.env 中定义 |
| 文件变量 | `{{通用表情包}}` | 读取对应 .txt 文件内容 |
| 插件变量 | `{{VCPWeatherInfo}}` | 插件动态注入 |

### 7.2 日记注入语法（四种模式）

RAGDiaryPlugin 在预处理阶段解析系统提示词中的特殊语法：

| 语法 | 模式 | 说明 |
|------|------|------|
| `{{角色日记本}}` | 无条件全量注入 | 直接插入所有日记内容 |
| `[[角色日记本]]` | 无条件 RAG 检索 | 始终执行向量检索 |
| `<<角色日记本>>` | 相似度阈值全量注入 | 相似度达标才注入全量 |
| `《《角色日记本》》` | 相似度阈值 RAG 检索 | 相似度达标才执行 RAG |

### 7.3 模型专属指令 (SAR)

针对特定模型自动追加系统提示词：

```env
SarModel1=gemini-2.5-flash
SarPrompt1="请对用户输入做详尽思考..."
```

当请求模型匹配 `SarModel1` 时，`SarPrompt1` 自动追加到 system prompt。

---

## 8. 配置系统

### 8.1 配置层级

```
全局配置: /root/VCPToolBox/config.env
插件配置: /root/VCPToolBox/Plugin/<插件名>/config.env
RAG参数: /root/VCPToolBox/rag_params.json  (热重载)
```

### 8.2 热重载机制

`rag_params.json` 通过 chokidar 监听，修改后无需重启即可生效。配置变更时通过 SHA256 哈希检测，自动清空相关缓存。

### 8.3 文本替换 (Detector)

支持对 AI 输出或输入进行文本替换，用于修正特定模型的固定输出模式：

```env
Detector1="You can use one tool per message"
Detector_Output1="You can use any tool per message"
```

`SuperDetector` 系列用于处理重复字符等噪声。

---

## 9. 安全机制

### 9.1 访问控制

- **API Key 鉴权**：所有请求需携带 `Authorization: Bearer <Key>`
- **IP 黑名单**：`ip_blacklist.json` 动态维护，支持运行时更新
- **登录失败锁定**：管理面板连续失败后锁定 IP

### 9.2 图片/文件访问控制

- 图片服务需携带 `Image_Key` 参数
- 文件服务需携带 `File_Key` 参数
- 与主 API Key 独立，降低泄露风险

### 9.3 管理面板

- 独立的 `AdminUsername` / `AdminPassword` 认证
- 提供插件管理、配置查看、日志查看等功能

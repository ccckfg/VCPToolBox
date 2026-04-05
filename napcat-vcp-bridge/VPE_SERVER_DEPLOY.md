# VPE v2 服务器上线指南

> 适用版本：VPE v2 + SemanticQueryGate + SensorAggregator
> Git 工作流参考：`.agent/rules/git-sync.md`

---

## 一、本地：提交并推送到私有仓库

在本地 Windows 开发机执行：

```bash
# 确认当前在 my-config 分支
git branch
# → * my-config

# 查看本次所有变更
git status
git diff --name-only HEAD

# 暂存并提交
git add Plugin/SemanticQueryGate/SemanticQueryGate.js
git add Plugin/SensorAggregator/SensorAggregator.js
git add Plugin.js
git add napcat-vcp-bridge/

# ⚠️ 不要 add napcat-vcp-bridge/review_v1.md 等本地草稿
# ⚠️ 不要 add config.env（已在 .gitignore 中）

git commit -m "feat(vpe): VPE v2 full implementation - SQG/SensorAggregator/GroupGate"

# 推送到私有仓库（不要推 origin 官方上游）
git push myfork my-config
```

---

## 二、服务器：拉取并部署 VCP

```bash
# SSH 登录服务器
ssh user@your-server

cd /path/to/VCPToolBox

# 拉取最新代码（从私有仓库）
git pull myfork my-config

# 安装新依赖（如有）
npm install

# 重启 VCP 主服务（让新插件生效）
pm2 restart server
```

**验证 VCP 端新插件已加载：**

```bash
# 检查 SemanticQueryGate 插件状态（应返回 JSON，groupCount 根据你的配置）
curl http://localhost:5890/api/plugins/SemanticQueryGate/health

# 期望响应示例：
# { "status": "ok", "embeddingReady": true, "semanticGroupsReady": true, "groupCount": N }

# 如果 groupCount=0，说明还没有配置语义组
# → 登录管理面板 → 语义组编辑器 → 添加词元组

# 检查 SensorAggregator（应返回天气+新闻事件）
curl http://localhost:5890/api/plugins/SensorAggregator/events
```

---

## 三、服务器：启动 Bridge（dryRun 模式）

**首次上线务必保持 `dryRun: true`**，只看日志不实际发消息。

```bash
cd /path/to/VCPToolBox/napcat-vcp-bridge

# 确认 config.json 中 dryRun 为 true
grep -A 3 '"vpe"' config.json | grep dryRun
# → "dryRun": true   ← 必须确认

# 启动 Bridge（前台运行，方便观察日志）
node bridge.js
```

**观察日志要点（VPE tick 每 10 分钟一次）：**

```
# 正常启动应看到：
[VPE] Engine initialized. tick=10min dryRun=true
[VPE] Proactive bootstrap started.

# 第一次 tick 时应看到：
[VPE] Collecting events...
[VPE] SemanticQueryGate HTTP 200 / 503（503 = 语义组未配置，正常降级）
[VPE] [DRY-RUN] 应主动发送给用户 xxxx: "..."

# ⚠️ 如果看到 DRY-RUN 字样，说明引擎判断正确但没有实际发消息
# ⚠️ 如果完全没有输出，检查 whitelist 中的 QQ 号是否有近期聊天记录
```

---

## 四、验证通过后：关闭 dryRun

确认日志输出符合预期（事件触发合理、语义分不为 0、门控逻辑正常）后：

```bash
# 编辑 config.json
vi config.json
# 将 "dryRun": true 改为 "dryRun": false

# 重启 Bridge
# Ctrl+C 停掉前台进程，再
node bridge.js
# 或用 pm2：
pm2 start bridge.js --name vpe-bridge
pm2 logs vpe-bridge
```

---

## 五、语义组配置（可选但推荐）

`SemanticQueryGate` 依赖 VCP 管理面板中的**语义组**。若未配置，SQG 返回 503，Bridge 自动降级为本地历史 Soft-Maximum，**功能不影响，但个性化程度降低**。

配置路径：**管理面板 → RAGDiaryPlugin → 语义组编辑器**

推荐词元组示例（根据用户实际兴趣调整）：

| 组名 | 词元 |
|------|------|
| 学习/学业 | 考试, 作业, 复习, 课程, 成绩 |
| 工作/项目 | 工作, 任务, 开发, 代码, 项目 |
| 情感/人际 | 朋友, 心情, 聊天, 思念, 关系 |
| 健康/生活 | 吃饭, 睡觉, 天气, 运动, 状态 |
| 时事/资讯 | 新闻, 热点, 社会, 科技, 最新 |

配置完成后，`/health` 接口的 `cachedVectorCount` 应大于 0。

---

## 六、故障排查速查

| 现象 | 可能原因 | 排查方法 |
|------|---------|---------|
| SQG `/health` 报错 | VCP 未重启 / 插件加载失败 | `pm2 logs server` 查看加载日志 |
| SQG `semanticGroupsReady: false` | RAGDiaryPlugin 未先于 SQG 初始化 | 检查插件加载顺序，SQG 是 service 插件，加载在 messagePreprocessor 之后 |
| `groupCount: 0` | 未在管理面板配置语义组 | 登录管理面板添加词元组 |
| VPE tick 无输出 | whitelist 用户无聊天记录 / embeddingModel 为空 | 确认 `embeddingModel` 配置的模型名正确 |
| `[DRY-RUN]` 一直在但从不发消息 | `dryRun: true` 未关闭 | 修改 config.json 后重启 Bridge |
| SensorAggregator 返回空事件 | WeatherReporter/DailyHot 缓存文件不存在 | 确认 VCP 中这两个插件已运行过 |

---

## 七、安全提醒

- ✅ 只向 `myfork`（私有仓库）推送，**绝不向 `origin` 官方上游推送**
- ✅ `config.env` 包含 API 密钥，只存在于私有仓库，已在 `.gitignore` 中豁免
- ✅ `napcat-vcp-bridge/config.json` 包含 `apiKey`，推送前确认私有仓库可见性为 **Private**

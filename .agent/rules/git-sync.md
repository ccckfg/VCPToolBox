# VCPToolBox Git 同步规则

## 仓库架构

```
本地/服务器 (my-config 分支)
  ├── origin   → github.com/VincentHDLee/VCPToolBox   (官方上游，只拉不推)
  └── myfork   → github.com/ccckfg/my-vcp-config      (私有仓库，同步个人配置)
```

## 分支规则

- `main` — 与官方上游保持一致，不做任何个人修改
- `my-config` — 日常工作分支，包含个人配置 + 官方代码合并

## 个人分支追踪的自定义文件

- `Agent/Connor.txt` — 康纳角色提示词
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` — VCP 状态传感器注入
- `config.env` — API 密钥和个人配置（强制追踪，仅推私有仓库）
- `docs/` — VCP_FRAMEWORK, META_THINKING 等个人文档
- `chat.py`, `test_api.py` — 调试脚本
- `GIT_SYNC_GUIDE.md` — 同步操作手册

## 更新 VCP 流程

```bash
# 1. 拉取官方更新
git checkout main
git pull origin main

# 2. 合并到个人分支
git checkout my-config
git merge main
# 有冲突则手动解决

# 3. 推送到私有仓库
git push myfork my-config
```

## 服务器同步流程

```bash
# 服务器拉取
git pull myfork my-config
npm install
pm2 restart server
```

## 安全规则

- `myfork` 仓库必须是 **私有仓库**（包含 config.env 中的 API 密钥）
- 绝不向 `origin`（官方上游）推送任何内容
- 绝不将 `config.env` 推送到任何公开仓库

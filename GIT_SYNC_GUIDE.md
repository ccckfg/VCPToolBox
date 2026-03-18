# VCPToolBox Git 同步指南

## 仓库架构

```
本地/服务器 (my-config 分支)
  ├── origin   → github.com/VincentHDLee/VCPToolBox   (官方上游，只拉不推)
  └── myfork   → github.com/ccckfg/my-vcp-config      (私有仓库，同步个人配置)
```

| Remote   | 用途               | 操作     |
|----------|--------------------|----------|
| `origin` | VCP 官方上游仓库   | 只 pull  |
| `myfork` | 个人私有同步仓库   | push/pull |

## 分支说明

| 分支        | 内容                     |
|-------------|--------------------------|
| `main`      | 与官方上游保持一致       |
| `my-config` | 个人配置 + 官方代码合并  |

### 个人分支包含的自定义内容

- `Agent/Connor.txt` — 康纳角色提示词
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` — VCP 状态传感器注入
- `config.env` — API 密钥和个人配置
- `docs/` — 个人文档（VCP_FRAMEWORK, META_THINKING 等）
- `chat.py`, `test_api.py` — 调试脚本
- `.gitignore` — 额外排除规则（AstrBot/, .venv/ 等）

---

## 日常操作

### 1. 更新 VCP 到最新版本（本地）

```bash
# 切到 main，拉取官方最新代码
git checkout main
git pull origin main

# 切回个人分支，合并更新
git checkout my-config
git merge main

# 如有冲突 → 手动解决后 git add . && git commit
# 推送到私有仓库
git push myfork my-config
```

### 2. 服务器拉取更新

```bash
git pull myfork my-config
npm install          # 如有新依赖
pm2 restart server   # 重启服务
```

### 3. 本地修改了配置后同步

```bash
# 提交修改
git add -A
git commit -m "描述你改了什么"

# 推送到私有仓库
git push myfork my-config

# 服务器上拉取
# ssh your-server
git pull myfork my-config
```

### 4. 服务器上修改了配置后同步回本地

```bash
# 服务器上提交并推送
git add -A
git commit -m "服务器端修改"
git push myfork my-config

# 本地拉取
git pull myfork my-config
```

---

## 首次配置（新机器/新服务器）

```bash
# 克隆私有仓库
git clone https://github.com/ccckfg/my-vcp-config.git VCPToolBox
cd VCPToolBox

# 切到个人分支
git checkout my-config

# 添加官方上游（用于以后更新）
git remote add origin https://github.com/VincentHDLee/VCPToolBox.git

# 安装依赖
npm install
pip install -r requirements.txt
```

---

## 安全提醒

> ⚠️ `myfork` 仓库必须是 **私有仓库**！其中包含 `config.env`（API 密钥）。
> 
> 绝对不要将 `config.env` 推送到任何公开仓库。

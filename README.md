# 知库

这是 `知库` 的首版工程骨架，目标是交付一个 `Windows` 桌面端本地知识库应用。

## 目录

- `apps/desktop`：`Tauri + React` 桌面端
- `apps/web`：`React + Vite` 网页端 MVP
- `services/api`：`FastAPI` 本地 sidecar 服务
- `docs/architecture`：架构设计文档
- `docs/release`：交付与发布文档

## 当前状态

当前已完成：

- 完整主链路：B站导入 → 字幕提取 → 结构化笔记 → FTS+向量检索 → RAG 问答 → 引用定位
- 内容详情页：内联编辑、片段批注/高亮、思维导图、测验题、导出 Markdown/Anki
- 设置页：多厂商预设（Ollama/DeepSeek）、Embedding 变更警告、手动重建索引、B站 Cookie 引导
- 全局状态（zustand）、导入进度轮询、Toast 通知
- 数据库迁移版本化、FTS 增量重建
- Docker 部署预备（见下方）

## 建议开发顺序

1. 安装前端依赖并启动 `desktop`
2. 创建 Python 虚拟环境并安装 `api` 依赖
3. 跑通 `health`、`system/status`、`settings` 基础接口
4. 实现 `B站` 与 `DOCX/TXT/MD` 导入链路
5. 接入摘要、向量检索和问答

## 运行说明

### API sidecar

```powershell
cd services/api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
python -m uvicorn zhiku_api.main:app --app-dir src --reload --host 127.0.0.1 --port 38765
```

### 本地 ASR 兜底

当 B站字幕受登录态限制、用户又只能提供分享链接时，推荐补一层本地 ASR：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev\setup_local_asr.ps1
python .\scripts\qa\check_local_asr.py
```

本地 ASR 接通后，可在设置页切到“本地转写”，再重新预检或正式导入 B站链接。

### 桌面端前端 / Tauri

```powershell
cd apps/desktop
npm install
npm run tauri:dev
```

### 网页端 MVP

```powershell
python -m uvicorn zhiku_api.main:app --app-dir services/api/src --reload --host 127.0.0.1 --port 38765
npm run dev:web
```

默认访问地址：

- `http://127.0.0.1:4173`

网页端开发模式会通过 `Vite proxy` 转发 `/api` 到本地 `FastAPI`，因此不需要额外配置 `CORS`。
当前目标是本地个人验证原型，不涉及正式上线部署。

如果仓库路径里包含中文或其他非 `ASCII` 字符，例如 `D:\桌面\zhiku`，`Vite dev` 在浏览器里可能会因为 `@fs` 路径编码异常而白屏。此时建议改用稳定预览模式：

```powershell
npm run build:web
python .\scripts\dev\serve_web_preview.py --host 127.0.0.1 --port 4173 --api-base http://127.0.0.1:38765
```

或者直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev\start_web.ps1
```

脚本会自动检测路径并切到稳定预览模式，同时使用非 `reload` 模式启动 API，避免本地权限环境下的卡死问题。
稳定预览模式会直接代理 `/api` 到本地 `FastAPI`，不再依赖 `vite preview`，因此在中文路径下也能稳定打开网页原型。
如果仓库里已经存在 `apps/web/dist/index.html`，启动脚本会优先复用现有构建产物，避免在后台再次构建时卡住。

### 一键启动提示

- API 启动脚本：`scripts/dev/start_api.ps1`
- 网页原型启动脚本：`scripts/dev/start_web.ps1`
- 联合启动提示：`scripts/dev/start_all.ps1`
- 浏览器小助手辅助安装：`scripts/dev/open_bilibili_bridge_helper.ps1`

## 协作与手动推送

为保证开发过程可追踪，仓库默认采用“实时记录进度 + 用户手动推送”的协作方式：

- 高层阶段进度：`docs/product/知库_开发进度同步.md`
- 实时变更日志：`docs/product/知库_开发变更日志.md`
- 协作规范：`docs/engineering/知库_协作与进度同步规范_v1.md`
- 推送前检查脚本：`scripts/dev/pre_push_check.ps1`

推荐在手动提交前执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev\pre_push_check.ps1
```

默认提交流程：

```powershell
git add -A
git commit -m "你的提交说明"
git push origin main
```

远程推送默认由用户手动执行，代理不自动 `push`，除非你明确要求。

## 打包说明

### 构建前环境检查

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build\check_env.ps1 -Profile bundle
```

### 构建 sidecar

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build\build_sidecar.ps1
```

产物会输出到：

- `dist/sidecar/zhiku-service.exe`
- `apps/desktop/src-tauri/resources/zhiku-service.exe`

### 构建桌面安装包

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build\build_desktop.ps1
```

这个脚本会先构建 Python sidecar，再执行 `Tauri` 打包。

## Docker 部署（预备，有服务器时使用）

```bash
cp .env.example .env
# 编辑 .env，填写模型接口地址和 API Key

docker compose up -d
# 访问 http://your-server:38765/api/v1/health 确认正常
```

前端构建后用 nginx 托管：

```bash
cd apps/desktop
npm run build:web
# dist/ 静态文件 + nginx 反向代理 /api → localhost:38765
```

> 详见 `docker-compose.yml` 和 `.env.example`。
